# INVEST MONGO AI Trading Bot

## Overview
Crypto trading platform using Precision v11 TradingView indicator signals
validated by Gemini AI, executing paper trades on Hyperliquid markets.

## Two signal tracks
- Track A: Chrome extension watches TradingView chart (while awake)
- Track B: Server scans 5m candles every 1 minute (24/7) — primary signal source
Both tracks send to same bot handler which deduplicates.

## Signal types from Precision v11
- yellow_dot: BUY — RSI 18-45 zone + bullish engulfing/doji + RSI hooking up + 3-bar cooldown
- pink_dot: SELL — RSI 55-85 zone + bearish engulfing/doji + RSI hooking down + 3-bar cooldown
- strong_buy: SMA50 crosses above SMA200 (golden cross) — Track A only
- strong_sell: SMA50 crosses below SMA200 (death cross) — Track A only

## Key parameters (Precision v11)
- Signal timeframe: 5m (sweet spot for crypto volatility capture)
- MTF confirmation: 15m candles fed as htfCandles to 5m scan
- Bias timeframe: 15m (determines counter-trend vs with-trend)
- SMA lengths: 50 and 200
- RSI length: 14, OB zone: 55-85, OS zone: 18-45
- RSI 50-level memory: 20 bars, cooldown confirm: 3 bars
- Volume spike filter: 1.3× 20-bar average (active)
- Wick/proximity filters: disabled for 5m (too restrictive on fast crypto TFs)

## Trade execution
- COUNTER-TREND (5m vs 15m bias): SL 0.5% | TP 3% fixed
- WITH-TREND (5m aligns with 15m): SL 1.5% | TP smart exit
- Dedup window: 15 minutes

## Smart exits (with-trend only, while in profit)
1. Bearish engulfing on 5m + RSI > 55 → close LONG
2. Bullish engulfing on 5m + RSI < 45 → close SHORT
3. 15m fires opposite dot (within 3 candles) → close either
4. ATR(14) × 1.5 trailing stop → activates once profit > 0.8%

## Assets monitored (Track B server loop)
BTC, ETH, DOGE, XAU, HYPE

## AI validation
Using Gemini 2.5 Flash (free tier)
Bot calls Gemini only when indicator fires a signal (~10-20 calls/day)
Gemini validates: news sentiment, macro risk, whale activity, funding rate

## Current mode
PAPER TRADING — all trades are simulated, no real money

## Database
SQLite at /data/invest_mongo.db (Fly.io) or ./invest_mongo.db (local)

## Stack
Node.js ESM, Express, better-sqlite3, ws, node-cron, rss-parser, dotenv
