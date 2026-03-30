// INVEST MONGO AI Terminal — WebSocket Client + Live Rendering

// ============================================================
// CONFIG
// ============================================================
const WS_URL = location.protocol === 'https:'
  ? `wss://${location.host}`
  : `ws://${location.host}`;

const STARTING_BALANCE = 10000;
const MAX_NEWS_LINES   = 12;
const NEWS_FADE_AFTER  = 8; // lines before this index start fading

// ============================================================
// STATE
// ============================================================
let state = {
  portfolio:  null,
  signals:    [],
  news:       [],
  snapshots:  [],
  fearGreed:  { value: 50, classification: 'Neutral' },
  newsCount:  0,
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
      renderPortfolio();
      renderPositions();
      break;

    case 'new_signal':
      if (msg.data?.signal) {
        state.signals.unshift(buildSignalRecord(msg.data));
        renderSignals();
        if (msg.data.decision) updateGeminiBox(msg.data.decision, msg.data.signal);
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
  const cursor = document.createElement('span');
  cursor.className = 'cursor-blink';
  feed.appendChild(cursor);
}

function trimNewsLines() {
  const feed  = document.getElementById('news-feed');
  const lines = feed.querySelectorAll('.news-line');
  if (lines.length > MAX_NEWS_LINES) {
    lines[0].classList.add('fading');
    setTimeout(() => lines[0].remove(), 600);
  }
}

function updateNewsCounter() {
  document.getElementById('news-counter').textContent =
    `${state.newsCount || state.news.length} items`;
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
// AUM CHART (Canvas)
// ============================================================
function drawChart() {
  const canvas = document.getElementById('aum-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // Resize canvas to container
  const container = canvas.parentElement;
  canvas.width    = container.clientWidth - 24;
  canvas.height   = container.clientHeight - 24;

  const W = canvas.width;
  const H = canvas.height;

  // Build data points
  let points = state.snapshots.map(s => ({
    value: s.total_value,
    time:  new Date(s.snapshot_at),
  }));

  // Always include starting point
  if (points.length === 0) {
    points = [
      { value: STARTING_BALANCE, time: new Date(Date.now() - 86400000) },
      { value: state.portfolio?.totalValue ?? STARTING_BALANCE, time: new Date() },
    ];
  }

  const values  = points.map(p => p.value);
  const minVal  = Math.min(...values) * 0.998;
  const maxVal  = Math.max(...values) * 1.002;
  const range   = maxVal - minVal || 1;

  const padL = 55, padR = 10, padT = 10, padB = 25;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  ctx.clearRect(0, 0, W, H);

  // Background grid
  ctx.strokeStyle = '#1e2d3d';
  ctx.lineWidth   = 0.5;
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const y = padT + (plotH / gridLines) * i;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();

    // Y labels
    const val = maxVal - (range / gridLines) * i;
    ctx.fillStyle = '#374151';
    ctx.font      = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`$${(val / 1000).toFixed(1)}k`, padL - 4, y + 3);
  }

  // X labels
  const labelStep = Math.max(1, Math.floor(points.length / 5));
  ctx.fillStyle = '#374151';
  ctx.font      = '9px monospace';
  ctx.textAlign = 'center';
  points.forEach((p, i) => {
    if (i % labelStep !== 0 && i !== points.length - 1) return;
    const x = padL + (i / (points.length - 1 || 1)) * plotW;
    const label = p.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ctx.fillText(label, x, H - 5);
  });

  if (points.length < 2) return;

  // Line gradient
  const isProfit = values[values.length - 1] >= values[0];
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, isProfit ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');

  // Fill area
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = padL + (i / (points.length - 1)) * plotW;
    const y = padT + plotH - ((p.value - minVal) / range) * plotH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  const lastX = padL + plotW;
  const lastY = padT + plotH;
  ctx.lineTo(lastX, lastY);
  ctx.lineTo(padL, lastY);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Main line
  ctx.beginPath();
  ctx.strokeStyle = isProfit ? '#4ade80' : '#f87171';
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  points.forEach((p, i) => {
    const x = padL + (i / (points.length - 1)) * plotW;
    const y = padT + plotH - ((p.value - minVal) / range) * plotH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Last point dot
  const lp  = points[points.length - 1];
  const lpx = padL + plotW;
  const lpy = padT + plotH - ((lp.value - minVal) / range) * plotH;
  ctx.beginPath();
  ctx.arc(lpx, lpy, 4, 0, Math.PI * 2);
  ctx.fillStyle = isProfit ? '#4ade80' : '#f87171';
  ctx.fill();
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
// X INTELLIGENCE FEED
// ============================================================
async function fetchXFeed() {
  try {
    const res  = await fetch('/api/x-feed');
    const data = await res.json();
    renderXFeed(data.items || []);
  } catch (e) {
    renderXFeedEmpty();
  }
}

function renderXFeed(items) {
  const feed = document.getElementById('x-feed');
  if (!feed) return;
  if (!items.length) {
    feed.innerHTML = '<div class="x-empty">Waiting for posts...</div>';
    return;
  }

  const html = items.map(item => {
    const d       = item.time ? new Date(item.time) : null;
    const timeStr = d && !isNaN(d)
      ? `[${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}]`
      : '';
    const text = (item.text || '').length > 100
      ? item.text.slice(0, 100) + '\u2026'
      : (item.text || '');
    const href = item.link ? ` href="${escHtml(item.link)}" target="_blank" rel="noopener"` : '';
    return `<a class="x-line"${href}>
      <span class="x-handle">${escHtml(item.handle || '')}</span>
      <span class="x-text">${escHtml(text)}</span>
      ${timeStr ? `<span class="x-time">${timeStr}</span>` : ''}
    </a>`;
  }).join('');

  // Fade out → replace → fade in
  feed.style.opacity = '0';
  feed.style.transition = 'opacity 0.15s';
  setTimeout(() => {
    feed.innerHTML = html;
    feed.style.opacity = '1';
    feed.style.transition = 'opacity 0.3s';
  }, 150);
}

function renderXFeedEmpty() {
  const feed = document.getElementById('x-feed');
  if (feed) feed.innerHTML = '<div class="x-empty">X feed temporarily unavailable</div>';
}

// ============================================================
// INIT
// ============================================================
window.addEventListener('load', () => {
  connect();
  setInterval(updateClock, 1000);
  updateClock();
  window.addEventListener('resize', () => drawChart());
  fetchXFeed();
  setInterval(fetchXFeed, 90000);
});
