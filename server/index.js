import 'dotenv/config';
import express           from 'express';
import { createServer }  from 'http';
import { WebSocketServer } from 'ws';
import path              from 'path';
import { fileURLToPath } from 'url';
import cron              from 'node-cron';

import { handleSignal, runServerLoop, getTradingAssets, addTradingAsset, setTradingAssetPct, removeTradingAsset, getTrendBias, setTrendBias } from './bot.js';
import userRoutes  from './user-routes.js';
import adminRoutes from './admin-routes.js';
import { adminMiddleware, authMiddleware, verifyJWT } from './auth.js';
import { scanAllDeposits, syncUserGains } from './wallet-manager.js';

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason?.message || reason);
  console.error('[FATAL] Stack:', reason?.stack);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  console.error('[FATAL] Stack:', err.stack);
});
process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] SIGTERM received — closing gracefully');
  server.close(() => {
    console.log('[SHUTDOWN] Server closed');
    process.exit(0);
  });
  // Force exit after 10s if server.close hangs
  setTimeout(() => process.exit(0), 10000).unref();
});
import { fetchAllNews, newsCache, fearGreed } from './news-scraper.js';
import { awardTokens, getBalance, getTransactions, runDailyRewards, getAirdropSnapshot } from './mongo-tokens.js';
import { setupNewsRoutes } from './news-routes.js';
import { chatWithGemini, getGeminiUsage } from './gemini.js';
import { getPortfolioStats, getAvailableCapital, closeTradeById, snapshotPortfolio } from './paper-trading.js';
import { getCurrentPrices, fetchCandles, getMarketData, hlCoin } from './hyperliquid.js';
import { fetchCandles as fetchCandlesOanda, getCurrentPrices as getCurrentPricesOanda, isOandaAsset } from './oanda.js';
import { calcRSI } from './indicator.js';
import { db }                          from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app       = express();
const server    = createServer(app);
const wss       = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../dashboard')));
app.use(userRoutes);
app.use(adminRoutes);
setupNewsRoutes(app);

// ============================================================
// WEBSOCKET — broadcast to all connected dashboard clients
// ============================================================
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    try {
      if (client.readyState === 1) client.send(msg);
    } catch (e) {
      console.error('[WS] Broadcast error:', e.message);
    }
  });
}

wss.on('connection', (ws) => {
  console.log('[WS] Dashboard client connected');

  try {
    const stats     = getPortfolioStats();
    const signals   = db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT 20').all();
    const news      = newsCache.slice(0, 25);
    const snapshots = db.prepare(
      'SELECT total_value, snapshot_at FROM portfolio_snapshots ORDER BY snapshot_at DESC LIMIT 100'
    ).all().reverse();

    ws.send(JSON.stringify({
      type: 'init',
      data: { stats, signals, news, fearGreed, snapshots },
    }));
  } catch (initErr) {
    console.error('[WS] Init send failed:', initErr.message);
    try {
      ws.send(JSON.stringify({
        type: 'init',
        data: { stats: {}, signals: [], news: [], fearGreed: { value: 50 }, snapshots: [] },
      }));
    } catch (e) {}
  }

  ws.on('error', (err) => console.error('[WS] Client error:', err.message));
  ws.on('close', ()  => console.log('[WS] Client disconnected'));
});

// ============================================================
// TRACK A: Webhook from Chrome extension
// ============================================================
app.post('/webhook/extension', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const signal = req.body;
  if (!signal.signal || !signal.asset || !signal.price) {
    return res.status(400).json({ error: 'Missing required fields: signal, asset, price' });
  }

  // Respond immediately — process async
  res.json({ ok: true, received: signal.signal, asset: signal.asset });

  handleSignal(signal, 'extension')
    .then(outcome => { if (outcome) broadcast({ type: 'new_signal', data: outcome }); })
    .catch(err => console.error('[WEBHOOK] Handle error:', err.message));
});

// ============================================================
// REST API for dashboard
// ============================================================
app.get('/api/portfolio', (req, res) => {
  try { res.json(getPortfolioStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/signals', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT ?').all(limit));
});

app.get('/api/trades', (req, res) => {
  const open   = db.prepare(`SELECT * FROM trades WHERE status='OPEN' AND mode='PAPER' ORDER BY opened_at DESC`).all();
  const closed = db.prepare(`SELECT * FROM trades WHERE mode='PAPER' AND status IN ('CLOSED','STOPPED') ORDER BY closed_at DESC LIMIT 30`).all();
  res.json({ open, closed });
});

// POST /api/trades/close/:id  → admin: close a single open paper position by trade ID
app.post('/api/trades/close/:id', async (req, res) => {
  try {
    const tradeId = parseInt(req.params.id, 10);
    if (isNaN(tradeId)) return res.status(400).json({ error: 'Invalid trade ID' });

    const trade = db.prepare(`SELECT * FROM trades WHERE id=? AND status='OPEN' AND mode='PAPER'`).get(tradeId);
    if (!trade) return res.status(404).json({ error: 'Trade not found or already closed' });

    const { getCurrentPrices } = await import('./hyperliquid.js');
    const prices = await getCurrentPrices([trade.asset]);
    const exitPrice = prices[trade.asset];
    if (!exitPrice) return res.status(503).json({ error: `No price available for ${trade.asset}` });

    closeTradeById(trade.id, exitPrice);
    console.log(`[ADMIN] Force-closed trade #${trade.id} ${trade.asset} ${trade.direction} @ $${exitPrice}`);
    broadcast({ type: 'portfolio_update' });
    res.json({ closed: 1, tradeId: trade.id, exitPrice });
  } catch (e) {
    console.error('[ADMIN] close-by-id error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/trades/close-all  → admin: close every open paper position at current market price
app.post('/api/trades/close-all', async (req, res) => {
  try {
    const open = db.prepare(`SELECT * FROM trades WHERE status='OPEN' AND mode='PAPER'`).all();
    if (open.length === 0) return res.json({ closed: 0, message: 'No open positions' });

    const { getCurrentPrices } = await import('./hyperliquid.js');
    const coins  = [...new Set(open.map(t => t.asset))];
    const prices = await getCurrentPrices(coins);

    let closedCount = 0;
    for (const t of open) {
      const exitPrice = prices[t.asset];
      if (!exitPrice) {
        console.warn(`[ADMIN] No price for ${t.asset}, skipping close`);
        continue;
      }
      closeTradeById(t.id, exitPrice);
      console.log(`[ADMIN] Force-closed trade #${t.id} ${t.asset} ${t.direction} @ $${exitPrice}`);
      closedCount++;
    }

    broadcast({ type: 'portfolio_update' });
    res.json({ closed: closedCount, total: open.length });
  } catch (e) {
    console.error('[ADMIN] close-all error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/news', async (req, res) => {
  try {
    const { news, fearGreed } = await fetchAllNews();
    res.json({ news: news.slice(0, 30), fearGreed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/snapshots', (req, res) => {
  const period = req.query.period || '1d';
  const periodMs = {
    '30m': 30*60*1000, '1h': 60*60*1000, '4h': 4*60*60*1000,
    '1d': 24*60*60*1000, '7d': 7*24*60*60*1000, '30d': 30*24*60*60*1000,
    '90d': 90*24*60*60*1000, '180d': 180*24*60*60*1000, '365d': 365*24*60*60*1000,
  };
  const cutoff = new Date(Date.now() - (periodMs[period] || periodMs['1d'])).toISOString();
  const rows = db.prepare(
    'SELECT total_value, snapshot_at FROM portfolio_snapshots WHERE snapshot_at >= ? ORDER BY snapshot_at ASC'
  ).all(cutoff);
  res.json({ snapshots: rows });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), time: new Date().toISOString() });
});

// Diagnostic — shows which auth env vars are present (values hidden)
app.get('/api/env-check', (req, res) => {
  res.json({
    GOOGLE_CLIENT_ID:     !!process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: !!process.env.GOOGLE_CLIENT_SECRET,
    GITHUB_CLIENT_ID:     !!process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: !!process.env.GITHUB_CLIENT_SECRET,
    ADMIN_GITHUB_USERNAME:!!process.env.ADMIN_GITHUB_USERNAME,
    JWT_SECRET:           !!process.env.JWT_SECRET,
    MASTER_MNEMONIC:      !!process.env.MASTER_MNEMONIC,
    ARBITRUM_RPC:         !!process.env.ARBITRUM_RPC,
  });
});

app.get('/api/capital', (req, res) => {
  const stats     = getPortfolioStats();
  const available = getAvailableCapital();
  const deployed  = parseFloat((stats.totalValue - available).toFixed(2));
  res.json({ totalValue: stats.totalValue, available, deployed });
});

// ── Trading asset management ────────────────────────────────
// GET  /api/trading/assets            → { assets: [{ asset, deploy_pct }] }
// POST /api/trading/assets            → activate/deactivate + set deploy_pct
//   body: { asset, active, deploy_pct }
app.get('/api/trading/assets', (req, res) => {
  res.json({ assets: getTradingAssets() });
});

app.post('/api/trading/assets', (req, res) => {
  const { asset, active, deploy_pct } = req.body;
  if (!asset || typeof asset !== 'string') return res.status(400).json({ error: 'asset required' });
  if (active) {
    addTradingAsset(asset, deploy_pct ?? 50);
    if (deploy_pct != null) setTradingAssetPct(asset, deploy_pct);
  } else {
    removeTradingAsset(asset);
  }
  res.json({ assets: getTradingAssets() });
});

// GET /api/trend-bias   → returns current admin trend bias
// POST /api/trend-bias  → sets trend bias { bias: 'neutral'|'long'|'short' }
app.get('/api/trend-bias', (req, res) => {
  res.json({ bias: getTrendBias() });
});

app.post('/api/trend-bias', adminMiddleware, (req, res) => {
  const { bias } = req.body;
  if (!['neutral','long','short'].includes(bias)) return res.status(400).json({ error: 'invalid bias' });
  setTrendBias(bias);
  // Broadcast new bias to all dashboard clients
  broadcast({ type: 'trend_bias', data: { bias } });
  res.json({ bias });
});

// ============================================================
// GEMINI CHAT — conversational assistant with portfolio context
// ============================================================
let geminiChatHistory = [];
let lastChatAt = 0;
const CHAT_RATE_MS = 5000; // min 5s between chat calls

app.get('/api/gemini-usage', (req, res) => {
  res.json(getGeminiUsage());
});

app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message required' });
  }
  const now = Date.now();
  if (now - lastChatAt < CHAT_RATE_MS) {
    return res.status(429).json({ error: `Please wait ${Math.ceil((CHAT_RATE_MS - (now - lastChatAt)) / 1000)}s before sending another message.` });
  }
  lastChatAt = now;
  try {
    const stats         = getPortfolioStats();
    const recentSignals = db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT 5').all();
    const topNews       = newsCache.slice(0, 5);
    const context       = { ...stats, fearGreed, recentSignals, topNews };

    const { reply, updatedHistory } = await chatWithGemini(message.trim(), context, geminiChatHistory);
    geminiChatHistory = updatedHistory;
    res.json({ reply });
  } catch (err) {
    console.error('[CHAT] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Twelve Data raw debug — returns the direct API response for diagnosis
app.get('/api/debug/twelvedata', async (req, res) => {
  const symbol = req.query.symbol || 'XAG/USD';
  const key    = process.env.TWELVEDATA_API_KEY;
  if (!key) return res.json({ error: 'TWELVEDATA_API_KEY not set' });
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=30min&outputsize=3&apikey=${key}`;
    const r   = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const raw = await r.json();
    res.json({ httpStatus: r.status, url: url.replace(key, 'KEY_HIDDEN'), raw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Spatial Trade Planner — live price for any coin
app.get('/api/spatial/price', async (req, res) => {
  try {
    const coin   = (req.query.coin || 'BTC').toUpperCase();
    const prices = isOandaAsset(coin)
      ? await getCurrentPricesOanda([coin])
      : await getCurrentPrices([coin]);
    res.json({ price: prices[coin] || null, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Spatial Trade Planner — candle data for neon candlestick chart
app.get('/api/spatial/candles', async (req, res) => {
  try {
    const coin     = (req.query.coin || 'BTC').toUpperCase();
    const interval = req.query.interval || '1d';

    // OANDA assets: always use OANDA fetch (no year-range support)
    if (isOandaAsset(coin)) {
      const bars    = Math.min(parseInt(req.query.bars) || 200, 500);
      const candles = await fetchCandlesOanda(coin, interval, bars);
      return res.json({ candles, ts: Date.now(), interval });
    }

    // Support explicit year range: ?year=2026
    const year = parseInt(req.query.year);
    if (year && !isNaN(year)) {
      const startTime = new Date(year, 0, 1).getTime();          // Jan 1
      const endTime   = Math.min(new Date(year, 11, 31, 23, 59, 59).getTime(), Date.now());
      const HL_URL    = 'https://api.hyperliquid.xyz/info';
      const r = await fetch(HL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'candleSnapshot', req: { coin: hlCoin(coin), interval, startTime, endTime } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`HL ${r.status}`);
      const raw = await r.json();
      const candles = raw.map(c => ({
        time: c.t, open: parseFloat(c.o), high: parseFloat(c.h),
        low: parseFloat(c.l), close: parseFloat(c.c), volume: parseFloat(c.v),
      }));
      return res.json({ candles, ts: Date.now(), year, interval });
    }
    // Fallback: bars-based fetch
    const bars    = Math.min(parseInt(req.query.bars) || 200, 500);
    const candles = await fetchCandles(coin, interval, bars);
    res.json({ candles, ts: Date.now(), interval });
  } catch (e) {
    res.status(500).json({ error: e.message, candles: [] });
  }
});

// ── Drawing annotations (Spatial Trade Planner) ───────────
app.get('/api/drawings', (req, res) => {
  const coin     = (req.query.coin || 'BTC').toUpperCase();
  const interval = req.query.interval || '5m';
  try {
    const rows = db.prepare('SELECT id, type, data FROM drawings WHERE coin=? AND interval=? ORDER BY id ASC').all(coin, interval);
    res.json(rows.map(r => ({ id: r.id, type: r.type, ...JSON.parse(r.data) })));
  } catch (e) { res.json([]); }
});

app.post('/api/drawings', (req, res) => {
  const { coin, interval, type, data } = req.body || {};
  if (!coin || !type) return res.status(400).json({ error: 'missing fields' });
  try {
    const info = db.prepare('INSERT INTO drawings (coin, interval, type, data) VALUES (?,?,?,?)').run(
      coin.toUpperCase(), interval || '5m', type, JSON.stringify(data || {})
    );
    res.json({ id: info.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/drawings/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM drawings WHERE id=?').run(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// X INTELLIGENCE FEED — Telegram mirrors via tg.i-c-a.su proxy
// ============================================================
const X_MIRROR_SOURCES = [
  { channel: 'MarioNawfal',     handle: '@MarioNawfal'     },
  { channel: 'coinbureau',      handle: '@coinbureau'      },
  { channel: 'MMCryptoTA',      handle: '@MMCrypto'        },
  { channel: 'spectatorindex',  handle: '@spectatorindex'  },
  { channel: 'RoundtableSpace', handle: '@RoundtableSpace' },
  { channel: 'MyLordBebo',      handle: '@MyLordBebo'      },
  { channel: 'cryptohayes',     handle: '@CryptoHayes'     },
];

const X_CACHE_TTL = 3 * 60 * 1000; // 3 minutes
const xFeedCache  = { items: [], cached_at: 0, rateLimited: false };

function cleanText(raw) {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseItems(xml, handle) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block   = m[1];
    const titleM  = /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/.exec(block);
    const dateM   = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block);
    const linkM   = /<link>([\s\S]*?)<\/link>/.exec(block);
    const rawText = titleM ? (titleM[1] ?? titleM[2] ?? '') : '';
    const text    = cleanText(rawText);
    if (!text) continue;
    const pubDate   = dateM ? dateM[1].trim() : '';
    const timestamp = pubDate ? Date.parse(pubDate) : 0;
    items.push({ handle, text, time: pubDate, timestamp, link: linkM ? linkM[1].trim() : '' });
  }
  return items;
}

// Two RSS providers — tg.i-c-a.su primary, rsshub.app fallback
const RSS_PROVIDERS = [
  (channel) => `https://tg.i-c-a.su/rss/${channel}`,
  (channel) => `https://rsshub.app/telegram/channel/${channel}`,
];

async function fetchChannelWithFallback(channel, handle) {
  for (const makeUrl of RSS_PROVIDERS) {
    try {
      const url = makeUrl(channel);
      const res = await fetch(url, {
        signal: AbortSignal.timeout(6000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        },
      });
      if (res.status === 403 || res.status === 429) continue; // try next provider
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const items = parseItems(xml, handle);
      if (items.length > 0) return items;
    } catch (e) {
      // try next provider
    }
  }
  return [];
}

async function fetchXFeed() {
  const now = Date.now();

  // Serve stale cache if fresh enough
  if (xFeedCache.items.length > 0 && now - xFeedCache.cached_at < X_CACHE_TTL) {
    return xFeedCache.items;
  }

  try {
    const rawResults = await Promise.allSettled(
      X_MIRROR_SOURCES.map(({ channel, handle }) => fetchChannelWithFallback(channel, handle))
    );

    const all = rawResults
      .filter(r => r.status === 'fulfilled' && Array.isArray(r.value))
      .flatMap(r => r.value)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 30);

    if (all.length > 0) {
      xFeedCache.items     = all;
      xFeedCache.cached_at = Date.now();
      xFeedCache.rateLimited = false;
      console.log(`[X-FEED] Fetched ${all.length} posts`);
    } else {
      console.warn('[X-FEED] All providers returned empty — serving stale cache');
    }

    return xFeedCache.items;
  } catch (err) {
    console.error('[X-FEED] fetchXFeed error:', err.message);
    return xFeedCache.items;
  }
}

app.get('/api/x-feed/debug', async (req, res) => {
  const url = 'https://tg.i-c-a.su/rss/coinbureau';
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    const text = await r.text();
    res.json({ status: r.status, ok: r.ok, length: text.length, preview: text.slice(0, 500) });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/api/x-feed', async (req, res) => {
  try {
    if (xFeedCache.items.length > 0 && Date.now() - xFeedCache.cached_at < X_CACHE_TTL) {
      return res.json({ items: xFeedCache.items, cached_at: xFeedCache.cached_at });
    }
    const items = await fetchXFeed();
    res.json({ items, cached_at: Date.now() });
  } catch (err) {
    console.error('[X-FEED] Route error:', err.message);
    res.json({ items: [], cached_at: Date.now() });
  }
});

// ============================================================
// MARKET SCREENER API
// ============================================================
let screenerCache = { data: null, at: 0 };
const SCREENER_TTL = 60_000;

app.get('/api/screener/market', async (req, res) => {
  try {
    if (screenerCache.data && Date.now() - screenerCache.at < SCREENER_TTL) {
      return res.json(screenerCache.data);
    }

    const trackedRows  = getTradingAssets();
    const trackedNames = trackedRows.map(r => r.asset);

    const marketData = await getMarketData();

    // Compute RSI for each tracked asset (30m candles, parallel)
    const rsiMap = {};
    await Promise.all(trackedNames.map(async (asset) => {
      try {
        const candles = await fetchCandles(asset, '30m', 60);
        if (candles && candles.length >= 20) {
          const closes = candles.map(c => c.close);
          rsiMap[asset] = calcRSI(closes, 14);
        }
      } catch (_) {}
    }));

    // Open positions
    const openTrades = db.prepare(
      `SELECT asset, direction FROM trades WHERE status='OPEN' AND mode='PAPER'`
    ).all();
    const positionMap = {};
    for (const t of openTrades) positionMap[t.asset] = t.direction;

    // Build tracked section with full data
    const tracked = trackedNames.map(name => {
      const m = marketData.find(a => a.asset === name) || {};
      return { asset: name, ...m, rsi: rsiMap[name] ?? null, position: positionMap[name] ?? null };
    });

    // Top 30 by OI for the full funding/OI table
    const topByOI = [...marketData]
      .sort((a, b) => b.openInterest - a.openInterest)
      .slice(0, 30);

    const result = { tracked, topByOI, updatedAt: Date.now() };
    screenerCache = { data: result, at: Date.now() };
    res.json(result);
  } catch (err) {
    console.error('[SCREENER]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/screener/performance', (req, res) => {
  try {
    const overall = db.prepare(`
      SELECT
        COUNT(*)                                                AS total,
        SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END)          AS wins,
        SUM(CASE WHEN pnl_usd <= 0 THEN 1 ELSE 0 END)          AS losses,
        ROUND(SUM(pnl_usd),  2)                                AS total_pnl,
        ROUND(AVG(pnl_pct),  2)                                AS avg_pnl_pct,
        ROUND(MAX(pnl_pct),  2)                                AS best_pct,
        ROUND(MIN(pnl_pct),  2)                                AS worst_pct,
        ROUND(AVG(CASE WHEN pnl_usd > 0 THEN pnl_pct END), 2) AS avg_win_pct,
        ROUND(AVG(CASE WHEN pnl_usd <= 0 THEN pnl_pct END), 2) AS avg_loss_pct
      FROM trades WHERE status='CLOSED' AND mode='PAPER'
    `).get();

    const byAsset = db.prepare(`
      SELECT asset,
        COUNT(*)                                              AS total,
        SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END)        AS wins,
        ROUND(SUM(pnl_usd), 2)                               AS pnl,
        ROUND(AVG(pnl_pct), 2)                               AS avg_pct
      FROM trades WHERE status='CLOSED' AND mode='PAPER'
      GROUP BY asset ORDER BY pnl DESC
    `).all();

    const recent = db.prepare(`
      SELECT asset, direction, entry_price, exit_price, pnl_usd, pnl_pct, opened_at, closed_at
      FROM trades WHERE status='CLOSED' AND mode='PAPER'
      ORDER BY closed_at DESC LIMIT 15
    `).all();

    const open = db.prepare(`
      SELECT asset, direction, entry_price, stop_loss, pnl_usd, pnl_pct, opened_at
      FROM trades WHERE status='OPEN' AND mode='PAPER'
      ORDER BY opened_at DESC
    `).all();

    res.json({ overall, byAsset, recent, open });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Portfolio, admin and auth pages
app.get('/portfolio', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/portfolio.html')));
app.get('/admin',     (req, res) => res.sendFile(path.join(__dirname, '../dashboard/admin.html')));
app.get('/auth',      (req, res) => res.sendFile(path.join(__dirname, '../dashboard/auth.html')));
app.get('/screener',  (req, res) => res.sendFile(path.join(__dirname, '../dashboard/screener.html')));
app.get('/community', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/community.html')));

// ── Community API ────────────────────────────────────────────

// GET /api/community/posts — list posts newest first, with user info + like status
app.get('/api/community/posts', (req, res) => {
  try {
    const header = req.headers['authorization'] || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    const me = token ? verifyJWT(token) : null;
    const meId = me?.id || null;

    const stmtPosts = db.prepare(`
      SELECT p.*, u.name AS author_name, u.avatar AS author_avatar,
             u.is_admin AS author_is_admin,
             COALESCE(u.handle, '') AS author_handle,
             COALESCE(u.tier, 'flexible') AS author_tier,
             COALESCE(u.lock_months, 0) AS author_lock_months
      FROM community_posts p
      JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC LIMIT 100
    `);
    const stmtLiked    = db.prepare(`SELECT 1 AS hit FROM community_likes WHERE post_id=? AND user_id=?`);
    const stmtFollowing = db.prepare(`SELECT 1 AS hit FROM community_follows WHERE follower_id=? AND following_id=?`);
    const stmtComments = db.prepare(`
      SELECT c.id, c.content, c.created_at, u.name AS author_name,
             u.avatar AS author_avatar, COALESCE(u.handle, '') AS author_handle,
             COALESCE(u.tier, 'flexible') AS author_tier,
             COALESCE(u.lock_months, 0) AS author_lock_months
      FROM community_comments c JOIN users u ON u.id = c.user_id
      WHERE c.post_id=? ORDER BY c.created_at ASC
    `);

    const stmtFollowers  = db.prepare(`SELECT COUNT(*) AS n FROM community_follows WHERE following_id=?`);
    const stmtFollowings = db.prepare(`SELECT COUNT(*) AS n FROM community_follows WHERE follower_id=?`);

    const posts  = stmtPosts.all();
    const result = posts.map(post => ({
      ...post,
      liked:     meId ? !!stmtLiked.get(post.id, meId) : false,
      following: meId ? !!stmtFollowing.get(meId, post.user_id) : false,
      followers: stmtFollowers.get(post.user_id)?.n || 0,
      comments:  stmtComments.all(post.id),
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/community/posts — create post (auth required)
app.post('/api/community/posts', authMiddleware, (req, res) => {
  try {
    const { content, ticker, image, link } = req.body;
    if (!content?.trim() && !image) return res.status(400).json({ error: 'Content required' });
    if (image && image.length > 500000) return res.status(400).json({ error: 'Image too large' });
    const cleanLink = link?.trim() ? link.trim() : null;
    const r = db.prepare(`INSERT INTO community_posts (user_id, content, ticker, image, link) VALUES (?,?,?,?,?)`)
      .run(req.user.id, (content||'').trim(), ticker?.trim() || null, image || null, cleanLink);
    const post = db.prepare(`
      SELECT p.*, u.name AS author_name, u.avatar AS author_avatar, u.is_admin AS author_is_admin,
             COALESCE(u.handle,'') AS author_handle,
             COALESCE(u.tier,'flexible') AS author_tier, COALESCE(u.lock_months,0) AS author_lock_months
      FROM community_posts p JOIN users u ON u.id=p.user_id WHERE p.id=?`).get(r.lastInsertRowid);
    awardTokens(req.user.id, 2, 'community_post', 'Posted in community');
    broadcast({ type: 'community_post', data: { ...post, liked: false, following: false, followers: 0, comments: [] } });
    res.json({ ...post, liked: false, following: false, followers: 0, comments: [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/community/posts/:id/like — toggle like
app.post('/api/community/posts/:id/like', authMiddleware, (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const userId = req.user.id;
    const existing = db.prepare(`SELECT 1 FROM community_likes WHERE post_id=? AND user_id=?`).get(postId, userId);
    if (existing) {
      db.prepare(`DELETE FROM community_likes WHERE post_id=? AND user_id=?`).run(postId, userId);
      db.prepare(`UPDATE community_posts SET likes_count = MAX(0, likes_count-1) WHERE id=?`).run(postId);
    } else {
      db.prepare(`INSERT OR IGNORE INTO community_likes (post_id, user_id) VALUES (?,?)`).run(postId, userId);
      db.prepare(`UPDATE community_posts SET likes_count = likes_count+1 WHERE id=?`).run(postId);
    }
    const updatedPost = db.prepare(`SELECT likes_count, user_id FROM community_posts WHERE id=?`).get(postId);
    // Award 5 MONGO to post author on every 10th like milestone
    if (!existing && updatedPost.likes_count > 0 && updatedPost.likes_count % 10 === 0) {
      awardTokens(updatedPost.user_id, 5, 'like_milestone', `Post #${postId} reached ${updatedPost.likes_count} likes`);
    }
    res.json({ liked: !existing, likes_count: updatedPost.likes_count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/community/posts/:id/comments — add comment
app.post('/api/community/posts/:id/comments', authMiddleware, (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
    const r = db.prepare(`INSERT INTO community_comments (post_id, user_id, content) VALUES (?,?,?)`).run(postId, req.user.id, content.trim());
    db.prepare(`UPDATE community_posts SET comments_count = comments_count+1 WHERE id=?`).run(postId);
    const comment = db.prepare(`SELECT c.*, u.name AS author_name, u.avatar AS author_avatar, COALESCE(u.handle,'') AS author_handle FROM community_comments c JOIN users u ON u.id=c.user_id WHERE c.id=?`).get(r.lastInsertRowid);
    res.json(comment);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/community/posts/:id — delete own post or admin
app.delete('/api/community/posts/:id', authMiddleware, (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const post = db.prepare(`SELECT user_id FROM community_posts WHERE id=?`).get(postId);
    if (!post) return res.status(404).json({ error: 'Not found' });
    if (post.user_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Forbidden' });
    db.prepare(`DELETE FROM community_likes WHERE post_id=?`).run(postId);
    db.prepare(`DELETE FROM community_comments WHERE post_id=?`).run(postId);
    db.prepare(`DELETE FROM community_posts WHERE id=?`).run(postId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/community/follow/:id — follow or unfollow a user
app.post('/api/community/follow/:id', authMiddleware, (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const meId = req.user.id;
    if (targetId === meId) return res.status(400).json({ error: 'Cannot follow yourself' });
    const existing = db.prepare(`SELECT 1 FROM community_follows WHERE follower_id=? AND following_id=?`).get(meId, targetId);
    if (existing) {
      db.prepare(`DELETE FROM community_follows WHERE follower_id=? AND following_id=?`).run(meId, targetId);
    } else {
      db.prepare(`INSERT OR IGNORE INTO community_follows (follower_id, following_id) VALUES (?,?)`).run(meId, targetId);
    }
    const followers  = db.prepare(`SELECT COUNT(*) AS n FROM community_follows WHERE following_id=?`).get(targetId)?.n || 0;
    const following  = !existing;
    res.json({ following, followers });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/community/me/counts — follower/following counts for logged-in user
app.get('/api/community/me/counts', authMiddleware, (req, res) => {
  try {
    const followers  = db.prepare(`SELECT COUNT(*) AS n FROM community_follows WHERE following_id=?`).get(req.user.id)?.n || 0;
    const followings = db.prepare(`SELECT COUNT(*) AS n FROM community_follows WHERE follower_id=?`).get(req.user.id)?.n || 0;
    const posts      = db.prepare(`SELECT COUNT(*) AS n FROM community_posts WHERE user_id=?`).get(req.user.id)?.n || 0;
    res.json({ followers, following: followings, posts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/community/sidebar — live market data + community stats for right panel
app.get('/api/community/sidebar', async (req, res) => {
  try {
    const market = await getMarketData();

    // Top 5 by 24h volume
    const byVolume = [...market]
      .sort((a, b) => b.dayVolume - a.dayVolume)
      .slice(0, 5)
      .map(a => ({ asset: a.asset, price: a.markPx, change24h: a.change24h, volume: a.dayVolume, oi: a.openInterest, funding: a.funding8h }));

    // Top 5 gainers
    const gainers = [...market]
      .filter(a => a.change24h > 0)
      .sort((a, b) => b.change24h - a.change24h)
      .slice(0, 5)
      .map(a => ({ asset: a.asset, price: a.markPx, change24h: a.change24h }));

    // Top 5 losers
    const losers = [...market]
      .filter(a => a.change24h < 0)
      .sort((a, b) => a.change24h - b.change24h)
      .slice(0, 5)
      .map(a => ({ asset: a.asset, price: a.markPx, change24h: a.change24h }));

    // Community stats
    const totalPosts   = db.prepare(`SELECT COUNT(*) AS n FROM community_posts`).get()?.n || 0;
    const totalMembers = db.prepare(`SELECT COUNT(*) AS n FROM users`).get()?.n || 0;
    const todayPosts   = db.prepare(`SELECT COUNT(*) AS n FROM community_posts WHERE DATE(created_at)=DATE('now')`).get()?.n || 0;
    const totalLikes   = db.prepare(`SELECT COUNT(*) AS n FROM community_likes`).get()?.n || 0;

    res.json({ byVolume, gainers, losers, stats: { totalPosts, totalMembers, todayPosts, totalLikes }, fearGreed: fearGreed || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── MONGO Token API ──────────────────────────────────────────

// GET /api/tokens/balance — user's own balance + recent transactions
app.get('/api/tokens/balance', authMiddleware, (req, res) => {
  try {
    const balance = getBalance(req.user.id);
    const transactions = getTransactions(req.user.id, 30);
    // Calculate earning rate
    const user = db.prepare(`SELECT COALESCE(tier,'flexible') AS tier, COALESCE(lock_months,0) AS lock_months FROM users WHERE id=?`).get(req.user.id);
    const ub   = db.prepare(`SELECT COALESCE(visible_balance_usd,0) AS bal FROM user_balances WHERE user_id=?`).get(req.user.id);
    const multiplierMap = { 0:1, 3:2, 6:4, 12:8 };
    const mult = user.tier === 'locked' ? (multiplierMap[user.lock_months] || 1) : 1;
    const dailyRate = ub ? parseFloat(((ub.bal / 100) * mult).toFixed(2)) : 0;
    res.json({ balance: parseFloat(balance.toFixed(2)), dailyRate, multiplier: mult, transactions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/tokens/snapshot — admin only, airdrop export
app.get('/api/tokens/snapshot', adminMiddleware, (req, res) => {
  try {
    const snapshot = getAirdropSnapshot();
    res.json(snapshot);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Serve dashboard for all other routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/index.html'));
});

// ============================================================
// CRON JOBS
// ============================================================

// Scan deposits every 2 minutes
cron.schedule('*/2 * * * *', () => scanAllDeposits().catch(console.error));

// Sync user gains daily at 00:05
cron.schedule('5 0 * * *', () => syncUserGains().catch(console.error));

// MONGO token daily rewards at 00:10 every day
cron.schedule('10 0 * * *', () => {
  try { runDailyRewards(); } catch (e) { console.error('[MONGO] Cron error:', e.message); }
});

// Track B: Run indicator every minute (Precision v11 — 1m signals)
cron.schedule('* * * * *', async () => {
  try {
    await runServerLoop(broadcast);
  } catch (err) {
    console.error('[CRON] Loop error:', err.message, err.stack);
  }
});

// Refresh news feed every 10 minutes
cron.schedule('*/10 * * * *', async () => {
  try {
    const { news, fearGreed } = await fetchAllNews(true);
    broadcast({ type: 'news_update', data: { news: news.slice(0, 25), fearGreed } });
  } catch (err) {
    console.error('[CRON] News error:', err.message);
  }
});

// Portfolio snapshot every 5 minutes — ensures short-period chart views (30m, 1h) always have data
cron.schedule('*/5 * * * *', () => {
  try { snapshotPortfolio(); } catch (e) { /* silent */ }
});

// Update open trade P&L every 60 seconds
cron.schedule('* * * * *', async () => {
  try {
    const { updateOpenTrades } = await import('./paper-trading.js');
    const prices = await getCurrentPrices(getTradingAssets().map(r => r.asset));
    updateOpenTrades(prices);
    const stats = getPortfolioStats();
    try {
      const freshSnaps = db.prepare(
        'SELECT total_value, snapshot_at FROM portfolio_snapshots ORDER BY snapshot_at DESC LIMIT 100'
      ).all().reverse();
      broadcast({ type: 'portfolio_update', data: { ...stats, snapshots: freshSnaps } });
    } catch (snapErr) {
      console.error('[BROADCAST] Snapshot fetch failed:', snapErr.message);
      broadcast({ type: 'portfolio_update', data: stats });
    }
  } catch (err) {
    console.error('[CRON] P&L update error:', err.message);
  }
});

// ============================================================
// START SERVER
// ============================================================
const PORT = parseInt(process.env.PORT) || 3000;
server.listen(PORT, async () => {
  console.log(`\n🚀 INVEST MONGO Bot running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🤖 AI Engine: Gemini 2.5 Flash (free tier)`);
  console.log(`📰 News: RSS feeds active`);
  console.log(`📄 Mode: PAPER TRADING\n`);

  // Warm up on start
  await fetchAllNews(true).catch(console.error);

  // Test Twelve Data connectivity on startup
  setTimeout(async () => {
    try {
      const key = process.env.TWELVEDATA_API_KEY;
      if (!key) { console.log('[TWELVEDATA] ⚠️  TWELVEDATA_API_KEY not set — SILVER/OIL charts disabled'); return; }
      const r = await fetch(`https://api.twelvedata.com/time_series?symbol=XAG/USD&interval=30min&outputsize=2&apikey=${key}`, { signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      if (d.status === 'error') console.log(`[TWELVEDATA] ❌ API error: ${d.message}`);
      else console.log(`[TWELVEDATA] ✅ Connected — XAG/USD latest close: ${d.values?.[0]?.close}`);
    } catch (e) { console.log(`[TWELVEDATA] ❌ Connection failed: ${e.message}`); }
  }, 5000);

  setTimeout(async () => {
    try {
      console.log('[STARTUP] Running initial bot loop...');
      await runServerLoop(broadcast);
    } catch (e) {
      console.error('[STARTUP] Error:', e.message, e.stack);
    }
  }, 15000);
});
