import { detectSignals, calcRSI, calcATR } from './indicator.js';
import { getGeminiAdvisory } from './gemini.js';
import { fetchCoinTelegraphOnly, fearGreed } from './news-scraper.js';
import {
  openPaperTrade, closeOpenPosition, closeTradeById,
  updateOpenTrades, getPortfolioStats, getAvailableCapital,
} from './paper-trading.js';
import { checkRiskLimits }               from './risk.js';
import { sendTelegram }                  from './telegram.js';
import { fetchCandles, getCurrentPrices } from './hyperliquid.js';
import { db }                            from './database.js';

// ============================================================
// Strategy: Precision V9 — 30m candles
//
// Pure signal-following mode:
//   • Yellow dot (BUY)  → close any open SHORT → open LONG
//   • Pink dot  (SELL)  → close any open LONG  → open SHORT
//
// Positions are HELD until the opposite signal fires.
// No fixed take-profit. Safety stop-loss only (3%) to prevent
// catastrophic loss if the market gaps hard against the position.
//
// Bias timeframe: 2h (context only — does not filter entries)
// Signal window:  barsAgo < 2 (up to 60 min old signal is valid)
// Dedup window:   30 min (one trade per direction per asset)
// ============================================================

const SIGNAL_WINDOW  = 2;               // act on signal within last 2 × 30m candles
const SAFETY_SL_PCT  = 0.03;           // 3% safety stop-loss — last resort protection
const DEDUP_MS       = 30 * 60 * 1000; // 30 min dedup — matches 30m candle cadence

// ── Admin trend bias ─────────────────────────────────────────
// 'neutral' | 'long' | 'short' — set via dashboard admin buttons
// Informational only in this mode — does not filter entries
let trendBias = 'neutral';
export function getTrendBias() { return trendBias; }
export function setTrendBias(bias) {
  if (!['neutral','long','short'].includes(bias)) return;
  trendBias = bias;
  console.log(`[BOT] Admin trend bias set → ${bias.toUpperCase()}`);
}

// Price rounding — preserves meaningful decimal places for all assets
function roundPrice(p) {
  if (p >= 10000) return parseFloat(p.toFixed(1));
  if (p >= 1000)  return parseFloat(p.toFixed(2));
  if (p >= 100)   return parseFloat(p.toFixed(3));
  if (p >= 10)    return parseFloat(p.toFixed(4));
  if (p >= 1)     return parseFloat(p.toFixed(5));
  if (p >= 0.1)   return parseFloat(p.toFixed(6));
  return parseFloat(p.toFixed(8));
}

// ── Trading asset management (persisted in SQLite) ─────────
export function getTradingAssets() {
  return db.prepare('SELECT asset, deploy_pct FROM trading_assets ORDER BY asset').all();
}
export function addTradingAsset(asset, deployPct = 50) {
  db.prepare('INSERT OR IGNORE INTO trading_assets (asset, deploy_pct) VALUES (?, ?)').run(asset.toUpperCase(), deployPct);
}
export function setTradingAssetPct(asset, deployPct) {
  db.prepare('UPDATE trading_assets SET deploy_pct=? WHERE asset=?').run(deployPct, asset.toUpperCase());
}
export function removeTradingAsset(asset) {
  const assets = getTradingAssets();
  if (assets.length <= 1) return;
  db.prepare('DELETE FROM trading_assets WHERE asset=?').run(asset.toUpperCase());
}

// ── Deduplication ───────────────────────────────────────────
const recentSignals = new Map();
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
      `${signal.signal} ${signal.asset} @ $${signal.price} [30m]\n` +
      `${advisory.hold ? 'HOLD' : 'REVIEW'} | Caution: ${advisory.caution ? 'YES' : 'NO'}\n` +
      `${advisory.reason}`
    );
  } catch (err) {
    console.error(`[ADVISORY] Failed for trade #${tradeId}:`, err.message);
  }
}

// ============================================================
// MAIN SIGNAL HANDLER
//
// On yellow_dot: close any open SHORT → open LONG
// On pink_dot:   close any open LONG  → open SHORT
// Position held until the opposite dot fires.
// ============================================================
export async function handleSignal(rawSignal, source = 'server') {
  const signal = { ...rawSignal, source };
  console.log(`[BOT] handleSignal: ${signal.signal} ${signal.asset} @ $${signal.price} barsAgo=${signal.barsAgo ?? '?'}`);

  if (isDuplicate(signal.asset, signal.signal)) {
    console.log(`[BOT] Duplicate ${signal.signal} — skipping`);
    return null;
  }

  const direction = signal.signal === 'BUY' ? 'LONG' : 'SHORT';

  // Skip if we already have an open position in the same direction
  const existing = db.prepare(
    `SELECT id FROM trades WHERE status='OPEN' AND mode='PAPER' AND asset=? AND direction=?`
  ).get(signal.asset, direction);
  if (existing) {
    console.log(`[BOT] Already ${direction} (trade #${existing.id}) — skipping`);
    return null;
  }

  // Safety stop-loss only — position is intended to be held until the
  // opposite signal fires; this SL is a last-resort protection layer only
  const stopLoss = roundPrice(
    signal.signal === 'BUY'
      ? signal.price * (1 - SAFETY_SL_PCT)
      : signal.price * (1 + SAFETY_SL_PCT)
  );

  // No fixed take-profit — held until opposite signal
  const takeProfit = 0;

  const assetRow  = db.prepare('SELECT deploy_pct FROM trading_assets WHERE asset=?').get(signal.asset);
  const deployPct = assetRow?.deploy_pct ?? 50;
  const available = getAvailableCapital();
  const sizeUsd   = parseFloat((available * deployPct / 100).toFixed(2));

  console.log(`[BOT] ${direction} ${signal.asset} — SL=$${stopLoss} (3% safety) | TP=hold until opposite signal | Deploy: ${deployPct}% of $${available} = $${sizeUsd}`);

  const defaultDecision = {
    verdict:     'CONFIRMED',
    confidence:  75,
    size_pct:    deployPct,
    size_usd:    sizeUsd,
    entry:       signal.price,
    stop_loss:   stopLoss,
    take_profit: takeProfit,
    reasoning: {
      summary: `${direction} on Precision V9 30m ${signal.type === 'yellow_dot' ? 'yellow dot' : 'pink dot'} — held until opposite signal`,
    },
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
    '30m', signal.pattern || null, signal.strength || 'normal',
    'ADVISORY', 75, defaultDecision.reasoning.summary, 'pending', 'low', '[]',
  );
  const signalId = signalRow.lastInsertRowid;

  // Close any open opposite position — this is the primary exit mechanism
  const closed = closeOpenPosition(signal.asset, signal.price);
  if (closed > 0) {
    console.log(`[BOT] Flipped — closed ${closed} opposite position(s) @ $${signal.price}`);
  }

  // Risk limits
  const riskCheck = checkRiskLimits(defaultDecision, signal);
  if (!riskCheck.allowed) {
    console.log(`[BOT] Blocked by risk: ${riskCheck.reason}`);
    await sendTelegram(`⛔ RISK LIMIT\n${signal.signal} ${signal.asset}\n${riskCheck.reason}`);
    return { signal, blocked: true, blockReason: riskCheck.reason };
  }

  // Open new position
  const tradeId = openPaperTrade(signalId, defaultDecision, signal);
  console.log(`[BOT] Trade #${tradeId} opened — ${direction} ${signal.asset}`);

  const icon     = signal.signal === 'BUY' ? '📈' : '📉';
  const dotLabel = signal.type === 'yellow_dot' ? '🟡 Yellow dot' : '🩷 Pink dot';

  await sendTelegram(
    `${icon} TRADE OPENED\n` +
    `${dotLabel} — ${signal.signal} ${signal.asset} @ $${signal.price} [30m]\n` +
    `RSI: ${signal.rsi?.toFixed(1) || '--'} | Pattern: ${signal.pattern || '--'}\n` +
    `Safety SL: $${stopLoss} (3%) | Exit: opposite signal\n` +
    `Size: ${deployPct}% ($${sizeUsd}) | Mode: PAPER`
  );

  setImmediate(() => postTradeAdvisory(tradeId, signal));

  return { signal, decision: defaultDecision, signalId, tradeId };
}

// ============================================================
// TRACK B: Server loop (every minute via cron)
//
// Per asset:
//   1. Fetch 30m candles (300 bars)
//   2. Detect Precision V9 signal on 30m
//   3. If fresh signal (barsAgo < SIGNAL_WINDOW) → handleSignal
//      Yellow dot → LONG | Pink dot → SHORT
//      Opposite position is closed automatically on flip
//   4. Check safety stop-loss on open trades
// ============================================================
export async function runServerLoop(broadcastFn) {
  const assetRows  = getTradingAssets();
  const assetNames = assetRows.map(r => r.asset);
  console.log(`[BOT] Precision V9 30m scan — assets: ${assetNames.join(', ')}`);

  for (const { asset } of assetRows) {
    try {
      const candles30m = await fetchCandles(asset, '30m', 300);

      if (!candles30m || candles30m.length < 70) {
        console.log(`[BOT] ${asset}: insufficient 30m candles — skipping`);
        continue;
      }

      const result = detectSignals(candles30m);
      console.log(`[BOT] ${asset} 30m: signal=${result.signal || 'none'} barsAgo=${result.barsAgo ?? '-'} RSI=${result.rsi ?? '-'}`);

      if (result.signal && result.barsAgo < SIGNAL_WINDOW) {
        const outcome = await handleSignal({ ...result, asset, timeframe: '30m' }, 'server');
        if (outcome && broadcastFn) broadcastFn({ type: 'new_signal', data: outcome });
      }

      // Safety SL check — closes trade only if price breaches the 3% safety stop
      await checkSafetySL(asset, candles30m.at(-1).close);

    } catch (err) {
      console.error(`[BOT] ${asset} scan error:`, err.message, err.stack);
    }
  }

  // Update P&L + broadcast
  try {
    const prices = await getCurrentPrices(assetNames);
    updateOpenTrades(prices);
    const stats = getPortfolioStats();
    if (broadcastFn) broadcastFn({ type: 'portfolio_update', data: stats });
    console.log(`[BOT] Done. Open: ${stats.openCount} | P&L: $${stats.totalPnl}`);
  } catch (err) {
    console.error('[BOT] P&L update error:', err.message);
  }
}

// ============================================================
// SAFETY SL CHECK
// The primary exit is always the opposite signal.
// This only triggers if price breaches the 3% safety stop-loss.
// ============================================================
async function checkSafetySL(asset, currentPrice) {
  const open = db.prepare(
    `SELECT * FROM trades WHERE status='OPEN' AND mode='PAPER' AND asset=?`
  ).all(asset);

  for (const trade of open) {
    if (!trade.stop_loss || trade.stop_loss === 0) continue;

    const isLong  = trade.direction === 'LONG';
    const breached = isLong
      ? currentPrice <= trade.stop_loss
      : currentPrice >= trade.stop_loss;

    if (breached) {
      const pnlPct = isLong
        ? (currentPrice - trade.entry_price) / trade.entry_price * 100
        : (trade.entry_price - currentPrice) / trade.entry_price * 100;

      closeTradeById(trade.id, currentPrice);
      console.log(`[BOT] Safety SL hit — ${asset} ${trade.direction} @ $${currentPrice} PnL=${pnlPct.toFixed(2)}%`);
      await sendTelegram(
        `🛑 SAFETY STOP HIT\n` +
        `${trade.direction} ${asset} @ $${currentPrice}\n` +
        `Entry: $${trade.entry_price} | SL: $${trade.stop_loss}\n` +
        `PnL: ${pnlPct.toFixed(2)}%`
      ).catch(() => {});
    }
  }
}
