// ============================================================
// PRECISION v9 INDICATOR — JavaScript port
// Exact translation of Pine Script logic
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
// MAIN: detectSignals — mirrors Pine Script logic exactly
// ============================================================
export function detectSignals(candles, cfg = {}) {
  const {
    sma50Len   = 50,
    sma200Len  = 200,
    rsiLen     = 14,
    rsiObMin   = 40,
    rsiObMax   = 85,
    rsiOsMin   = 18,
    rsiOsMax   = 60,
    lookback50 = 10,
  } = cfg;

  if (candles.length < sma200Len + 5) {
    return { signal: null, reason: 'insufficient_candles' };
  }

  const closes   = candles.map(c => c.close);
  const rsiHist  = calcRSIHistory(closes, rsiLen, lookback50 + 3);
  const rsiNow   = rsiHist.at(-1);
  const rsiPrev  = rsiHist.at(-2);
  const rsiLast10 = rsiHist.slice(-lookback50).filter(Boolean);

  const sma50    = calcSMA(closes, sma50Len);
  const sma200   = calcSMA(closes, sma200Len);
  const sma50p   = calcSMA(closes.slice(0, -1), sma50Len);
  const sma200p  = calcSMA(closes.slice(0, -1), sma200Len);

  const { isDoji, isBullishEngulfing, isBearishEngulfing } = getPatterns(candles);
  const cur = candles.at(-1);

  // RSI hook directions
  const rsiHookUp   = rsiNow > rsiPrev;
  const rsiHookDown = rsiNow < rsiPrev;

  // Oversold zone: RSI in range + recent peak below 50
  const osZone = rsiNow >= rsiOsMin && rsiNow <= rsiOsMax &&
    Math.max(...rsiLast10) < 50;

  // Overbought zone: RSI in range + recent trough above 50
  const obZone = rsiNow >= rsiObMin && rsiNow <= rsiObMax &&
    Math.min(...rsiLast10) > 50;

  // --- YELLOW DOT: BUY ---
  if (osZone && (isDoji || isBullishEngulfing) && rsiHookUp) {
    return {
      signal:   'BUY',
      type:     'yellow_dot',
      strength: 'normal',
      price:    cur.close,
      low:      cur.low,
      high:     cur.high,
      rsi:      rsiNow,
      sma50,
      sma200,
      pattern:  isBullishEngulfing ? 'bullish_engulfing' : 'doji',
      trend:    sma50 > sma200 ? 'uptrend' : 'downtrend',
    };
  }

  // --- PINK DOT: SELL ---
  if (obZone && (isDoji || isBearishEngulfing) && rsiHookDown) {
    return {
      signal:   'SELL',
      type:     'pink_dot',
      strength: 'normal',
      price:    cur.close,
      low:      cur.low,
      high:     cur.high,
      rsi:      rsiNow,
      sma50,
      sma200,
      pattern:  isBearishEngulfing ? 'bearish_engulfing' : 'doji',
      trend:    sma50 > sma200 ? 'uptrend' : 'downtrend',
    };
  }

  // --- STRONG BUY: Golden cross ---
  if (sma50p !== null && sma200p !== null && sma50p <= sma200p && sma50 > sma200) {
    return {
      signal:   'BUY',
      type:     'strong_buy',
      strength: 'strong',
      price:    cur.close,
      rsi:      rsiNow,
      sma50,
      sma200,
      pattern:  'golden_cross',
      trend:    'uptrend',
    };
  }

  // --- STRONG SELL: Death cross ---
  if (sma50p !== null && sma200p !== null && sma50p >= sma200p && sma50 < sma200) {
    return {
      signal:   'SELL',
      type:     'strong_sell',
      strength: 'strong',
      price:    cur.close,
      rsi:      rsiNow,
      sma50,
      sma200,
      pattern:  'death_cross',
      trend:    'downtrend',
    };
  }

  return { signal: null };
}
