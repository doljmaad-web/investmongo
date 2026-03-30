import 'dotenv/config';
import express           from 'express';
import { createServer }  from 'http';
import { WebSocketServer } from 'ws';
import path              from 'path';
import { fileURLToPath } from 'url';
import cron              from 'node-cron';

import { handleSignal, runServerLoop } from './bot.js';
import { fetchAllNews } from './news-scraper.js';
import { getPortfolioStats }           from './paper-trading.js';
import { getCurrentPrices }            from './hyperliquid.js';
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
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

wss.on('connection', async ws => {
  console.log('[WS] Dashboard client connected');

  try {
    const stats   = getPortfolioStats();
    const { news, fearGreed } = await fetchAllNews();
    const signals = db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT 30').all();
    const snapshots = db.prepare(
      'SELECT total_value, snapshot_at FROM portfolio_snapshots ORDER BY snapshot_at DESC LIMIT 50'
    ).all().reverse();

    ws.send(JSON.stringify({
      type: 'init',
      data: { stats, news: news.slice(0, 25), signals, fearGreed, snapshots },
    }));
  } catch (err) {
    console.error('[WS] Init error:', err.message);
  }

  ws.on('error', e => console.error('[WS] Error:', e.message));
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
  const snaps = db.prepare(
    'SELECT total_value, snapshot_at FROM portfolio_snapshots ORDER BY snapshot_at DESC LIMIT 100'
  ).all().reverse();
  res.json(snaps);
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), time: new Date().toISOString() });
});

// ============================================================
// X INTELLIGENCE FEED — Telegram mirrors via tg.i-c-a.su proxy
// ============================================================
const X_MIRROR_SOURCES = [
  { channel: 'marionawfal',     handle: '@MarioNawfal'     },
  { channel: 'arthurhayescio',  handle: '@CryptoHayes'     },
  { channel: 'coinbureau',      handle: '@coinbureau'      },
  { channel: 'mmcryptota',      handle: '@MMCrypto'        },
  { channel: 'spectatorindex',  handle: '@spectatorindex'  },
  { channel: 'roundtablespace', handle: '@RoundtableSpace' },
  { channel: 'mylordbebo',      handle: '@MyLordBebo'      },
  { channel: 'untaxxable',      handle: '@untaxxable'      },
];

const X_CACHE_TTL = 90 * 1000;
const xFeedCache  = { items: [], cached_at: 0 };

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
  try {
    const results = await Promise.allSettled(
      X_MIRROR_SOURCES.map(async ({ channel, handle }) => {
        const url = `https://tg.i-c-a.su/rss/${channel}`;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(6000),
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = await res.text();
        return parseItems(xml, handle);
      })
    );

    const all = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 30);

    xFeedCache.items     = all;
    xFeedCache.cached_at = Date.now();
    return all;
  } catch (err) {
    console.error('[X-FEED] fetchXFeed error:', err.message);
    return xFeedCache.items; // serve stale on error
  }
}

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
cron.schedule('*/5 * * * *', () => {
  runServerLoop(broadcast).catch(err => console.error('[CRON] Loop error:', err.message));
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
    broadcast({ type: 'portfolio_update', data: stats });
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
  await runServerLoop(broadcast).catch(console.error);
});
