// ============================================================
// ORDER FLOW — Hyperliquid WebSocket (browser-direct)
// l2Book + trades, follows the active asset on Spatial Planner
// ============================================================
(function () {
  'use strict';

  const HL_WS     = 'wss://api.hyperliquid.xyz/ws';
  const TICKER_MAP = { PEPE: 'kPEPE' };
  const DEPTH      = 10;   // order book levels per side
  const MAX_TRADES = 80;   // trade tape length

  let ws             = null;
  let currentCoin    = 'BTC';
  let reconnectTimer = null;
  let pingTimer      = null;

  function ticker(coin) { return TICKER_MAP[coin] || coin; }

  // ── Price / size formatters ──────────────────────────────
  function fmtPx(p) {
    const n = parseFloat(p);
    if (n >= 1000)  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (n >= 100)   return n.toFixed(1);
    if (n >= 1)     return n.toFixed(3);
    if (n >= 0.01)  return n.toFixed(5);
    if (n >= 0.001) return n.toFixed(6);
    return n.toFixed(8);
  }

  function fmtSz(s) {
    const n = parseFloat(s);
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    if (n >= 1)     return n.toFixed(2);
    return n.toFixed(4);
  }

  // ── WebSocket lifecycle ──────────────────────────────────
  function connect() {
    if (ws) { ws.onclose = null; ws.close(); }
    clearTimeout(reconnectTimer);
    clearInterval(pingTimer);

    ws = new WebSocket(HL_WS);

    ws.onopen = () => {
      console.log('[OB] connected');
      subscribe(currentCoin);
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 'ping' }));
      }, 20000);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.channel === 'l2Book') renderBook(msg.data);
        if (msg.channel === 'trades') renderTrades(msg.data);
      } catch (_) {}
    };

    ws.onclose = () => {
      clearInterval(pingTimer);
      console.log('[OB] disconnected — retry in 3s');
      reconnectTimer = setTimeout(connect, 3000);
    };

    ws.onerror = () => {};
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function subscribe(coin) {
    const t = ticker(coin);
    send({ method: 'subscribe', subscription: { type: 'l2Book', coin: t } });
    send({ method: 'subscribe', subscription: { type: 'trades',  coin: t } });
    const lbl = document.getElementById('ob-asset-label');
    if (lbl) lbl.textContent = coin;
  }

  function unsubscribe(coin) {
    const t = ticker(coin);
    send({ method: 'unsubscribe', subscription: { type: 'l2Book', coin: t } });
    send({ method: 'unsubscribe', subscription: { type: 'trades',  coin: t } });
  }

  // ── Asset switch ─────────────────────────────────────────
  function switchCoin(coin) {
    if (coin === currentCoin) return;
    unsubscribe(currentCoin);
    currentCoin = coin;

    // clear displays
    const asks = document.getElementById('ob-asks');
    const bids = document.getElementById('ob-bids');
    const tape = document.getElementById('ob-trades');
    if (asks) asks.innerHTML = '';
    if (bids) bids.innerHTML = '';
    if (tape) tape.innerHTML = '';
    const midPx = document.getElementById('ob-mid-price');
    const spread = document.getElementById('ob-spread-val');
    if (midPx)  midPx.textContent  = '--';
    if (spread) spread.textContent = 'spread --';

    subscribe(currentCoin);
  }

  // ── Render order book ────────────────────────────────────
  function renderBook(data) {
    const [bidsRaw, asksRaw] = data.levels || [[], []];
    if (!bidsRaw || !asksRaw) return;

    // top DEPTH levels; asks displayed in reverse so lowest ask is at bottom (closest to mid)
    const topAsks = asksRaw.slice(0, DEPTH).reverse();
    const topBids = bidsRaw.slice(0, DEPTH);

    const maxAsk = Math.max(...topAsks.map(l => parseFloat(l.sz)), 1e-9);
    const maxBid = Math.max(...topBids.map(l => parseFloat(l.sz)), 1e-9);

    const asksEl = document.getElementById('ob-asks');
    const bidsEl = document.getElementById('ob-bids');
    if (!asksEl || !bidsEl) return;

    asksEl.innerHTML = topAsks.map(l => {
      const pct = Math.min(100, parseFloat(l.sz) / maxAsk * 100).toFixed(1);
      return `<div class="ob-row ob-ask">
        <div class="ob-bar" style="width:${pct}%"></div>
        <span class="ob-price">${fmtPx(l.px)}</span>
        <span class="ob-size">${fmtSz(l.sz)}</span>
      </div>`;
    }).join('');

    bidsEl.innerHTML = topBids.map(l => {
      const pct = Math.min(100, parseFloat(l.sz) / maxBid * 100).toFixed(1);
      return `<div class="ob-row ob-bid">
        <div class="ob-bar" style="width:${pct}%"></div>
        <span class="ob-price">${fmtPx(l.px)}</span>
        <span class="ob-size">${fmtSz(l.sz)}</span>
      </div>`;
    }).join('');

    // mid price + spread
    const bestAsk = parseFloat(asksRaw[0]?.px || 0);
    const bestBid = parseFloat(bidsRaw[0]?.px || 0);
    if (bestAsk && bestBid) {
      const mid    = (bestAsk + bestBid) / 2;
      const spread = bestAsk - bestBid;
      const midEl  = document.getElementById('ob-mid-price');
      const sprEl  = document.getElementById('ob-spread-val');
      if (midEl) midEl.textContent = fmtPx(mid);
      if (sprEl) sprEl.textContent = 'spread ' + fmtPx(spread);
    }
  }

  // ── Render trade tape ────────────────────────────────────
  function renderTrades(trades) {
    const el = document.getElementById('ob-trades');
    if (!el) return;

    const frag = document.createDocumentFragment();
    for (const t of trades) {
      const isBuy = t.side === 'B';
      const d = new Date(t.time);
      const hh = d.getHours().toString().padStart(2, '0');
      const mm = d.getMinutes().toString().padStart(2, '0');
      const ss = d.getSeconds().toString().padStart(2, '0');

      const row = document.createElement('div');
      row.className = 'ob-trade ' + (isBuy ? 'buy' : 'sell');
      row.innerHTML =
        `<span class="ob-trade-dir">${isBuy ? '▲' : '▼'}</span>` +
        `<span class="ob-trade-px">${fmtPx(t.px)}</span>` +
        `<span class="ob-trade-sz">${fmtSz(t.sz)}</span>` +
        `<span class="ob-trade-time">${hh}:${mm}:${ss}</span>`;
      frag.appendChild(row);
    }

    // prepend new trades (newest at top)
    el.insertBefore(frag, el.firstChild);

    // trim to MAX_TRADES
    while (el.children.length > MAX_TRADES) el.removeChild(el.lastChild);
  }

  // ── Init ─────────────────────────────────────────────────
  function init() {
    connect();
    // Hook into Spatial Planner asset changes
    if (window.SpatialPlanner) {
      window.SpatialPlanner.onAssetChange = switchCoin;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
