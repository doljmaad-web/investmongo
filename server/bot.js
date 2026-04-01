import { detectSignals, calcRSI, getPatterns, calcATR } from './indicator.js';
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
// Strategy: Precision v11 — 5m yellow/pink dots
//
// Signal: 5m candle with V11 RSI zones, volume filter, MTF (15m) confirmation
// Bias:   15m last dot signal → determines counter vs with-trend
//
// COUNTER-TREND (5m opposes 15m bias):
//   SL = 0.5% | TP = 3% fixed
//
// WITH-TREND (5m aligns with 15m bias, or no bias yet):
//   SL = 1.5% | TP = smart exit (reversal candle / ATR trail / 15m flip)
//
// SMART EXITS (with-trend only, while in profit):
//   1. Bearish engulfing on 5m + RSI > 55  → close LONG
//   2. Bullish engulfing on 5m + RSI < 45  → close SHORT
//   3. 15m fires opposite dot (barsAgo<3)  → close either
//   4. ATR(14)×1.5 trailing stop           → activates once profit > 0.8%
// ============================================================
const SIGNAL_WINDOW = 3;   // act on signal within last 3 candles (~15 min on 5m)
const SL_COUNTER    = 0.005;  // 0.5%  stop loss — counter-trend
const TP_COUNTER    = 0.03;   // 3%    take profit — counter-trend
const SL_WITH       = 0.015;  // 1.5%  stop loss — with-trend
const ATR_TRAIL_MULT   = 1.5; // ATR multiplier for trailing stop
const TRAIL_ACTIVATE   = 0.8; // % profit before trailing stop engages
const DEDUP_MS         = 15 * 60 * 1000; // 15 min dedup window

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
// 15M BIAS — per-asset map, tracks last 15m dot signal direction
// ============================================================
const bias15mMap = new Map(); // asset → { direction, updatedAt }

function getBias(asset) {
  return bias15mMap.get(asset) || { direction: null, updatedAt: null };
}

async function update15mBias(asset, candles15m) {
  try {
    if (!candles15m || candles15m.length < 70) return;
    const result = detectSignals(candles15m, { useProximity: false, useWick: false });
    if (result.signal) {
      const direction = result.signal === 'BUY' ? 'BULLISH' : 'BEARISH';
      bias15mMap.set(asset, { direction, updatedAt: new Date().toISOString() });
      console.log(`[BOT] 15m bias ${asset} → ${direction} (RSI=${result.rsi})`);
    }
  } catch (err) {
    console.error(`[BOT] 15m bias scan error (${asset}):`, err.message);
  }
}

// ============================================================
// SMART EXIT ENGINE — checks open trades for profitable exit conditions
// Called every minute with fresh 5m + 15m candle data
// ============================================================
async function checkSmartExits(asset, candles5m, candles15m, currentPrice) {
  const open = db.prepare(
    `SELECT * FROM trades WHERE status='OPEN' AND mode='PAPER' AND asset=?`
  ).all(asset);
  if (!open.length) return;

  // 5m indicators
  const closes5m = candles5m.map(c => c.close);
  const rsiNow   = calcRSI(closes5m, 14);
  const pat5m    = getPatterns(candles5m);
  const atr5m    = calcATR(candles5m, 14);

  // Check if 15m recently fired an opposite signal (within 3 candles = 45 min)
  let htf15Signal = null;
  if (candles15m && candles15m.length >= 70) {
    const htfResult = detectSignals(candles15m, { useProximity: false, useWick: false });
    if (htfResult.signal && htfResult.barsAgo < 3) htf15Signal = htfResult.signal;
  }

  for (const trade of open) {
    const isLong = trade.direction === 'LONG';
    const pnlPct = isLong
      ? (currentPrice - trade.entry_price) / trade.entry_price * 100
      : (trade.entry_price - currentPrice) / trade.entry_price * 100;

    // ── 1. Reversal candle exit — only take when in profit ──
    if (pnlPct > 0 && rsiNow !== null) {
      if (isLong && pat5m.isBearishEngulfing && rsiNow > 55) {
        await smartClose(trade, currentPrice, `bearish engulfing (RSI ${rsiNow?.toFixed(1)})`, pnlPct);
        continue;
      }
      if (!isLong && pat5m.isBullishEngulfing && rsiNow < 45) {
        await smartClose(trade, currentPrice, `bullish engulfing (RSI ${rsiNow?.toFixed(1)})`, pnlPct);
        continue;
      }
    }

    // ── 2. 15m opposite signal exit — only take when in profit ──
    if (pnlPct > 0 && htf15Signal) {
      if ((isLong && htf15Signal === 'SELL') || (!isLong && htf15Signal === 'BUY')) {
        await smartClose(trade, currentPrice, `15m ${htf15Signal} signal`, pnlPct);
        continue;
      }
    }

    // ── 3. ATR trailing stop — activates once profit > TRAIL_ACTIVATE% ──
    if (atr5m && pnlPct > TRAIL_ACTIVATE) {
      const trailSl = isLong
        ? parseFloat((currentPrice - ATR_TRAIL_MULT * atr5m).toFixed(2))
        : parseFloat((currentPrice + ATR_TRAIL_MULT * atr5m).toFixed(2));

      // Ratchet: only move SL in the profitable direction
      const shouldUpdate = isLong
        ? (trade.stop_loss === 0 || trailSl > trade.stop_loss)
        : (trade.stop_loss === 0 || trailSl < trade.stop_loss);

      if (shouldUpdate) {
        db.prepare('UPDATE trades SET stop_loss=? WHERE id=?').run(trailSl, trade.id);
        console.log(`[BOT] ATR trail ${asset} ${trade.direction}: SL → $${trailSl} (PnL=${pnlPct.toFixed(2)}% ATR=${atr5m.toFixed(4)})`);
      }
    }
  }
}

async function smartClose(trade, price, reason, pnlPct) {
  closeTradeById(trade.id, price);
  const icon = pnlPct >= 0 ? '✅' : '🔴';
  console.log(`[BOT] Smart exit [${reason}]: ${trade.asset} ${trade.direction} @ $${price} PnL=${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%`);
  sendTelegram(
    `${icon} SMART EXIT — ${reason}\n` +
    `${trade.direction} ${trade.asset} @ $${price}\n` +
    `PnL: ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%`
  ).catch(() => {});
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
      `${signal.signal} ${signal.asset} @ $${signal.price} [5m]\n` +
      `${advisory.hold ? 'HOLD' : 'REVIEW'} | Caution: ${advisory.caution ? 'YES' : 'NO'}\n` +
      `${advisory.reason}`
    );
  } catch (err) {
    console.error(`[ADVISORY] Failed for trade #${tradeId}:`, err.message);
  }
}

// ============================================================
// MAIN SIGNAL HANDLER
// ============================================================
export async function handleSignal(rawSignal, source = 'server') {
  const signal = { ...rawSignal, source };
  console.log(`[BOT] handleSignal: ${signal.signal} ${signal.asset} @ $${signal.price} barsAgo=${signal.barsAgo ?? '?'}`);

  if (isDuplicate(signal.asset, signal.signal)) {
    console.log(`[BOT] Duplicate ${signal.signal} — skipping`);
    return null;
  }

  const direction = signal.signal === 'BUY' ? 'LONG' : 'SHORT';

  const existing = db.prepare(
    `SELECT id FROM trades WHERE status='OPEN' AND mode='PAPER' AND asset=? AND direction=?`
  ).get(signal.asset, direction);
  if (existing) {
    console.log(`[BOT] Already ${direction} (trade #${existing.id}) — skipping`);
    return null;
  }

  // ── Counter-trend vs with-trend ─────────────────────────────
  const bias15m = getBias(signal.asset);
  const isCounterTrend =
    bias15m.direction !== null && (
      (signal.signal === 'BUY'  && bias15m.direction === 'BEARISH') ||
      (signal.signal === 'SELL' && bias15m.direction === 'BULLISH')
    );

  const slPct = isCounterTrend ? SL_COUNTER : SL_WITH;
  const tpPct = isCounterTrend ? TP_COUNTER : 0;

  const stopLoss = parseFloat((
    signal.signal === 'BUY'
      ? signal.price * (1 - slPct)
      : signal.price * (1 + slPct)
  ).toFixed(2));

  const takeProfit = tpPct > 0
    ? parseFloat((
        signal.signal === 'BUY'
          ? signal.price * (1 + tpPct)
          : signal.price * (1 - tpPct)
      ).toFixed(2))
    : 0;

  const tradeType = isCounterTrend ? 'COUNTER-TREND' : 'WITH-TREND';
  const biasNote  = bias15m.direction ? ` | 15m: ${bias15m.direction}` : ' | 15m: no bias';

  const assetRow  = db.prepare('SELECT deploy_pct FROM trading_assets WHERE asset=?').get(signal.asset);
  const deployPct = assetRow?.deploy_pct ?? 50;
  const available = getAvailableCapital();
  const sizeUsd   = parseFloat((available * deployPct / 100).toFixed(2));

  console.log(`[BOT] ${tradeType}${biasNote} → SL=$${stopLoss} (${slPct*100}%) TP=${takeProfit || 'smart exit'} | Deploy: ${deployPct}% of $${available} = $${sizeUsd}`);

  const defaultDecision = {
    verdict:     'CONFIRMED',
    confidence:  75,
    size_pct:    deployPct,
    size_usd:    sizeUsd,
    entry:       signal.price,
    stop_loss:   stopLoss,
    take_profit: takeProfit,
    reasoning: {
      summary: isCounterTrend
        ? `Counter-trend vs 15m ${bias15m.direction} — SL ${slPct*100}%, TP ${tpPct*100}%`
        : `With-trend (15m ${bias15m.direction || 'no bias'}) — SL ${slPct*100}%, smart exit`,
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
    signal.timeframe || '5m', signal.pattern || null, signal.strength || 'normal',
    'ADVISORY', 75, defaultDecision.reasoning.summary, 'pending', 'low', '[]',
  );
  const signalId = signalRow.lastInsertRowid;

  // Close any existing opposite position (signal flip)
  const closed = closeOpenPosition(signal.asset, signal.price);
  if (closed > 0) console.log(`[BOT] Flipped — closed ${closed} position(s) @ $${signal.price}`);

  // Risk limits
  const riskCheck = checkRiskLimits(defaultDecision, signal);
  if (!riskCheck.allowed) {
    console.log(`[BOT] Blocked by risk: ${riskCheck.reason}`);
    await sendTelegram(`⛔ RISK LIMIT\n${signal.signal} ${signal.asset}\n${riskCheck.reason}`);
    return { signal, blocked: true, blockReason: riskCheck.reason };
  }

  // Open trade
  const tradeId = openPaperTrade(signalId, defaultDecision, signal);
  console.log(`[BOT] Trade #${tradeId} opened — ${tradeType}`);

  const icon     = signal.signal === 'BUY' ? '📈' : '📉';
  const dotLabel = signal.type === 'yellow_dot' ? '🟡 Yellow dot' : '🩷 Pink dot';
  const exitNote = isCounterTrend
    ? `SL: $${stopLoss} (0.5%) | TP: $${takeProfit} (3%)`
    : `SL: $${stopLoss} (1.5%) | TP: smart exit (reversal/ATR trail/15m flip)`;

  await sendTelegram(
    `${icon} TRADE OPENED [${tradeType}]\n` +
    `${dotLabel} — ${signal.signal} ${signal.asset} @ $${signal.price}\n` +
    `RSI: ${signal.rsi?.toFixed(1) || '--'} | Pattern: ${signal.pattern || '--'}${biasNote}\n` +
    `${exitNote}\nSize: ${deployPct}% | Mode: PAPER`
  );

  setImmediate(() => postTradeAdvisory(tradeId, signal));

  return { signal, decision: defaultDecision, signalId, tradeId };
}

// ============================================================
// TRACK B: Server loop (every minute via cron)
//
// Per asset:
//   1. Fetch 5m (400 bars) + 15m (200 bars) candles in parallel
//   2. Update 15m bias (direction context for new trades)
//   3. Detect 5m V11 signal — use 15m as MTF confirmation
//   4. If fresh signal (barsAgo < 3) → handleSignal
//   5. Run smart exit checks on all open trades
// ============================================================
export async function runServerLoop(broadcastFn) {
  const assetRows  = getTradingAssets();
  const assetNames = assetRows.map(r => r.asset);
  console.log(`[BOT] Precision v11 5m scan — assets: ${assetNames.join(', ')}`);

  for (const { asset } of assetRows) {
    try {
      const [candles5m, candles15m] = await Promise.all([
        fetchCandles(asset, '5m', 400),
        fetchCandles(asset, '15m', 200),
      ]);

      // Update 15m bias with freshly fetched candles
      await update15mBias(asset, candles15m);

      if (!candles5m || candles5m.length < 70) {
        console.log(`[BOT] ${asset}: insufficient 5m candles — skipping`);
        continue;
      }

      // Detect 5m signal — volume filter on, proximity/wick off (fast TF)
      const result = detectSignals(candles5m, {
        htfCandles:   candles15m,
        useProximity: false,
        useWick:      false,
      });
      console.log(`[BOT] ${asset} 5m: signal=${result.signal || 'none'} barsAgo=${result.barsAgo ?? '-'} RSI=${result.rsi ?? '-'}`);

      if (result.signal && result.barsAgo < SIGNAL_WINDOW) {
        const outcome = await handleSignal({ ...result, asset, timeframe: '5m' }, 'server');
        if (outcome && broadcastFn) broadcastFn({ type: 'new_signal', data: outcome });
      }

      // Smart exit checks — runs every minute regardless of new signals
      const currentPrice = candles5m.at(-1).close;
      await checkSmartExits(asset, candles5m, candles15m, currentPrice);

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
