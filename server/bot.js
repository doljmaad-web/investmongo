import { detectSignals }           from './indicator.js';
import { validateWithGemini }      from './gemini.js';
import { fetchAllNews }            from './news-scraper.js';
import { openPaperTrade, closeOpenPosition, updateOpenTrades, getPortfolioStats } from './paper-trading.js';
import { checkRiskLimits }         from './risk.js';
import { sendTelegram }            from './telegram.js';
import { fetchCandles, getCurrentPrices, getFundingRate } from './hyperliquid.js';
import { db }                      from './database.js';

// BTC futures only — 5m execution, 4h bias
const ASSET = 'BTC';

// Deduplication — timeframe-aware cooldowns
const recentSignals = new Map();
const DEDUP_COOLDOWN = {
  '5m': 15 * 60 * 1000,       // 15 min — allows frequent 5m signals
  '1h':  2 * 60 * 60 * 1000,  // 2 hours
  '4h':  4 * 60 * 60 * 1000,  // 4 hours
};

function isDuplicate(asset, action, timeframe) {
  const key      = `${asset}_${action}_${timeframe}`;
  const last     = recentSignals.get(key);
  const cooldown = DEDUP_COOLDOWN[timeframe] || DEDUP_COOLDOWN['1h'];
  if (last && Date.now() - last < cooldown) return true;
  recentSignals.set(key, Date.now());
  return false;
}

// ============================================================
// 4H MARKET BIAS — persists in memory across cron cycles
// Tells Gemini the overall market direction for BTC
// ============================================================
let marketBias = {
  direction:  null,   // 'BULLISH' | 'BEARISH' | null
  signalType: null,   // 'yellow_dot' | 'pink_dot' | 'strong_buy' | 'strong_sell'
  price:      null,
  updatedAt:  null,
};

function updateMarketBias(signal) {
  marketBias = {
    direction:  signal.signal === 'BUY' ? 'BULLISH' : 'BEARISH',
    signalType: signal.type,
    price:      signal.price,
    updatedAt:  new Date().toISOString(),
  };
  console.log(`[BOT] 4h market bias → ${marketBias.direction} (${marketBias.signalType} @ $${marketBias.price})`);
}

// ============================================================
// MAIN SIGNAL HANDLER
// Called by: webhook (Track A) and server loop (Track B)
// ============================================================
export async function handleSignal(rawSignal, source = 'server') {
  const signal = { ...rawSignal, source };
  const tag    = `[BOT][${source.toUpperCase()}][${signal.timeframe || '?'}]`;

  console.log(`${tag} Signal: ${signal.signal} ${signal.asset} @ $${signal.price}`);

  // Deduplicate
  if (isDuplicate(signal.asset, signal.signal, signal.timeframe || '1h')) {
    console.log(`${tag} Duplicate — skipping`);
    return null;
  }

  // Gather market context for Gemini
  const { news, fearGreed, whales, macroEvent } = await fetchAllNews();
  const fundingRate = await getFundingRate(signal.asset).catch(() => 0);

  const marketContext = {
    recentNews:     news.slice(0, 10),
    fearGreed,
    whaleAlerts:    whales.slice(0, 5),
    fundingRate:    (fundingRate * 100).toFixed(4),
    nextMacroEvent: macroEvent,
    fourHourBias:   marketBias,   // Pass 4h market direction to Gemini
  };

  // Gemini validates
  console.log(`${tag} Sending to Gemini for validation...`);
  const decision = await validateWithGemini(signal, marketContext);

  // Save signal to database
  const signalRow = db.prepare(`
    INSERT INTO signals
      (timestamp, source, asset, action, signal_type, price, rsi, sma50, sma200,
       timeframe, pattern, strength, gemini_verdict, gemini_confidence,
       gemini_reasoning, gemini_news_sentiment, gemini_macro_risk, validated_news)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    source,
    signal.asset,
    signal.signal,
    signal.type     || 'unknown',
    signal.price,
    signal.rsi      || null,
    signal.sma50    || null,
    signal.sma200   || null,
    signal.timeframe || '5m',
    signal.pattern  || null,
    signal.strength || 'normal',
    decision.verdict,
    decision.confidence,
    decision.reasoning?.summary || '',
    decision.reasoning?.news_sentiment || '',
    decision.reasoning?.macro_risk || '',
    JSON.stringify(decision.validated_news || []),
  );

  const signalId = signalRow.lastInsertRowid;

  // Close existing position first (signal flip) so risk check sees 0 open positions
  if (decision.verdict === 'CONFIRMED' || decision.verdict === 'REDUCED') {
    const closed = closeOpenPosition(signal.asset, signal.price);
    if (closed > 0) {
      console.log(`${tag} Flipped position — closed ${closed} trade(s) at $${signal.price}`);
    }
  }

  // Check risk limits
  const riskCheck = checkRiskLimits(decision, signal);
  if (!riskCheck.allowed) {
    console.log(`${tag} Risk limit blocked: ${riskCheck.reason}`);
    await sendTelegram(
      `⛔ RISK LIMIT\n${signal.signal} ${signal.asset} [${signal.timeframe}]\nBlocked: ${riskCheck.reason}`
    );
    return { signal, decision, signalId, blocked: true, blockReason: riskCheck.reason };
  }

  // Execute paper trade if confirmed
  if (decision.verdict === 'CONFIRMED' || decision.verdict === 'REDUCED') {
    const tradeId = openPaperTrade(signalId, decision, signal);
    console.log(`${tag} Paper trade opened #${tradeId}`);

    const dir        = signal.signal === 'BUY' ? '📈' : '📉';
    const biasNote   = marketBias.direction
      ? `4h Bias: ${marketBias.direction}\n`
      : '';
    await sendTelegram(
      `${dir} PAPER TRADE OPENED [${signal.timeframe}]\n` +
      `${signal.signal} ${signal.asset} @ $${signal.price}\n` +
      `Confidence: ${decision.confidence}%\n` +
      `${biasNote}` +
      `Size: ${decision.size_pct}% | Emergency SL: $${decision.stop_loss}\n` +
      `Exit: Holds until opposite signal\n\n` +
      `${decision.reasoning?.summary}`
    );

    return { signal, decision, signalId, tradeId };
  }

  // Vetoed
  console.log(`${tag} VETOED — ${decision.reasoning?.veto_reason || 'low confidence'}`);
  await sendTelegram(
    `❌ SIGNAL VETOED [${signal.timeframe}]\n` +
    `${signal.signal} ${signal.asset} @ $${signal.price}\n` +
    `Confidence: ${decision.confidence}%\n` +
    `Reason: ${decision.reasoning?.veto_reason || decision.reasoning?.summary}`
  );

  return { signal, decision, signalId, vetoed: true };
}

// ============================================================
// TRACK B: Server-side indicator loop (every 5 minutes)
// Step 1 — Read 4h chart → update market bias
// Step 2 — Read 5m chart → execute trades using bias context
// ============================================================
export async function runServerLoop(broadcastFn) {
  console.log('[BOT] Running Track B server indicator loop...');

  // --- Step 1: Check 4h chart for market bias ---
  try {
    const candles4h = await fetchCandles(ASSET, '4h', 250);
    if (candles4h && candles4h.length >= 205) {
      const result4h = detectSignals(candles4h);
      if (result4h.signal) {
        updateMarketBias({ ...result4h, asset: ASSET, timeframe: '4h' });

        // Also handle it as a signal — 4h signal is a major direction call
        const outcome4h = await handleSignal(
          { ...result4h, asset: ASSET, timeframe: '4h' },
          'server'
        );
        if (outcome4h && broadcastFn) {
          broadcastFn({ type: 'new_signal', data: outcome4h });
        }
      }
    }
  } catch (err) {
    console.error('[BOT] 4h bias scan error:', err.message);
  }

  await new Promise(r => setTimeout(r, 1000));

  // --- Step 2: Check 5m chart for execution ---
  try {
    const candles5m = await fetchCandles(ASSET, '5m', 250);
    if (candles5m && candles5m.length >= 205) {
      const result5m = detectSignals(candles5m);
      if (result5m.signal) {
        console.log(`[BOT] 5m signal: ${result5m.signal} BTC @ $${result5m.price}`);
        const outcome = await handleSignal(
          { ...result5m, asset: ASSET, timeframe: '5m' },
          'server'
        );
        if (outcome && broadcastFn) {
          broadcastFn({ type: 'new_signal', data: outcome });
        }
      } else {
        console.log(`[BOT] 5m: no signal. Bias: ${marketBias.direction || 'none'}`);
      }
    }
  } catch (err) {
    console.error('[BOT] 5m scan error:', err.message);
  }

  // Update P&L on all open trades
  const prices = await getCurrentPrices([ASSET]);
  updateOpenTrades(prices);

  // Broadcast portfolio update
  const stats = getPortfolioStats();
  if (broadcastFn) broadcastFn({ type: 'portfolio_update', data: stats });

  console.log(`[BOT] Track B complete. Bias: ${marketBias.direction || 'none'} | Open: ${stats.openCount} | P&L: $${stats.totalPnl}`);
}
