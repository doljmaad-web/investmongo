import { detectSignals }           from './indicator.js';
import { validateWithGemini }      from './gemini.js';
import { fetchAllNews }            from './news-scraper.js';
import { openPaperTrade, updateOpenTrades, getPortfolioStats } from './paper-trading.js';
import { checkRiskLimits }         from './risk.js';
import { sendTelegram }            from './telegram.js';
import { fetchCandles, getCurrentPrices, getFundingRate } from './hyperliquid.js';
import { db }                      from './database.js';

// Assets monitored by Track B server loop
const ASSETS     = ['BTC', 'ETH', 'DOGE', 'XAU', 'HYPE'];
const TIMEFRAMES  = ['4h', '1h'];

// Deduplication — prevent same signal firing twice within 4 hours
const recentSignals = new Map();

function isDuplicate(asset, action) {
  const key  = `${asset}_${action}`;
  const last = recentSignals.get(key);
  if (last && Date.now() - last < 4 * 60 * 60 * 1000) return true;
  recentSignals.set(key, Date.now());
  return false;
}

// ============================================================
// MAIN SIGNAL HANDLER
// Called by: webhook (Track A) and server loop (Track B)
// ============================================================
export async function handleSignal(rawSignal, source = 'server') {
  const signal = { ...rawSignal, source };
  const tag    = `[BOT][${source.toUpperCase()}]`;

  console.log(`${tag} Signal: ${signal.signal} ${signal.asset} @ $${signal.price}`);

  // Deduplicate
  if (isDuplicate(signal.asset, signal.signal)) {
    console.log(`${tag} Duplicate — skipping`);
    return null;
  }

  // Gather market context for Gemini
  const { news, fearGreed, whales } = await fetchAllNews();
  const fundingRate = await getFundingRate(signal.asset).catch(() => 0);

  const marketContext = {
    recentNews:     news.slice(0, 10),
    fearGreed,
    whaleAlerts:    whales.slice(0, 5),
    fundingRate:    (fundingRate * 100).toFixed(4),
    nextMacroEvent: null, // Future: plug in economic calendar API
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
    signal.timeframe || '4h',
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

  // Check risk limits
  const riskCheck = checkRiskLimits(decision, signal);
  if (!riskCheck.allowed) {
    console.log(`${tag} Risk limit blocked: ${riskCheck.reason}`);
    await sendTelegram(
      `⛔ RISK LIMIT\n${signal.signal} ${signal.asset}\nBlocked: ${riskCheck.reason}`
    );
    return { signal, decision, signalId, blocked: true, blockReason: riskCheck.reason };
  }

  // Execute paper trade if confirmed
  if (decision.verdict === 'CONFIRMED' || decision.verdict === 'REDUCED') {
    const tradeId = openPaperTrade(signalId, decision, signal);
    console.log(`${tag} Paper trade opened #${tradeId}`);

    const dir = signal.signal === 'BUY' ? '📈' : '📉';
    await sendTelegram(
      `${dir} PAPER TRADE OPENED\n` +
      `${signal.signal} ${signal.asset} @ $${signal.price}\n` +
      `Confidence: ${decision.confidence}%\n` +
      `Size: ${decision.size_pct}% | SL: $${decision.stop_loss} | TP: $${decision.take_profit}\n` +
      `R:R = ${decision.rr_ratio}\n\n` +
      `${decision.reasoning?.summary}`
    );

    return { signal, decision, signalId, tradeId };
  }

  // Vetoed
  console.log(`${tag} VETOED — ${decision.reasoning?.veto_reason || 'low confidence'}`);
  await sendTelegram(
    `❌ SIGNAL VETOED\n` +
    `${signal.signal} ${signal.asset} @ $${signal.price}\n` +
    `Confidence: ${decision.confidence}%\n` +
    `Reason: ${decision.reasoning?.veto_reason || decision.reasoning?.summary}`
  );

  return { signal, decision, signalId, vetoed: true };
}

// ============================================================
// TRACK B: Server-side indicator loop (every 5 minutes)
// ============================================================
export async function runServerLoop(broadcastFn) {
  console.log('[BOT] Running Track B server indicator loop...');

  for (const asset of ASSETS) {
    for (const tf of TIMEFRAMES) {
      try {
        const candles = await fetchCandles(asset, tf, 250);
        if (!candles || candles.length < 205) {
          console.warn(`[BOT] Not enough candles for ${asset} ${tf}`);
          continue;
        }

        const result = detectSignals(candles);
        if (!result.signal) continue;

        console.log(`[BOT] Track B signal: ${result.signal} on ${asset} ${tf}`);

        const outcome = await handleSignal(
          { ...result, asset, timeframe: tf },
          'server'
        );

        if (outcome && broadcastFn) {
          broadcastFn({ type: 'new_signal', data: outcome });
        }

      } catch (err) {
        console.error(`[BOT] Error on ${asset} ${tf}:`, err.message);
      }

      // Small delay between assets to avoid rate limits
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Update P&L on all open trades
  const prices = await getCurrentPrices(ASSETS);
  updateOpenTrades(prices);

  // Broadcast portfolio update
  const stats = getPortfolioStats();
  if (broadcastFn) broadcastFn({ type: 'portfolio_update', data: stats });

  console.log(`[BOT] Track B complete. Open trades: ${stats.openCount}, Total P&L: $${stats.totalPnl}`);
}
