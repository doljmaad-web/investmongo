import { detectSignals }           from './indicator.js';
import { getGeminiAdvisory }       from './gemini.js';
import { fetchCoinTelegraphOnly }  from './news-scraper.js';
import { fearGreed }               from './news-scraper.js';
import { openPaperTrade, closeOpenPosition, updateOpenTrades, getPortfolioStats } from './paper-trading.js';
import { checkRiskLimits }         from './risk.js';
import { sendTelegram }            from './telegram.js';
import { fetchCandles, getCurrentPrices } from './hyperliquid.js';
import { db }                      from './database.js';

// BTC futures only — 5m execution, 4h bias
const ASSET = 'BTC';

// Timeframe-aware deduplication cooldowns
const recentSignals = new Map();
const DEDUP_COOLDOWN = {
  '5m': 15 * 60 * 1000,
  '1h':  2 * 60 * 60 * 1000,
  '4h':  4 * 60 * 60 * 1000,
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
// ============================================================
let marketBias = {
  direction:  null,
  signalType: null,
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
// POST-TRADE ADVISORY — runs in background after trade opens
// Fetches minimal news, calls lightweight Gemini, sends to Telegram
// Never blocks trade execution
// ============================================================
async function postTradeAdvisory(tradeId, signal) {
  try {
    const news     = await fetchCoinTelegraphOnly();        // 3 headlines max, one source
    const fg       = fearGreed;                             // already cached in memory — no fetch
    const advisory = await getGeminiAdvisory(signal, news, fg);

    const icon = advisory.caution ? '⚠️' : '✅';
    const holdText = advisory.hold ? 'HOLD position' : 'REVIEW position';

    await sendTelegram(
      `${icon} ADVISORY — Trade #${tradeId}\n` +
      `${signal.signal} BTC @ $${signal.price} [${signal.timeframe}]\n` +
      `${holdText} | Caution: ${advisory.caution ? 'YES' : 'NO'}\n` +
      `${advisory.reason}`
    );

    console.log(`[ADVISORY] Trade #${tradeId}: hold=${advisory.hold} caution=${advisory.caution}`);
  } catch (err) {
    console.error(`[ADVISORY] Failed for trade #${tradeId}:`, err.message);
    // Trade stays open regardless — advisory is informational only
  }
}

// ============================================================
// MAIN SIGNAL HANDLER — executes immediately, no blocking APIs
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

  // Default trade parameters — no Gemini blocking execution
  const defaultDecision = {
    verdict:    'CONFIRMED',
    confidence: 75,
    size_pct:   50,
    entry:      signal.price,
    stop_loss:  signal.signal === 'BUY'
      ? parseFloat((signal.price * 0.94).toFixed(2))
      : parseFloat((signal.price * 1.06).toFixed(2)),
    reasoning:  { summary: 'Auto-executed — Gemini advisory pending' },
    validated_news: [],
  };

  // Close existing position first (signal flip) so risk check sees 0 open
  const closed = closeOpenPosition(signal.asset, signal.price);
  if (closed > 0) {
    console.log(`${tag} Flipped — closed ${closed} position(s) at $${signal.price}`);
  }

  // Risk limits (daily loss, max positions, max exposure)
  const riskCheck = checkRiskLimits(defaultDecision, signal);
  if (!riskCheck.allowed) {
    console.log(`${tag} Risk blocked: ${riskCheck.reason}`);
    await sendTelegram(`⛔ RISK LIMIT\n${signal.signal} BTC [${signal.timeframe}]\n${riskCheck.reason}`);
    return { signal, blocked: true, blockReason: riskCheck.reason };
  }

  // Save signal to DB
  const signalRow = db.prepare(`
    INSERT INTO signals
      (timestamp, source, asset, action, signal_type, price, rsi, sma50, sma200,
       timeframe, pattern, strength, gemini_verdict, gemini_confidence,
       gemini_reasoning, gemini_news_sentiment, gemini_macro_risk, validated_news)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(), source, signal.asset, signal.signal,
    signal.type || 'unknown', signal.price,
    signal.rsi || null, signal.sma50 || null, signal.sma200 || null,
    signal.timeframe || '5m', signal.pattern || null, signal.strength || 'normal',
    'ADVISORY', 75, 'Auto-executed — advisory pending', 'pending', 'low',
    '[]',
  );

  const signalId = signalRow.lastInsertRowid;

  // Open trade immediately
  const tradeId = openPaperTrade(signalId, defaultDecision, signal);
  console.log(`${tag} Trade #${tradeId} opened immediately`);

  const dir = signal.signal === 'BUY' ? '📈' : '📉';
  const biasNote = marketBias.direction ? ` | 4h: ${marketBias.direction}` : '';
  await sendTelegram(
    `${dir} TRADE OPENED [${signal.timeframe}]\n` +
    `${signal.signal} BTC @ $${signal.price}${biasNote}\n` +
    `Size: 50% | Emergency SL: $${defaultDecision.stop_loss}\n` +
    `Holds until opposite signal fires`
  );

  // Fire advisory in background — does not block return
  setImmediate(() => {
    postTradeAdvisory(tradeId, signal).catch(err =>
      console.error('[BOT] Advisory fire error:', err.message)
    );
  });

  return { signal, decision: defaultDecision, signalId, tradeId };
}

// ============================================================
// TRACK B: Server-side indicator loop (every 5 minutes)
// Step 1 — Read 4h chart → update market bias
// Step 2 — Read 5m chart → execute trades
// ============================================================
export async function runServerLoop(broadcastFn) {
  console.log('[BOT] Running Track B server indicator loop...');

  // --- Step 1: 4h bias ---
  try {
    const candles4h = await fetchCandles(ASSET, '4h', 250);
    if (candles4h && candles4h.length >= 205) {
      const result4h = detectSignals(candles4h);
      if (result4h.signal) {
        updateMarketBias({ ...result4h, asset: ASSET, timeframe: '4h' });
        const outcome4h = await handleSignal({ ...result4h, asset: ASSET, timeframe: '4h' }, 'server');
        if (outcome4h && broadcastFn) broadcastFn({ type: 'new_signal', data: outcome4h });
      }
    }
  } catch (err) {
    console.error('[BOT] 4h scan error:', err.message);
  }

  await new Promise(r => setTimeout(r, 1000));

  // --- Step 2: 5m execution ---
  try {
    const candles5m = await fetchCandles(ASSET, '5m', 250);
    if (candles5m && candles5m.length >= 205) {
      const result5m = detectSignals(candles5m);
      if (result5m.signal) {
        console.log(`[BOT] 5m signal: ${result5m.signal} BTC @ $${result5m.price}`);
        const outcome = await handleSignal({ ...result5m, asset: ASSET, timeframe: '5m' }, 'server');
        if (outcome && broadcastFn) broadcastFn({ type: 'new_signal', data: outcome });
      } else {
        console.log(`[BOT] 5m: no signal. Bias: ${marketBias.direction || 'none'}`);
      }
    }
  } catch (err) {
    console.error('[BOT] 5m scan error:', err.message);
  }

  // Update P&L
  const prices = await getCurrentPrices([ASSET]);
  updateOpenTrades(prices);

  const stats = getPortfolioStats();
  if (broadcastFn) broadcastFn({ type: 'portfolio_update', data: stats });

  console.log(`[BOT] Done. Bias: ${marketBias.direction || 'none'} | Open: ${stats.openCount} | P&L: $${stats.totalPnl}`);
}
