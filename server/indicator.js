//@version=6
indicator(title="Precision Dynamic Historical v11", shorttitle="Precision v11", overlay=true, max_labels_count=500)

// ==========================================
// --- Input Parameters ---
// ==========================================
sma50_length  = input.int(50,  title="Short SMA Length")
sma200_length = input.int(200, title="Long SMA Length")
rsi_length    = input.int(14,  title="RSI Length")

// RSI Range Settings — non-overlapping zones
rsi_ob_min = input.int(55, title="RSI OB Min Range", tooltip="Overbought zone start. Keep above 50 to avoid overlap with OS zone.")
rsi_ob_max = input.int(85, title="RSI OB Max Range")
rsi_os_min = input.int(18, title="RSI OS Min Range")
rsi_os_max = input.int(45, title="RSI OS Max Range", tooltip="Oversold zone end. Keep below 50 to avoid overlap with OB zone.")

lookback_50 = input.int(20, title="RSI 50-Level Memory (bars)", tooltip="How many bars back RSI must have been on the correct side of 50.")

// Cooldown: how many bars RSI must stay on one side of 50 before resetting labels
cross_confirm_bars = input.int(3, title="RSI 50 Cross Confirmation Bars", tooltip="Prevents whipsaw resets. RSI must stay on one side of 50 for this many bars before a new cycle begins.")

// --- Volume Filter ---
use_volume_filter = input.bool(true,  title="Enable Volume Spike Filter",  group="Volume Filter")
volume_mult       = input.float(1.3,  title="Volume Spike Multiplier",      group="Volume Filter", step=0.1)
volume_lookback   = input.int(20,     title="Volume Average Length",         group="Volume Filter")

// --- Wick Rejection Filter ---
use_wick_filter = input.bool(true,  title="Enable Wick Rejection Filter", group="Wick Rejection")
wick_threshold  = input.float(0.6,  title="Wick Rejection Ratio",         group="Wick Rejection", step=0.05, tooltip="Ratio of rejection wick to total candle range. 0.6 = 60%.")

// --- SMA50 Proximity Filter ---
use_proximity = input.bool(true,  title="Enable SMA50 Proximity Filter", group="SMA Proximity")
proximity_pct = input.float(0.5,  title="Max Distance from SMA50 (%)",   group="SMA Proximity", step=0.1)

// --- Multi-Timeframe RSI ---
use_mtf      = input.bool(true,    title="Enable MTF RSI Confirmation",   group="Multi-Timeframe")
mtf_tf       = input.timeframe("15", title="HTF Timeframe",               group="Multi-Timeframe", tooltip="Set to one timeframe above your chart. E.g. '15' on 5min chart, '60' on 15min chart.")
htf_os_level = input.int(55, title="HTF RSI Max for Bottom Signals",      group="Multi-Timeframe", tooltip="HTF RSI must be below this value to confirm gold dot.")
htf_ob_level = input.int(45, title="HTF RSI Min for Top Signals",         group="Multi-Timeframe", tooltip="HTF RSI must be above this value to confirm pink dot.")

// ==========================================
// --- Core Calculations ---
// ==========================================
sma50   = ta.sma(close, sma50_length)
sma200  = ta.sma(close, sma200_length)
rsi_val = ta.rsi(close, rsi_length)

// --- Volume ---
avg_volume   = ta.sma(volume, volume_lookback)
volume_spike = volume > avg_volume * volume_mult

// --- Candle Geometry ---
candle_range = high - low
body_size    = math.abs(open - close)

// --- Wick Rejection ---
bullish_wick_rejection = candle_range > 0 and (close - low)  / candle_range > wick_threshold
bearish_wick_rejection = candle_range > 0 and (high - close) / candle_range > wick_threshold

// --- SMA50 Proximity ---
near_sma50 = math.abs(close - sma50) / sma50 * 100 < proximity_pct

// --- MTF RSI (non-repainting) ---
rsi_htf             = request.security(syminfo.tickerid, mtf_tf, ta.rsi(close, rsi_length), lookahead=barmerge.lookahead_off)
htf_confirms_bottom = rsi_htf < htf_os_level
htf_confirms_top    = rsi_htf > htf_ob_level

// --- Candlestick Patterns (corrected: prior candle direction verified) ---
is_doji              = candle_range > 0 and body_size <= candle_range * 0.1
is_bullish_engulfing = close > open and open[1] > close[1] and close > open[1] and open < close[1] and body_size > math.abs(open[1] - close[1])
is_bearish_engulfing = close < open and open[1] < close[1] and close < open[1] and open > close[1] and body_size > math.abs(open[1] - close[1])

// ==========================================
// --- RSI 50 Cooldown Reset (anti-whipsaw) ---
// ==========================================
var int bars_above_50 = 0
var int bars_below_50 = 0

bars_above_50 := rsi_val > 50 ? bars_above_50 + 1 : 0
bars_below_50 := rsi_val < 50 ? bars_below_50 + 1 : 0

// Only confirm a new cycle after RSI stays on one side for N bars
confirmed_bull_cycle = bars_below_50 >= cross_confirm_bars  // RSI settled below 50 → look for bottoms
confirmed_bear_cycle = bars_above_50 >= cross_confirm_bars  // RSI settled above 50 → look for tops

// ==========================================
// --- State Variables (Locked Historical Labels) ---
// ==========================================
var float current_gold_low  = na
var label current_gold_lbl  = na
var float current_pink_high = na
var label current_pink_lbl  = na

// Reset gold tracking when a confirmed bear cycle starts (RSI moved above 50 cleanly)
if confirmed_bear_cycle and not confirmed_bear_cycle[1]
    current_gold_low := na
    current_gold_lbl := na

// Reset pink tracking when a confirmed bull cycle starts (RSI moved below 50 cleanly)
if confirmed_bull_cycle and not confirmed_bull_cycle[1]
    current_pink_high := na
    current_pink_lbl  := na

// ==========================================
// --- RSI Zone Conditions (non-overlapping) ---
// ==========================================
rsi_hook_up   = rsi_val > rsi_val[1]
rsi_hook_down = rsi_val < rsi_val[1]

// OS zone: RSI 18–45 AND RSI has been below 50 for the lookback window
os_zone = rsi_val >= rsi_os_min and rsi_val <= rsi_os_max and ta.highest(rsi_val, lookback_50) < 50

// OB zone: RSI 55–85 AND RSI has been above 50 for the lookback window
ob_zone = rsi_val >= rsi_ob_min and rsi_val <= rsi_ob_max and ta.lowest(rsi_val, lookback_50) > 50

// ==========================================
// --- Composite Filter Gates ---
// ==========================================
vol_ok_bull  = not use_volume_filter or volume_spike
vol_ok_bear  = not use_volume_filter or volume_spike
wick_ok_bull = not use_wick_filter   or bullish_wick_rejection
wick_ok_bear = not use_wick_filter   or bearish_wick_rejection
prox_ok      = not use_proximity     or near_sma50
mtf_ok_bull  = not use_mtf           or htf_confirms_bottom
mtf_ok_bear  = not use_mtf           or htf_confirms_top

// ==========================================
// --- Historical Golden Dots (Bottoms) ---
// ==========================================
// Requires: OS zone + RSI hooking up + candle pattern + all active filters + confirmed bull cycle
gold_signal = os_zone and rsi_hook_up and (is_doji or is_bullish_engulfing) and vol_ok_bull and wick_ok_bull and prox_ok and mtf_ok_bull and confirmed_bull_cycle

if gold_signal
    if na(current_gold_low) or low < current_gold_low
        current_gold_low := low
        if not na(current_gold_lbl)
            label.set_xy(current_gold_lbl, bar_index, low)
        else
            current_gold_lbl := label.new(x=bar_index, y=low, text="", yloc=yloc.belowbar, color=color.yellow, style=label.style_circle, size=size.small)

// ==========================================
// --- Historical Pink Dots (Tops) ---
// ==========================================
// Requires: OB zone + RSI hooking down + candle pattern + all active filters + confirmed bear cycle
pink_signal = ob_zone and rsi_hook_down and (is_doji or is_bearish_engulfing) and vol_ok_bear and wick_ok_bear and prox_ok and mtf_ok_bear and confirmed_bear_cycle

if pink_signal
    if na(current_pink_high) or high > current_pink_high
        current_pink_high := high
        if not na(current_pink_lbl)
            label.set_xy(current_pink_lbl, bar_index, high)
        else
            current_pink_lbl := label.new(x=bar_index, y=high, text="", yloc=yloc.abovebar, color=color.rgb(255, 0, 255), style=label.style_circle, size=size.small)

// ==========================================
// --- Visuals & Ribbon ---
// ==========================================
p1 = plot(sma50,  color=color.blue, linewidth=2, title="Short SMA (Blue)")
p2 = plot(sma200, color=color.red,  linewidth=2, title="Long SMA (Red)")

fill(p1, p2,
     color = sma50 > sma200 ? color.new(color.green, 85) : color.new(color.red, 85),
     title = "Trend Ribbon")

// Re-entry signals
plotshape((sma50 > sma200) and ta.crossover(close,  math.min(sma50, sma200)),
          style=shape.circle, location=location.belowbar, color=color.green, size=size.tiny, title="Bullish Re-entry")
plotshape((sma50 < sma200) and ta.crossunder(close, math.max(sma50, sma200)),
          style=shape.circle, location=location.abovebar, color=color.red,   size=size.tiny, title="Bearish Re-entry")

// SMA Cross Labels
if ta.crossover(sma50, sma200)
    label.new(bar_index, na, "STRONG BUY",  yloc=yloc.abovebar, color=color.green, style=label.style_label_down, textcolor=color.white)
if ta.crossunder(sma50, sma200)
    label.new(bar_index, na, "STRONG SELL", yloc=yloc.abovebar, color=color.red,   style=label.style_label_down, textcolor=color.white)
