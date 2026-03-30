import Parser from 'rss-parser';

const parser = new Parser({ timeout: 10000, headers: { 'User-Agent': 'INVEST-MONGO-BOT/1.0' } });

const FEEDS = [
  { url: 'https://cointelegraph.com/rss',                              source: 'COINTELEGRAPH' },
  { url: 'https://coindesk.com/arc/outboundfeeds/rss/',               source: 'COINDESK'      },
  { url: 'https://feeds.reuters.com/reuters/businessNews',            source: 'REUTERS'       },
  { url: 'https://www.reddit.com/r/CryptoCurrency/hot.rss',           source: 'REDDIT'        },
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/category/markets/', source: 'COINDESK_MKT' },
];

const FEAR_GREED_URL = 'https://api.alternative.me/fng/';

// In-memory cache
let newsCache        = [];
let fearGreed        = { value: 50, classification: 'Neutral' };
let whaleCache       = [];
let macroEvent       = null;
let defiLlamaCache   = [];
let glassnodeCache   = [];
let lastFetch        = 0;
let lastMacroFetch   = 0;
let lastDefiLlama    = 0;
let lastGlassnode    = 0;
const CACHE_TTL      = 10 * 60 * 1000; // 10 minutes
const MACRO_TTL      = 60 * 60 * 1000; // 1 hour
const DEFILLAMA_TTL  = 30 * 60 * 1000; // 30 minutes
const GLASSNODE_TTL  = 60 * 60 * 1000; // 1 hour

const BULLISH_WORDS = ['surge','rally','bull','gain','rise','high','buy','etf','approval','adoption','inflow','pump','accumulate','breakout'];
const BEARISH_WORDS = ['crash','fall','drop','bear','sell','hack','ban','regulation','fine','loss','dump','outflow','liquidat','lawsuit'];

// ============================================================
// WHALE ACTIVITY — Free sources, no API key required
//
// 1. CoinGecko: flags large 24h price moves + volume spikes
// 2. Mempool.space: BTC on-chain activity (block fee pressure)
// ============================================================
const COINGECKO_IDS = {
  BTC:  'bitcoin',
  ETH:  'ethereum',
  DOGE: 'dogecoin',
  XAU:  'gold',      // CoinGecko uses "tether-gold" or similar; gold may return empty
  HYPE: 'hyperliquid',
};

async function fetchWhaleAlerts() {
  const alerts = [];

  // --- CoinGecko: volume/price anomalies ---
  try {
    const ids = Object.values(COINGECKO_IDS).filter(Boolean).join(',');
    const url  = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`;
    const res  = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    for (const [symbol, cgId] of Object.entries(COINGECKO_IDS)) {
      const info = data[cgId];
      if (!info) continue;
      const change = info.usd_24h_change ?? 0;
      const vol    = info.usd_24h_vol    ?? 0;

      // Flag significant moves: >6% price move = unusual, likely whale-driven
      if (Math.abs(change) >= 6) {
        alerts.push({
          symbol,
          type:       change > 0 ? 'price_surge' : 'price_dump',
          detail:     `${change.toFixed(1)}% in 24h`,
          amountUsd:  Math.round(vol),
          source:     'coingecko',
        });
      }
    }
  } catch (e) {
    console.warn('[NEWS] CoinGecko whale check failed:', e.message);
  }

  // --- Mempool.space: BTC on-chain pressure ---
  try {
    const res  = await fetch('https://mempool.space/api/v1/fees/mempool-blocks');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blocks = await res.json();

    if (blocks?.length) {
      const totalTx  = blocks.reduce((s, b) => s + (b.nTx || 0), 0);
      const medianFee = blocks[0]?.medianFee ?? 0;

      // High fee pressure (>50 sat/vB) = unusual BTC network activity
      if (medianFee > 50) {
        alerts.push({
          symbol:    'BTC',
          type:      'mempool_congestion',
          detail:    `${medianFee} sat/vB median fee, ${totalTx} pending txs`,
          amountUsd: 0,
          source:    'mempool.space',
        });
      }
    }
  } catch (e) {
    console.warn('[NEWS] Mempool.space whale check failed:', e.message);
  }

  return alerts;
}

// ============================================================
// DEFILLAMA — Total DeFi TVL trend + top chains (no API key)
// ============================================================
async function fetchDeFiLlama() {
  const now = Date.now();
  if (now - lastDefiLlama < DEFILLAMA_TTL && defiLlamaCache.length) return defiLlamaCache;

  const items = [];

  // Global TVL trend (daily history)
  try {
    const res  = await fetch('https://api.llama.fi/v2/historicalChainTvl');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (Array.isArray(data) && data.length >= 2) {
      const latest = data[data.length - 1];
      const prev   = data[data.length - 2];
      const change = ((latest.tvl - prev.tvl) / prev.tvl) * 100;
      const tvlB   = (latest.tvl / 1e9).toFixed(1);
      const dir    = change > 0 ? 'IN ↑' : 'OUT ↓';
      items.push({
        source:      'DEFILLAMA',
        title:       `DeFi Total TVL: $${tvlB}B (${change > 0 ? '+' : ''}${change.toFixed(1)}% 24h) — liquidity flowing ${dir}`,
        sentiment:   change > 2 ? 'bullish' : change < -2 ? 'bearish' : 'neutral',
        publishedAt: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.warn('[NEWS] DeFiLlama TVL fetch failed:', e.message);
  }

  // Top 3 chains by TVL
  try {
    const res    = await fetch('https://api.llama.fi/v2/chains');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const chains = await res.json();
    const top3   = chains.sort((a, b) => b.tvl - a.tvl).slice(0, 3);
    const summary = top3.map(c => `${c.name} $${(c.tvl / 1e9).toFixed(1)}B`).join(' | ');
    items.push({
      source:      'DEFILLAMA',
      title:       `Top Chain TVL — ${summary}`,
      sentiment:   'neutral',
      publishedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[NEWS] DeFiLlama chains fetch failed:', e.message);
  }

  defiLlamaCache = items;
  lastDefiLlama  = now;
  console.log(`[NEWS] DeFiLlama: ${items.length} items fetched`);
  return items;
}

// ============================================================
// GLASSNODE — BTC exchange balance (free tier, needs GLASSNODE_API_KEY)
// Get a free key at: https://glassnode.com
// ============================================================
async function fetchGlassnode() {
  const apiKey = process.env.GLASSNODE_API_KEY;
  if (!apiKey) return [];

  const now = Date.now();
  if (now - lastGlassnode < GLASSNODE_TTL && glassnodeCache.length) return glassnodeCache;

  const items = [];

  try {
    // BTC balance held on exchanges — decreasing = coins leaving = bullish
    const url = `https://api.glassnode.com/v1/metrics/distribution/balance_exchanges?a=BTC&api_key=${apiKey}&i=24h&limit=8`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (Array.isArray(data) && data.length >= 2) {
      const latest  = data[data.length - 1];
      const weekAgo = data[Math.max(0, data.length - 7)];
      const change  = latest.v - weekAgo.v;
      const pct     = ((change / weekAgo.v) * 100).toFixed(2);
      const btcAmt  = (latest.v / 1000).toFixed(0);
      const signal  = change < 0 ? 'outflow — accumulation signal' : 'inflow — sell pressure signal';
      items.push({
        source:      'GLASSNODE',
        title:       `BTC Exchange Balance: ${btcAmt}K BTC (${change < 0 ? '' : '+'}${pct}% 7d) — ${signal}`,
        sentiment:   change < 0 ? 'bullish' : 'bearish',
        publishedAt: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.warn('[NEWS] Glassnode fetch failed:', e.message);
  }

  glassnodeCache = items;
  lastGlassnode  = now;
  console.log(`[NEWS] Glassnode: ${items.length} items fetched`);
  return items;
}

// ============================================================
// MACRO EVENTS — Finnhub economic calendar (free tier)
// Set FINNHUB_API_KEY in .env to enable
// Returns the next high-impact event within 7 days, or null
// ============================================================
async function fetchNextMacroEvent() {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return null;

  const now = Date.now();
  if (macroEvent !== undefined && now - lastMacroFetch < MACRO_TTL) {
    return macroEvent;
  }

  try {
    const from = new Date().toISOString().split('T')[0];
    const to   = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const url  = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${apiKey}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const events = (data.economicCalendar || [])
      .filter(e => e.impact === 'high' || e.impact === '3')
      .map(e => ({ ...e, _ms: new Date(e.time).getTime() }))
      .filter(e => e._ms > now)
      .sort((a, b) => a._ms - b._ms);

    macroEvent = events.length > 0 ? {
      event:     events[0].event,
      time:      events[0].time,
      country:   events[0].country,
      impact:    'high',
      hoursAway: Math.round((events[0]._ms - now) / (1000 * 60 * 60)),
    } : null;

    lastMacroFetch = now;
    console.log(`[NEWS] Next macro event: ${macroEvent?.event || 'none'}`);
    return macroEvent;
  } catch (e) {
    console.warn('[NEWS] Macro calendar fetch failed:', e.message);
    return null;
  }
}

function guessSentiment(title) {
  const t = title.toLowerCase();
  const b = BULLISH_WORDS.filter(w => t.includes(w)).length;
  const s = BEARISH_WORDS.filter(w => t.includes(w)).length;
  if (b > s) return 'bullish';
  if (s > b) return 'bearish';
  return 'neutral';
}

export async function fetchAllNews(force = false) {
  const now = Date.now();
  if (!force && now - lastFetch < CACHE_TTL) {
    return { news: newsCache, fearGreed, whales: whaleCache, macroEvent };
  }

  lastFetch = now;
  const fresh = [];

  // Fetch RSS feeds, whale alerts, macro events, Fear & Greed, DeFiLlama, Glassnode concurrently
  const [feedResults, whaleResults, macroResult, fngResult, defiResult, glassResult] = await Promise.allSettled([
    Promise.allSettled(
      FEEDS.map(async feed => {
        const parsed = await parser.parseURL(feed.url);
        return parsed.items.slice(0, 6).map(item => ({
          source:      feed.source,
          title:       item.title?.trim() || '',
          url:         item.link || '',
          sentiment:   guessSentiment(item.title || ''),
          publishedAt: item.pubDate || new Date().toISOString(),
        }));
      })
    ),
    fetchWhaleAlerts(),
    fetchNextMacroEvent(),
    fetch(FEAR_GREED_URL).then(r => r.json()),
    fetchDeFiLlama(),
    fetchGlassnode(),
  ]);

  // Process RSS feeds
  if (feedResults.status === 'fulfilled') {
    for (const r of feedResults.value) {
      if (r.status === 'fulfilled') fresh.push(...r.value);
      else console.warn('[NEWS] Feed error:', r.reason?.message);
    }
  }

  newsCache = fresh
    .filter(n => n.title.length > 10)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  // Whale alerts
  if (whaleResults.status === 'fulfilled') whaleCache = whaleResults.value;

  // Macro event
  if (macroResult.status === 'fulfilled') macroEvent = macroResult.value;

  // DeFiLlama + Glassnode — inject into news feed
  if (defiResult.status === 'fulfilled')  fresh.push(...defiResult.value);
  if (glassResult.status === 'fulfilled') fresh.push(...glassResult.value);

  // Fear & Greed index
  if (fngResult.status === 'fulfilled') {
    try {
      fearGreed = {
        value:          parseInt(fngResult.value.data[0].value),
        classification: fngResult.value.data[0].value_classification,
      };
    } catch (e) {
      console.warn('[NEWS] Fear & Greed parse failed:', e.message);
    }
  } else {
    console.warn('[NEWS] Fear & Greed fetch failed:', fngResult.reason?.message);
  }

  console.log(`[NEWS] Fetched ${newsCache.length} articles, ${whaleCache.length} whale txs. F&G: ${fearGreed.value}. Next macro: ${macroEvent?.event || 'none'}`);
  return { news: newsCache, fearGreed, whales: whaleCache, macroEvent };
}

export { newsCache, fearGreed, whaleCache, macroEvent, defiLlamaCache, glassnodeCache };
