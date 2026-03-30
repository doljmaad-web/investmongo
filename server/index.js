import 'dotenv/config';
import express           from 'express';
import { createServer }  from 'http';
import { WebSocketServer } from 'ws';
import path              from 'path';
import { fileURLToPath } from 'url';
import cron              from 'node-cron';

import { handleSignal, runServerLoop } from './bot.js';
import { fetchAllNews }                from './news-scraper.js';
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
// X / TWITTER FEED — via Nitter public RSS mirrors (no API key)
// ============================================================
const NITTER_FEEDS = [
  { url: 'https://nitter.poast.org/MarioNawfal/rss',     handle: '@MarioNawfal'     },
  { url: 'https://nitter.poast.org/CryptoHayes/rss',     handle: '@CryptoHayes'     },
  { url: 'https://nitter.poast.org/spectatorindex/rss',  handle: '@spectatorindex'  },
  { url: 'https://nitter.poast.org/coinbureau/rss',      handle: '@coinbureau'      },
  { url: 'https://nitter.poast.org/RoundtableSpace/rss', handle: '@RoundtableSpace' },
  { url: 'https://nitter.poast.org/MyLordBebo/rss',      handle: '@MyLordBebo'      },
  { url: 'https://nitter.poast.org/untaxxable/rss',      handle: '@untaxxable'      },
  { url: 'https://nitter.poast.org/MMCrypto/rss',        handle: '@MMCrypto'        },
];

let xFeedCache = { items: [], cached_at: 0 };
const X_CACHE_TTL = 60 * 1000;

function parseNitterRSS(xml, handle) {
  const items = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRx.exec(xml)) !== null) {
    const block    = m[1];
    const rawTitle = (/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/.exec(block)?.[1] ||
                      /<title>([\s\S]*?)<\/title>/.exec(block)?.[1] || '').trim();
    const pubDate  = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1] || '').trim();
    const title    = rawTitle
      .replace(/^R to @\w+: /, '').replace(/^RT by @\w+: /, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .trim();
    if (title.length > 5) {
      items.push({ handle, title, pubDate, ts: pubDate ? new Date(pubDate).getTime() : 0 });
    }
  }
  return items;
}

async function fetchXFeed() {
  const now = Date.now();
  if (now - xFeedCache.cached_at < X_CACHE_TTL && xFeedCache.items.length > 0) {
    return xFeedCache.items;
  }

  const results = await Promise.allSettled(
    NITTER_FEEDS.map(async ({ url, handle }) => {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': 'INVEST-MONGO-BOT/1.0' },
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return parseNitterRSS(await r.text(), handle);
      } catch (err) {
        console.warn(`[X-FEED] ${handle} failed: ${err.message}`);
        return [];
      }
    })
  );

  const all    = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  const sorted = all.sort((a, b) => b.ts - a.ts).slice(0, 20)
                    .map(({ handle, title, pubDate }) => ({ handle, title, pubDate }));

  xFeedCache = { items: sorted, cached_at: now };
  return sorted;
}

// Test route — confirms endpoint is registered before debugging fetches
app.get('/api/x-feed/test', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/api/x-feed', async (req, res) => {
  try {
    const items = await fetchXFeed();
    res.json({ items, cached_at: Date.now() });
  } catch (err) {
    console.error('[X-FEED] Fatal error:', err.message);
    res.json({ items: [], error: err.message, cached_at: Date.now() });
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
