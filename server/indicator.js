// ============================================================
// PRECISION v9 INDICATOR — JavaScript port
// Scans last 10 candles for yellow/pink dot conditions
// ============================================================

// --- RSI Calculation ---
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return parseFloat((100 - (100 / (1 + avgGain / avgLoss))).toFixed(2));
}

// --- SMA Calculation ---
function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return parseFloat((slice.reduce((a, b) => a + b, 0) / period).toFixed(4));
}

// --- RSI history array (last N values) ---
function calcRSIHistory(closes, period = 14, bars = 15) {
  const arr = [];
  for (let i = Math.max(period + 1, closes.length - bars); i <= closes.length; i++) {
    arr.push(calcRSI(closes.slice(0, i), period));
  }
  return arr.filter(v => v !== null);
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
  const cur    = candles.at(-1);

  // Scan last 10 candles for yellow or pink dot
  for (let i = 0; i < lookback; i++) {
    const slice       = candles.slice(0, candles.length - i);
    const sliceCloses = slice.map(c => c.close);
    const rsiHist     = calcRSIHistory(sliceCloses, rsiLen, 5);
    const rsiNow      = rsiHist.at(-1);
    const rsiPrev     = rsiHist.at(-2);

    if (rsiNow === null || rsiPrev === null) continue;

    const rsiHookUp   = rsiNow > rsiPrev;
    const rsiHookDown = rsiNow < rsiPrev;
    const osZone      = rsiNow >= rsiOsMin && rsiNow <= rsiOsMax;
    const obZone      = rsiNow >= rsiObMin && rsiNow <= rsiObMax;

    const { isDoji, isBullishEngulfing, isBearishEngulfing } = getPatterns(slice);

    // Yellow dot — BUY
    if (osZone && (isDoji || isBullishEngulfing) && rsiHookUp) {
      console.log(`[INDICATOR] YELLOW DOT found ${i} candles ago — RSI=${rsiNow} isDoji=${isDoji} bullEng=${isBullishEngulfing}`);
      return {
        signal:  'BUY',
        type:    'yellow_dot',
        strength: 'normal',
        price:   cur.close,
        low:     cur.low,
        high:    cur.high,
        rsi:     rsiNow,
        sma50,
        sma200,
        pattern: isBullishEngulfing ? 'bullish_engulfing' : 'doji',
        trend:   sma50 && sma200 ? (sma50 > sma200 ? 'uptrend' : 'downtrend') : 'unknown',
        barsAgo: i,
      };
    }

    // Pink dot — SELL
    if (obZone && (isDoji || isBearishEngulfing) && rsiHookDown) {
      console.log(`[INDICATOR] PINK DOT found ${i} candles ago — RSI=${rsiNow} isDoji=${isDoji} bearEng=${isBearishEngulfing}`);
      return {
        signal:  'SELL',
        type:    'pink_dot',
        strength: 'normal',
        price:   cur.close,
        low:     cur.low,
        high:    cur.high,
        rsi:     rsiNow,
        sma50,
        sma200,
        pattern: isBearishEngulfing ? 'bearish_engulfing' : 'doji',
        trend:   sma50 && sma200 ? (sma50 > sma200 ? 'uptrend' : 'downtrend') : 'unknown',
        barsAgo: i,
      };
    }
  }

  const rsiNow = calcRSIHistory(closes, rsiLen, 3).at(-1);
  console.log(`[INDICATOR] No signal in last ${lookback} candles. Current RSI=${rsiNow} sma50=${sma50?.toFixed(0)}`);
  return { signal: null };
}
