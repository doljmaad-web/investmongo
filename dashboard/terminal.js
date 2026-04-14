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
// SESSION — who is viewing the terminal
// ============================================================
let sessionUser = null; // { is_admin, balance: { visible_balance_usd, deposited_usd, total_gain_usd } }

async function loadSessionUser() {
  const token = localStorage.getItem('dm_token');
  if (!token) return;
  try {
    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return;
    const { user, balance } = await res.json();
    sessionUser = { is_admin: !!user.is_admin, balance };
    // Show admin-only controls
    if (sessionUser.is_admin) {
      const closeAllBtn = document.getElementById('btn-close-all');
      if (closeAllBtn) closeAllBtn.style.display = '';
    }
  } catch (e) { /* not logged in */ }
}

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
let dockResizeTimer = null;

const LEFT_DOCK_STORAGE_KEY = 'invest-mongo-left-dock-v1';
let leftDockState = {
  signals: true,
  trend: true,
};

function loadLeftDockState() {
  try {
    const saved = JSON.parse(localStorage.getItem(LEFT_DOCK_STORAGE_KEY) || '{}');
    leftDockState = {
      ...leftDockState,
      ...saved,
    };
  } catch (_) {}
}

function persistLeftDockState() {
  try {
    localStorage.setItem(LEFT_DOCK_STORAGE_KEY, JSON.stringify(leftDockState));
  } catch (_) {}
}

function syncDockButtons(key, isOpen) {
  document.querySelectorAll(`[data-panel-toggle="${key}"]`).forEach(btn => {
    btn.setAttribute('aria-expanded', String(isOpen));
  });
}

function getVisibleDockSections() {
  return Array.from(document.querySelectorAll('#panel-left .left-dock-section')).filter(section => {
    return window.getComputedStyle(section).display !== 'none';
  });
}

function refreshLeftDockLayout() {
  const panelLeft = document.getElementById('panel-left');
  if (!panelLeft) return;
  const visibleSections = getVisibleDockSections();
  const hasOpenSection = visibleSections.some(section => !section.classList.contains('is-collapsed'));
  panelLeft.classList.toggle('panel-left-collapsed', visibleSections.length > 0 && !hasOpenSection);
}

function applyLeftDockState() {
  document.querySelectorAll('#panel-left .left-dock-section').forEach(section => {
    const key = section.dataset.dockKey;
    const isOpen = leftDockState[key] !== false;
    section.classList.toggle('is-collapsed', !isOpen);
    syncDockButtons(key, isOpen);
  });
  refreshLeftDockLayout();
}

function scheduleDockResize() {
  window.dispatchEvent(new Event('resize'));
  clearTimeout(dockResizeTimer);
  dockResizeTimer = setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
    drawChart();
  }, 320);
}

function toggleDockSection(key) {
  leftDockState[key] = leftDockState[key] === false;
  applyLeftDockState();
  persistLeftDockState();
  scheduleDockResize();
}

function initLeftDock() {
  loadLeftDockState();
  document.querySelectorAll('[data-panel-toggle]').forEach(btn => {
    btn.addEventListener('click', () => toggleDockSection(btn.dataset.panelToggle));
  });
  applyLeftDockState();
}
// ============================================================
// ADMIN TREND BIAS
// ============================================================
let currentTrendBias = 'neutral';

function getAdminToken() {
  return localStorage.getItem('dm_token') || null;
}

function isAdmin() {
  try {
    const u = JSON.parse(localStorage.getItem('dm_user'));
    return !!(u && u.is_admin);
  } catch { return false; }
}

async function loadTrendBias() {
  // Only show trend control section if logged-in admin
  if (isAdmin()) {
    const section = document.getElementById('trend-bias-section');
    if (section) {
      section.style.display = '';
      applyLeftDockState();
      scheduleDockResize();
    }
  }
  try {
    const r = await fetch('/api/trend-bias');
    const d = await r.json();
    applyTrendBias(d.bias || 'neutral');
  } catch (_) {}
}

async function setTrendBias(bias) {
  const token = getAdminToken();
  if (!token) return;
  try {
    await fetch('/api/trend-bias', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ bias }),
    });
    applyTrendBias(bias);
  } catch (_) {}
}

function applyTrendBias(bias) {
  currentTrendBias = bias;
  ['neutral','long','short'].forEach(b => {
    const btn = document.getElementById(`tbtn-${b}`);
    if (btn) btn.classList.toggle('active', b === bias);
  });
  const icon = document.getElementById('trend-status-icon');
  const text = document.getElementById('trend-status-text');
  if (!icon || !text) return;
  if (bias === 'neutral') {
    icon.textContent = 'N';
    text.textContent = 'Bot trading independently in both directions';
    text.style.color = 'var(--text-muted)';
  } else if (bias === 'long') {
    icon.textContent = 'L';
    text.textContent = 'LONG TREND active - bot aggressively hunting Yellow dot BUY entries. Short signals suppressed.';
    text.style.color = 'var(--green)';
  } else {
    icon.textContent = 'S';
    text.textContent = 'SHORT TREND active - bot aggressively hunting Pink dot SELL entries. Long signals suppressed.';
    text.style.color = 'var(--red)';
  }
}

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

  if (msg.type === 'trend_bias') {
    applyTrendBias(msg.data.bias);
    return;
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

  // Admin or not logged in → show full pool value
  // Regular logged-in user → show their personal balance
  const isPersonalView = sessionUser && !sessionUser.is_admin;
  const userBalance    = isPersonalView ? (sessionUser.balance?.visible_balance_usd ?? 0) : null;
  const userDeposited  = isPersonalView ? (sessionUser.balance?.deposited_usd ?? 0) : STARTING_BALANCE;

  const total   = isPersonalView ? userBalance : (p.totalValue ?? STARTING_BALANCE);
  const base    = isPersonalView ? userDeposited : STARTING_BALANCE;
  const diff    = total - base;
  const diffPct = base > 0 ? ((diff / base) * 100).toFixed(1) : '0.0';
  const isPos   = diff >= 0;

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
  document.getElementById('metric-today-sub').textContent = `${p.closedTodayCount ?? 0} closed today`;

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
  attachSignalPopups();
}

// ── Signal popup ─────────────────────────────────────────────
let activeSignalPopup = null;

function attachSignalPopups() {
  document.querySelectorAll('.signal-card[data-signal]').forEach(card => {
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeSignalPopup && activeSignalPopup._card === card) {
        closeSignalPopup(); return;
      }
      closeSignalPopup();
      openSignalPopup(card);
    });
  });
  document.addEventListener('click', closeSignalPopup, { once: false, capture: false });
}

function openSignalPopup(card) {
  let d;
  try { d = JSON.parse(card.getAttribute('data-signal')); } catch { return; }

  let newsHtml = '';
  try {
    const arr = JSON.parse(d.validated_news || '[]');
    if (arr.length) newsHtml = `<div class="sp-news">${arr.slice(0,3).map(n => `<p>• ${escHtml(n)}</p>`).join('')}</div>`;
  } catch {}

  const reasonHtml = d.gemini_reasoning
    ? `<div class="sp-reasoning">${escHtml(d.gemini_reasoning)}</div>` : '';

  const pop = document.createElement('div');
  pop.className = 'signal-popup';
  pop.innerHTML = `
    <div class="sp-header">
      <span class="sp-asset">${escHtml(d.asset)}</span>
      <span class="signal-dir ${d.action === 'BUY' ? 'buy' : 'sell'}">${d.action}</span>
      <span class="verdict-badge ${d.verdict}">${(d.gemini_verdict || 'PENDING')}</span>
    </div>
    <div class="sp-pills">
      ${d.signal_type ? `<span>${escHtml(d.signal_type)}</span>` : ''}
      ${d.rsi        ? `<span>RSI ${d.rsi}</span>` : ''}
      ${d.timeframe  ? `<span>${d.timeframe}</span>` : ''}
      ${d.pattern    ? `<span>${escHtml(d.pattern)}</span>` : ''}
      <span>${d.time}</span>
    </div>
    <div class="sp-conf-row">
      <span class="sp-conf-label">AI Confidence</span>
      <div class="conf-bar"><div class="conf-bar-fill ${d.confClass}" style="width:${d.confidence}%"></div></div>
      <span class="conf-pct">${d.confidence}%</span>
    </div>
    ${reasonHtml}
    ${newsHtml}`;

  pop.addEventListener('click', e => e.stopPropagation());
  pop._card = card;
  card.appendChild(pop);
  activeSignalPopup = pop;

  // flip up if near bottom
  const rect = card.getBoundingClientRect();
  if (window.innerHeight - rect.bottom < 160) pop.classList.add('flip-up');
}

function closeSignalPopup() {
  if (activeSignalPopup) {
    activeSignalPopup.remove();
    activeSignalPopup = null;
  }
}

function buildSignalCard(s) {
  const verdict    = (s.gemini_verdict || 'PENDING').toLowerCase();
  const confidence = s.gemini_confidence || 0;
  const confClass  = confidence >= 70 ? 'high' : confidence >= 50 ? 'medium' : 'low';
  const dirClass   = s.action === 'BUY' ? 'buy' : 'sell';
  const time       = formatTime(s.created_at);

  // encode popup data as JSON in data attribute
  const popupData = escHtml(JSON.stringify({
    asset: s.asset, action: s.action, signal_type: s.signal_type,
    rsi: s.rsi, timeframe: s.timeframe, pattern: s.pattern,
    confidence, confClass, verdict, gemini_verdict: s.gemini_verdict,
    gemini_reasoning: s.gemini_reasoning || '',
    validated_news: s.validated_news || '[]', time
  }));

  return `
    <div class="signal-card ${verdict}" data-signal='${popupData}'>
      <div class="sc-mini">
        <span class="signal-asset">${escHtml(s.asset || '--')}</span>
        <span class="signal-dir ${dirClass}">${s.action || '--'}</span>
        <span class="sc-type">${escHtml(s.signal_type || '--')}</span>
        <span class="sc-time">${time}</span>
      </div>
    </div>`;
}

// ============================================================
// ADMIN: Close all positions
// ============================================================
async function closeAllPositions() {
  const btn = document.getElementById('btn-close-all');
  const open = state.portfolio?.openTrades || [];
  if (open.length === 0) return alert('No open positions to close.');

  if (!confirm(`Close ALL ${open.length} open position(s) at market price?`)) return;

  btn.disabled = true;
  btn.textContent = 'Closing…';
  try {
    const res  = await fetch('/api/trades/close-all', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    alert(`✅ Closed ${data.closed} of ${data.total} position(s).`);
    await refreshPortfolio();
  } catch (e) {
    alert('❌ Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '⏻ CLOSE ALL';
  }
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
  closedHeader.style.display = 'block';
  if (closed.length > 0) {
    closedList.innerHTML = closed.map(t => {
      const isPos = t.pnl_usd >= 0;
      const dateStr = t.closed_at ? new Date(t.closed_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
      const timeStr = formatTime(t.closed_at);
      return `
        <div class="closed-trade-row">
          <span class="asset">${t.asset} ${t.direction}</span>
          <span class="pnl ${isPos ? 'pos' : 'neg'}">${fmtUSD(t.pnl_usd, true)}</span>
          <span class="time">${dateStr} ${timeStr}</span>
        </div>`;
    }).join('');
  } else {
    closedList.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:8px 0">No closed trades yet</div>';
  }
}

function buildPositionCard(t) {
  const isPos   = (t.pnl_usd || 0) >= 0;
  const dirClass = t.direction === 'LONG' ? 'long' : 'short';
  const pnlPct   = t.pnl_pct ? ` (${t.pnl_pct > 0 ? '+' : ''}${t.pnl_pct.toFixed(1)}%)` : '';
  return `
    <div class="position-card" id="pos-card-${t.id}">
      <div class="pos-header">
        <span class="pos-asset">${escHtml(t.asset)}</span>
        <span class="pos-dir ${dirClass}">${t.direction}</span>
        ${sessionUser?.is_admin ? `<button class="pos-close-btn" onclick="closePosition(${t.id}, this)" title="Close this position">✕ Close</button>` : ''}
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

async function closePosition(tradeId, btn) {
  if (!confirm(`Close position #${tradeId} at market price?`)) return;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res  = await fetch(`/api/trades/close/${tradeId}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    await refreshPortfolio();
  } catch (e) {
    alert('❌ Error: ' + e.message);
    btn.disabled = false;
    btn.textContent = '✕ Close';
  }
}

// ============================================================

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
  if (el) el.textContent = new Date().toLocaleTimeString('mn-MN', { timeZone: 'Asia/Ulaanbaatar', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
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
  // SQLite stores UTC without 'Z'; add it so the browser converts to local time correctly
  const normalized = isoStr.includes('T') ? isoStr : isoStr.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
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
window.addEventListener('load', async () => {
  await loadSessionUser(); // must run before first renderPortfolio
  initLeftDock();
  connect();
  if (window.SpatialPlanner) window.SpatialPlanner.init();
  setInterval(updateClock, 1000);
  updateClock();
  window.addEventListener('resize', () => drawChart());
  fetchTradeIntel();
  setInterval(fetchTradeIntel, 60000);
  loadTrendBias();

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

window.setTrendBias = setTrendBias;

