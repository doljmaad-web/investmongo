// ============================================================
// PRECISION v9 INDICATOR — exact JavaScript port of Pine Script
// "Precision Dynamic Historical v9" by DeFiMongo
//
// Parameters (match TradingView defaults exactly):
//   RSI length:        14
//   OB zone:           40 – 85   (rsi_ob_min / rsi_ob_max)
//   OS zone:           18 – 60   (rsi_os_min / rsi_os_max)
//   50-level memory:   10 bars   (lookback_50 = ta.highest/lowest window)
//
// Yellow dot (BUY):
//   RSI in OS zone  AND  ta.highest(RSI, 10) < 50
//   AND (doji OR bullish_engulfing)  AND  RSI hooking up
//
// Pink dot (SELL):
//   RSI in OB zone  AND  ta.lowest(RSI, 10) > 50
//   AND (doji OR bearish_engulfing)  AND  RSI hooking down
//
// No volume filter, no MTF, no wick/proximity filters — pure v9.
// SMA50/200 computed for trend context only.
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

// --- RSI — Wilder's smoothing (matches Pine Script ta.rsi exactly) ---
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

// --- Full RSI array — Wilder's, O(n) single pass ---
// Returns array same length as closes, null until period+1 bars available
function buildRSIArray(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi[i]  = avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
  }
  return rsi;
}

// --- Candlestick patterns — matches Pine Script exactly ---
//
// Pine Script:
//   body_size = math.abs(open - close)
//   candle_range = high - low
//   is_doji = candle_range > 0 and body_size <= candle_range * 0.1
//   is_bullish_engulfing = close > open[1] and open < close[1] and body_size > math.abs(open[1]-close[1])
//   is_bearish_engulfing = close < open[1] and open > close[1] and body_size > math.abs(open[1]-close[1])
//
// NOTE: Pine Script does NOT require close > open for bullish, or close < open for bearish.
// Only the open/close cross vs. the previous bar matters.
export function getPatterns(candles) {
  if (candles.length < 2) return {};
  const cur = candles.at(-1);
  const prv = candles.at(-2);

  const bodySize = Math.abs(cur.open - cur.close);      // body_size
  const range    = cur.high - cur.low;                   // candle_range
  const prvBody  = Math.abs(prv.open - prv.close);       // math.abs(open[1] - close[1])

  const isDoji = range > 0 && bodySize <= range * 0.1;

  // close > open[1] AND open < close[1] AND body > prev_body
  const isBullishEngulfing =
    cur.close > prv.open  &&
    cur.open  < prv.close &&
    bodySize  > prvBody;

  // close < open[1] AND open > close[1] AND body > prev_body
  const isBearishEngulfing =
    cur.close < prv.open  &&
    cur.open  > prv.close &&
    bodySize  > prvBody;

  return { isDoji, isBullishEngulfing, isBearishEngulfing, range, bodySize };
}

// ============================================================
// MAIN: detectSignals
//
// Simulates the Pine Script bar-by-bar logic on a candle array.
// Uses a full O(n) RSI array so all lookback windows are correct.
//
// cfg options:
//   rsiLen     — RSI period              (default 14)
//   rsiObMin   — OB zone lower bound     (default 40)
//   rsiObMax   — OB zone upper bound     (default 85)
//   rsiOsMin   — OS zone lower bound     (default 18)
//   rsiOsMax   — OS zone upper bound     (default 60)
//   lookback50 — ta.highest/lowest bars  (default 10)
//   sma50Len   — short SMA period        (default 50)
//   sma200Len  — long SMA period         (default 200)
//   scanWindow — how many completed bars back to check (default 2)
//   trendBias  — 'neutral'|'long'|'short' — admin override
// ============================================================
export function detectSignals(candles, cfg = {}) {
  const {
    rsiLen     = 14,
    rsiObMin   = 40,
    rsiObMax   = 85,
    rsiOsMin   = 18,
    rsiOsMax   = 60,
    lookback50 = 10,   // Pine Script: lookback_50 — window for ta.highest/lowest
    sma50Len   = 50,
    sma200Len  = 200,
    scanWindow = 2,    // check last N completed candles (handles server loop timing)
    trendBias  = 'neutral',
  } = cfg;

  // Admin trend bias — slightly loosens the favoured direction
  const effOsMax = trendBias === 'long'  ? Math.max(rsiOsMax, 65) : rsiOsMax;
  const effObMin = trendBias === 'short' ? Math.min(rsiObMin, 35) : rsiObMin;
  const hiRsiCap = trendBias === 'long'  ? 52 : 50;
  const loRsiFlr = trendBias === 'short' ? 48 : 50;

  const minBars = Math.max(sma50Len, rsiLen + lookback50 + 2);
  if (candles.length < minBars) {
    return { signal: null, reason: 'insufficient_candles' };
  }

  const closes = candles.map(c => c.close);
  const sma50  = calcSMA(closes, sma50Len);
  const sma200 = candles.length >= sma200Len ? calcSMA(closes, sma200Len) : null;

  // Build full RSI array once — O(n), matches ta.rsi exactly
  const rsiArr = buildRSIArray(closes, rsiLen);

  const allowBuy  = trendBias !== 'short';
  const allowSell = trendBias !== 'long';

  // Check last `scanWindow` completed candles, newest first
  for (let barsAgo = 0; barsAgo < scanWindow; barsAgo++) {
    const idx = candles.length - 1 - barsAgo;
    if (idx < lookback50 + rsiLen + 1) continue;

    const rsiNow  = rsiArr[idx];
    const rsiPrev = rsiArr[idx - 1];
    if (rsiNow === null || rsiPrev === null) continue;

    const rsiHookUp   = rsiNow > rsiPrev;   // rsi_val > rsi_val[1]
    const rsiHookDown = rsiNow < rsiPrev;   // rsi_val < rsi_val[1]

    // ta.highest(rsi_val, lookback_50) — max RSI over last lookback50 bars ending at idx
    // ta.lowest(rsi_val, lookback_50)  — min RSI over last lookback50 bars ending at idx
    let hiRsi = -Infinity, loRsi = Infinity;
    for (let k = idx - lookback50 + 1; k <= idx; k++) {
      if (rsiArr[k] !== null) {
        if (rsiArr[k] > hiRsi) hiRsi = rsiArr[k];
        if (rsiArr[k] < loRsi) loRsi = rsiArr[k];
      }
    }

    // os_zone = rsi >= rsi_os_min AND rsi <= rsi_os_max AND ta.highest(rsi, lookback) < 50
    const osZone = rsiNow >= rsiOsMin && rsiNow <= effOsMax && hiRsi < hiRsiCap;

    // ob_zone = rsi >= rsi_ob_min AND rsi <= rsi_ob_max AND ta.lowest(rsi, lookback) > 50
    const obZone = rsiNow >= effObMin && rsiNow <= rsiObMax && loRsi > loRsiFlr;

    // Patterns at this bar (Pine Script: is_doji, is_bullish_engulfing, is_bearish_engulfing)
    const { isDoji, isBullishEngulfing, isBearishEngulfing } = getPatterns(candles.slice(idx - 1, idx + 1));

    // ── Yellow dot — BUY ─────────────────────────────────────────
    // if os_zone and (is_doji or is_bullish_engulfing) and rsi_hook_up
    if (allowBuy && osZone && rsiHookUp && (isDoji || isBullishEngulfing)) {
      const pattern = isBullishEngulfing ? 'bullish_engulfing' : 'doji';
      console.log(`[INDICATOR] 🟡 YELLOW DOT barsAgo=${barsAgo} — RSI=${rsiNow} hiRSI=${hiRsi.toFixed(1)} pattern=${pattern}`);
      return {
        signal:   'BUY',
        type:     'yellow_dot',
        strength: 'normal',
        price:    candles[candles.length - 1].close,   // current bar's close (entry)
        signalPrice: candles[idx].close,               // price at signal bar
        low:      candles[idx].low,
        high:     candles[idx].high,
        rsi:      rsiNow,
        sma50,
        sma200,
        pattern,
        trend:    sma50 && sma200 ? (sma50 > sma200 ? 'uptrend' : 'downtrend') : 'unknown',
        barsAgo,
      };
    }

    // ── Pink dot — SELL ──────────────────────────────────────────
    // if ob_zone and (is_doji or is_bearish_engulfing) and rsi_hook_down
    if (allowSell && obZone && rsiHookDown && (isDoji || isBearishEngulfing)) {
      const pattern = isBearishEngulfing ? 'bearish_engulfing' : 'doji';
      console.log(`[INDICATOR] 🩷 PINK DOT barsAgo=${barsAgo} — RSI=${rsiNow} loRSI=${loRsi.toFixed(1)} pattern=${pattern}`);
      return {
        signal:   'SELL',
        type:     'pink_dot',
        strength: 'normal',
        price:    candles[candles.length - 1].close,
        signalPrice: candles[idx].close,
        low:      candles[idx].low,
        high:     candles[idx].high,
        rsi:      rsiNow,
        sma50,
        sma200,
        pattern,
        trend:    sma50 && sma200 ? (sma50 > sma200 ? 'uptrend' : 'downtrend') : 'unknown',
        barsAgo,
      };
    }
  }

  const lastRsi = rsiArr[candles.length - 1];
  console.log(`[INDICATOR] No signal. RSI=${lastRsi?.toFixed(1)} sma50=${sma50?.toFixed(0)}`);
  return { signal: null };
}
