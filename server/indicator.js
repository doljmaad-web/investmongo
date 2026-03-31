// ============================================================
// PRECISION v9 INDICATOR — JavaScript port
// Matches Pine Script exactly (Precision Dynamic Historical v9)
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

  // Wilder's smoothing for remaining bars
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

// --- SMA ---
function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return parseFloat((slice.reduce((a, b) => a + b, 0) / period).toFixed(4));
}

// --- RSI history array (Wilder's, last N values) ---
function calcRSIHistory(closes, period = 14, bars = 20) {
  const arr = [];
  for (let i = Math.max(period + 1, closes.length - bars); i <= closes.length; i++) {
    arr.push(calcRSI(closes.slice(0, i), period));
  }
  return arr.filter(v => v !== null);
}

// --- Candlestick patterns (matches Pine Script) ---
function getPatterns(candles) {
  if (candles.length < 2) return {};
  const cur = candles.at(-1);
  const prv = candles.at(-2);
  const bodySize = Math.abs(cur.open - cur.close);
  const range    = cur.high - cur.low;

  return {
    isDoji: range > 0 && bodySize <= range * 0.1,
    isBullishEngulfing:
      cur.close > cur.open &&
      cur.open  < prv.close &&
      cur.close > prv.open  &&
      bodySize  > Math.abs(prv.open - prv.close),
    isBearishEngulfing:
      cur.close < cur.open &&
      cur.open  > prv.close &&
      cur.close < prv.open  &&
      bodySize  > Math.abs(prv.open - prv.close),
  };
}

// ============================================================
// MAIN: detectSignals
// Scans last `lookback` candles for yellow/pink dot conditions
// matching Pine Script exactly
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
    lookback  = 10,  // RSI 50-level memory window (lookback_50 in Pine)
  } = cfg;

  if (candles.length < sma50Len + lookback) {
    return { signal: null, reason: 'insufficient_candles' };
  }

  const closes = candles.map(c => c.close);
  const sma50  = calcSMA(closes, sma50Len);
  const sma200 = candles.length >= sma200Len ? calcSMA(closes, sma200Len) : null;
  const cur    = candles.at(-1);

  // Scan last `lookback` candles for dot signal
  for (let i = 0; i < lookback; i++) {
    const slice       = candles.slice(0, candles.length - i);
    const sliceCloses = slice.map(c => c.close);

    // Need enough history for Wilder's RSI + 50-level memory window
    if (sliceCloses.length < rsiLen + lookback + 2) continue;

    // RSI history: need at least lookback+2 values (for highest/lowest + hook)
    const rsiHist = calcRSIHistory(sliceCloses, rsiLen, lookback + 2);
    if (rsiHist.length < lookback + 1) continue;

    const rsiNow  = rsiHist.at(-1);
    const rsiPrev = rsiHist.at(-2);

    // --- Pine Script exact hook logic ---
    // rsi_hook_up   = rsi_val > rsi_val[1]
    // rsi_hook_down = rsi_val < rsi_val[1]
    const hookUp   = rsiNow > rsiPrev;
    const hookDown = rsiNow < rsiPrev;

    // --- Pine Script 50-level memory ---
    // os_zone: rsi in [18,60] AND ta.highest(rsi_val, 10) < 50
    // ob_zone: rsi in [40,85] AND ta.lowest(rsi_val, 10)  > 50
    const last10 = rsiHist.slice(-lookback);
    const rsiHigh10 = Math.max(...last10);
    const rsiLow10  = Math.min(...last10);

    const osZone = rsiNow >= rsiOsMin && rsiNow <= rsiOsMax && rsiHigh10 < 50;
    const obZone = rsiNow >= rsiObMin && rsiNow <= rsiObMax && rsiLow10  > 50;

    const { isDoji, isBullishEngulfing, isBearishEngulfing } = getPatterns(slice);

    // Yellow dot — BUY
    if (osZone && (isDoji || isBullishEngulfing) && hookUp) {
      console.log(`[INDICATOR] YELLOW DOT found ${i} candles ago — RSI=${rsiNow} highest10=${rsiHigh10.toFixed(1)} isDoji=${isDoji} bullEng=${isBullishEngulfing}`);
      return {
        signal:   'BUY',
        type:     'yellow_dot',
        strength: 'normal',
        price:    cur.close,
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

    // Pink dot — SELL
    if (obZone && (isDoji || isBearishEngulfing) && hookDown) {
      console.log(`[INDICATOR] PINK DOT found ${i} candles ago — RSI=${rsiNow} lowest10=${rsiLow10.toFixed(1)} isDoji=${isDoji} bearEng=${isBearishEngulfing}`);
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
  console.log(`[INDICATOR] No signal. RSI=${rsiNow} sma50=${sma50?.toFixed(0)}`);
  return { signal: null };
}
