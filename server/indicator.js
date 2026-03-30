// ============================================================
// PRECISION v9 INDICATOR — JavaScript port
// Scans last 10 candles for yellow/pink dot conditions
// ============================================================

// --- RSI — Wilder's smoothing (matches Pine Script ta.rsi) ---
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  // Seed: simple average of first `period` changes
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing for all remaining bars
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

// --- SMA Calculation ---
function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return parseFloat((slice.reduce((a, b) => a + b, 0) / period).toFixed(4));
}

// --- RSI history array (last N values) using Wilder's ---
function calcRSIHistory(closes, period = 14, bars = 15) {
  const arr = [];
  for (let i = Math.max(period + 1, closes.length - bars); i <= closes.length; i++) {
    arr.push(calcRSI(closes.slice(0, i), period));
  }
  return arr.filter(v => v !== null);
}

// --- RSI hook check: rising/falling for at least 2 of last 3 bars ---
function rsiHookUp(rsiHist) {
  if (rsiHist.length < 3) return rsiHist.at(-1) > rsiHist.at(-2);
  const [a, b, c] = rsiHist.slice(-3);
  return (c > b) || (c > a); // turning up in last 2 or last 3
}

function rsiHookDown(rsiHist) {
  if (rsiHist.length < 3) return rsiHist.at(-1) < rsiHist.at(-2);
  const [a, b, c] = rsiHist.slice(-3);
  return (c < b) || (c < a); // turning down in last 2 or last 3
}

// --- Candlestick patterns ---
function getPatterns(candles) {
  if (candles.length < 2) return {};
  const cur = candles.at(-1);
  const prv = candles.at(-2);
  const bodySize = Math.abs(cur.open - cur.close);
  const range = cur.high - cur.low;

  return {
    isDoji: range > 0 && bodySize <= range * 0.1,
    isBullishEngulfing:
      cur.close > cur.open &&
      cur.open < prv.close &&
      cur.close > prv.open &&
      bodySize > Math.abs(prv.open - prv.close),
    isBearishEngulfing:
      cur.close < cur.open &&
      cur.open > prv.close &&
      cur.close < prv.open &&
      bodySize > Math.abs(prv.open - prv.close),
  };
}

// --- SMA cross detection (golden / death cross) ---
function detectSmaCross(closes, sma50Len, sma200Len, lookback = 3) {
  if (closes.length < sma200Len + lookback) return null;
  // Check last `lookback` bars for a crossover
  for (let i = 1; i <= lookback; i++) {
    const slice     = closes.slice(0, closes.length - i + 1);
    const slicePrev = closes.slice(0, closes.length - i);
    const sma50now  = calcSMA(slice,     sma50Len);
    const sma200now = calcSMA(slice,     sma200Len);
    const sma50prv  = calcSMA(slicePrev, sma50Len);
    const sma200prv = calcSMA(slicePrev, sma200Len);
    if (!sma50now || !sma200now || !sma50prv || !sma200prv) continue;
    if (sma50prv <= sma200prv && sma50now > sma200now) return { type: 'golden_cross', barsAgo: i - 1 };
    if (sma50prv >= sma200prv && sma50now < sma200now) return { type: 'death_cross',  barsAgo: i - 1 };
  }
  return null;
}

// ============================================================
// MAIN: detectSignals — scans last 10 candles for missed signals
// ============================================================
export function detectSignals(candles, cfg = {}) {
  const {
    sma50Len  = 50,
    sma200Len = 200,
    rsiLen    = 14,
    rsiObMin  = 40,
    rsiObMax  = 85,
    rsiOsMin  = 18,
    rsiOsMax  = 60,
    lookback  = 10,
  } = cfg;

  if (candles.length < sma50Len + 10) {
    return { signal: null, reason: 'insufficient_candles' };
  }

  const closes = candles.map(c => c.close);
  const sma50  = calcSMA(closes, sma50Len);
  const sma200 = candles.length >= sma200Len ? calcSMA(closes, sma200Len) : null;
  const cur    = candles.at(-1); // current (most recent) candle — used for live entry price

  // --- Check for golden/death cross first (strong signals) ---
  if (candles.length >= sma200Len + 3) {
    const cross = detectSmaCross(closes, sma50Len, sma200Len, 3);
    if (cross) {
      const isBuy = cross.type === 'golden_cross';
      console.log(`[INDICATOR] ${cross.type.toUpperCase()} found ${cross.barsAgo} bars ago`);
      return {
        signal:   isBuy ? 'BUY' : 'SELL',
        type:     isBuy ? 'strong_buy' : 'strong_sell',
        strength: 'strong',
        price:    cur.close,
        low:      cur.low,
        high:     cur.high,
        rsi:      calcRSI(closes, rsiLen),
        sma50,
        sma200,
        pattern:  cross.type,
        trend:    isBuy ? 'uptrend' : 'downtrend',
        barsAgo:  cross.barsAgo,
      };
    }
  }

  // --- Scan last N candles for yellow/pink dot ---
  for (let i = 0; i < lookback; i++) {
    const slice       = candles.slice(0, candles.length - i);
    const sliceCloses = slice.map(c => c.close);

    // Need enough bars for Wilder's RSI seed + some history
    if (sliceCloses.length < rsiLen + 3) continue;

    const rsiHist = calcRSIHistory(sliceCloses, rsiLen, 6);
    const rsiNow  = rsiHist.at(-1);

    if (rsiNow === null || rsiHist.length < 2) continue;

    const osZone = rsiNow >= rsiOsMin && rsiNow <= rsiOsMax;
    const obZone = rsiNow >= rsiObMin && rsiNow <= rsiObMax;

    const { isDoji, isBullishEngulfing, isBearishEngulfing } = getPatterns(slice);

    // Yellow dot — BUY: oversold zone + bullish pattern + RSI hooking up
    if (osZone && (isDoji || isBullishEngulfing) && rsiHookUp(rsiHist)) {
      console.log(`[INDICATOR] YELLOW DOT found ${i} candles ago — RSI=${rsiNow} isDoji=${isDoji} bullEng=${isBullishEngulfing}`);
      return {
        signal:   'BUY',
        type:     'yellow_dot',
        strength: 'normal',
        price:    cur.close,   // current price — realistic execution price
        low:      slice.at(-1).low,
        high:     slice.at(-1).high,
        rsi:      rsiNow,
        sma50,
        sma200,
        pattern:  isBullishEngulfing ? 'bullish_engulfing' : 'doji',
        trend:    sma50 && sma200 ? (sma50 > sma200 ? 'uptrend' : 'downtrend') : 'unknown',
        barsAgo:  i,
      };
    }

    // Pink dot — SELL: overbought zone + bearish pattern + RSI hooking down
    if (obZone && (isDoji || isBearishEngulfing) && rsiHookDown(rsiHist)) {
      console.log(`[INDICATOR] PINK DOT found ${i} candles ago — RSI=${rsiNow} isDoji=${isDoji} bearEng=${isBearishEngulfing}`);
      return {
        signal:   'SELL',
        type:     'pink_dot',
        strength: 'normal',
        price:    cur.close,
        low:      slice.at(-1).low,
        high:     slice.at(-1).high,
        rsi:      rsiNow,
        sma50,
        sma200,
        pattern:  isBearishEngulfing ? 'bearish_engulfing' : 'doji',
        trend:    sma50 && sma200 ? (sma50 > sma200 ? 'uptrend' : 'downtrend') : 'unknown',
        barsAgo:  i,
      };
    }
  }

  const rsiNow = calcRSI(closes, rsiLen);
  console.log(`[INDICATOR] No signal in last ${lookback} candles. Current RSI=${rsiNow} sma50=${sma50?.toFixed(0)}`);
  return { signal: null };
}
