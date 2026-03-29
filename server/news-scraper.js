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
let newsCache    = [];
let fearGreed    = { value: 50, classification: 'Neutral' };
let whaleCache   = [];
let lastFetch    = 0;
const CACHE_TTL  = 10 * 60 * 1000; // 10 minutes

const BULLISH_WORDS = ['surge','rally','bull','gain','rise','high','buy','etf','approval','adoption','inflow','pump','accumulate','breakout'];
const BEARISH_WORDS = ['crash','fall','drop','bear','sell','hack','ban','regulation','fine','loss','dump','outflow','liquidat','lawsuit'];

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
    return { news: newsCache, fearGreed, whales: whaleCache };
  }

  lastFetch = now;
  const fresh = [];

  // Fetch RSS feeds concurrently
  const results = await Promise.allSettled(
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
  );

  for (const r of results) {
    if (r.status === 'fulfilled') fresh.push(...r.value);
    else console.warn('[NEWS] Feed error:', r.reason?.message);
  }

  newsCache = fresh
    .filter(n => n.title.length > 10)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  // Fear & Greed index
  try {
    const res  = await fetch(FEAR_GREED_URL);
    const data = await res.json();
    fearGreed  = {
      value:          parseInt(data.data[0].value),
      classification: data.data[0].value_classification,
    };
  } catch (e) {
    console.warn('[NEWS] Fear & Greed fetch failed:', e.message);
  }

  console.log(`[NEWS] Fetched ${newsCache.length} articles. F&G: ${fearGreed.value}`);
  return { news: newsCache, fearGreed, whales: whaleCache };
}

export { newsCache, fearGreed, whaleCache };
