import { db } from './database.js';
import { getPortfolioStats } from './paper-trading.js';

const LIMITS = {
  maxDailyLossUsd:    200,   // Stop trading for the day if daily loss hits this
  maxOpenPositions:   5,     // Max concurrent open trades
  maxExposureUsd:     3000,  // Max total capital at risk at once
  minGeminiConfidence: 55,   // Minimum confidence to execute any trade
  maxSizePct:         8,     // Never more than 8% per trade
};

export function checkRiskLimits(decision, signal) {
  const stats = getPortfolioStats();

  // Check daily loss limit
  if (stats.closedPnlToday <= -LIMITS.maxDailyLossUsd) {
    return { allowed: false, reason: `Daily loss limit hit ($${LIMITS.maxDailyLossUsd})` };
  }

  // Check max open positions
  if (stats.openCount >= LIMITS.maxOpenPositions) {
    return { allowed: false, reason: `Max open positions reached (${LIMITS.maxOpenPositions})` };
  }

  // Check Gemini confidence threshold
  if (decision.confidence < LIMITS.minGeminiConfidence) {
    return { allowed: false, reason: `Gemini confidence too low (${decision.confidence}% < ${LIMITS.minGeminiConfidence}%)` };
  }

  // Check max exposure
  const currentExposure = stats.openTrades.reduce((s, t) => s + t.size_usd, 0);
  const newTradeSize    = stats.cashBalance * (decision.size_pct / 100);
  if (currentExposure + newTradeSize > LIMITS.maxExposureUsd) {
    return { allowed: false, reason: `Max exposure would be exceeded ($${LIMITS.maxExposureUsd})` };
  }

  // Cap size
  if (decision.size_pct > LIMITS.maxSizePct) {
    decision.size_pct = LIMITS.maxSizePct;
  }

  return { allowed: true };
}

export { LIMITS };
