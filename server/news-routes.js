// ============================================================
// NEWS ROUTES — Mongolia (ikon.mn) + World (BBC, translated)
// All output in Mongolian. Cached in news_cache table (30/60 min TTL).
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
  return (str || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
}

function getCached(source, ttlMinutes) {
  return db.prepare(`
    SELECT title, url, sentiment AS description, fetched_at
    FROM news_cache
    WHERE source = ?
      AND fetched_at > datetime('now', ? )
    ORDER BY id DESC LIMIT 20
  `).all(source, `-${ttlMinutes} minutes`);
}

function clearAndSave(source, items) {
  db.prepare(`DELETE FROM news_cache WHERE source = ?`).run(source);
  const ins = db.prepare(`INSERT INTO news_cache (source, title, url, sentiment) VALUES (?,?,?,?)`);
  for (const it of items) ins.run(source, it.title || '', it.url || '', it.description || '');
}

// ── Gemini batch translation ──────────────────────────────────
async function translateBatch(items) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !items.length) return items;

  try {
    const numbered = items.map((it, i) =>
      `${i + 1}. TITLE: ${it.title}\n   DESC: ${it.description || ''}`
    ).join('\n');

    const prompt =
      `Translate the following English news headlines and descriptions into natural Mongolian (Cyrillic). ` +
      `Return ONLY a valid JSON array of objects with keys "title" and "description", same order, no extra text.\n\n` +
      numbered;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
        })
      }
    );
    const data = await res.json();
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    // Strip markdown code fences if Gemini wraps in ```json
    text = text.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(text);
    return items.map((it, i) => ({
      ...it,
      title: parsed[i]?.title || it.title,
      description: parsed[i]?.description || it.description,
    }));
  } catch (e) {
    console.warn('[NEWS] translation failed:', e.message);
    return items; // fallback: return untranslated
  }
}

// ── Relative time in Mongolian ────────────────────────────────
function relativeTimeMn(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'одоо саяхан';
  if (mins < 60) return `${mins} минутын өмнө`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs} цагийн өмнө`;
  return `${Math.floor(hrs / 24)} өдрийн өмнө`;
}

// ── Routes ────────────────────────────────────────────────────
export function setupNewsRoutes(app) {

  // ── GET /api/news/mongolia ────────────────────────────────
  app.get('/api/news/mongolia', async (req, res) => {
    try {
      const cached = getCached('ikon.mn', 30);
      if (cached.length > 0) {
        return res.json(cached.map(c => ({
          title: c.title, url: c.url,
          description: c.description, source: 'iKon.МН'
        })));
      }

      const feed = await parser.parseURL('https://ikon.mn/rss');
      const items = feed.items;
      const todayItems = items.filter(i => isToday(i.pubDate || i.isoDate));
      const result = (todayItems.length >= 5 ? todayItems : items).slice(0, 20);

      const mapped = result.map(i => ({
        title:       (i.title || '').trim(),
        url:         i.link || '',
        description: stripHtml(i.contentSnippet || i.summary || '').slice(0, 250),
        pubDate:     i.pubDate || i.isoDate || '',
        source:      'iKon.МН',
      }));

      clearAndSave('ikon.mn', mapped);
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
        return res.json(cached.map(c => ({
          title: c.title, url: c.url,
          description: c.description, source: 'BBC Дэлхий'
        })));
      }

      const feed = await parser.parseURL('https://feeds.bbci.co.uk/news/world/rss.xml');
      const items = feed.items;
      const todayItems = items.filter(i => isToday(i.pubDate || i.isoDate));
      const result = (todayItems.length >= 5 ? todayItems : items).slice(0, 15);

      const raw = result.map(i => ({
        title:       (i.title || '').trim(),
        url:         i.link || '',
        description: stripHtml(i.contentSnippet || i.summary || '').slice(0, 200),
        pubDate:     i.pubDate || i.isoDate || '',
        source:      'BBC Дэлхий',
      }));

      // Translate to Mongolian via Gemini
      const translated = await translateBatch(raw);

      clearAndSave('bbc.world', translated);
      res.json(translated);
    } catch (err) {
      console.error('[NEWS] World error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
