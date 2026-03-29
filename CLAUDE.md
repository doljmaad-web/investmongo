# INVEST MONGO AI Trading Bot

## Overview
Crypto trading platform using Precision v9 TradingView indicator signals
validated by Gemini AI, executing paper trades on Hyperliquid markets.

## Two signal tracks
- Track A: Chrome extension watches TradingView chart (while awake)
- Track B: Server runs indicator logic every 5 minutes (24/7)
Both tracks send to same bot handler which deduplicates.

## Signal types from Precision v9
- yellow_dot: BUY — RSI oversold zone + bullish engulfing/doji + RSI hooking up
- pink_dot: SELL — RSI overbought zone + bearish engulfing/doji + RSI hooking down
- strong_buy: SMA50 crosses above SMA200 (golden cross)
- strong_sell: SMA50 crosses below SMA200 (death cross)

## Key parameters (match Pine Script exactly)
- SMA lengths: 50 and 200
- RSI length: 14
- RSI overbought range: 40-85
- RSI oversold range: 18-60
- RSI 50-level memory (lookback): 10 bars

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
