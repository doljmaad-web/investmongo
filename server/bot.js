import { detectSignals }     from './indicator.js';
import { getGeminiAdvisory } from './gemini.js';
import { fetchCoinTelegraphOnly, fearGreed } from './news-scraper.js';
import {
  openPaperTrade, closeOpenPosition,
  updateOpenTrades, getPortfolioStats,
} from './paper-trading.js';
import { checkRiskLimits }            from './risk.js';
import { sendTelegram }               from './telegram.js';
import { fetchCandles, getCurrentPrices } from './hyperliquid.js';
import { db }                         from './database.js';

// ============================================================
// Strategy: Precision v9 — 5m yellow/pink dots only
//   - Yellow dot in last 5 candles → enter LONG
//   - Pink dot  in last 5 candles → enter SHORT (and close LONG)
//   - Hold position until opposite dot fires — no fixed TP/SL
// ============================================================
const ASSET         = 'BTC';
const SIGNAL_WINDOW = 5;   // act only if dot fired within last 5 candles

// Dedup: 25 min window (5 candles × 5 min) prevents re-entry on same dot
const recentSignals = new Map();
const DEDUP_MS      = 25 * 60 * 1000;

function isDuplicate(asset, action) {
  const key  = `${asset}_${action}`;
  const last = recentSignals.get(key);
  if (last && Date.now() - last < DEDUP_MS) return true;
  recentSignals.set(key, Date.now());
  return false;
}

// ============================================================
// POST-TRADE ADVISORY — background, non-blocking
// ============================================================
async function postTradeAdvisory(tradeId, signal) {
  try {
    const news     = await fetchCoinTelegraphOnly();
    const advisory = await getGeminiAdvisory(signal, news, fearGreed);
    const icon     = advisory.caution ? '⚠️' : '✅';
    await sendTelegram(
      `${icon} ADVISORY — Trade #${tradeId}\n` +
      `${signal.signal} BTC @ $${signal.price} [5m]\n` +
      `${advisory.hold ? 'HOLD' : 'REVIEW'} | Caution: ${advisory.caution ? 'YES' : 'NO'}\n` +
      `${advisory.reason}`
    );
    console.log(`[ADVISORY] Trade #${tradeId}: hold=${advisory.hold} caution=${advisory.caution}`);
  } catch (err) {
    console.error(`[ADVISORY] Failed for trade #${tradeId}:`, err.message);
  }
}

// ============================================================
// MAIN SIGNAL HANDLER
// ============================================================
export async function handleSignal(rawSignal, source = 'server') {
  const signal = { ...rawSignal, source };
  console.log(`[BOT] handleSignal: ${signal.signal} ${signal.asset} @ $${signal.price} barsAgo=${signal.barsAgo ?? '?'} src=${source}`);

  // Dedup — block same direction re-entry within 25 min
  if (isDuplicate(signal.asset, signal.signal)) {
    console.log(`[BOT] Duplicate ${signal.signal} — skipping`);
    return null;
  }

  const direction = signal.signal === 'BUY' ? 'LONG' : 'SHORT';

  // Don't re-enter if already in same direction
  const existing = db.prepare(
    `SELECT id FROM trades WHERE status='OPEN' AND mode='PAPER' AND asset=? AND direction=?`
  ).get(signal.asset, direction);
  if (existing) {
    console.log(`[BOT] Already ${direction} (trade #${existing.id}) — skipping`);
    return null;
  }

  // No fixed stop loss — exit triggered only by opposite signal
  const defaultDecision = {
    verdict:    'CONFIRMED',
    confidence: 75,
    size_pct:   50,
    entry:      signal.price,
    stop_loss:  0,   // disabled — hold until opposite signal
    reasoning:  { summary: 'Precision v9 dot signal — hold until opposite dot' },
    validated_news: [],
  };

  // Save signal to DB
  const signalRow = db.prepare(`
    INSERT INTO signals
      (timestamp, source, asset, action, signal_type, price, rsi, sma50, sma200,
       timeframe, pattern, strength, gemini_verdict, gemini_confidence,
       gemini_reasoning, gemini_news_sentiment, gemini_macro_risk, validated_news)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(), source, signal.asset, signal.signal,
    signal.type || 'yellow_dot', signal.price,
    signal.rsi || null, signal.sma50 || null, signal.sma200 || null,
    '5m', signal.pattern || null, signal.strength || 'normal',
    'ADVISORY', 75, 'Auto-executed — advisory pending', 'pending', 'low', '[]',
  );
  const signalId = signalRow.lastInsertRowid;
  console.log(`[BOT] Signal saved id=${signalId}`);

  // Close any existing opposite position (signal flip)
  const closed = closeOpenPosition(signal.asset, signal.price);
  if (closed > 0) console.log(`[BOT] Flipped — closed ${closed} position(s) @ $${signal.price}`);

  // Risk limits
  const riskCheck = checkRiskLimits(defaultDecision, signal);
  if (!riskCheck.allowed) {
    console.log(`[BOT] Blocked by risk: ${riskCheck.reason}`);
    await sendTelegram(`⛔ RISK LIMIT\n${signal.signal} BTC\n${riskCheck.reason}`);
    return { signal, blocked: true, blockReason: riskCheck.reason };
  }

  // Open trade
  const tradeId = openPaperTrade(signalId, defaultDecision, signal);
  console.log(`[BOT] Trade opened: #${tradeId}`);

  const icon = signal.signal === 'BUY' ? '📈' : '📉';
  const dotLabel = signal.type === 'yellow_dot' ? '🟡 Yellow dot' : '🩷 Pink dot';
  await sendTelegram(
    `${icon} TRADE OPENED\n` +
    `${dotLabel} — ${signal.signal} BTC @ $${signal.price}\n` +
    `RSI: ${signal.rsi?.toFixed(1) || '--'} | Pattern: ${signal.pattern || '--'}\n` +
    `Size: 50% | No fixed SL — exits on opposite dot\n` +
    `Mode: PAPER`
  );

  // Advisory in background — non-blocking
  setImmediate(() => postTradeAdvisory(tradeId, signal));

  return { signal, decision: defaultDecision, signalId, tradeId };
}

// ============================================================
// TRACK B: Server loop (runs every 5 minutes via cron)
// Scans 5m candles — acts if yellow/pink dot within last 5 bars
// ============================================================
export async function runServerLoop(broadcastFn) {
  console.log('[BOT] Running Precision v9 5m scan...');

  try {
    const candles5m = await fetchCandles(ASSET, '5m', 250);
    if (!candles5m || candles5m.length < 60) {
      console.log('[BOT] Insufficient 5m candles — skipping');
    } else {
      const result = detectSignals(candles5m);
      console.log(`[BOT] 5m scan: signal=${result.signal || 'none'} barsAgo=${result.barsAgo ?? '-'} RSI=${result.rsi || '-'}`);

      // Only act if dot fired within last SIGNAL_WINDOW candles
      if (result.signal && result.barsAgo < SIGNAL_WINDOW) {
        const outcome = await handleSignal({ ...result, asset: ASSET, timeframe: '5m' }, 'server');
        if (outcome && broadcastFn) broadcastFn({ type: 'new_signal', data: outcome });
      }
    }
  } catch (err) {
    console.error('[BOT] 5m scan error:', err.message, err.stack);
  }

  // Update open trade P&L
  try {
    const prices = await getCurrentPrices([ASSET]);
    updateOpenTrades(prices);
    const stats = getPortfolioStats();
    if (broadcastFn) broadcastFn({ type: 'portfolio_update', data: stats });
    console.log(`[BOT] Done. Open: ${stats.openCount} | P&L: $${stats.totalPnl}`);
  } catch (err) {
    console.error('[BOT] P&L update error:', err.message);
  }
}
