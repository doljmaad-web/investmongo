// ============================================================
// PRECISION v9 INDICATOR — JavaScript port
// Matches Pine Script "Precision Dynamic Historical v9" exactly
//
// Signal logic:
//   • yellow_dot (BUY):  RSI 18–60 (OS zone) + highest(RSI,10) < 50
//                        + doji OR bullish engulfing + RSI hooking up
//   • pink_dot (SELL):   RSI 40–85 (OB zone) + lowest(RSI,10) > 50
//                        + doji OR bearish engulfing + RSI hooking down
//
// No MTF, no volume, no wick, no proximity filters (v9 is pure)
// SMA50/200 computed for trend context and chart ribbon only
// ============================================================

// --- ATR — Wilder's smoothing ---
export function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// --- RSI — Wilder's smoothing (matches Pine Script ta.rsi) ---
export function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

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

// --- Candlestick patterns — v9 subset only ---
// Matches Pine Script v9 exactly:
//   is_doji             = body ≤ 10% of range
//   is_bullish_engulfing = close > open[1] AND open < close[1] AND body > prev_body
//   is_bearish_engulfing = close < open[1] AND open > close[1] AND body > prev_body
export function getPatterns(candles) {
  if (candles.length < 2) return {};
  const cur = candles.at(-1);
  const prv = candles.at(-2);

  const bodySize = Math.abs(cur.open - cur.close);
  const range    = cur.high - cur.low;
  const prvBody  = Math.abs(prv.open - prv.close);

  const isDoji = range > 0 && bodySize <= range * 0.1;

  // v9: no prior-direction check — just checks close/open cross of prior bar
  const isBullishEngulfing =
    cur.close > cur.open &&
    cur.open  < prv.close &&
    cur.close > prv.open  &&
    bodySize  > prvBody;

  const isBearishEngulfing =
    cur.close < cur.open &&
    cur.open  > prv.close &&
    cur.close < prv.open  &&
    bodySize  > prvBody;

  return { isDoji, isBullishEngulfing, isBearishEngulfing, range, bodySize };
}

// ============================================================
// MAIN: detectSignals
// Scans last `lookback` candles for yellow/pink dot conditions
// matching Pine Script v9 exactly — no filters, no MTF
//
// cfg options:
//   rsiLen     — RSI period (default 14)
//   rsiObMin/Max — OB zone bounds (default 40–85)
//   rsiOsMin/Max — OS zone bounds (default 18–60)
//   sma50Len   — SMA short period (default 50)
//   sma200Len  — SMA long period (default 200)
//   lookback   — RSI 50-level memory + scan window (default 10)
// ============================================================
export function detectSignals(candles, cfg = {}) {
  const {
    rsiLen    = 14,
    rsiObMin  = 40,
    rsiObMax  = 85,
    rsiOsMin  = 18,
    rsiOsMax  = 60,
    sma50Len  = 50,
    sma200Len = 200,
    lookback  = 10,
    trendBias = 'neutral',  // 'neutral' | 'long' | 'short'
  } = cfg;

  // Aggressive mode overrides — loosen the favoured direction's conditions
  const effOsMax = trendBias === 'long'  ? 65 : rsiOsMax;   // Long mode: wider OS zone (18-65)
  const effObMin = trendBias === 'short' ? 36 : rsiObMin;   // Short mode: wider OB zone (36-85)
  const hiRsiCap = trendBias === 'long'  ? 52 : 50;         // Long mode: allow brief RSI touch of 50
  const loRsiFlr = trendBias === 'short' ? 48 : 50;         // Short mode: allow brief RSI touch of 50

  if (candles.length < sma50Len + lookback) {
    return { signal: null, reason: 'insufficient_candles' };
  }

  const closes = candles.map(c => c.close);
  const sma50  = calcSMA(closes, sma50Len);
  const sma200 = candles.length >= sma200Len ? calcSMA(closes, sma200Len) : null;
  const cur    = candles.at(-1);

  // Scan last `lookback` candles for a dot signal
  for (let i = 0; i < lookback; i++) {
    const slice       = candles.slice(0, candles.length - i);
    const sliceCloses = slice.map(c => c.close);

    if (sliceCloses.length < rsiLen + lookback + 2) continue;

    // Build RSI history for this slice
    const rsiHist = calcRSIHistory(sliceCloses, rsiLen, lookback + 2);
    if (rsiHist.length < lookback + 1) continue;

    const rsiNow  = rsiHist.at(-1);
    const rsiPrev = rsiHist.at(-2);

    const hookUp   = rsiNow > rsiPrev;
    const hookDown = rsiNow < rsiPrev;

    // 50-level memory: highest/lowest RSI over lookback window
    const last  = rsiHist.slice(-lookback);
    const hiRsi = Math.max(...last);
    const loRsi = Math.min(...last);

    // OS zone: RSI in range AND RSI 50-memory check (loosened in Long Trend mode)
    const osZone = rsiNow >= rsiOsMin && rsiNow <= effOsMax && hiRsi < hiRsiCap;

    // OB zone: RSI in range AND RSI 50-memory check (loosened in Short Trend mode)
    const obZone = rsiNow >= effObMin && rsiNow <= rsiObMax && loRsi > loRsiFlr;

    // Patterns for this slice
    const { isDoji, isBullishEngulfing, isBearishEngulfing } = getPatterns(slice);

    // In directional modes, skip the non-favoured signal entirely
    const allowBuy  = trendBias !== 'short';
    const allowSell = trendBias !== 'long';

    // ── Yellow dot — BUY ─────────────────────────────────────
    if (allowBuy && osZone && hookUp && (isDoji || isBullishEngulfing)) {
      const patternName = isBullishEngulfing ? 'bullish_engulfing' : 'doji';
      console.log(`[INDICATOR] YELLOW DOT found ${i} candles ago — RSI=${rsiNow} hiRSI=${hiRsi.toFixed(1)} pattern=${patternName}`);
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
        pattern:  patternName,
        trend:    sma50 && sma200 ? (sma50 > sma200 ? 'uptrend' : 'downtrend') : 'unknown',
        barsAgo:  i,
      };
    }

    // ── Pink dot — SELL ──────────────────────────────────────
    if (allowSell && obZone && hookDown && (isDoji || isBearishEngulfing)) {
      const patternName = isBearishEngulfing ? 'bearish_engulfing' : 'doji';
      console.log(`[INDICATOR] PINK DOT found ${i} candles ago — RSI=${rsiNow} loRSI=${loRsi.toFixed(1)} pattern=${patternName}`);
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
        pattern:  patternName,
        trend:    sma50 && sma200 ? (sma50 > sma200 ? 'uptrend' : 'downtrend') : 'unknown',
        barsAgo:  i,
      };
    }
  }

  const rsiNow = calcRSI(closes, rsiLen);
  console.log(`[INDICATOR] No signal. RSI=${rsiNow} sma50=${sma50?.toFixed(0)}`);
  return { signal: null };
}
