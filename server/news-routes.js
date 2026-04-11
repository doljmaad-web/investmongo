// ============================================================
// NEWS ROUTES — Mongolia (ikon.mn) + World (BBC, translated)
// All output in Mongolian. Cached in news_cache table.
// ============================================================
import Parser from 'rss-parser';
import { db } from './database.js';

const parser = new Parser({ timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } });

// ── Helpers ──────────────────────────────────────────────────

function isToday(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

function stripHtml(str) {
  return (str || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

// NOTE: ttlMinutes is always a hardcoded number — safe to interpolate directly
function getCached(source, ttlMinutes) {
  return db.prepare(`
    SELECT title, url, sentiment AS description, fetched_at
    FROM news_cache
    WHERE source = ?
      AND fetched_at > datetime('now', '-${ttlMinutes} minutes')
    ORDER BY id DESC LIMIT 20
  `).all(source);
}

function clearAndSave(source, items) {
  db.prepare(`DELETE FROM news_cache WHERE source = ?`).run(source);
  const ins = db.prepare(`INSERT INTO news_cache (source, title, url, sentiment) VALUES (?,?,?,?)`);
  for (const it of items) {
    ins.run(source, (it.title || '').slice(0, 500), (it.url || '').slice(0, 1000), (it.description || '').slice(0, 400));
  }
}

// ── Gemini batch translation (gemini-2.5-flash, same as rest of app) ─────────
async function translateBatch(items) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !items.length) {
    console.warn('[NEWS] No GEMINI_API_KEY — skipping translation');
    return items;
  }

  try {
    // Build numbered list for Gemini
    const numbered = items.map((it, i) =>
      `${i + 1}|${it.title}|||${it.description || ''}`
    ).join('\n');

    const prompt =
      `Translate the following English news headlines and short descriptions into natural Mongolian Cyrillic script.\n` +
      `Format: numbered same as input, pipe-separated: number|translated_title|||translated_description\n` +
      `Return ONLY the translated lines, no extra text, no markdown.\n\n` +
      numbered;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
        })
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('[NEWS] Gemini translation raw length:', raw.length);

    // Parse pipe-delimited lines
    const lines = raw.trim().split('\n').filter(l => l.includes('|'));
    return items.map((it, i) => {
      const line = lines.find(l => l.startsWith(`${i + 1}|`)) || lines[i] || '';
      const parts = line.split('|||');
      const titlePart = (parts[0] || '').replace(/^\d+\|/, '').trim();
      const descPart  = (parts[1] || '').trim();
      return {
        ...it,
        title:       titlePart || it.title,
        description: descPart  || it.description,
      };
    });
  } catch (e) {
    console.error('[NEWS] Gemini translation failed:', e.message);
    return items; // fallback: return BBC titles in English
  }
}

// ── Routes ────────────────────────────────────────────────────
export function setupNewsRoutes(app) {

  // ── GET /api/news/mongolia ────────────────────────────────
  app.get('/api/news/mongolia', async (req, res) => {
    try {
      const cached = getCached('ikon.mn', 30);
      if (cached.length > 0) {
        console.log(`[NEWS] Mongolia cache hit (${cached.length} items)`);
        return res.json(cached.map(c => ({
          title: c.title, url: c.url,
          description: c.description, source: 'iKon.МН'
        })));
      }

      console.log('[NEWS] Fetching Mongolia news from ikon.mn...');
      const feed = await parser.parseURL('https://ikon.mn/rss');
      const todayItems = feed.items.filter(i => isToday(i.pubDate || i.isoDate));
      const result = (todayItems.length >= 5 ? todayItems : feed.items).slice(0, 20);

      const mapped = result.map(i => ({
        title:       (i.title || '').trim(),
        url:         i.link || '',
        description: stripHtml(i.contentSnippet || i.summary || '').slice(0, 250),
        pubDate:     i.pubDate || i.isoDate || '',
        source:      'iKon.МН',
      }));

      clearAndSave('ikon.mn', mapped);
      console.log(`[NEWS] Mongolia: cached ${mapped.length} items`);
      res.json(mapped);
    } catch (err) {
      console.error('[NEWS] Mongolia error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/news/world ───────────────────────────────────
  app.get('/api/news/world', async (req, res) => {
    try {
      const cached = getCached('bbc.world', 60);
      if (cached.length > 0) {
        console.log(`[NEWS] World cache hit (${cached.length} items)`);
        return res.json(cached.map(c => ({
          title: c.title, url: c.url,
          description: c.description, source: 'BBC Дэлхий'
        })));
      }

      console.log('[NEWS] Fetching world news from BBC...');
      const feed = await parser.parseURL('https://feeds.bbci.co.uk/news/world/rss.xml');
      const todayItems = feed.items.filter(i => isToday(i.pubDate || i.isoDate));
      const result = (todayItems.length >= 5 ? todayItems : feed.items).slice(0, 15);

      const raw = result.map(i => ({
        title:       stripHtml(i.title || '').trim(),
        url:         i.link || '',
        description: stripHtml(i.contentSnippet || i.summary || '').slice(0, 200),
        pubDate:     i.pubDate || i.isoDate || '',
        source:      'BBC Дэлхий',
      }));

      console.log(`[NEWS] Translating ${raw.length} BBC items to Mongolian...`);
      const translated = await translateBatch(raw);

      clearAndSave('bbc.world', translated);
      console.log(`[NEWS] World: cached ${translated.length} translated items`);
      res.json(translated);
    } catch (err) {
      console.error('[NEWS] World error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/news/clear-cache — force-refresh (admin) ────
  app.post('/api/news/clear-cache', (req, res) => {
    try {
      db.prepare(`DELETE FROM news_cache WHERE source IN ('ikon.mn','bbc.world')`).run();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
