// INVEST MONGO AI Terminal — WebSocket Client + Live Rendering

// ============================================================
// CONFIG
// ============================================================
const WS_URL = location.protocol === 'https:'
  ? `wss://${location.host}`
  : `ws://${location.host}`;

const STARTING_BALANCE = 10000;
const MAX_NEWS_LINES   = 12;
const NEWS_FADE_AFTER  = 8;

let activePeriod = '1d';
const PERIOD_MS = {
  '30m':  30 * 60 * 1000,
  '1h':   60 * 60 * 1000,
  '4h':   4 * 60 * 60 * 1000,
  '1d':   24 * 60 * 60 * 1000,
  '7d':   7 * 24 * 60 * 60 * 1000,
  '30d':  30 * 24 * 60 * 60 * 1000,
  '90d':  90 * 24 * 60 * 60 * 1000,
  '180d': 180 * 24 * 60 * 60 * 1000,
  '365d': 365 * 24 * 60 * 60 * 1000,
};

// ============================================================
// STATE
// ============================================================
let state = {
  portfolio:       null,
  signals:         [],
  news:            [],
  snapshots:       [],
  fearGreed:       { value: 50, classification: 'Neutral' },
  newsCount:       0,
  tradeIntelItems: [],
  activeTiFilters: new Set(['BTC','GOLD','GEO','AI','CT','CD','DEFI','WHALE']),
};

let ws       = null;
let wsRetry  = null;
let chartCtx = null;

// ============================================================
// WEBSOCKET
// ============================================================
function connect() {
  clearTimeout(wsRetry);
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[WS] Connected');
    document.getElementById('connecting-overlay').classList.add('hidden');
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (e) {
      console.error('[WS] Parse error:', e);
    }
  };

  ws.onclose = () => {
    console.log('[WS] Disconnected — retrying in 5s');
    document.getElementById('connecting-overlay').classList.remove('hidden');
    wsRetry = setTimeout(connect, 5000);
  };

  ws.onerror = (e) => console.error('[WS] Error:', e);
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'init':
      state.portfolio = msg.data.stats;
      state.signals   = msg.data.signals || [];
      state.news      = msg.data.news    || [];
      state.snapshots = msg.data.snapshots || [];
      state.fearGreed = msg.data.fearGreed || state.fearGreed;
      renderAll();
      break;

    case 'portfolio_update':
      state.portfolio = msg.data;
      if (msg.data.snapshots) state.snapshots = msg.data.snapshots;
      if (msg.data.totalValue !== undefined) {
        state.snapshots.push({
          total_value: msg.data.totalValue,
          snapshot_at: new Date().toISOString(),
        });
        if (state.snapshots.length > 100) state.snapshots.shift();
      }
      renderPortfolio();
      renderPositions();
      drawChart();
      break;

    case 'new_signal':
      if (msg.data?.signal) {
        state.signals.unshift(buildSignalRecord(msg.data));
        renderSignals();
        if (msg.data.decision) updateGeminiBox(msg.data.decision, msg.data.signal);
        if (msg.data.decision && window.SpatialPlanner) {
          window.SpatialPlanner.onSignal(msg.data.signal, msg.data.decision);
        }
      }
      break;

    case 'news_update':
      if (msg.data?.news) {
        const fresh = msg.data.news.filter(n =>
          !state.news.some(e => e.title === n.title)
        );
        state.news = [...fresh, ...state.news].slice(0, 60);
        if (msg.data.fearGreed) state.fearGreed = msg.data.fearGreed;
        appendNewsLines(fresh);
        renderTradeIntel();
        updateFGBadge();
      }
      break;
  }
}

// Helper to build a unified signal record from WS outcome
function buildSignalRecord(outcome) {
  return {
    asset:             outcome.signal?.asset,
    action:            outcome.signal?.signal,
    signal_type:       outcome.signal?.type,
    price:             outcome.signal?.price,
    rsi:               outcome.signal?.rsi,
    timeframe:         outcome.signal?.timeframe,
    pattern:           outcome.signal?.pattern,
    strength:          outcome.signal?.strength,
    gemini_verdict:    outcome.decision?.verdict,
    gemini_confidence: outcome.decision?.confidence,
    gemini_reasoning:  outcome.decision?.reasoning?.summary,
    validated_news:    JSON.stringify(outcome.decision?.validated_news || []),
    created_at:        new Date().toISOString(),
  };
}

// ============================================================
// RENDER ALL
// ============================================================
function renderAll() {
  renderPortfolio();
  renderSignals();
  renderPositions();
  renderNewsTerminal();
  renderTradeIntel();
  updateFGBadge();
  drawChart();
}

// ============================================================
// PORTFOLIO / METRICS
// ============================================================
function renderPortfolio() {
  const p = state.portfolio;
  if (!p) return;

  const total    = p.totalValue ?? STARTING_BALANCE;
  const diff     = total - STARTING_BALANCE;
  const diffPct  = ((diff / STARTING_BALANCE) * 100).toFixed(1);
  const isPos    = diff >= 0;

  document.getElementById('aum-value').textContent   = fmtUSD(total);
  const changeEl = document.getElementById('aum-change');
  changeEl.textContent = `${isPos ? '+' : ''}${fmtUSD(diff)} (${diffPct}%)`;
  changeEl.className   = 'change ' + (isPos ? 'pos' : 'neg');

  // Metrics grid
  const winEl = document.getElementById('metric-winrate');
  winEl.textContent = p.totalTrades > 0 ? `${p.winRate}%` : '--%';
  winEl.className = 'value';

  document.getElementById('metric-trades').textContent = `${p.totalTrades} trades`;

  const todayEl = document.getElementById('metric-today-pnl');
  todayEl.textContent = fmtUSD(p.closedPnlToday, true);
  todayEl.className   = 'value ' + (p.closedPnlToday >= 0 ? 'pos' : 'neg');
  document.getElementById('metric-today-sub').textContent = `${p.closedToday?.length ?? 0} closed today`;

  const totalPnlEl = document.getElementById('metric-total-pnl');
  totalPnlEl.textContent = fmtUSD(p.totalPnl, true);
  totalPnlEl.className   = 'value ' + (p.totalPnl >= 0 ? 'pos' : 'neg');

  document.getElementById('metric-open').textContent    = p.openCount;
  const exposure = (p.openTrades || []).reduce((s, t) => s + t.size_usd, 0);
  document.getElementById('metric-exposure').textContent = `${fmtUSD(exposure)} exposure`;

  // Risk bars
  const dailyLoss = Math.max(0, -p.closedPnlToday);
  updateRiskBar('risk-daily', 'risk-daily-text', dailyLoss, 200, `$${dailyLoss.toFixed(0)} / $200`);
  updateRiskBar('risk-pos',   'risk-pos-text',   p.openCount, 5, `${p.openCount} / 5`);
  updateRiskBar('risk-exp',   'risk-exp-text',   exposure, 3000, `$${exposure.toFixed(0)} / $3000`);

  // Snapshots → chart
  if (state.snapshots.length > 0) drawChart();
}

function updateRiskBar(barId, textId, value, max, label) {
  const pct   = Math.min(100, (value / max) * 100);
  const bar   = document.getElementById(barId);
  const text  = document.getElementById(textId);
  bar.style.width = `${pct}%`;
  bar.className = 'risk-mini-fill' + (pct > 80 ? ' danger' : pct > 50 ? ' warn' : '');
  if (text) text.textContent = label;
}

// ============================================================
// SIGNAL FEED
// ============================================================
function renderSignals() {
  const feed   = document.getElementById('signal-feed');
  const signals = state.signals.slice(0, 30);
  document.getElementById('signal-count').textContent = signals.length;

  if (signals.length === 0) {
    feed.innerHTML = '<div class="empty-state">Waiting for signals...</div>';
    return;
  }

  feed.innerHTML = signals.map(s => buildSignalCard(s)).join('');
}

function buildSignalCard(s) {
  const verdict     = (s.gemini_verdict || 'PENDING').toLowerCase();
  const confidence  = s.gemini_confidence || 0;
  const confClass   = confidence >= 70 ? 'high' : confidence >= 50 ? 'medium' : 'low';
  const dirClass    = s.action === 'BUY' ? 'buy' : 'sell';
  const time        = formatTime(s.created_at);

  let newsHtml = '';
  try {
    const newsArr = JSON.parse(s.validated_news || '[]');
    if (newsArr.length > 0) {
      newsHtml = `<div class="signal-news">${newsArr.slice(0,2).map(n =>
        `<p>• ${escHtml(n)}</p>`
      ).join('')}</div>`;
    }
  } catch {}

  return `
    <div class="signal-card ${verdict}">
      <div class="signal-header">
        <span class="signal-asset">${escHtml(s.asset || '--')}</span>
        <span class="signal-dir ${dirClass}">${s.action || '--'}</span>
      </div>
      <div class="signal-meta">
        <span>${escHtml(s.signal_type || '--')}</span>
        ${s.rsi ? `<span>RSI ${s.rsi}</span>` : ''}
        ${s.timeframe ? `<span>${s.timeframe}</span>` : ''}
        ${s.pattern ? `<span>${escHtml(s.pattern)}</span>` : ''}
        <span>${time}</span>
      </div>
      <div class="conf-bar-wrap">
        <label>AI</label>
        <div class="conf-bar">
          <div class="conf-bar-fill ${confClass}" style="width:${confidence}%"></div>
        </div>
        <span class="conf-pct">${confidence}%</span>
      </div>
      <span class="verdict-badge ${verdict}">${(s.gemini_verdict || 'PENDING')}</span>
      ${newsHtml}
    </div>`;
}

// ============================================================
// POSITIONS
// ============================================================
function renderPositions() {
  const p = state.portfolio;
  if (!p) return;

  const open   = p.openTrades   || [];
  const closed = p.closedToday  || [];

  document.getElementById('open-count-badge').textContent = open.length;
  document.getElementById('no-positions').style.display   = open.length ? 'none' : 'block';

  document.getElementById('positions-list').innerHTML =
    open.map(t => buildPositionCard(t)).join('');

  const closedHeader = document.getElementById('closed-today-header');
  const closedList   = document.getElementById('closed-today-list');
  if (closed.length > 0) {
    closedHeader.style.display = 'block';
    closedList.innerHTML = closed.slice(0, 8).map(t => {
      const isPos = t.pnl_usd >= 0;
      return `
        <div class="closed-trade-row">
          <span class="asset">${t.asset} ${t.direction}</span>
          <span class="pnl ${isPos ? 'pos' : 'neg'}">${fmtUSD(t.pnl_usd, true)}</span>
          <span class="time">${formatTime(t.closed_at)}</span>
        </div>`;
    }).join('');
  } else {
    closedHeader.style.display = 'none';
    closedList.innerHTML = '';
  }
}

function buildPositionCard(t) {
  const isPos   = (t.pnl_usd || 0) >= 0;
  const dirClass = t.direction === 'LONG' ? 'long' : 'short';
  const pnlPct   = t.pnl_pct ? ` (${t.pnl_pct > 0 ? '+' : ''}${t.pnl_pct.toFixed(1)}%)` : '';
  return `
    <div class="position-card">
      <div class="pos-header">
        <span class="pos-asset">${escHtml(t.asset)}</span>
        <span class="pos-dir ${dirClass}">${t.direction}</span>
      </div>
      <div class="pos-pnl ${isPos ? 'pos' : 'neg'}">${fmtUSD(t.pnl_usd, true)}${pnlPct}</div>
      <div class="pos-details">
        <span>Entry: <b>${fmtPrice(t.entry_price)}</b></span>
        <span>Size: <b>${fmtUSD(t.size_usd)}</b></span>
        <span>SL: <b style="color:var(--red)">${fmtPrice(t.stop_loss)}</b></span>
        <span>TP: <b style="color:var(--green)">${fmtPrice(t.take_profit)}</b></span>
      </div>
    </div>`;
}

// ============================================================
// GEMINI BOX
// ============================================================
function updateGeminiBox(decision, signal) {
  if (!decision) return;
  const verdict = (decision.verdict || '').toLowerCase();

  document.getElementById('gemini-reasoning').textContent =
    decision.reasoning?.summary || 'No reasoning available.';

  const footer  = document.getElementById('gemini-footer');
  footer.style.display = 'flex';

  const vb = document.getElementById('gemini-verdict-badge');
  vb.textContent = decision.verdict || '--';
  vb.className   = `verdict-badge ${verdict}`;

  document.getElementById('gemini-conf').textContent =
    `${decision.confidence || 0}% confidence`;

  document.getElementById('gemini-sl').textContent  = fmtPrice(decision.stop_loss);
  document.getElementById('gemini-tp').textContent  = fmtPrice(decision.take_profit);
  document.getElementById('gemini-rr').textContent  = decision.rr_ratio ?? '--';
}

// ============================================================
// NEWS TERMINAL
// ============================================================
function renderNewsTerminal() {
  const feed = document.getElementById('news-feed');
  if (!feed) return;
  feed.innerHTML = '';
  const items = state.news.slice(0, MAX_NEWS_LINES);
  items.forEach((n, i) => appendNewsLine(n, i < items.length - MAX_NEWS_LINES + NEWS_FADE_AFTER));
  addCursor();
  updateNewsCounter();
  activatePills();
}

function appendNewsLines(items) {
  items.forEach(n => appendNewsLine(n, false));
  trimNewsLines();
  addCursor();
  state.newsCount += items.length;
  updateNewsCounter();
}

function appendNewsLine(n, fading = false) {
  const feed = document.getElementById('news-feed');
  if (!feed) return;
  // Remove old cursor if present
  const oldCursor = feed.querySelector('.cursor-blink');
  if (oldCursor) oldCursor.remove();

  const div  = document.createElement('div');
  const sent = n.sentiment || 'neutral';
  div.className = `news-line ${sent}${fading ? ' fading' : ''}`;

  const timeStr = n.publishedAt
    ? new Date(n.publishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  div.innerHTML = `
    <span class="news-source">${escHtml(n.source || '?')}</span>
    <span class="news-text">${escHtml(n.title || '')}</span>
    ${timeStr ? `<span class="news-time">[${timeStr}]</span>` : ''}`;

  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

function addCursor() {
  const feed = document.getElementById('news-feed');
  if (!feed) return;
  const cursor = document.createElement('span');
  cursor.className = 'cursor-blink';
  feed.appendChild(cursor);
}

function trimNewsLines() {
  const feed  = document.getElementById('news-feed');
  if (!feed) return;
  const lines = feed.querySelectorAll('.news-line');
  if (lines.length > MAX_NEWS_LINES) {
    lines[0].classList.add('fading');
    setTimeout(() => lines[0].remove(), 600);
  }
}

function updateNewsCounter() {
  const el = document.getElementById('news-counter');
  if (!el) return;
  el.textContent = `${state.newsCount || state.news.length} items`;
}

function activatePills() {
  const sources = new Set(state.news.map(n => n.source));
  const pillMap = {
    'pill-ct': ['COINTELEGRAPH', 'BITCOIN_MAG', 'CRYPTOSLATE', 'DECRYPT'],
    'pill-cd': ['COINDESK', 'COINDESK_MKT'],
    'pill-rt': ['REUTERS'],
    'pill-wh': ['WHALEALERT'],
    'pill-rd': ['REDDIT', 'REDDIT_BTC'],
    'pill-dl': ['DEFILLAMA'],
    'pill-gn': ['GLASSNODE'],
    'pill-mm': ['MMCRYPTO_TG'],
  };
  for (const [id, srcs] of Object.entries(pillMap)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const active = srcs.some(s => sources.has(s));
    el.classList.toggle('active', active);
  }
}

// ============================================================
// FEAR & GREED BADGE
// ============================================================
function updateFGBadge() {
  const fg  = state.fearGreed;
  const el  = document.getElementById('fg-badge');
  const val = fg?.value ?? 50;
  const cls = fg?.classification || 'Neutral';
  el.textContent = `F&G: ${val} — ${cls}`;
  el.className   = `badge ${val >= 75 ? 'red' : val >= 55 ? 'amber' : val <= 25 ? 'red' : 'purple'}`;
}

// ============================================================
// AUM CHART (Canvas) — period-aware
// ============================================================
async function fetchSnapshotsForPeriod(period) {
  try {
    const res  = await fetch(`/api/snapshots?period=${period}`);
    const data = await res.json();
    if (data.snapshots?.length) state.snapshots = data.snapshots;
  } catch(e) {}
  drawChart();
}

function drawChart() {
  const canvas = document.getElementById('aum-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const container = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const W = (container.clientWidth - 2);
  const H = (container.clientHeight - 2);
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (W < 10 || H < 10) return;

  const now    = Date.now();
  const cutoff = now - (PERIOD_MS[activePeriod] || PERIOD_MS['1d']);

  let points = state.snapshots
    .map(s => ({ value: s.total_value, time: new Date(s.snapshot_at) }))
    .filter(p => p.time.getTime() >= cutoff)
    .sort((a, b) => a.time - b.time);

  if (points.length === 0) {
    points = [
      { value: STARTING_BALANCE, time: new Date(cutoff) },
      { value: state.portfolio?.totalValue ?? STARTING_BALANCE, time: new Date() },
    ];
  }
  if (state.portfolio?.totalValue) {
    points.push({ value: state.portfolio.totalValue, time: new Date() });
  }

  const values = points.map(p => p.value);
  const minVal = Math.min(...values) * 0.9995;
  const maxVal = Math.max(...values) * 1.0005;
  const range  = maxVal - minVal || 1;
  const padL = 65, padR = 12, padT = 12, padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  ctx.clearRect(0, 0, W, H);

  // Grid + Y labels
  for (let i = 0; i <= 5; i++) {
    const y   = padT + (plotH / 5) * i;
    const val = maxVal - (range / 5) * i;
    ctx.strokeStyle = '#1a2332'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillStyle = '#4b5563'; ctx.font = '9px monospace'; ctx.textAlign = 'right';
    ctx.fillText(`$${val.toFixed(0)}`, padL - 4, y + 3);
  }

  // X labels
  function fmtTime(d) {
    if (['30m','1h','4h','1d'].includes(activePeriod))
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  const step = Math.max(1, Math.floor(points.length / 6));
  ctx.fillStyle = '#4b5563'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
  points.forEach((p, i) => {
    if (i % step !== 0 && i !== points.length - 1) return;
    const x = padL + (i / (points.length - 1 || 1)) * plotW;
    ctx.fillText(fmtTime(p.time), x, H - 6);
  });

  if (points.length < 2) return;

  const isProfit  = values[values.length - 1] >= values[0];
  const lineColor = isProfit ? '#00ff88' : '#ff4444';
  const toX = i => padL + (i / (points.length - 1)) * plotW;
  const toY = v => padT + plotH - ((v - minVal) / range) * plotH;

  // Gradient fill
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, isProfit ? 'rgba(0,255,136,0.15)' : 'rgba(255,68,68,0.15)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  points.forEach((p, i) => i === 0 ? ctx.moveTo(toX(i), toY(p.value)) : ctx.lineTo(toX(i), toY(p.value)));
  ctx.lineTo(toX(points.length - 1), padT + plotH);
  ctx.lineTo(toX(0), padT + plotH);
  ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = lineColor; ctx.lineWidth = 1.5;
  ctx.shadowColor = lineColor; ctx.shadowBlur = 6;
  points.forEach((p, i) => i === 0 ? ctx.moveTo(toX(i), toY(p.value)) : ctx.lineTo(toX(i), toY(p.value)));
  ctx.stroke(); ctx.shadowBlur = 0;

  // End dot
  const lastI = points.length - 1;
  ctx.beginPath();
  ctx.arc(toX(lastI), toY(values[lastI]), 3, 0, Math.PI * 2);
  ctx.fillStyle = lineColor; ctx.fill();
}

// ============================================================
// CLOCK
// ============================================================
function updateClock() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleTimeString();
}

// ============================================================
// HELPERS
// ============================================================
function fmtUSD(val, showSign = false) {
  if (val === null || val === undefined) return '$--';
  const abs    = Math.abs(val);
  const sign   = showSign ? (val >= 0 ? '+' : '-') : (val < 0 ? '-' : '');
  const parts  = abs.toFixed(2).split('.');
  parts[0]     = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${parts.join('.')}`;
}

function fmtPrice(val) {
  if (val === null || val === undefined) return '--';
  return `$${parseFloat(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTime(isoStr) {
  if (!isoStr) return '--';
  const d = new Date(isoStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// TRADE INTELLIGENCE FEED
// ============================================================
function categorizSource(src) {
  if (!src) return 'BTC';
  const s = src.toUpperCase();
  if (s.includes('COINTELEGRAPH') || s.includes('BITCOIN_MAG') || s.includes('CRYPTOSLATE') || s.includes('DECRYPT')) return 'CT';
  if (s.includes('COINDESK')) return 'CD';
  if (s.includes('DEFILLAMA') || s.includes('DEFI')) return 'DEFI';
  if (s.includes('REDDIT')) return 'BTC';
  if (s.includes('WHALEALERT') || s.includes('WHALE') || s.includes('COINGECKO') || s.includes('MEMPOOL')) return 'WHALE';
  if (s.includes('GLASSNODE')) return 'BTC';
  return 'BTC';
}

async function fetchTradeIntel() {
  try {
    const [newsRes, xRes] = await Promise.allSettled([
      fetch('/api/news'),
      fetch('/api/x-feed')
    ]);

    let items = [];

    if (newsRes.status === 'fulfilled' && newsRes.value.ok) {
      const data = await newsRes.value.json();
      const newsItems = (data.news || []).map(n => ({
        id:          n.title,
        source:      n.source || 'NEWS',
        category:    categorizSource(n.source),
        headline:    n.title || '',
        description: n.description || n.summary || '',
        time:        n.publishedAt || n.pubDate || null,
        link:        n.link || n.url || null,
        sentiment:   n.sentiment || 'neutral',
      }));
      items.push(...newsItems);
    }

    if (xRes.status === 'fulfilled' && xRes.value.ok) {
      const data = await xRes.value.json();
      const xItems = (data.items || []).map(x => ({
        id:          x.text,
        source:      x.handle || 'INTEL',
        category:    'GEO',
        headline:    x.text || '',
        description: '',
        time:        x.time || null,
        link:        x.link || null,
        sentiment:   'neutral',
      }));
      items.push(...xItems);
    }

    items.sort((a, b) => {
      const ta = a.time ? new Date(a.time).getTime() : 0;
      const tb = b.time ? new Date(b.time).getTime() : 0;
      return tb - ta;
    });

    state.tradeIntelItems = items;
    renderTradeIntel();
  } catch(e) {
    console.error('[TRADE-INTEL]', e.message);
  }
}

function renderTradeIntel() {
  const feed = document.getElementById('ti-feed');
  if (!feed) return;

  const active   = state.activeTiFilters;
  const filtered = state.tradeIntelItems.filter(item => active.has(item.category));

  if (!filtered.length) {
    feed.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:12px 10px;">Waiting for intelligence feed...</div>';
    return;
  }

  feed.innerHTML = filtered.map(item => {
    const timeStr = item.time
      ? new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
    const desc = item.description ? item.description.slice(0, 200) : '';
    const href = item.link ? `href="${escHtml(item.link)}" target="_blank" rel="noopener"` : '';
    return `<a class="ti-item sentiment-${escHtml(item.sentiment)}" ${href}>
      <div class="ti-top">
        <span class="ti-source ti-cat-${escHtml(item.category)}">${escHtml(item.source)}</span>
        <span class="ti-headline">${escHtml(item.headline)}</span>
        ${timeStr ? `<span class="ti-time">${timeStr}</span>` : ''}
      </div>
      ${desc ? `<div class="ti-preview">${escHtml(desc)}</div>` : ''}
      ${item.link ? `<div class="ti-readmore">→ Read full article</div>` : ''}
    </a>`;
  }).join('');
}

// ============================================================
// INIT
// ============================================================
window.addEventListener('load', () => {
  connect();
  if (window.SpatialPlanner) window.SpatialPlanner.init();
  setInterval(updateClock, 1000);
  updateClock();
  window.addEventListener('resize', () => drawChart());
  fetchTradeIntel();
  setInterval(fetchTradeIntel, 60000);

  document.querySelectorAll('.ti-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const f = pill.dataset.filter;
      if (state.activeTiFilters.has(f)) {
        state.activeTiFilters.delete(f);
        pill.classList.remove('active');
      } else {
        state.activeTiFilters.add(f);
        pill.classList.add('active');
      }
      renderTradeIntel();
    });
  });

  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activePeriod = btn.dataset.period;
      fetchSnapshotsForPeriod(activePeriod);
    });
  });
});

// ============================================================
// GEMINI CHAT
// ============================================================
async function fetchGeminiUsage() {
  try {
    const res  = await fetch('/api/gemini-usage');
    const data = await res.json();
    const el   = document.getElementById('gemini-usage-counter');
    if (el) {
      const left = data.dailyLimit - data.callCount;
      el.textContent = `${left}/${data.dailyLimit} calls left today`;
      el.style.color = left <= 3 ? 'var(--red)' : left <= 7 ? 'var(--amber)' : 'var(--text-muted)';
    }
  } catch (_) {}
}

function switchGeminiTab(tab) {
  document.getElementById('gemini-tab-reasoning').style.display = tab === 'reasoning' ? '' : 'none';
  document.getElementById('gemini-tab-chat').style.display      = tab === 'chat'      ? 'flex' : 'none';
  document.getElementById('tab-reasoning').classList.toggle('active', tab === 'reasoning');
  document.getElementById('tab-chat').classList.toggle('active', tab === 'chat');
  if (tab === 'chat') {
    const msgs = document.getElementById('gemini-chat-messages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
    document.getElementById('gemini-chat-input')?.focus();
    fetchGeminiUsage();
  }
}

function appendChatBubble(text, role) {
  const msgs = document.getElementById('gemini-chat-messages');
  if (!msgs) return null;
  const div = document.createElement('div');
  div.className = `chat-bubble ${role}`;
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

async function sendChatMessage() {
  const input  = document.getElementById('gemini-chat-input');
  const btn    = document.getElementById('gemini-chat-send');
  const msg    = input?.value?.trim();
  if (!msg) return;

  input.value = '';
  btn.disabled = true;

  appendChatBubble(msg, 'user');
  const typingBubble = appendChatBubble('Gemini is thinking...', 'typing');

  try {
    const res  = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    const data = await res.json();
    if (typingBubble) typingBubble.remove();
    if (res.status === 429) {
      appendChatBubble('⏳ ' + (data.error || 'Please wait a moment before sending again.'), 'typing');
    } else {
      appendChatBubble(data.reply || data.error || 'No response.', 'gemini');
    }
    fetchGeminiUsage();
  } catch (err) {
    if (typingBubble) typingBubble.remove();
    appendChatBubble('Connection error. Please try again.', 'gemini');
  } finally {
    btn.disabled = false;
    input?.focus();
  }
}

// Allow Enter key to send
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('gemini-chat-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
});
