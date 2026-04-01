# INVEST MONGO AI Trading Bot

## Overview
Crypto trading platform using Precision v11 TradingView indicator signals
validated by Gemini AI, executing paper trades on Hyperliquid markets.

## Two signal tracks
- Track A: Chrome extension watches TradingView chart (while awake)
- Track B: Server runs indicator logic every 1 minute (24/7) — primary signal source
Both tracks send to same bot handler which deduplicates.

## Signal types from Precision v11
- yellow_dot: BUY — RSI oversold zone + bullish engulfing/doji + RSI hooking up + cooldown confirmed
- pink_dot: SELL — RSI overbought zone + bearish engulfing/doji + RSI hooking down + cooldown confirmed
- strong_buy: SMA50 crosses above SMA200 (golden cross) — Track A only
- strong_sell: SMA50 crosses below SMA200 (death cross) — Track A only

## Key parameters (match Pine Script v11 exactly)
- SMA lengths: 50 and 200
- RSI length: 14
- RSI overbought range: 55-85 (tightened from 40-85)
- RSI oversold range: 18-45 (tightened from 18-60)
- RSI 50-level memory (lookback): 20 bars (increased from 10)
- Cooldown confirm bars: 3 (anti-whipsaw — RSI must stay one side of 50 for 3 bars)
- Volume spike filter: 1.3× 20-bar average (toggleable)
- Wick rejection filter: 60% ratio (toggleable)
- SMA50 proximity filter: 0.5% max distance (toggleable)
- MTF RSI confirmation: 5m candles used as HTF when scanning 1m

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
