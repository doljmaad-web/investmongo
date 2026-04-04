// ============================================================
// PRECISION v11 INDICATOR — JavaScript port
// Matches Pine Script exactly (Precision Dynamic Historical v11)
//
// Changes from v9 → v11:
//   • OS zone tightened to 18–45 (was 18–60) — no overlap with OB
//   • OB zone tightened to 55–85 (was 40–85) — no overlap with OS
//   • Cooldown-based RSI 50 reset (was instant cross) — anti-whipsaw
//   • Volume spike filter (toggleable)
//   • Wick rejection filter (toggleable)
//   • SMA50 proximity filter (toggleable)
//   • MTF RSI confirmation via separate candle array (toggleable)
//   • Engulfing patterns corrected — prior candle direction verified
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

// --- Volume SMA ---
function calcVolumeSMA(candles, period) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period).map(c => c.volume || 0);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// --- Candlestick reversal patterns ---
export function getPatterns(candles) {
  if (candles.length < 2) return {};
  const cur  = candles.at(-1);
  const prv  = candles.at(-2);
  const prv2 = candles.length >= 3 ? candles.at(-3) : null;

  const bodySize    = Math.abs(cur.open - cur.close);
  const range       = cur.high - cur.low;
  const upperShadow = cur.high - Math.max(cur.open, cur.close);
  const lowerShadow = Math.min(cur.open, cur.close) - cur.low;
  const prvBody     = Math.abs(prv.open - prv.close);

  // ── Single-candle patterns ──────────────────────────────────

  // Doji: body ≤ 15% of range (indecision)
  const isDoji = range > 0 && bodySize <= range * 0.15;

  // Hammer: long lower wick (≥2× body), small upper wick — bullish reversal
  const isHammer =
    bodySize > 0 &&
    lowerShadow >= 2 * bodySize &&
    upperShadow <= bodySize;

  // Inverted Hammer: long upper wick (≥2× body), small lower wick — bullish reversal
  const isInvertedHammer =
    bodySize > 0 &&
    upperShadow >= 2 * bodySize &&
    lowerShadow <= bodySize;

  // Shooting Star: long upper wick (≥2× body), small lower wick — bearish reversal
  const isShootingStar =
    bodySize > 0 &&
    upperShadow >= 2 * bodySize &&
    lowerShadow <= bodySize * 0.5;

  // Hanging Man: long lower wick (≥2× body), small upper wick — bearish reversal
  const isHangingMan =
    bodySize > 0 &&
    lowerShadow >= 2 * bodySize &&
    upperShadow <= bodySize * 0.5;

  // ── Two-candle patterns ─────────────────────────────────────

  // Bullish Engulfing: prior bearish, current bullish and body engulfs prior
  const isBullishEngulfing =
    cur.close > cur.open &&
    prv.open  > prv.close &&
    cur.close > prv.open  &&
    cur.open  < prv.close &&
    bodySize  > prvBody;

  // Bearish Engulfing: prior bullish, current bearish and body engulfs prior
  const isBearishEngulfing =
    cur.close < cur.open &&
    prv.open  < prv.close &&
    cur.close < prv.open  &&
    cur.open  > prv.close &&
    bodySize  > prvBody;

  // Piercing Line: prior bearish, current bullish opens below prior low,
  // closes above prior midpoint — bullish reversal
  const isPiercingLine =
    prv.open  > prv.close &&
    cur.close > cur.open  &&
    cur.open  < prv.low   &&
    cur.close > prv.close + prvBody * 0.5 &&
    cur.close < prv.open;

  // Dark Cloud Cover: prior bullish, current bearish opens above prior high,
  // closes below prior midpoint — bearish reversal
  const isDarkCloudCover =
    prv.close > prv.open  &&
    cur.close < cur.open  &&
    cur.open  > prv.high  &&
    cur.close < prv.open  + prvBody * 0.5 &&
    cur.close > prv.close;

  // ── Three-candle patterns ───────────────────────────────────

  // Morning Star: large bearish, small body (star), large bullish — bullish reversal
  const isMorningStar = prv2 !== null && (() => {
    const p2Body = Math.abs(prv2.open - prv2.close);
    const starBody = prvBody;
    return (
      prv2.open  > prv2.close &&               // candle 1: bearish
      p2Body > range * 0.3 &&                  // candle 1: significant body
      starBody < p2Body * 0.3 &&               // candle 2: small star body
      cur.close  > cur.open &&                 // candle 3: bullish
      cur.close  > prv2.open - p2Body * 0.5   // candle 3: closes above midpoint of candle 1
    );
  })();

  // Evening Star: large bullish, small body (star), large bearish — bearish reversal
  const isEveningStar = prv2 !== null && (() => {
    const p2Body = Math.abs(prv2.open - prv2.close);
    const starBody = prvBody;
    return (
      prv2.close > prv2.open &&                // candle 1: bullish
      p2Body > range * 0.3 &&                  // candle 1: significant body
      starBody < p2Body * 0.3 &&               // candle 2: small star body
      cur.close  < cur.open &&                 // candle 3: bearish
      cur.close  < prv2.open + p2Body * 0.5   // candle 3: closes below midpoint of candle 1
    );
  })();

  return {
    // Bullish reversal patterns (qualify for BUY signals)
    isDoji,
    isHammer,
    isInvertedHammer,
    isBullishEngulfing,
    isPiercingLine,
    isMorningStar,

    // Bearish reversal patterns (qualify for SELL signals)
    isShootingStar,
    isHangingMan,
    isBearishEngulfing,
    isDarkCloudCover,
    isEveningStar,

    // Wick rejection ratios (used by filters)
    bullishWickRejection: range > 0 && (cur.close - cur.low)  / range > 0.6,
    bearishWickRejection: range > 0 && (cur.high  - cur.close) / range > 0.6,

    range,
    bodySize,
  };
}

// --- RSI 50 cooldown state (mirrors Pine Script var counters) ---
// Returns { confirmedBullCycle, confirmedBearCycle } across an RSI history array
function calcCooldownState(rsiHistory, confirmBars = 3) {
  let barsAbove = 0, barsBelow = 0;
  const confirmedBull = []; // RSI settled below 50
  const confirmedBear = []; // RSI settled above 50

  for (const rsi of rsiHistory) {
    barsAbove = rsi > 50 ? barsAbove + 1 : 0;
    barsBelow = rsi < 50 ? barsBelow + 1 : 0;
    confirmedBull.push(barsBelow >= confirmBars);
    confirmedBear.push(barsAbove >= confirmBars);
  }

  return {
    confirmedBullCycle: confirmedBull.at(-1),  // currently in bull cycle (RSI settled below 50)
    confirmedBearCycle: confirmedBear.at(-1),  // currently in bear cycle (RSI settled above 50)
  };
}

// ============================================================
// MAIN: detectSignals
// Scans last `lookback` candles for yellow/pink dot conditions
// matching Pine Script v11 exactly
//
// cfg options:
//   sma50Len        — SMA short period (default 50)
//   sma200Len       — SMA long period (default 200)
//   rsiLen          — RSI period (default 14)
//   rsiObMin/Max    — OB zone bounds (default 55–85)
//   rsiOsMin/Max    — OS zone bounds (default 18–45)
//   lookback        — RSI 50-level memory window (default 20)
//   crossConfirm    — bars RSI must stay on one side of 50 (default 3)
//   useVolume       — enable volume spike filter (default true)
//   volumeMult      — volume spike multiplier (default 1.3)
//   volumeLookback  — volume average period (default 20)
//   useWick         — enable wick rejection filter (default true)
//   wickThreshold   — wick ratio threshold (default 0.6)
//   useProximity    — enable SMA50 proximity filter (default true)
//   proximityPct    — max % distance from SMA50 (default 0.5)
//   useMtf          — enable MTF RSI confirmation (default true)
//   htfCandles      — candle array for HTF (required if useMtf=true)
//   htfOsLevel      — HTF RSI max for bottom signals (default 55)
//   htfObLevel      — HTF RSI min for top signals (default 45)
// ============================================================
export function detectSignals(candles, cfg = {}) {
  const {
    sma50Len       = 50,
    sma200Len      = 200,
    rsiLen         = 8,
    rsiObMin       = 55,   // tightened from 40
    rsiObMax       = 85,
    rsiOsMin       = 18,
    rsiOsMax       = 45,   // tightened from 60
    lookback       = 10,   // short window → easier entry on fast TFs
    crossConfirm   = 1,    // 1 bar cooldown → fires sooner after RSI crosses 50

    // Volume filter
    useVolume      = true,
    volumeMult     = 1.3,
    volumeLookback = 20,

    // Wick rejection filter
    useWick        = true,
    wickThreshold  = 0.6,

    // SMA50 proximity filter
    useProximity   = true,
    proximityPct   = 0.5,

    // MTF RSI confirmation
    useMtf         = true,
    htfCandles     = null,  // pass next-TF candle array here
    htfOsLevel     = 55,
    htfObLevel     = 45,
  } = cfg;

  if (candles.length < sma50Len + lookback) {
    return { signal: null, reason: 'insufficient_candles' };
  }

  const closes = candles.map(c => c.close);
  const sma50  = calcSMA(closes, sma50Len);
  const sma200 = candles.length >= sma200Len ? calcSMA(closes, sma200Len) : null;
  const cur    = candles.at(-1);

  // --- Volume average (for filter) ---
  const avgVol = useVolume ? calcVolumeSMA(candles, volumeLookback) : null;

  // --- MTF RSI ---
  let htfRsi = null;
  if (useMtf && htfCandles && htfCandles.length >= rsiLen + 2) {
    htfRsi = calcRSI(htfCandles.map(c => c.close), rsiLen);
  }
  const htfConfirmsBull = !useMtf || htfRsi === null || htfRsi < htfOsLevel;
  const htfConfirmsBear = !useMtf || htfRsi === null || htfRsi > htfObLevel;

  // Scan last `lookback` candles for a dot signal
  for (let i = 0; i < lookback; i++) {
    const slice       = candles.slice(0, candles.length - i);
    const sliceCloses = slice.map(c => c.close);

    if (sliceCloses.length < rsiLen + lookback + 2) continue;

    // Full RSI history for cooldown state + zone checks
    const rsiHist = calcRSIHistory(sliceCloses, rsiLen, lookback + crossConfirm + 2);
    if (rsiHist.length < lookback + 1) continue;

    const rsiNow  = rsiHist.at(-1);
    const rsiPrev = rsiHist.at(-2);

    const hookUp   = rsiNow > rsiPrev;
    const hookDown = rsiNow < rsiPrev;

    // 50-level memory: highest/lowest RSI over lookback window
    const last  = rsiHist.slice(-lookback);
    const hiRsi = Math.max(...last);
    const loRsi = Math.min(...last);

    // OS zone: RSI 18–45 AND RSI hasn't spiked above 52 in lookback (allows brief touches of 50)
    const osZone = rsiNow >= rsiOsMin && rsiNow <= rsiOsMax && hiRsi < 52;

    // OB zone: RSI 55–85 AND RSI hasn't dipped below 48 in lookback (allows brief touches of 50)
    const obZone = rsiNow >= rsiObMin && rsiNow <= rsiObMax && loRsi > 48;

    // Cooldown state — confirmed cycle
    const { confirmedBullCycle, confirmedBearCycle } = calcCooldownState(rsiHist, crossConfirm);

    // Patterns for this slice
    const patterns = getPatterns(slice);
    const {
      isDoji, isHammer, isInvertedHammer, isBullishEngulfing, isPiercingLine, isMorningStar,
      isShootingStar, isHangingMan, isBearishEngulfing, isDarkCloudCover, isEveningStar,
    } = patterns;

    const isBullishPattern = isDoji || isHammer || isInvertedHammer || isBullishEngulfing || isPiercingLine || isMorningStar;
    const isBearishPattern = isDoji || isShootingStar || isHangingMan || isBearishEngulfing || isDarkCloudCover || isEveningStar;

    // --- Volume filter ---
    const sliceVol = slice.at(-1).volume || 0;
    const volOk    = !useVolume || avgVol === null || sliceVol > avgVol * volumeMult;

    // --- Wick filter ---
    const wickOkBull = !useWick || patterns.bullishWickRejection;
    const wickOkBear = !useWick || patterns.bearishWickRejection;

    // --- SMA50 proximity filter ---
    const sliceSma50 = calcSMA(sliceCloses, sma50Len);
    const proxOk     = !useProximity || !sliceSma50 ||
                       Math.abs(slice.at(-1).close - sliceSma50) / sliceSma50 * 100 < proximityPct;

    // ── Yellow dot — BUY ───────────────────────────────────────
    const goldSignal =
      osZone &&
      hookUp &&
      isBullishPattern &&
      confirmedBullCycle &&
      volOk &&
      wickOkBull &&
      proxOk &&
      htfConfirmsBull;

    if (goldSignal) {
      const patternName = isBullishEngulfing ? 'bullish_engulfing'
        : isHammer          ? 'hammer'
        : isInvertedHammer  ? 'inverted_hammer'
        : isPiercingLine    ? 'piercing_line'
        : isMorningStar     ? 'morning_star'
        : 'doji';
      console.log(`[INDICATOR] YELLOW DOT found ${i} candles ago — RSI=${rsiNow} hiRSI=${hiRsi.toFixed(1)} pattern=${patternName} htf=${htfConfirmsBull}`);
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

    // ── Pink dot — SELL ────────────────────────────────────────
    const pinkSignal =
      obZone &&
      hookDown &&
      isBearishPattern &&
      confirmedBearCycle &&
      volOk &&
      wickOkBear &&
      proxOk &&
      htfConfirmsBear;

    if (pinkSignal) {
      const patternName = isBearishEngulfing ? 'bearish_engulfing'
        : isShootingStar  ? 'shooting_star'
        : isHangingMan    ? 'hanging_man'
        : isDarkCloudCover ? 'dark_cloud_cover'
        : isEveningStar   ? 'evening_star'
        : 'doji';
      console.log(`[INDICATOR] PINK DOT found ${i} candles ago — RSI=${rsiNow} loRSI=${loRsi.toFixed(1)} pattern=${patternName} htf=${htfConfirmsBear}`);
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
