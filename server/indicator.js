// ============================================================
// PRECISION v11 INDICATOR — JavaScript port
// Matches Pine Script "Precision Dynamic Historical v11" exactly
//
// Signal logic:
//   • yellow_dot (BUY):  RSI 18–45 (OS zone) + highest(RSI,20) < 50
//                        + doji OR bullish engulfing + RSI hooking up
//                        + volume > 1.3× 20-bar average
//   • pink_dot (SELL):   RSI 55–85 (OB zone) + lowest(RSI,20) > 50
//                        + doji OR bearish engulfing + RSI hooking down
//                        + volume > 1.3× 20-bar average
//
// RSI 50-level memory: 20 bars  |  Volume filter: 1.3× active
// No MTF, no wick, no proximity filters
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
// Scans last `scanWindow` candles for yellow/pink dot conditions
// matching Pine Script v11 exactly.
//
// cfg options:
//   rsiLen     — RSI period (default 14)
//   rsiObMin/Max — OB zone bounds (default 55–85)
//   rsiOsMin/Max — OS zone bounds (default 18–45)
//   sma50Len   — SMA short period (default 50)
//   sma200Len  — SMA long period (default 200)
//   rsiMemory  — RSI 50-level memory window in bars (default 20)
//   scanWindow — how many bars back to look for a fresh signal (default 3)
//   volMult    — volume spike multiplier (default 1.3)
// ============================================================
export function detectSignals(candles, cfg = {}) {
  const {
    rsiLen     = 14,
    rsiObMin   = 55,
    rsiObMax   = 85,
    rsiOsMin   = 18,
    rsiOsMax   = 45,
    sma50Len   = 50,
    sma200Len  = 200,
    rsiMemory  = 20,   // bars for highest/lowest RSI 50-level check
    scanWindow = 3,    // bars back to look for a fresh signal
    volMult    = 1.3,  // volume spike threshold
    trendBias  = 'neutral',
  } = cfg;

  // Aggressive mode overrides — loosen the favoured direction's conditions
  const effOsMax = trendBias === 'long'  ? 55 : rsiOsMax;   // Long mode: wider OS zone (18-55)
  const effObMin = trendBias === 'short' ? 45 : rsiObMin;   // Short mode: wider OB zone (45-85)
  const hiRsiCap = trendBias === 'long'  ? 52 : 50;
  const loRsiFlr = trendBias === 'short' ? 48 : 50;

  const minBars = sma50Len + rsiMemory + 2;
  if (candles.length < minBars) {
    return { signal: null, reason: 'insufficient_candles' };
  }

  const closes = candles.map(c => c.close);
  const sma50  = calcSMA(closes, sma50Len);
  const sma200 = candles.length >= sma200Len ? calcSMA(closes, sma200Len) : null;
  const cur    = candles.at(-1);

  // Scan last `scanWindow` candles for a dot signal (newest first)
  for (let i = 0; i < scanWindow; i++) {
    const slice       = candles.slice(0, candles.length - i);
    const sliceCloses = slice.map(c => c.close);

    if (sliceCloses.length < rsiLen + rsiMemory + 2) continue;

    // Build RSI history — need rsiMemory + 2 values
    const rsiHist = calcRSIHistory(sliceCloses, rsiLen, rsiMemory + 2);
    if (rsiHist.length < rsiMemory + 1) continue;

    const rsiNow  = rsiHist.at(-1);
    const rsiPrev = rsiHist.at(-2);
    if (rsiNow === null || rsiPrev === null) continue;

    const hookUp   = rsiNow > rsiPrev;
    const hookDown = rsiNow < rsiPrev;

    // 50-level memory: highest/lowest RSI over last rsiMemory bars
    const memWindow = rsiHist.slice(-rsiMemory);
    const hiRsi = Math.max(...memWindow);
    const loRsi = Math.min(...memWindow);

    // OS zone check
    const osZone = rsiNow >= rsiOsMin && rsiNow <= effOsMax && hiRsi < hiRsiCap;
    // OB zone check
    const obZone = rsiNow >= effObMin && rsiNow <= rsiObMax && loRsi > loRsiFlr;

    // Volume spike filter: current bar volume > volMult × 20-bar average
    const candleBar = slice.at(-1);
    const volWindow = slice.slice(-21, -1);
    const avgVol    = volWindow.length > 0
      ? volWindow.reduce((s, c) => s + (c.volume || 0), 0) / volWindow.length
      : 0;
    const volumeOk  = !avgVol || (candleBar.volume || 0) >= avgVol * volMult;

    // Patterns for this slice
    const { isDoji, isBullishEngulfing, isBearishEngulfing } = getPatterns(slice);

    const allowBuy  = trendBias !== 'short';
    const allowSell = trendBias !== 'long';

    // ── Yellow dot — BUY ─────────────────────────────────────
    if (allowBuy && osZone && hookUp && volumeOk && (isDoji || isBullishEngulfing)) {
      const patternName = isBullishEngulfing ? 'bullish_engulfing' : 'doji';
      console.log(`[INDICATOR] YELLOW DOT found ${i} candles ago — RSI=${rsiNow} hiRSI=${hiRsi.toFixed(1)} vol=${candleBar.volume?.toFixed(0)} avgVol=${avgVol?.toFixed(0)} pattern=${patternName}`);
      return {
        signal:   'BUY',
        type:     'yellow_dot',
        strength: 'normal',
        price:    cur.close,
        low:      candleBar.low,
        high:     candleBar.high,
        rsi:      rsiNow,
        sma50,
        sma200,
        pattern:  patternName,
        trend:    sma50 && sma200 ? (sma50 > sma200 ? 'uptrend' : 'downtrend') : 'unknown',
        barsAgo:  i,
      };
    }

    // ── Pink dot — SELL ──────────────────────────────────────
    if (allowSell && obZone && hookDown && volumeOk && (isDoji || isBearishEngulfing)) {
      const patternName = isBearishEngulfing ? 'bearish_engulfing' : 'doji';
      console.log(`[INDICATOR] PINK DOT found ${i} candles ago — RSI=${rsiNow} loRSI=${loRsi.toFixed(1)} vol=${candleBar.volume?.toFixed(0)} avgVol=${avgVol?.toFixed(0)} pattern=${patternName}`);
      return {
        signal:   'SELL',
        type:     'pink_dot',
        strength: 'normal',
        price:    cur.close,
        low:      candleBar.low,
        high:     candleBar.high,
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
  console.log(`[INDICATOR] No signal. RSI=${rsiNow?.toFixed(1)} sma50=${sma50?.toFixed(0)}`);
  return { signal: null };
}
