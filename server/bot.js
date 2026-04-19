import { detectSignals, calcRSI, calcATR } from './indicator.js';
import { getGeminiAdvisory } from './gemini.js';
import { fetchCoinTelegraphOnly, fearGreed } from './news-scraper.js';
import {
  openPaperTrade, closeOpenPosition, closeTradeById,
  updateOpenTrades, getPortfolioStats, getAvailableCapital,
  getPaperSessionStart,
} from './paper-trading.js';
import { checkRiskLimits }               from './risk.js';
import { sendTelegram }                  from './telegram.js';
import { fetchCandles, getCurrentPrices } from './hyperliquid.js';
import { fetchCandles as fetchCandlesOanda, getCurrentPrices as getCurrentPricesOanda, isOandaAsset } from './oanda.js';
import { db }                            from './database.js';

// ============================================================
// Strategy: Precision V9 — 15m candles
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
// Signal window:  barsAgo < 2 (up to 30 min old signal is valid)
// Dedup window:   30 min (one trade per direction per asset)
// ============================================================

const SIGNAL_WINDOW  = 2;               // act on signal within last 2 × 15m candles (up to 1 bar old)
const SAFETY_SL_PCT         = 0.03;            // 3% initial protective stop
const ATR_PERIOD            = 14;
const ATR_BREAKEVEN_TRIGGER = 1.0;             // arm breakeven after price moves 1 ATR in favor
const ATR_TRAIL_MULTIPLIER  = 1.8;             // trail behind price once trade is in profit
const DEDUP_MS              = 90 * 60 * 1000; // 90 min dedup - prevents re-firing across the scan window

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

function applyAtrTrailingStop(asset, candles30m, currentPrice) {
  if (!candles30m || candles30m.length < ATR_PERIOD + 1) return;

  const atr = calcATR(candles30m, ATR_PERIOD);
  if (!Number.isFinite(atr) || atr <= 0) return;

  const openTrades = db.prepare(`
    SELECT id, asset, direction, entry_price, stop_loss
    FROM trades
    WHERE status='OPEN' AND mode='PAPER' AND asset=? AND opened_at >= ?
  `).all(asset, getPaperSessionStart());

  for (const trade of openTrades) {
    const isLong = trade.direction === 'LONG';
    const profitMove = isLong
      ? currentPrice - trade.entry_price
      : trade.entry_price - currentPrice;

    if (profitMove < atr * ATR_BREAKEVEN_TRIGGER) continue;

    const breakEvenStop = trade.entry_price;
    const atrTrailStop = isLong
      ? currentPrice - atr * ATR_TRAIL_MULTIPLIER
      : currentPrice + atr * ATR_TRAIL_MULTIPLIER;

    const candidateStopRaw = isLong
      ? Math.max(breakEvenStop, atrTrailStop)
      : Math.min(breakEvenStop, atrTrailStop);
    const candidateStop = roundPrice(candidateStopRaw);

    const canTighten = isLong
      ? candidateStop > trade.stop_loss && candidateStop < currentPrice
      : candidateStop < trade.stop_loss && candidateStop > currentPrice;

    if (!canTighten) continue;

    db.prepare('UPDATE trades SET stop_loss=? WHERE id=?').run(candidateStop, trade.id);
    console.log(
      `[BOT] ATR trail tightened ${asset} ${trade.direction} stop ` +
      `from ${trade.stop_loss} to ${candidateStop} (ATR=${atr.toFixed(4)})`
    );
  }
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
      `${signal.signal} ${signal.asset} @ $${signal.price} [15m]\n` +
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

  // Enforce admin trend bias
  if (trendBias === 'long' && direction === 'SHORT') {
    console.log(`[BOT] Trend bias=LONG — SHORT signal suppressed for ${signal.asset}`);
    return null;
  }
  if (trendBias === 'short' && direction === 'LONG') {
    console.log(`[BOT] Trend bias=SHORT — LONG signal suppressed for ${signal.asset}`);
    return null;
  }

  // Skip if we already have an open position in the same direction
  const existing = db.prepare(
    `SELECT id FROM trades WHERE status='OPEN' AND mode='PAPER' AND asset=? AND direction=? AND opened_at >= ?`
  ).get(signal.asset, direction, getPaperSessionStart());
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
      summary: `${direction} on Precision V9 15m ${signal.type === 'yellow_dot' ? 'yellow dot' : 'pink dot'} — held until opposite signal`,
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
    '15m', signal.pattern || null, signal.strength || 'normal',
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
    `${dotLabel} — ${signal.signal} ${signal.asset} @ $${signal.price} [15m]\n` +
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
//   1. Fetch 15m candles (300 bars)
//   2. Detect Precision V9 signal on 15m
//   3. If fresh signal (barsAgo < SIGNAL_WINDOW) → handleSignal
//      Yellow dot → LONG | Pink dot → SHORT
//      Opposite position is closed automatically on flip
//   4. Check safety stop-loss on open trades
// ============================================================
export async function runServerLoop(broadcastFn) {
  const assetRows  = getTradingAssets();
  const assetNames = assetRows.map(r => r.asset);
  console.log(`[BOT] Precision V9 15m scan — assets: ${assetNames.join(', ')}`);

  for (const { asset } of assetRows) {
    try {
      const candles30m = isOandaAsset(asset)
        ? await fetchCandlesOanda(asset, '15m', 300)
        : await fetchCandles(asset, '15m', 300);

      if (!candles30m || candles30m.length < 70) {
        console.log(`[BOT] ${asset}: insufficient 15m candles — skipping`);
        continue;
      }

      const result = detectSignals(candles30m);
      console.log(`[BOT] ${asset} 15m: signal=${result.signal || 'none'} barsAgo=${result.barsAgo ?? '-'} RSI=${result.rsi ?? '-'}`);

      if (result.signal && result.barsAgo < SIGNAL_WINDOW) {
        const outcome = await handleSignal({ ...result, asset, timeframe: '15m' }, 'server');
        if (outcome && broadcastFn) broadcastFn({ type: 'new_signal', data: outcome });
      }

      applyAtrTrailingStop(asset, candles30m, candles30m.at(-1).close);

      // Safety SL check - closes trade if price breaches the current protective stop
      await checkSafetySL(asset, candles30m.at(-1).close);

    } catch (err) {
      console.error(`[BOT] ${asset} scan error:`, err.message, err.stack);
    }
  }

  // Update P&L + broadcast
  try {
    const hlAssets    = assetNames.filter(a => !isOandaAsset(a));
    const oandaAssets = assetNames.filter(a =>  isOandaAsset(a));
    const [hlPrices, oandaPrices] = await Promise.all([
      hlAssets.length    ? getCurrentPrices(hlAssets)           : {},
      oandaAssets.length ? getCurrentPricesOanda(oandaAssets)   : {},
    ]);
    const prices = { ...hlPrices, ...oandaPrices };
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
    `SELECT * FROM trades WHERE status='OPEN' AND mode='PAPER' AND asset=? AND opened_at >= ?`
  ).all(asset, getPaperSessionStart());

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
