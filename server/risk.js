import { db } from './database.js';
import { getPortfolioStats } from './paper-trading.js';

const LIMITS = {
  maxDailyLossUsd:    1000,  // Stop trading for the day if daily loss hits this
  maxOpenPositions:   5,     // one per asset (BTC, ETH, DOGE, XAU, HYPE)
  maxExposureUsd:     9000,  // Up to 90% exposure (50% position size on $10k+)
  minGeminiConfidence: 50,   // Minimum confidence to execute any trade
  maxSizePct:         50,    // Up to 50% per trade for BTC futures
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
