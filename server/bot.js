import { detectSignals }     from './indicator.js';
import { getGeminiAdvisory } from './gemini.js';
import { fetchCoinTelegraphOnly, fearGreed } from './news-scraper.js';
import {
  openPaperTrade, closeOpenPosition,
  updateOpenTrades, getPortfolioStats, getAvailableCapital,
} from './paper-trading.js';
import { checkRiskLimits }               from './risk.js';
import { sendTelegram }                  from './telegram.js';
import { fetchCandles, getCurrentPrices } from './hyperliquid.js';
import { db }                            from './database.js';

// ============================================================
// Strategy: Precision v11 — 1m yellow/pink dots
//
// Holding conditions:
//   COUNTER-TREND (1m opposes 30m last signal):
//     SL = 0.1% from entry
//     TP = 10% from entry (fixed target)
//
//   WITH-TREND (1m aligns with 30m last signal, or no 30m bias yet):
//     SL = 2% from entry
//     TP = none — hold until opposite 1m dot fires
// ============================================================
const SIGNAL_WINDOW = 5;          // act only if dot fired within last 5 candles

// ── Trading asset management (persisted in SQLite) ─────────
export function getTradingAssets() {
  // Returns [{ asset, deploy_pct }]
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
  if (assets.length <= 1) return; // always keep at least one asset
  db.prepare('DELETE FROM trading_assets WHERE asset=?').run(asset.toUpperCase());
}

const SL_COUNTER    = 0.001;      // 0.1% stop loss for counter-trend
const TP_COUNTER    = 0.10;       // 10% take profit for counter-trend
const SL_WITH       = 0.02;       // 2% stop loss for with-trend

// Dedup: 25 min window prevents re-entry on same dot
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
// 30M BIAS — per-asset map, tracks last 30m dot signal
// ============================================================
const bias30mMap = new Map(); // asset → { direction, updatedAt }

function getBias(asset) {
  return bias30mMap.get(asset) || { direction: null, updatedAt: null };
}

async function update30mBias(asset) {
  try {
    const candles30m = await fetchCandles(asset, '30m', 400);
    if (!candles30m || candles30m.length < 60) return;
    const result = detectSignals(candles30m, { useProximity: false, useWick: false });
    if (result.signal) {
      const direction = result.signal === 'BUY' ? 'BULLISH' : 'BEARISH';
      bias30mMap.set(asset, { direction, updatedAt: new Date().toISOString() });
      console.log(`[BOT] 30m bias ${asset} → ${direction} (RSI=${result.rsi})`);
    }
  } catch (err) {
    console.error(`[BOT] 30m bias scan error (${asset}):`, err.message);
  }
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

  // Dedup
  if (isDuplicate(signal.asset, signal.signal)) {
    console.log(`[BOT] Duplicate ${signal.signal} — skipping`);
    return null;
  }

  const direction = signal.signal === 'BUY' ? 'LONG' : 'SHORT';

  // Don't re-enter same direction
  const existing = db.prepare(
    `SELECT id FROM trades WHERE status='OPEN' AND mode='PAPER' AND asset=? AND direction=?`
  ).get(signal.asset, direction);
  if (existing) {
    console.log(`[BOT] Already ${direction} (trade #${existing.id}) — skipping`);
    return null;
  }

  // ── Determine counter-trend vs with-trend ───────────────────
  const bias1h = getBias(signal.asset);
  const isCounterTrend =
    bias1h.direction !== null && (
      (signal.signal === 'BUY'  && bias1h.direction === 'BEARISH') ||
      (signal.signal === 'SELL' && bias1h.direction === 'BULLISH')
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
  const biasNote  = bias1h.direction ? ` | 30m: ${bias1h.direction}` : ' | 30m: no bias';

  // Deploy_pct: how much of available capital to use for this trade
  const assetRow   = db.prepare('SELECT deploy_pct FROM trading_assets WHERE asset=?').get(signal.asset);
  const deployPct  = assetRow?.deploy_pct ?? 50;
  const available  = getAvailableCapital();
  const sizeUsd    = parseFloat((available * deployPct / 100).toFixed(2));

  console.log(`[BOT] ${tradeType}${biasNote} → SL=$${stopLoss} (${slPct*100}%) TP=${takeProfit || 'next signal'} | Deploy: ${deployPct}% of $${available} = $${sizeUsd}`);

  const defaultDecision = {
    verdict:    'CONFIRMED',
    confidence: 75,
    size_pct:   deployPct,
    size_usd:   sizeUsd,
    entry:      signal.price,
    stop_loss:  stopLoss,
    take_profit: takeProfit,
    reasoning:  {
      summary: isCounterTrend
        ? `Counter-trend vs 30m ${bias1h.direction} — tight SL 0.1%, TP 10%`
        : `With-trend (30m ${bias1h.direction || 'no bias'}) — SL 2%, exit on opposite dot`,
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
    signal.timeframe || '1m', signal.pattern || null, signal.strength || 'normal',
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
    ? `SL: $${stopLoss} (0.1%) | TP: $${takeProfit} (10%)`
    : `SL: $${stopLoss} (2%) | TP: next opposite dot`;

  await sendTelegram(
    `${icon} TRADE OPENED [${tradeType}]\n` +
    `${dotLabel} — ${signal.signal} ${signal.asset} @ $${signal.price}\n` +
    `RSI: ${signal.rsi?.toFixed(1) || '--'} | Pattern: ${signal.pattern || '--'}${biasNote}\n` +
    `${exitNote}\nSize: 50% | Mode: PAPER`
  );

  setImmediate(() => postTradeAdvisory(tradeId, signal));

  return { signal, decision: defaultDecision, signalId, tradeId };
}

// ============================================================
// TRACK B: Server loop (every 1 minute via cron)
// 1. Update 30m bias (read-only, no trades)
// 2. Scan 1m with 5m MTF confirmation — act if dot within last 5 candles
// ============================================================
export async function runServerLoop(broadcastFn) {
  const assetRows = getTradingAssets(); // [{ asset, deploy_pct }]
  const assetNames = assetRows.map(r => r.asset);
  console.log(`[BOT] Running Precision v11 1m scan — assets: ${assetNames.join(', ')}`);

  // Step 1 — refresh 30m bias + scan 1m for each active asset
  for (const { asset } of assetRows) {
    await update30mBias(asset);

    try {
      const [candles1m, candles5m] = await Promise.all([
        fetchCandles(asset, '1m', 400),
        fetchCandles(asset, '5m', 100),
      ]);

      if (!candles1m || candles1m.length < 60) {
        console.log(`[BOT] ${asset}: insufficient 1m candles — skipping`);
      } else {
        const result = detectSignals(candles1m, {
          htfCandles:   candles5m,
          useProximity: false,   // SMA50 proximity too restrictive on 1m
          useWick:      false,   // wick ratio filter kills doji signals on 1m
        });
        console.log(`[BOT] ${asset} 1m: signal=${result.signal || 'none'} barsAgo=${result.barsAgo ?? '-'} RSI=${result.rsi || '-'}`);

        if (result.signal && result.barsAgo < SIGNAL_WINDOW) {
          const outcome = await handleSignal({ ...result, asset, timeframe: '1m' }, 'server');
          if (outcome && broadcastFn) broadcastFn({ type: 'new_signal', data: outcome });
        }
      }
    } catch (err) {
      console.error(`[BOT] ${asset} 1m scan error:`, err.message, err.stack);
    }
  }

  // Step 2 — update P&L for all active assets and broadcast
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
