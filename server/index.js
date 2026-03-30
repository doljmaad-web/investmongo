import 'dotenv/config';
import express           from 'express';
import { createServer }  from 'http';
import { WebSocketServer } from 'ws';
import path              from 'path';
import { fileURLToPath } from 'url';
import cron              from 'node-cron';

import { handleSignal, runServerLoop } from './bot.js';

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason?.message || reason);
  console.error('[FATAL] Stack:', reason?.stack);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  console.error('[FATAL] Stack:', err.stack);
});
import { fetchAllNews, newsCache, fearGreed } from './news-scraper.js';
import { getPortfolioStats }           from './paper-trading.js';
import { getCurrentPrices, fetchCandles } from './hyperliquid.js';
import { db }                          from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app       = express();
const server    = createServer(app);
const wss       = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../dashboard')));

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

app.get('/api/news', async (req, res) => {
  try {
    const { news, fearGreed } = await fetchAllNews();
    res.json({ news: news.slice(0, 30), fearGreed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/snapshots', (req, res) => {
  const period = req.query.period || '1d';
  const limits = { '30m': 40, '1h': 60, '4h': 100, '1d': 288, '7d': 500, '30d': 500, '90d': 500, '180d': 500, '365d': 500 };
  const rows = db.prepare(
    'SELECT total_value, snapshot_at FROM portfolio_snapshots ORDER BY snapshot_at DESC LIMIT ?'
  ).all(limits[period] || 288).reverse();
  res.json({ snapshots: rows });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), time: new Date().toISOString() });
});

// Spatial Trade Planner — live BTC price for particle feed
app.get('/api/spatial/price', async (req, res) => {
  try {
    const prices = await getCurrentPrices(['BTC']);
    res.json({ price: prices['BTC'] || null, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Spatial Trade Planner — candle data for neon candlestick chart
app.get('/api/spatial/candles', async (req, res) => {
  try {
    const coin     = req.query.coin     || 'BTC';
    const interval = req.query.interval || '1d';
    // Support explicit year range: ?year=2026
    const year = parseInt(req.query.year);
    if (year && !isNaN(year)) {
      const startTime = new Date(year, 0, 1).getTime();          // Jan 1
      const endTime   = Math.min(new Date(year, 11, 31, 23, 59, 59).getTime(), Date.now());
      const HL_URL    = 'https://api.hyperliquid.xyz/info';
      const r = await fetch(HL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } }),
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

async function fetchXFeed() {
  const now = Date.now();

  // Serve stale cache during active rate-limit window (20 min)
  if (xFeedCache.items.length > 0 && xFeedCache.rateLimited && now - xFeedCache.cached_at < 20 * 60 * 1000) {
    console.log('[X-FEED] Serving stale cache during rate limit window');
    return xFeedCache.items;
  }

  try {
    const rawResults = await Promise.allSettled(
      X_MIRROR_SOURCES.map(async ({ channel, handle }) => {
        const url = `https://tg.i-c-a.su/rss/${channel}`;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(6000),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          },
        });
        if (res.status === 403) return { status: 403 };
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = await res.text();
        return parseItems(xml, handle);
      })
    );

    // Detect rate limiting
    const isRateLimited = rawResults.some(r =>
      r.status === 'fulfilled' && r.value?.status === 403
    );
    if (isRateLimited) {
      xFeedCache.rateLimited = true;
      console.log('[X-FEED] 403 detected — rate limited for ~15 min');
      return xFeedCache.items;
    }
    xFeedCache.rateLimited = false;

    const all = rawResults
      .filter(r => r.status === 'fulfilled' && Array.isArray(r.value))
      .flatMap(r => r.value)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 30);

    xFeedCache.items     = all;
    xFeedCache.cached_at = Date.now();
    return all;
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

// Serve dashboard for all other routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/index.html'));
});

// ============================================================
// CRON JOBS
// ============================================================

// Track B: Run indicator every 5 minutes
cron.schedule('*/5 * * * *', async () => {
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

// Update open trade P&L every 60 seconds
cron.schedule('* * * * *', async () => {
  try {
    const { updateOpenTrades } = await import('./paper-trading.js');
    const prices = await getCurrentPrices(['BTC','ETH','DOGE','XAU','HYPE']);
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
  setTimeout(async () => {
    try {
      console.log('[STARTUP] Running initial bot loop...');
      await runServerLoop(broadcast);
    } catch (e) {
      console.error('[STARTUP] Error:', e.message, e.stack);
    }
  }, 15000);
});
