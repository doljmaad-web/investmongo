// ============================================================
// SPATIAL TRADE PLANNER v3 — Immersive Neon Candlestick Engine
// Self-contained IIFE. Exports window.SpatialPlanner.
// Touches nothing in terminal.js except the 2 wired calls.
// ============================================================
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  let canvas, ctx, animId;
  let W = 0, H = 0;
  let dpr = 1;
  let candles      = [];
  let plan         = null;
  let particles    = [];
  let currentPrice = 0;
  let frame        = 0;
  let priceTimer   = null;
  let candleTimer  = null;

  // ── Asset list ─────────────────────────────────────────────
  const ASSETS = ['BTC','ETH','SOL','XRP','DOGE','BNB','AVAX','LINK','ARB','SUI','ZEC','HYPE','TAO','PENDLE','PEPE'];
  const TICKER_MAP = { 'PEPE': 'kPEPE' }; // display name → Hyperliquid ticker
  function getTicker(coin) { return TICKER_MAP[coin] || coin; }

  let activeCoin     = 'BTC';
  let activeYear     = new Date().getFullYear();
  let activeInterval = '5m';
  let tradingMap     = new Map(); // asset → deploy_pct  (only active assets)
  let capitalInfo    = { totalValue: 10000, available: 10000, deployed: 0 };
  let tradePopup     = null;     // null | { coin, selectedPct }
  let precisionDots  = []; // { index, type: 'yellow'|'pink', price, rsi } — from chart scan
  let botSignalDots  = []; // { index, type, price, rsi, fromBot:true } — from live bot signals, persist across refreshes
  let sma50arr       = []; // SMA50 value per candle index (null if insufficient history)
  let sma200arr      = []; // SMA200 value per candle index

  // ── Drawing tool state ──────────────────────────────────────
  let drawTool     = 'pan';    // 'pan'|'line'|'hline'|'rect'|'channel'
  let drawColor    = '#f5c518';
  let drawings     = [];       // completed drawings
  let drawInProg   = null;     // { type, p1, p2, phase, offset }
  let drawHoverIdx = -1;
  const DRAW_COLORS = ['#f5c518','#e879a0','#26d987','#5ba8e0','#e8a020','#d8dfe8'];
  let _toolBtns = [], _colorBtns = [], _savBtn = null, _clrBtn = null;

  let assetDropdownOpen = false;
  let dropdownEl     = null;

  // ── View (zoom / pan) ──────────────────────────────────────
  let viewStart = 0;   // float index into candles[]
  let viewEnd   = 0;   // float index, exclusive
  let isDragging        = false;
  let dragStartX        = 0;
  let dragStartViewStart= 0;
  let pinchDist         = 0;
  let mouseX = -1, mouseY = -1;

  // ── Layout ─────────────────────────────────────────────────
  const PAD = { top: 60, bot: 24, left: 10, right: 88 };

  // ── Palette ────────────────────────────────────────────────
  const C = {
    bg:      '#0c0f12',
    panel:   '#111418',
    border:  '#1f2a35',
    green:   '#26d987',
    greenDim:'#0a2018',
    red:     '#e0455a',
    redDim:  '#2a0a10',
    amber:   '#e8a020',
    blue:    '#5ba8e0',
    purple:  '#8b7dd4',
    muted:   '#5a6a7a',
    dim:     '#1a2530',
    white:   '#d8dfe8',
  };

  function rgba(hex, a) {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${+Math.max(0,Math.min(1,a)).toFixed(3)})`;
  }

  // ── Price formatter (works for BTC ~$90k down to PEPE ~$0.000013) ─
  function fmtPrice(p) {
    if (!p && p !== 0) return '$--';
    if (p >= 1000) return '$' + Math.round(p).toLocaleString('en-US');
    if (p >= 100)  return '$' + p.toFixed(1);
    if (p >= 10)   return '$' + p.toFixed(2);
    if (p >= 1)    return '$' + p.toFixed(3);
    if (p >= 0.1)  return '$' + p.toFixed(4);
    if (p >= 0.01) return '$' + p.toFixed(5);
    if (p >= 0.001)return '$' + p.toFixed(6);
    return '$' + p.toFixed(8);
  }

  // ── Geometry ───────────────────────────────────────────────
  function plotW() { return W - PAD.left - PAD.right; }
  function plotH() { return H - PAD.top  - PAD.bot;   }

  let cachedHi = 100, cachedLo = 0;

  function priceY(p) {
    if (cachedHi === cachedLo) return PAD.top + plotH() / 2;
    return PAD.top + plotH() * (1 - (p - cachedLo) / (cachedHi - cachedLo));
  }

  function slotW() {
    const count = Math.max(1, viewEnd - viewStart);
    return plotW() / count;
  }

  function candleX(gi) {
    return PAD.left + (gi - viewStart) * slotW() + slotW() / 2;
  }

  function xToIdx(px) {
    return viewStart + (px - PAD.left) / slotW();
  }

  function yToPrice(py) {
    if (cachedHi === cachedLo) return (cachedHi + cachedLo) / 2;
    return cachedHi - (py - PAD.top) / plotH() * (cachedHi - cachedLo);
  }

  function lineAtIdx(p1, p2, idx) {
    if (!p1 || !p2 || p1.idx === p2.idx) return null;
    const m = (p2.price - p1.price) / (p2.idx - p1.idx);
    return p1.price + m * (idx - p1.idx);
  }

  function visRange() {
    const s = Math.max(0, Math.floor(viewStart));
    const e = Math.min(candles.length, Math.ceil(viewEnd));
    const vc = candles.slice(s, e);
    if (!vc.length) return { hi: 100, lo: 0 };
    let hi = -Infinity, lo = Infinity;
    vc.forEach(c => { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; });
    if (plan) {
      [plan.tp3, plan.tp2, plan.tp1, plan.entry, plan.sl].forEach(p => {
        if (p) { if (p > hi) hi = p; if (p < lo) lo = p; }
      });
    }
    const m = (hi - lo) * 0.05;
    return { hi: hi + m, lo: lo - m };
  }

  // empty candle slots to the right of the last candle (breathing room)
  const RIGHT_PAD = 12;

  // ── Zoom / pan ─────────────────────────────────────────────
  function clampView() {
    const n      = candles.length || 1;
    const maxEnd = n + RIGHT_PAD;
    const span   = viewEnd - viewStart;
    const s      = Math.max(5, Math.min(maxEnd, span));
    if (viewStart < 0)       { viewStart = 0; viewEnd = s; }
    if (viewEnd   > maxEnd)  { viewEnd = maxEnd; viewStart = maxEnd - s; }
    viewStart = Math.max(0, viewStart);
    viewEnd   = Math.min(maxEnd, viewEnd);
  }

  function zoomAt(focalX, factor) {
    const fi   = xToIdx(focalX);
    const span = viewEnd - viewStart;
    const ns   = Math.max(5, Math.min(candles.length + RIGHT_PAD, span / factor));
    const ratio= (fi - viewStart) / span;
    viewStart  = fi - ratio * ns;
    viewEnd    = viewStart + ns;
    clampView();
  }

  // ── Data ───────────────────────────────────────────────────
  async function loadCandles() {
    try {
      const ticker = getTicker(activeCoin);
      let url;
      if (activeInterval === '5m') {
        url = `/api/spatial/candles?coin=${ticker}&interval=5m&bars=400`;
      } else if (activeInterval === '1h') {
        url = `/api/spatial/candles?coin=${ticker}&interval=1h&bars=400`;
      } else if (activeInterval === '4h') {
        url = `/api/spatial/candles?coin=${ticker}&interval=4h&bars=300`;
      } else if (activeInterval === '1D') {
        url = `/api/spatial/candles?coin=${ticker}&interval=1d&year=${activeYear}`;
      } else if (activeInterval === '1W') {
        url = `/api/spatial/candles?coin=${ticker}&interval=1w&bars=200`;
      }
      const r = await fetch(url);
      if (!r.ok) return;
      const d = await r.json();
      if (d.candles && d.candles.length) {
        candles   = d.candles;
        viewEnd   = candles.length + RIGHT_PAD;
        viewStart = Math.max(0, viewEnd - 80);
        computeSMAs();
        runIndicatorScan();
        loadDrawings();
      }
    } catch (_) {}
  }

  async function fetchPrice() {
    try {
      const r = await fetch(`/api/spatial/price?coin=${getTicker(activeCoin)}`);
      if (!r.ok) return;
      const d = await r.json();
      if (!d.price) return;
      currentPrice = d.price;
      if (candles.length) {
        const last = candles[candles.length - 1];
        last.close = d.price;
        if (d.price > last.high) last.high = d.price;
        if (d.price < last.low)  last.low  = d.price;
      }
      if (plan) spawnPriceParts();
    } catch (_) {}
  }

  // ── Particles ──────────────────────────────────────────────
  class Pt {
    constructor(x, y, col, o = {}) {
      this.x = x; this.y = y; this.col = col;
      this.vx = o.vx !== undefined ? o.vx : (Math.random()-.5)*1.8;
      this.vy = o.vy !== undefined ? o.vy : (Math.random()-.5)*1.8;
      this.life  = 1;
      this.decay = o.decay || .012 + Math.random()*.014;
      this.size  = o.size  || 1.2 + Math.random()*1.8;
      this.trail = []; this.maxT = o.trail || 5;
    }
    tick() {
      this.trail.push({ x: this.x, y: this.y });
      if (this.trail.length > this.maxT) this.trail.shift();
      this.x += this.vx; this.y += this.vy;
      this.vx *= .994; this.vy *= .994;
      this.life -= this.decay;
    }
    draw() {
      if (this.life <= 0) return;
      this.trail.forEach((t, i) => {
        ctx.beginPath(); ctx.arc(t.x, t.y, this.size*.4, 0, Math.PI*2);
        ctx.fillStyle = rgba(this.col, (i/this.trail.length)*this.life*.18); ctx.fill();
      });
      ctx.beginPath(); ctx.arc(this.x, this.y, this.size, 0, Math.PI*2);
      ctx.fillStyle = rgba(this.col, this.life*.85); ctx.fill();
    }
  }

  function spawnPriceParts() {
    if (!candles.length || W === 0) return;
    const py  = priceY(currentPrice);
    const px  = PAD.left + plotW() - 4;
    const col = plan?.direction === 'LONG' ? C.green : C.red;
    for (let i = 0; i < 2; i++)
      particles.push(new Pt(px, py+(Math.random()-.5)*5, col,
        { vx:-.5-Math.random()*.9, vy:(Math.random()-.5)*.5, decay:.015, trail:4 }));
    if (particles.length > 400) particles.splice(0, particles.length-400);
  }

  function burstSignal(dir) {
    if (!plan || W === 0) return;
    const ey  = priceY(plan.entry);
    const col = dir === 'LONG' ? C.green : C.red;
    for (let i = 0; i < 110; i++)
      particles.push(new Pt(PAD.left+Math.random()*plotW(), ey+(Math.random()-.5)*30, col,
        { vx:(Math.random()-.5)*3, vy:(Math.random()-.5)*3, decay:.007, size:1.5+Math.random()*2.5, trail:8 }));
    for (let i = 0; i < 36; i++) {
      const a = (i/36)*Math.PI*2;
      particles.push(new Pt(PAD.left+plotW()/2, ey, C.purple,
        { vx:Math.cos(a)*2.8, vy:Math.sin(a)*2.8, decay:.02, size:1.2, trail:3 }));
    }
  }

  // ── roundRect ──────────────────────────────────────────────
  function rr(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x+r,y); c.lineTo(x+w-r,y);
    c.arcTo(x+w,y,x+w,y+r,r); c.lineTo(x+w,y+h-r);
    c.arcTo(x+w,y+h,x+w-r,y+h,r); c.lineTo(x+r,y+h);
    c.arcTo(x,y+h,x,y+h-r,r); c.lineTo(x,y+r);
    c.arcTo(x,y,x+r,y,r); c.closePath();
  }

  // ── Client-side Precision V9 indicator (O(n) single-pass Wilder RSI) ─
  function _buildRSIArr(closes, period) {
    const rsi = new Array(closes.length).fill(null);
    if (closes.length < period + 1) return rsi;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i-1];
      if (d > 0) avgGain += d; else avgLoss -= d;
    }
    avgGain /= period; avgLoss /= period;
    rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i-1];
      avgGain = (avgGain * (period-1) + (d > 0 ? d : 0)) / period;
      avgLoss = (avgLoss * (period-1) + (d < 0 ? -d  : 0)) / period;
      rsi[i]  = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return rsi;
  }

  function _getPatterns(slice) {
    if (slice.length < 2) return {};
    const cur = slice[slice.length - 1];
    const prv = slice[slice.length - 2];
    const bodySize = Math.abs(cur.open - cur.close);
    const range = cur.high - cur.low;
    return {
      isDoji: range > 0 && bodySize <= range * 0.1,
      isBullishEngulfing: cur.close > cur.open && cur.open < prv.close && cur.close > prv.open && bodySize > Math.abs(prv.open - prv.close),
      isBearishEngulfing: cur.close < cur.open && cur.open > prv.close && cur.close < prv.open && bodySize > Math.abs(prv.open - prv.close),
    };
  }

  function runIndicatorScan() {
    const rsiLen = 14, lookback = 10;
    const rsiObMin=40, rsiObMax=85, rsiOsMin=18, rsiOsMax=60;
    const minBars = rsiLen + lookback + 1;
    if (candles.length < minBars + 1) { precisionDots = []; return; }

    const closes = candles.map(c => c.close);
    const rsiArr = _buildRSIArr(closes, rsiLen); // O(n) — computed once for all bars

    const dots = [];
    for (let i = minBars; i < candles.length; i++) {
      const rsiNow  = rsiArr[i];
      const rsiPrev = rsiArr[i - 1];
      if (rsiNow === null || rsiPrev === null) continue;

      // 50-level memory window: max/min RSI over last 10 bars including current
      let rsiHigh10 = -Infinity, rsiLow10 = Infinity;
      for (let k = i - lookback + 1; k <= i; k++) {
        if (rsiArr[k] !== null) {
          if (rsiArr[k] > rsiHigh10) rsiHigh10 = rsiArr[k];
          if (rsiArr[k] < rsiLow10 ) rsiLow10  = rsiArr[k];
        }
      }

      const hookUp  = rsiNow > rsiPrev;
      const hookDown= rsiNow < rsiPrev;
      const osZone  = rsiNow >= rsiOsMin && rsiNow <= rsiOsMax && rsiHigh10 < 50;
      const obZone  = rsiNow >= rsiObMin && rsiNow <= rsiObMax && rsiLow10  > 50;

      const { isDoji, isBullishEngulfing, isBearishEngulfing } = _getPatterns(candles.slice(i - 1, i + 1));

      if (osZone && (isDoji || isBullishEngulfing) && hookUp) {
        dots.push({ index: i, type: 'yellow', price: candles[i].close, rsi: rsiNow });
      } else if (obZone && (isDoji || isBearishEngulfing) && hookDown) {
        dots.push({ index: i, type: 'pink',   price: candles[i].close, rsi: rsiNow });
      }
    }
    precisionDots = dots;
  }

  function computeSMAs() {
    const closes = candles.map(c => c.close);
    sma50arr  = [];
    sma200arr = [];
    for (let i = 0; i < closes.length; i++) {
      sma50arr.push( i >= 49  ? closes.slice(i-49, i+1).reduce((a,b)=>a+b,0)/50   : null);
      sma200arr.push(i >= 199 ? closes.slice(i-199,i+1).reduce((a,b)=>a+b,0)/200  : null);
    }
  }

  // ── Drawing: find nearest drawing to mouse ─────────────────
  function findNearestDrawing(mx, my) {
    const THRESH = 8;
    for (let i = drawings.length - 1; i >= 0; i--) {
      const d = drawings[i];
      if (d.type === 'hline') {
        if (Math.abs(priceY(d.price) - my) < THRESH) return i;
      } else if (d.type === 'line' || d.type === 'channel') {
        if (!d.p1 || !d.p2) continue;
        const idx = xToIdx(mx);
        const ep  = lineAtIdx(d.p1, d.p2, idx);
        if (ep !== null && Math.abs(priceY(ep) - my) < THRESH) return i;
        if (d.type === 'channel' && d.offset != null && ep !== null) {
          if (Math.abs(priceY(ep + d.offset) - my) < THRESH) return i;
        }
      } else if (d.type === 'rect') {
        if (!d.p1 || !d.p2) continue;
        const x1 = candleX(d.p1.idx), y1 = priceY(d.p1.price);
        const x2 = candleX(d.p2.idx), y2 = priceY(d.p2.price);
        const rx = Math.min(x1,x2), ry = Math.min(y1,y2);
        const rw = Math.abs(x2-x1), rh = Math.abs(y2-y1);
        const inside = mx>=rx-THRESH && mx<=rx+rw+THRESH && my>=ry-THRESH && my<=ry+rh+THRESH;
        const edge   = mx<rx+THRESH || mx>rx+rw-THRESH || my<ry+THRESH || my>ry+rh-THRESH;
        if (inside && edge) return i;
      }
    }
    return -1;
  }

  // ── Drawing: render all drawings + preview ──────────────────
  function drawDrawings() {
    const s = viewStart, e = viewEnd;

    drawings.forEach((d, i) => {
      const hover = i === drawHoverIdx;
      ctx.save();
      ctx.lineWidth   = hover ? 2.2 : 1.6;
      ctx.setLineDash([]);

      if (d.type === 'hline') {
        const y = priceY(d.price);
        if (y < PAD.top || y > PAD.top + plotH()) { ctx.restore(); return; }
        ctx.strokeStyle = rgba(d.color, hover ? 1 : 0.8);
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = rgba(d.color, hover ? 1 : 0.75);
        ctx.font = '9px Inter,"JetBrains Mono",monospace'; ctx.textAlign = 'right';
        ctx.fillText(fmtPrice(d.price), W - PAD.right - 3, y - 3);

      } else if (d.type === 'line' || d.type === 'channel') {
        if (!d.p1 || !d.p2) { ctx.restore(); return; }
        const lp = lineAtIdx(d.p1, d.p2, s);
        const rp = lineAtIdx(d.p1, d.p2, e);
        if (lp === null) { ctx.restore(); return; }
        ctx.strokeStyle = rgba(d.color, hover ? 1 : 0.85);
        ctx.beginPath();
        ctx.moveTo(PAD.left,      priceY(lp));
        ctx.lineTo(W - PAD.right, priceY(rp));
        ctx.stroke();
        if (d.type === 'channel' && d.offset != null) {
          ctx.strokeStyle = rgba(d.color, hover ? 0.7 : 0.5);
          ctx.setLineDash([5, 3]);
          ctx.beginPath();
          ctx.moveTo(PAD.left,      priceY(lp + d.offset));
          ctx.lineTo(W - PAD.right, priceY(rp + d.offset));
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 0.06;
          ctx.fillStyle = d.color;
          ctx.beginPath();
          ctx.moveTo(PAD.left,      priceY(lp));
          ctx.lineTo(W - PAD.right, priceY(rp));
          ctx.lineTo(W - PAD.right, priceY(rp + d.offset));
          ctx.lineTo(PAD.left,      priceY(lp + d.offset));
          ctx.closePath(); ctx.fill();
          ctx.globalAlpha = 1;
        }

      } else if (d.type === 'rect') {
        if (!d.p1 || !d.p2) { ctx.restore(); return; }
        const x1 = candleX(d.p1.idx), y1 = priceY(d.p1.price);
        const x2 = candleX(d.p2.idx), y2 = priceY(d.p2.price);
        const rx = Math.min(x1,x2), ry = Math.min(y1,y2);
        const rw = Math.abs(x2-x1), rh = Math.abs(y2-y1);
        ctx.strokeStyle = rgba(d.color, hover ? 1 : 0.8);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.fillStyle = rgba(d.color, 0.07);
        ctx.fillRect(rx, ry, rw, rh);
      }
      ctx.restore();
    });

    // In-progress preview
    if (!drawInProg) return;
    const { type, p1, p2, phase, offset } = drawInProg;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(drawColor, 0.7);
    ctx.setLineDash([5, 3]);

    if (type === 'hline' && p1) {
      const y = priceY(p1.price);
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();

    } else if (type === 'line' && p1 && p2) {
      const lp = lineAtIdx(p1, p2, s), rp = lineAtIdx(p1, p2, e);
      if (lp !== null) {
        ctx.beginPath();
        ctx.moveTo(PAD.left,      priceY(lp));
        ctx.lineTo(W - PAD.right, priceY(rp));
        ctx.stroke();
      }

    } else if (type === 'channel' && p1 && p2) {
      const lp = lineAtIdx(p1, p2, s), rp = lineAtIdx(p1, p2, e);
      if (lp !== null) {
        ctx.beginPath();
        ctx.moveTo(PAD.left,      priceY(lp));
        ctx.lineTo(W - PAD.right, priceY(rp));
        ctx.stroke();
        if (phase === 2 && offset != null) {
          ctx.strokeStyle = rgba(drawColor, 0.45);
          ctx.beginPath();
          ctx.moveTo(PAD.left,      priceY(lp + offset));
          ctx.lineTo(W - PAD.right, priceY(rp + offset));
          ctx.stroke();
        }
      }

    } else if (type === 'rect' && p1 && p2) {
      const x1 = candleX(p1.idx), y1 = priceY(p1.price);
      const x2 = candleX(p2.idx), y2 = priceY(p2.price);
      ctx.strokeRect(Math.min(x1,x2), Math.min(y1,y2), Math.abs(x2-x1), Math.abs(y2-y1));
      ctx.fillStyle = rgba(drawColor, 0.05);
      ctx.fillRect(Math.min(x1,x2), Math.min(y1,y2), Math.abs(x2-x1), Math.abs(y2-y1));
    }
    ctx.restore();
  }

  // ── Draw: trend ribbon (fill between SMA50/SMA200) ─────────
  function drawTrendRibbon() {
    if (!sma50arr.length || !sma200arr.length) return;
    const s = Math.max(0, Math.floor(viewStart));
    const e = Math.min(candles.length, Math.ceil(viewEnd));
    ctx.save();
    ctx.globalAlpha = 0.07;
    // Find segments where both SMAs are defined
    let segStart = -1;
    for (let gi = s; gi <= e; gi++) {
      const v50  = sma50arr[gi];
      const v200 = sma200arr[gi];
      const hasBoth = v50 !== null && v200 !== null;
      if (hasBoth && segStart < 0) { segStart = gi; }
      if ((!hasBoth || gi === e) && segStart >= 0) {
        const segEnd = hasBoth ? gi : gi - 1;
        // Draw ribbon for this segment
        ctx.beginPath();
        for (let j = segStart; j <= segEnd; j++) ctx[j===segStart?'moveTo':'lineTo'](candleX(j), priceY(sma50arr[j]));
        for (let j = segEnd; j >= segStart; j--) ctx.lineTo(candleX(j), priceY(sma200arr[j]));
        ctx.closePath();
        const bull = sma50arr[segEnd] > sma200arr[segEnd];
        ctx.fillStyle = bull ? C.green : C.red;
        ctx.fill();
        segStart = hasBoth ? gi : -1;
      }
    }
    ctx.restore();
  }

  // ── Draw: SMA lines ────────────────────────────────────────
  function drawSMALines() {
    const s = Math.max(0, Math.floor(viewStart));
    const e = Math.min(candles.length, Math.ceil(viewEnd));
    // SMA50 — blue
    ctx.save();
    ctx.lineWidth = 1.2; ctx.setLineDash([]);
    ctx.strokeStyle = rgba(C.blue, 0.7);
    ctx.beginPath();
    let started50 = false;
    for (let gi = s; gi < e; gi++) {
      if (sma50arr[gi] === null) { started50 = false; continue; }
      started50 ? ctx.lineTo(candleX(gi), priceY(sma50arr[gi])) : ctx.moveTo(candleX(gi), priceY(sma50arr[gi]));
      started50 = true;
    }
    ctx.stroke();
    // SMA200 — red
    ctx.strokeStyle = rgba(C.red, 0.7);
    ctx.beginPath();
    let started200 = false;
    for (let gi = s; gi < e; gi++) {
      if (sma200arr[gi] === null) { started200 = false; continue; }
      started200 ? ctx.lineTo(candleX(gi), priceY(sma200arr[gi])) : ctx.moveTo(candleX(gi), priceY(sma200arr[gi]));
      started200 = true;
    }
    ctx.stroke();

    // ── SMA labels at right edge ─────────────────────────────
    ctx.font = 'bold 9px Inter,"JetBrains Mono",monospace';
    ctx.textAlign = 'left';
    // SMA50 label
    const last50 = sma50arr[Math.min(Math.ceil(viewEnd)-1, sma50arr.length-1)];
    if (last50 !== null && last50 !== undefined) {
      ctx.fillStyle = rgba(C.blue, 0.9);
      ctx.fillText('SMA50', W - PAD.right + 2, priceY(last50) + 3);
    }
    // SMA200 label
    const last200 = sma200arr[Math.min(Math.ceil(viewEnd)-1, sma200arr.length-1)];
    if (last200 !== null && last200 !== undefined) {
      ctx.fillStyle = rgba(C.red, 0.9);
      ctx.fillText('SMA200', W - PAD.right + 2, priceY(last200) + 3);
    }
    ctx.restore();
  }

  // ── Draw: drawing toolbar (second header row y:34–60) ───────
  function drawToolbar() {
    const ROW_Y = 36, BTN_H = 18;
    // Divider
    ctx.strokeStyle = rgba(C.border, 0.5); ctx.lineWidth = 0.5; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(0, 34); ctx.lineTo(W, 34); ctx.stroke();

    _toolBtns = [];
    const tools = [
      { key:'pan',     label:'↖ PAN'   },
      { key:'line',    label:'/ LINE'  },
      { key:'hline',   label:'─ H-LVL' },
      { key:'rect',    label:'▭ ZONE'  },
      { key:'channel', label:'═ CHAN'  },
    ];
    let bx = PAD.left + 2;
    tools.forEach(t => {
      const bw = 44;
      const isActive = drawTool === t.key;
      ctx.fillStyle = isActive ? rgba(C.amber, 0.9) : rgba(C.border, 0.85);
      rr(ctx, bx, ROW_Y, bw, BTN_H, 3); ctx.fill();
      if (isActive) {
        ctx.strokeStyle = rgba(C.amber, 0.7); ctx.lineWidth = 0.7;
        rr(ctx, bx, ROW_Y, bw, BTN_H, 3); ctx.stroke();
      }
      ctx.fillStyle = isActive ? '#000' : rgba(C.white, 0.8);
      ctx.font = (isActive ? 'bold ' : '') + '9px Inter,"JetBrains Mono",monospace';
      ctx.textAlign = 'center';
      ctx.fillText(t.label, bx + bw/2, ROW_Y + 12);
      _toolBtns.push({ x: bx, y: ROW_Y, w: bw, h: BTN_H, key: t.key });
      bx += bw + 3;
    });

    // Color swatches
    _colorBtns = [];
    const swatchCY = ROW_Y + BTN_H/2;
    let cx = bx + 12;
    DRAW_COLORS.forEach(col => {
      const active = col === drawColor;
      ctx.beginPath(); ctx.arc(cx, swatchCY, active ? 7 : 5, 0, Math.PI*2);
      ctx.fillStyle = col; ctx.fill();
      if (active) {
        ctx.strokeStyle = rgba(C.white, 0.9); ctx.lineWidth = 1.5; ctx.stroke();
      }
      _colorBtns.push({ x: cx-9, y: swatchCY-9, w: 18, h: 18, col });
      cx += 19;
    });

    // SAVE button
    const savW = 38, savH = BTN_H, savX = W - PAD.right - savW - 34;
    ctx.fillStyle = rgba(C.green, 0.15); rr(ctx, savX, ROW_Y, savW, savH, 3); ctx.fill();
    ctx.strokeStyle = rgba(C.green, 0.55); ctx.lineWidth = 0.6;
    rr(ctx, savX, ROW_Y, savW, savH, 3); ctx.stroke();
    ctx.fillStyle = C.green; ctx.font = '9px Inter,"JetBrains Mono",monospace'; ctx.textAlign = 'center';
    ctx.fillText('SAVE', savX + savW/2, ROW_Y + 12);
    _savBtn = { x: savX, y: ROW_Y, w: savW, h: savH };

    // CLR button
    const clrW = 28, clrX = savX + savW + 4;
    ctx.fillStyle = rgba(C.red, 0.12); rr(ctx, clrX, ROW_Y, clrW, savH, 3); ctx.fill();
    ctx.strokeStyle = rgba(C.red, 0.5); ctx.lineWidth = 0.6;
    rr(ctx, clrX, ROW_Y, clrW, savH, 3); ctx.stroke();
    ctx.fillStyle = C.red; ctx.font = '9px Inter,"JetBrains Mono",monospace'; ctx.textAlign = 'center';
    ctx.fillText('CLR', clrX + clrW/2, ROW_Y + 12);
    _clrBtn = { x: clrX, y: ROW_Y, w: clrW, h: savH };

    // Hint: right-click to delete
    if (drawHoverIdx >= 0) {
      ctx.fillStyle = rgba(C.muted, 0.7);
      ctx.font = '8px Inter,"JetBrains Mono",monospace'; ctx.textAlign = 'right';
      ctx.fillText('right-click to delete', W - PAD.right - 70, ROW_Y + 12);
    }
  }

  // ── Draw: grid ─────────────────────────────────────────────
  function drawGrid() {
    const steps = 6;
    ctx.setLineDash([2,5]); ctx.lineWidth = .35;
    for (let i = 0; i <= steps; i++) {
      const p = cachedLo + (cachedHi-cachedLo)*(i/steps);
      const y = priceY(p);
      ctx.strokeStyle = rgba(C.border,.7);
      ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(W-PAD.right,y); ctx.stroke();
      ctx.fillStyle = rgba(C.white,.95); ctx.font='bold 11px Inter,"JetBrains Mono",monospace'; ctx.textAlign='right';
      ctx.fillText(fmtPrice(p), W-2, y+3.5);
    }
    ctx.setLineDash([]);

    // X labels: time (HH:MM) for intraday, or date for daily+
    const span = viewEnd - viewStart;
    const s = Math.max(0,Math.floor(viewStart));
    const e = Math.min(candles.length,Math.ceil(viewEnd));
    ctx.fillStyle=rgba(C.white,.72); ctx.font='bold 10px Inter,"JetBrains Mono",monospace'; ctx.textAlign='center';
    const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const isIntraday = activeInterval === '5m' || activeInterval === '1h' || activeInterval === '4h';
    if (isIntraday) {
      // Show HH:MM labels, avoid overlap by spacing
      const step = Math.max(1, Math.floor(span / 8));
      let lastDay = -1;
      for (let gi = s; gi < e; gi += step) {
        const d = new Date(candles[gi].time);
        const day = d.getDate();
        const hh  = d.getHours().toString().padStart(2,'0');
        const mm  = d.getMinutes().toString().padStart(2,'0');
        const lbl = day !== lastDay ? `${d.getMonth()+1}/${day}` : `${hh}:${mm}`;
        if (day !== lastDay) {
          lastDay = day;
          const x = candleX(gi);
          ctx.strokeStyle=rgba(C.border,.35); ctx.lineWidth=.3; ctx.setLineDash([2,6]);
          ctx.beginPath(); ctx.moveTo(x,PAD.top); ctx.lineTo(x,PAD.top+plotH()); ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.fillText(lbl, candleX(gi), H-6);
      }
    } else if (span > 20) {
      let lastMo = -1;
      for (let gi = s; gi < e; gi++) {
        const mo = new Date(candles[gi].time).getMonth();
        if (mo !== lastMo) {
          lastMo = mo;
          const x = candleX(gi);
          ctx.strokeStyle=rgba(C.border,.35); ctx.lineWidth=.3; ctx.setLineDash([2,6]);
          ctx.beginPath(); ctx.moveTo(x,PAD.top); ctx.lineTo(x,PAD.top+plotH()); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillText(MONTHS[mo], x, H-6);
        }
      }
    } else {
      const step = Math.max(1,Math.floor((e-s)/8));
      for (let gi = s; gi < e; gi += step) {
        const d   = new Date(candles[gi].time);
        const lbl = (d.getMonth()+1)+'/'+d.getDate();
        ctx.fillText(lbl, candleX(gi), H-6);
      }
    }
  }

  // ── Draw: volume bars ──────────────────────────────────────
  function drawVolume() {
    const s = Math.max(0,Math.floor(viewStart));
    const e = Math.min(candles.length,Math.ceil(viewEnd));
    const vc  = candles.slice(s,e);
    const maxV= Math.max(...vc.map(c=>c.volume),1);
    const maxH= plotH()*.1;
    const base= PAD.top+plotH();
    const bw  = Math.max(1, slotW()*.65);
    for (let gi=s; gi<e; gi++) {
      const c   = candles[gi];
      const bull= c.close>=c.open;
      const x   = candleX(gi);
      const h   = (c.volume/maxV)*maxH;
      ctx.fillStyle=rgba(bull?C.green:C.red,.18);
      ctx.fillRect(x-bw/2, base-h, bw, h);
    }
  }

  // ── Draw: neon candlesticks ────────────────────────────────
  function drawCandles() {
    const s  = Math.max(0,Math.floor(viewStart));
    const e  = Math.min(candles.length,Math.ceil(viewEnd));
    const sw = slotW();
    const bw = Math.max(1.5, sw*.68);
    const compact = sw < 4;

    for (let gi = s; gi < e; gi++) {
      const c    = candles[gi];
      const bull = c.close >= c.open;
      const col  = bull ? C.green : C.red;
      const dim  = bull ? C.greenDim : C.redDim;
      const x    = candleX(gi);
      const isLast = gi === candles.length-1;

      const bTop = priceY(Math.max(c.open,c.close));
      const bBot = priceY(Math.min(c.open,c.close));
      const bH   = Math.max(1, bBot-bTop);
      const wTop = priceY(c.high);
      const wBot = priceY(c.low);

      if (compact) {
        ctx.strokeStyle=rgba(col,.65); ctx.lineWidth=Math.max(1,bw);
        ctx.beginPath(); ctx.moveTo(x,wTop); ctx.lineTo(x,wBot); ctx.stroke();
        continue;
      }

      // wick
      ctx.strokeStyle=rgba(col, isLast ? .95 : .7); ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(x,wTop); ctx.lineTo(x,wBot); ctx.stroke();

      // body — solid fill
      ctx.fillStyle=rgba(col, isLast ? .95 : .80);
      ctx.fillRect(x-bw/2, bTop, bw, bH);

      // border — slightly brighter on last candle
      ctx.strokeStyle=rgba(col, isLast ? 1 : .9); ctx.lineWidth=isLast ? 1.2 : .6;
      ctx.strokeRect(x-bw/2, bTop, bw, bH);
    }
  }

  // ── Draw: Precision V9 dots ────────────────────────────────
  function drawPrecisionDots() {
    // Merge scan dots + live bot dots (bot dots fill any gaps due to timing)
    const allDots = [...precisionDots];
    for (const bd of botSignalDots) {
      if (!allDots.some(d => Math.abs(d.index - bd.index) <= 1 && d.type === bd.type))
        allDots.push(bd);
    }
    if (!allDots.length) return;

    const s  = Math.max(0, Math.floor(viewStart));
    const e  = Math.min(candles.length, Math.ceil(viewEnd));
    const sw = slotW();
    const r  = Math.max(5, Math.min(9, sw * 0.55)); // scales with zoom

    allDots.forEach(dot => {
      if (dot.index < s || dot.index >= e) return;
      const c = candles[dot.index];
      if (!c) return;
      const x   = candleX(dot.index);
      const isY = dot.type === 'yellow';
      const col = isY ? '#f5c518' : '#e879a0';
      const yDot= isY ? priceY(c.low) + r + 4 : priceY(c.high) - r - 4;

      ctx.save();

      // Outer glow
      ctx.shadowColor = col;
      ctx.shadowBlur  = 14;
      ctx.beginPath(); ctx.arc(x, yDot, r, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      ctx.shadowBlur = 0;

      // Inner bright core
      ctx.beginPath(); ctx.arc(x, yDot, r * 0.45, 0, Math.PI * 2);
      ctx.fillStyle = rgba('#ffffff', 0.55); ctx.fill();

      // Arrow + label (only when candle is wide enough to read)
      if (sw > 4) {
        ctx.fillStyle = col;
        ctx.font = `bold ${Math.min(11, Math.max(8, sw * 0.9))}px Inter,"JetBrains Mono",monospace`;
        ctx.textAlign = 'center';
        if (isY) {
          ctx.fillText('▲', x, yDot + r + 11);
          if (dot.rsi != null && sw > 8) {
            ctx.font = `8px Inter,"JetBrains Mono",monospace`;
            ctx.fillStyle = rgba(col, 0.75);
            ctx.fillText('RSI ' + dot.rsi.toFixed(0), x, yDot + r + 21);
          }
        } else {
          ctx.fillText('▼', x, yDot - r - 3);
          if (dot.rsi != null && sw > 8) {
            ctx.font = `8px Inter,"JetBrains Mono",monospace`;
            ctx.fillStyle = rgba(col, 0.75);
            ctx.fillText('RSI ' + dot.rsi.toFixed(0), x, yDot - r - 13);
          }
        }
      }

      // Bot-fired badge (small B marker)
      if (dot.fromBot) {
        ctx.fillStyle = rgba(col, 0.9);
        ctx.font = 'bold 7px Inter,"JetBrains Mono",monospace';
        ctx.textAlign = 'center';
        ctx.fillText('●BOT', x, isY ? yDot + r + (sw > 8 ? 32 : 21) : yDot - r - (sw > 8 ? 23 : 13));
      }

      ctx.restore();
    });
  }

  // ── Draw: plan zones & levels ──────────────────────────────
  function drawPlanZones() {
    if (!plan) return;
    const dir = plan.direction;
    if (plan.tp1 && plan.entry) {
      const y1=priceY(dir==='LONG'?plan.tp1:plan.entry);
      const y2=priceY(dir==='LONG'?plan.entry:plan.tp1);
      ctx.fillStyle=rgba(C.green,.04); ctx.fillRect(PAD.left,Math.min(y1,y2),plotW(),Math.abs(y2-y1));
    }
    if (plan.sl && plan.entry) {
      const y1=priceY(dir==='LONG'?plan.entry:plan.sl);
      const y2=priceY(dir==='LONG'?plan.sl:plan.entry);
      ctx.fillStyle=rgba(C.red,.04); ctx.fillRect(PAD.left,Math.min(y1,y2),plotW(),Math.abs(y2-y1));
    }
  }

  function drawPlanLevels() {
    if (!plan) return;
    [
      { p:plan.tp3, col:rgba(C.green,.3), lbl:'TP3', dash:true  },
      { p:plan.tp2, col:rgba(C.green,.55),lbl:'TP2', dash:true  },
      { p:plan.tp1, col:rgba(C.green,.88),lbl:'TP1', dash:true  },
      { p:plan.entry,col:C.amber,          lbl:'ENTRY',dash:false},
      { p:plan.sl,  col:rgba(C.red,.88),  lbl:'SL',  dash:true  },
    ].forEach(({ p, col, lbl, dash }) => {
      if (!p) return;
      const y = priceY(p);
      if (y < PAD.top || y > PAD.top+plotH()) return;
      ctx.setLineDash(dash?[5,4]:[]); ctx.lineWidth=dash?.8:1.2; ctx.strokeStyle=col;
      ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(W-PAD.right+2,y); ctx.stroke();
      ctx.setLineDash([]);
      const txt=lbl+' '+fmtPrice(p);
      const pw=txt.length*5.6+8; const ph=13; const px=W-pw-2;
      ctx.fillStyle=rgba(col,.15); rr(ctx,px,y-ph/2,pw,ph,2); ctx.fill();
      ctx.strokeStyle=rgba(col,.55); ctx.lineWidth=.5; rr(ctx,px,y-ph/2,pw,ph,2); ctx.stroke();
      ctx.fillStyle=col; ctx.font='bold 7.5px Inter,"JetBrains Mono",monospace'; ctx.textAlign='left';
      ctx.fillText(txt, px+4, y+3);
    });
  }

  // ── Draw: live price line ──────────────────────────────────
  function drawLivePrice() {
    if (!currentPrice || !candles.length) return;
    const y   = priceY(currentPrice);
    if (y < PAD.top || y > PAD.top+plotH()) return;
    const col = plan?(plan.direction==='LONG'?C.green:C.red):C.blue;
    ctx.setLineDash([2,3]); ctx.lineWidth=.6; ctx.strokeStyle=rgba(col,.35);
    ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(PAD.left+plotW(),y); ctx.stroke();
    ctx.setLineDash([]);
    const lbl=fmtPrice(currentPrice);
    const tw=lbl.length*7.8+14; const ph=18;
    ctx.fillStyle=col; rr(ctx,W-tw-2,y-ph/2,tw,ph,2); ctx.fill();
    ctx.fillStyle='#000'; ctx.font='bold 11px Inter,"JetBrains Mono",monospace'; ctx.textAlign='right';
    ctx.fillText(lbl, W-6, y+4);
  }

  // ── Draw: crosshair + tooltip ──────────────────────────────
  function drawCrosshair() {
    if (mouseX < PAD.left || mouseX > W-PAD.right) return;
    if (mouseY < PAD.top  || mouseY > PAD.top+plotH()) return;
    ctx.setLineDash([3,4]); ctx.lineWidth=.5; ctx.strokeStyle=rgba(C.muted,.3);
    ctx.beginPath(); ctx.moveTo(mouseX,PAD.top); ctx.lineTo(mouseX,PAD.top+plotH()); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PAD.left,mouseY); ctx.lineTo(PAD.left+plotW(),mouseY); ctx.stroke();
    ctx.setLineDash([]);
    const price=cachedLo+(cachedHi-cachedLo)*(1-(mouseY-PAD.top)/plotH());
    ctx.fillStyle=rgba(C.white,.75); ctx.font='9px Inter,"JetBrains Mono",monospace'; ctx.textAlign='right';
    ctx.fillText(fmtPrice(price), W-2, mouseY+3);
    const idx=Math.round(xToIdx(mouseX));
    if (idx>=0 && idx<candles.length) {
      const c=candles[idx]; const bull=c.close>=c.open;
      const col=bull?C.green:C.red;
      const d=new Date(c.time);
      const dStr=d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
      const pct=((c.close-c.open)/c.open*100).toFixed(2);
      const fp=p=>fmtPrice(p).slice(1); // strip $ for compact OHLC display
      const info=`${dStr}   O:${fp(c.open)}  H:${fp(c.high)}  L:${fp(c.low)}  C:${fp(c.close)}  (${pct>0?'+':''}${pct}%)`;
      const tw=info.length*5.3+16;
      let tx=mouseX-tw/2;
      tx=Math.max(PAD.left, Math.min(W-PAD.right-tw,tx));
      ctx.fillStyle=rgba(C.panel,.94); rr(ctx,tx,PAD.top+4,tw,16,2); ctx.fill();
      ctx.strokeStyle=rgba(col,.4); ctx.lineWidth=.5; rr(ctx,tx,PAD.top+4,tw,16,2); ctx.stroke();
      ctx.fillStyle=col; ctx.font='8px Inter,"JetBrains Mono",monospace'; ctx.textAlign='left';
      ctx.fillText(info, tx+8, PAD.top+15);
    }
  }

  // ── Asset dropdown (HTML overlay) ──────────────────────────
  function createDropdown() {
    const el = document.createElement('div');
    el.id = 'asset-dropdown';
    el.style.cssText = [
      'position:absolute','z-index:200','background:#111418',
      'border:1px solid #1f2a35','border-radius:6px','padding:6px',
      'display:none','grid-template-columns:repeat(5,1fr)','gap:4px',
      'box-shadow:0 8px 30px rgba(0,0,0,.85)','min-width:280px'
    ].join(';');
    ASSETS.forEach(coin => {
      const btn = document.createElement('button');
      btn.textContent = coin;
      btn.style.cssText = [
        'border:none','padding:6px 4px','border-radius:3px','cursor:pointer',
        'font:bold 11px Inter,"JetBrains Mono",monospace','width:100%','text-align:center',
        'transition:background .15s'
      ].join(';');
      const updateStyle = () => {
        const active = coin === activeCoin;
        btn.style.background = active ? '#e8a020' : '#1a2530';
        btn.style.color      = active ? '#000' : '#d8dfe8';
      };
      updateStyle();
      btn.addEventListener('mouseover', () => { if (coin !== activeCoin) btn.style.background = '#2a3a4a'; });
      btn.addEventListener('mouseout',  updateStyle);
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        if (coin !== activeCoin) {
          activeCoin = coin; candles = []; precisionDots = [];
          sma50arr = []; sma200arr = [];
          loadCandles();
          if (window.SpatialPlanner?.onAssetChange) window.SpatialPlanner.onAssetChange(coin);
        }
        closeDropdown();
      });
      el.appendChild(btn);
    });
    canvas.parentElement.style.position = 'relative';
    canvas.parentElement.appendChild(el);
    dropdownEl = el;
    document.addEventListener('click', ev => {
      if (assetDropdownOpen && !el.contains(ev.target)) closeDropdown();
    });
  }

  function openDropdown() {
    if (!dropdownEl) return;
    // refresh active state on all buttons
    Array.from(dropdownEl.children).forEach((btn, i) => {
      const active = ASSETS[i] === activeCoin;
      btn.style.background = active ? '#e8a020' : '#1a2530';
      btn.style.color      = active ? '#000' : '#d8dfe8';
    });
    // position below the trigger
    const trigW = 88;
    const trigX = W / 2 - trigW / 2;
    dropdownEl.style.left = trigX + 'px';
    dropdownEl.style.top  = (PAD.top + 4) + 'px';
    dropdownEl.style.display = 'grid';
    assetDropdownOpen = true;
  }

  function closeDropdown() {
    if (dropdownEl) dropdownEl.style.display = 'none';
    assetDropdownOpen = false;
  }

  // ── Trading asset management ────────────────────────────────
  async function fetchTradingAssets() {
    try {
      const [ta, cap] = await Promise.all([
        fetch('/api/trading/assets').then(r => r.json()),
        fetch('/api/capital').then(r => r.json()),
      ]);
      tradingMap  = new Map((ta.assets || []).map(a => [a.asset, a.deploy_pct]));
      capitalInfo = { totalValue: cap.totalValue || 10000, available: cap.available || 10000, deployed: cap.deployed || 0 };
    } catch (e) {}
  }

  async function applyTradeAsset(coin, active, deployPct) {
    try {
      const r = await fetch('/api/trading/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset: coin, active, deploy_pct: deployPct }),
      });
      const d = await r.json();
      tradingMap = new Map((d.assets || []).map(a => [a.asset, a.deploy_pct]));
    } catch (e) {}
    await fetchTradingAssets(); // refresh capital too
  }

  function openTradePopup(coin) {
    fetchTradingAssets(); // refresh capital before showing popup
    const currentPct = tradingMap.has(coin) ? tradingMap.get(coin) : 25;
    tradePopup = { coin, selectedPct: currentPct };
  }

  function closeTradePopup() { tradePopup = null; }

  // ── Draw: header bar ───────────────────────────────────────
  function drawHeader() {
    // background + bottom border
    ctx.fillStyle = rgba(C.bg, .96); ctx.fillRect(0, 0, W, PAD.top);
    drawToolbar();
    ctx.strokeStyle = rgba(C.border, .8); ctx.lineWidth = .5; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(0, PAD.top); ctx.lineTo(W, PAD.top); ctx.stroke();

    // ── Interval buttons (left) ──
    const btnLabels = ['5m','1h','4h','1D','1W'];
    const btnW=32, btnH=20, btnGap=4;
    let bx = PAD.left + 4;
    btnLabels.forEach(lbl => {
      const isActive = lbl === activeInterval;
      ctx.fillStyle = isActive ? C.amber : rgba(C.border, 1);
      rr(ctx, bx, 6, btnW, btnH, 3); ctx.fill();
      if (isActive) { ctx.strokeStyle=rgba(C.amber,.6); ctx.lineWidth=.6; rr(ctx,bx,6,btnW,btnH,3); ctx.stroke(); }
      ctx.fillStyle = isActive ? '#000' : rgba(C.white, .88);
      ctx.font = isActive ? 'bold 10px Inter,"JetBrains Mono",monospace' : '10px Inter,"JetBrains Mono",monospace';
      ctx.textAlign = 'center';
      ctx.fillText(lbl, bx + btnW/2, 20);
      bx += btnW + btnGap;
    });

    // ── Asset dropdown trigger (center) ──
    const trigW = 88, trigH = 20;
    const trigX = W / 2 - trigW / 2;
    ctx.fillStyle = rgba(C.border, 1);
    rr(ctx, trigX, 6, trigW, trigH, 3); ctx.fill();
    ctx.strokeStyle = rgba(C.amber, .5); ctx.lineWidth = .6;
    rr(ctx, trigX, 6, trigW, trigH, 3); ctx.stroke();
    ctx.fillStyle = rgba(C.white, .98);
    ctx.font = 'bold 12px Inter,"JetBrains Mono",monospace'; ctx.textAlign = 'center';
    ctx.fillText(activeCoin + '  ▾', W / 2, 21);

    // ── TRADE toggle button (right of asset dropdown) ──
    const tradeBtnX = W/2 + trigW/2 + 6;
    const tradeBtnW = 54, tradeBtnH = 20;
    const isTrading = tradingMap.has(activeCoin);
    ctx.fillStyle = isTrading ? rgba(C.green, .18) : rgba(C.border, 1);
    rr(ctx, tradeBtnX, 6, tradeBtnW, tradeBtnH, 3); ctx.fill();
    ctx.strokeStyle = isTrading ? rgba(C.green, .75) : rgba(C.muted, .35);
    ctx.lineWidth = isTrading ? 1 : 0.5;
    rr(ctx, tradeBtnX, 6, tradeBtnW, tradeBtnH, 3); ctx.stroke();
    ctx.fillStyle = isTrading ? C.green : rgba(C.white, .4);
    ctx.font = isTrading ? 'bold 9px Inter,"JetBrains Mono",monospace' : '9px Inter,"JetBrains Mono",monospace';
    ctx.textAlign = 'center';
    ctx.fillText(isTrading ? '● TRADE' : '○ TRADE', tradeBtnX + tradeBtnW/2, 20);

    // ── Plan badge / waiting (right) ──
    if (plan) {
      const dir=plan.direction; const dc=dir==='LONG'?C.green:C.red; const db=dir==='LONG'?'#052e16':'#450a0a';
      ctx.fillStyle=db; rr(ctx,W-PAD.right-88,6,36,20,3); ctx.fill();
      ctx.strokeStyle=dc; ctx.lineWidth=.6; rr(ctx,W-PAD.right-88,6,36,20,3); ctx.stroke();
      ctx.fillStyle=dc; ctx.font='bold 10px Inter,"JetBrains Mono",monospace'; ctx.textAlign='center';
      ctx.fillText(dir, W-PAD.right-70, 20);
      const conv=Math.min(1,(plan.conviction||5)/10);
      const cc=conv>.7?C.green:conv>.4?C.amber:C.red;
      const barX=W-PAD.right-48;
      ctx.fillStyle=C.border; rr(ctx,barX,13,44,6,2); ctx.fill();
      ctx.fillStyle=cc;       rr(ctx,barX,13,44*conv,6,2); ctx.fill();
    } else {
      ctx.fillStyle=rgba(C.muted,.35); ctx.font='10px Inter,"JetBrains Mono",monospace'; ctx.textAlign='right';
      ctx.fillText('no signal', W-PAD.right-4, 20);
    }
  }

  // ── Sidebar panel ──────────────────────────────────────────
  function updateSidebar() {
    if (!plan) return;
    const set=(id,v)=>{ const el=document.getElementById(id); if(el&&v!=null) el.textContent=v; };
    const fmt=p=>p?fmtPrice(p):'--';
    set('sp-asset', plan.asset);
    set('sp-entry', fmt(plan.entry));
    set('sp-tp1',   fmt(plan.tp1));
    set('sp-tp2',   fmt(plan.tp2));
    set('sp-tp3',   fmt(plan.tp3));
    set('sp-sl',    fmt(plan.sl));
    set('sp-rr',    plan.rr||'--');
    set('sp-conv',  Math.round((plan.conviction||5)/10*100)+'%');
    set('sp-thesis',plan.reasoning||'');
    const cb=document.getElementById('sp-conv-bar');
    if(cb) cb.style.width=Math.round((plan.conviction||5)/10*100)+'%';
    const sd=document.getElementById('sp-direction');
    if(sd){ sd.textContent=plan.direction; sd.className='sp-dir-badge '+(plan.direction==='LONG'?'long':'short'); }
    const sp=document.getElementById('sp-panel');
    if(sp) sp.classList.add('active');

    const sigEl=document.getElementById('sp-signal-details');
    if (sigEl && plan._signal) {
      const s=plan._signal;
      sigEl.innerHTML=`
        <div class="sp-detail-row"><span>Pattern</span><span>${s.pattern||'--'}</span></div>
        <div class="sp-detail-row"><span>RSI</span><span>${s.rsi?s.rsi.toFixed(1):'--'}</span></div>
        <div class="sp-detail-row"><span>Timeframe</span><span>${s.timeframe||'--'}</span></div>
        <div class="sp-detail-row"><span>Dot Type</span><span class="sp-dot-type ${s.dotType}">${s.dotType==='yellow'?'● Accumulation':s.dotType==='pink'?'● Distribution':'--'}</span></div>
      `;
    }
  }

  // ── Trade popup ─────────────────────────────────────────────
  function drawTradePopup() {
    if (!tradePopup) return;
    const { coin, selectedPct } = tradePopup;
    const isActive = tradingMap.has(coin);

    const pw = 300, ph = 168;
    const px = W/2 - pw/2;
    const py = PAD.top + 10;

    // dim backdrop
    ctx.fillStyle = rgba(C.bg, .72);
    ctx.fillRect(0, 0, W, H);

    // popup box
    ctx.fillStyle = C.panel; rr(ctx, px, py, pw, ph, 6); ctx.fill();
    ctx.strokeStyle = rgba(C.amber, .55); ctx.lineWidth = 1;
    rr(ctx, px, py, pw, ph, 6); ctx.stroke();

    // ── Title ──
    ctx.fillStyle = C.amber;
    ctx.font = 'bold 11px Inter,"JetBrains Mono",monospace'; ctx.textAlign = 'left';
    ctx.fillText('▶ TRADE  ' + coin, px+12, py+18);
    // ✕ close
    ctx.fillStyle = rgba(C.white, .45); ctx.font = '11px Inter,"JetBrains Mono",monospace'; ctx.textAlign = 'right';
    ctx.fillText('✕', px+pw-10, py+18);
    tradePopup._closeBtn = { x: px+pw-24, y: py+6, w: 20, h: 16 };

    // divider
    ctx.strokeStyle = rgba(C.border, .6); ctx.lineWidth = .5; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(px+10, py+26); ctx.lineTo(px+pw-10, py+26); ctx.stroke();

    // ── Capital info ──
    const avail = capitalInfo.available;
    const total = capitalInfo.totalValue;
    const availPct = total > 0 ? Math.round(avail / total * 100) : 100;
    ctx.fillStyle = rgba(C.white, .55); ctx.font = '9px Inter,"JetBrains Mono",monospace'; ctx.textAlign = 'left';
    ctx.fillText('AVAILABLE', px+12, py+42);
    ctx.fillStyle = rgba(C.white, .9); ctx.font = 'bold 11px Inter,"JetBrains Mono",monospace';
    ctx.fillText('$' + avail.toLocaleString('en-US', {maximumFractionDigits:0}) + '  (' + availPct + '%)', px+82, py+42);

    // computed trade size preview
    const tradeSize = (avail * selectedPct / 100);
    ctx.fillStyle = rgba(C.white, .55); ctx.font = '9px Inter,"JetBrains Mono",monospace';
    ctx.fillText('PER TRADE', px+12, py+56);
    ctx.fillStyle = C.green; ctx.font = 'bold 11px Inter,"JetBrains Mono",monospace';
    ctx.fillText(selectedPct + '% → $' + tradeSize.toLocaleString('en-US', {maximumFractionDigits:0}), px+82, py+56);

    // ── % preset buttons ──
    ctx.fillStyle = rgba(C.white, .55); ctx.font = '9px Inter,"JetBrains Mono",monospace';
    ctx.fillText('DEPLOY %', px+12, py+76);
    tradePopup._pctBtns = [];
    const presets = [10, 25, 50, 75];
    const bw = 46, bh = 20, gap = 6;
    const rowX = px + pw - (presets.length*(bw+gap)-gap) - 10;
    presets.forEach((pct, i) => {
      const bx = rowX + i*(bw+gap), by = py+63;
      const active = selectedPct === pct;
      ctx.fillStyle = active ? rgba(C.amber, .9) : rgba(C.border, .9);
      rr(ctx, bx, by, bw, bh, 3); ctx.fill();
      if (active) { ctx.strokeStyle = rgba(C.amber, .5); ctx.lineWidth = .6; rr(ctx, bx, by, bw, bh, 3); ctx.stroke(); }
      ctx.fillStyle = active ? '#000' : rgba(C.white, .75);
      ctx.font = active ? 'bold 10px Inter,"JetBrains Mono",monospace' : '10px Inter,"JetBrains Mono",monospace';
      ctx.textAlign = 'center';
      ctx.fillText(pct + '%', bx+bw/2, by+14);
      tradePopup._pctBtns.push({ x: bx, y: by, w: bw, h: bh, pct });
    });

    // ── Action buttons ──
    const actY = py+ph-38;
    // Cancel
    const cancelW=80, cancelH=22;
    ctx.fillStyle=rgba(C.border,.8); rr(ctx, px+10, actY, cancelW, cancelH, 3); ctx.fill();
    ctx.fillStyle=rgba(C.white,.6); ctx.font='10px Inter,"JetBrains Mono",monospace'; ctx.textAlign='center';
    ctx.fillText('CANCEL', px+10+cancelW/2, actY+15);
    tradePopup._cancelBtn = { x: px+10, y: actY, w: cancelW, h: cancelH };

    if (isActive) {
      // Stop button
      const stopW=80, stopH=22;
      const stopX = px+10+cancelW+8;
      ctx.fillStyle=rgba(C.red,.25); rr(ctx, stopX, actY, stopW, stopH, 3); ctx.fill();
      ctx.strokeStyle=rgba(C.red,.5); ctx.lineWidth=.6; rr(ctx, stopX, actY, stopW, stopH, 3); ctx.stroke();
      ctx.fillStyle=C.red; ctx.font='bold 10px Inter,"JetBrains Mono",monospace';
      ctx.fillText('STOP', stopX+stopW/2, actY+15);
      tradePopup._stopBtn = { x: stopX, y: actY, w: stopW, h: stopH };

      // Update button
      const updW=70, updH=22;
      const updX = px+pw-10-updW;
      ctx.fillStyle=rgba(C.green,.25); rr(ctx, updX, actY, updW, updH, 3); ctx.fill();
      ctx.strokeStyle=rgba(C.green,.6); ctx.lineWidth=.6; rr(ctx, updX, actY, updW, updH, 3); ctx.stroke();
      ctx.fillStyle=C.green; ctx.font='bold 10px Inter,"JetBrains Mono",monospace';
      ctx.fillText('UPDATE', updX+updW/2, actY+15);
      tradePopup._updateBtn = { x: updX, y: actY, w: updW, h: updH };
      tradePopup._stopBtn   = { x: stopX, y: actY, w: stopW, h: stopH };
    } else {
      // Activate button
      const actW=pw-10-cancelW-8-10, actH=22;
      const actX=px+10+cancelW+8;
      ctx.fillStyle=rgba(C.green,.25); rr(ctx, actX, actY, actW, actH, 3); ctx.fill();
      ctx.strokeStyle=rgba(C.green,.7); ctx.lineWidth=.7; rr(ctx, actX, actY, actW, actH, 3); ctx.stroke();
      ctx.fillStyle=C.green; ctx.font='bold 10px Inter,"JetBrains Mono",monospace'; ctx.textAlign='center';
      ctx.fillText('ACTIVATE  ' + coin, actX+actW/2, actY+15);
      tradePopup._activateBtn = { x: actX, y: actY, w: actW, h: actH };
    }
  }

  // ── Idle animation ─────────────────────────────────────────
  function drawIdle() {
    const sy=((frame*.25)%(H-PAD.top-PAD.bot))+PAD.top;
    ctx.fillStyle=rgba(C.purple,.03); ctx.fillRect(PAD.left,sy,plotW(),2);
    ctx.fillStyle=rgba(C.muted,.22); ctx.font='10px Inter,"JetBrains Mono",monospace'; ctx.textAlign='center';
    ctx.fillText('▸ SPATIAL TRADE PLANNER', W/2, H/2-8);
    ctx.fillStyle=rgba(C.muted,.12); ctx.font='8px Inter,"JetBrains Mono",monospace';
    ctx.fillText('Loading '+activeCoin+' '+activeInterval+' data...', W/2, H/2+8);
  }

  // ── Resize ─────────────────────────────────────────────────
  function resize() {
    if (!canvas) return;
    const p = canvas.parentElement.getBoundingClientRect();
    W = p.width  || 600;
    H = p.height || 300;
    dpr = window.devicePixelRatio || 1;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ── Events ─────────────────────────────────────────────────
  function attachEvents() {
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      zoomAt(e.offsetX, e.deltaY < 0 ? 1.13 : 0.88);
    }, { passive: false });

    canvas.addEventListener('mousedown', e => {
      const rect = canvas.getBoundingClientRect();
      const ox = e.clientX - rect.left;
      const oy = e.clientY - rect.top;

      // Drawing tools intercept chart-area clicks
      if (drawTool !== 'pan' && oy > PAD.top) {
        const idx   = xToIdx(ox);
        const price = yToPrice(oy);

        if (drawTool === 'hline') {
          drawings.push({ id: null, type:'hline', color:drawColor, price });
          return;
        }
        if (drawTool === 'channel' && drawInProg && drawInProg.phase === 2) {
          drawings.push({ id: null, type:'channel', color:drawColor,
            p1: drawInProg.p1, p2: drawInProg.p2, offset: drawInProg.offset || 0 });
          drawInProg = null;
          return;
        }
        drawInProg = { type: drawTool, p1: { idx, price }, p2: { idx, price }, phase: 1 };
        return;
      }

      // Pan mode
      isDragging        = true;
      dragStartX        = ox;
      dragStartViewStart= viewStart;
      if (drawTool === 'pan') canvas.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      mouseX = e.clientX - rect.left;
      mouseY = e.clientY - rect.top;

      if (drawInProg && mouseY > PAD.top) {
        const idx   = xToIdx(mouseX);
        const price = yToPrice(mouseY);
        if (drawInProg.phase === 1) {
          drawInProg.p2 = { idx, price };
        } else if (drawInProg.phase === 2) {
          // Channel offset: vertical distance from main line at current x
          const mainP = lineAtIdx(drawInProg.p1, drawInProg.p2, idx);
          drawInProg.offset = mainP !== null ? price - mainP : 0;
        }
        return;
      }

      if (mouseY > PAD.top) {
        drawHoverIdx = findNearestDrawing(mouseX, mouseY);
      } else {
        drawHoverIdx = -1;
      }

      if (!isDragging) return;
      const dx   = mouseX - dragStartX;
      const span = viewEnd - viewStart;
      viewStart  = dragStartViewStart - dx / slotW();
      viewEnd    = viewStart + span;
      clampView();
    });

    window.addEventListener('mouseup', () => {
      if (drawInProg) {
        const { type, p1, p2, phase } = drawInProg;
        if (type === 'channel' && phase === 1 && p2 && p1.idx !== p2.idx) {
          // Transition to phase 2 — wait for next click to set offset
          drawInProg = { type:'channel', p1, p2, phase:2, offset:0 };
        } else if (p2 && p1.idx !== p2.idx) {
          drawings.push({ id:null, type, color:drawColor, p1, p2 });
          drawInProg = null;
        } else if (type !== 'channel') {
          drawInProg = null;
        }
        return;
      }
      isDragging = false;
      if (canvas) canvas.style.cursor = 'crosshair';
    });

    canvas.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (drawHoverIdx < 0) return;
      const removed = drawings.splice(drawHoverIdx, 1)[0];
      if (removed && removed.id) deleteDrawing(removed.id);
      drawHoverIdx = -1;
    });

    canvas.addEventListener('mouseleave', () => { mouseX = -1; mouseY = -1; });

    canvas.addEventListener('touchstart', e => {
      if (e.touches.length===1) {
        isDragging=true; dragStartX=e.touches[0].clientX; dragStartViewStart=viewStart;
      } else if (e.touches.length===2) {
        isDragging=false;
        pinchDist=Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
      }
    },{ passive:true });
    canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length===1 && isDragging) {
        const dx=e.touches[0].clientX-dragStartX;
        const span=viewEnd-viewStart;
        viewStart=dragStartViewStart-dx/slotW();
        viewEnd=viewStart+span; clampView();
      } else if (e.touches.length===2) {
        const nd=Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
        const mx=(e.touches[0].clientX+e.touches[1].clientX)/2;
        const rect=canvas.getBoundingClientRect();
        zoomAt(mx-rect.left, nd/Math.max(pinchDist,1));
        pinchDist=nd;
      }
    },{ passive:false });
    canvas.addEventListener('touchend',()=>{ isDragging=false; });
    window.addEventListener('resize', resize);

    // Header clicks — interval buttons + asset dropdown trigger
    canvas.addEventListener('click', e => {
      // ── Popup intercepts all clicks while open ──
      if (tradePopup) {
        const p = tradePopup;
        const hit = (r, ex, ey) => r && ex>=r.x && ex<=r.x+r.w && ey>=r.y && ey<=r.y+r.h;
        if (hit(p._closeBtn,  e.offsetX, e.offsetY)) { closeTradePopup(); return; }
        if (hit(p._cancelBtn, e.offsetX, e.offsetY)) { closeTradePopup(); return; }
        if (hit(p._activateBtn, e.offsetX, e.offsetY)) {
          applyTradeAsset(p.coin, true, p.selectedPct);
          closeTradePopup(); return;
        }
        if (hit(p._updateBtn, e.offsetX, e.offsetY)) {
          applyTradeAsset(p.coin, true, p.selectedPct);
          closeTradePopup(); return;
        }
        if (hit(p._stopBtn, e.offsetX, e.offsetY)) {
          applyTradeAsset(p.coin, false, p.selectedPct);
          closeTradePopup(); return;
        }
        for (const btn of (p._pctBtns || [])) {
          if (hit(btn, e.offsetX, e.offsetY)) { tradePopup.selectedPct = btn.pct; return; }
        }
        return; // swallow clicks outside popup buttons while open
      }

      if (e.offsetY > PAD.top) return;

      // Drawing toolbar (second row y:34–60)
      if (e.offsetY >= 34 && e.offsetY < 60) {
        const hit = (r, ex, ey) => r && ex>=r.x && ex<=r.x+r.w && ey>=r.y && ey<=r.y+r.h;
        for (const btn of _toolBtns) {
          if (hit(btn, e.offsetX, e.offsetY)) { drawTool = btn.key; drawInProg = null; return; }
        }
        for (const btn of _colorBtns) {
          if (hit(btn, e.offsetX, e.offsetY)) { drawColor = btn.col; return; }
        }
        if (_savBtn && hit(_savBtn, e.offsetX, e.offsetY)) { saveDrawings(); return; }
        if (_clrBtn && hit(_clrBtn, e.offsetX, e.offsetY)) { clearDrawings(); return; }
        return;
      }

      // Interval buttons (left)
      const btnLabels=['5m','1h','4h','1D','1W'];
      const btnW=32, btnH=20, btnGap=4;
      let bx=PAD.left+4;
      for (const lbl of btnLabels) {
        if (e.offsetX>=bx && e.offsetX<=bx+btnW && e.offsetY>=6 && e.offsetY<=6+btnH) {
          if (lbl !== activeInterval) { activeInterval=lbl; candles=[]; loadCandles(); }
          return;
        }
        bx += btnW + btnGap;
      }

      // Asset dropdown trigger (center)
      const trigW=88, trigH=20;
      const trigX=W/2-trigW/2;
      if (e.offsetX>=trigX && e.offsetX<=trigX+trigW && e.offsetY>=6 && e.offsetY<=6+trigH) {
        e.stopPropagation(); // prevent bubbling to document which would close it immediately
        if (assetDropdownOpen) closeDropdown(); else openDropdown();
        return;
      }

      // TRADE button — opens popup
      const tradeBtnX=W/2+trigW/2+6;
      const tradeBtnW=54, tradeBtnH=20;
      if (e.offsetX>=tradeBtnX && e.offsetX<=tradeBtnX+tradeBtnW && e.offsetY>=6 && e.offsetY<=6+tradeBtnH) {
        e.stopPropagation();
        openTradePopup(activeCoin);
        return;
      }
    });
  }

  // ── Drawing persistence ─────────────────────────────────────
  async function loadDrawings() {
    try {
      const r = await fetch(`/api/drawings?coin=${activeCoin}&interval=${activeInterval}`);
      if (!r.ok) return;
      drawings = await r.json();
    } catch (_) {}
  }

  async function saveDrawings() {
    for (const d of drawings) {
      if (d.id) continue; // already saved
      try {
        const r = await fetch('/api/drawings', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ coin:activeCoin, interval:activeInterval, type:d.type, data:d }),
        });
        if (r.ok) { const j = await r.json(); d.id = j.id; }
      } catch (_) {}
    }
  }

  async function deleteDrawing(id) {
    try { await fetch(`/api/drawings/${id}`, { method:'DELETE' }); } catch (_) {}
  }

  function clearDrawings() {
    drawings.forEach(d => { if (d.id) deleteDrawing(d.id); });
    drawings = [];
    drawInProg = null;
  }

  // ── Main loop ───────────────────────────────────────────────
  function loop() {
    animId = requestAnimationFrame(loop);
    frame++;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0,0,W,H);

    if (!candles.length) { drawIdle(); drawHeader(); return; }

    const range = visRange();
    cachedHi = range.hi; cachedLo = range.lo;

    drawVolume();
    drawGrid();
    drawTrendRibbon();
    drawSMALines();
    drawDrawings();
    drawPlanZones();
    drawCandles();
    drawPrecisionDots();
    drawPlanLevels();
    drawLivePrice();

    particles = particles.filter(p => p.life > 0);
    particles.forEach(p => { p.tick(); p.draw(); });
    if (frame%8===0 && currentPrice>0 && plan) spawnPriceParts();

    drawCrosshair();
    drawHeader();

    // plan timestamp bottom-right
    if (plan?.timestamp) {
      ctx.fillStyle=rgba(C.dim,1); ctx.font='8px Inter,"JetBrains Mono",monospace'; ctx.textAlign='right';
      ctx.fillText('PLAN @ '+new Date(plan.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),
        W-PAD.right, H-6);
    }

    drawTradePopup();
  }

  // ── Public API ─────────────────────────────────────────────
  window.SpatialPlanner = {

    onAssetChange: null, // set by orderbook.js to receive asset switch events

    init() {
      canvas = document.getElementById('spatial-canvas');
      if (!canvas) return;
      ctx = canvas.getContext('2d');
      resize();
      canvas.style.cursor = 'crosshair';
      attachEvents();
      createDropdown();
      if (animId) cancelAnimationFrame(animId);
      loop();
      loadCandles();
      priceTimer  = setInterval(fetchPrice, 5000);
      candleTimer = setInterval(loadCandles, 15*60*1000);
      fetchPrice();
      fetchTradingAssets();
    },

    onSignal(signalData, decision) {
      if (!signalData || !decision) return;
      const price = signalData.price || currentPrice;
      const dir   = (signalData.signal||'').toUpperCase()==='BUY'?'LONG':'SHORT';
      plan = {
        asset:      signalData.asset||'BTC',
        direction:  dir,
        entry:      decision.entry||price,
        sl:         decision.stop_loss,
        tp1:        decision.take_profit,
        tp2:        decision.take_profit ? decision.take_profit*(dir==='LONG'?1.012:.988) : null,
        tp3:        decision.take_profit ? decision.take_profit*(dir==='LONG'?1.025:.975) : null,
        rr:         decision.rr_ratio||'--',
        conviction: decision.confidence||5,
        rangeHigh:  price*1.015,
        rangeLow:   price*.985,
        timestamp:  Date.now(),
        reasoning:  decision.reasoning?.summary||'',
      };
      if (decision.analysis?.rangeHigh) plan.rangeHigh=decision.analysis.rangeHigh;
      if (decision.analysis?.rangeLow)  plan.rangeLow =decision.analysis.rangeLow;
      plan._signal = {
        pattern:   signalData.pattern||signalData.indicator||'--',
        rsi:       signalData.rsi||null,
        timeframe: signalData.timeframe||activeInterval,
        dotType:   dir==='LONG'?'yellow':'pink',
      };

      // Place precision dot at the correct historical candle (using barsAgo from indicator)
      const barsAgo = signalData.barsAgo || 0;
      const sigIdx  = Math.max(0, candles.length - 1 - barsAgo);
      const dot = {
        index:   sigIdx,
        type:    plan._signal.dotType,
        price:   decision.entry || price,
        rsi:     signalData.rsi || null,
        fromBot: true,
      };
      // Store in persistent bot array (survives loadCandles refreshes)
      botSignalDots = botSignalDots.filter(d => d.index !== sigIdx || d.type !== dot.type);
      botSignalDots.push(dot);
      if (botSignalDots.length > 50) botSignalDots.shift();

      // Refresh candles so the latest bar is visible, then re-scan
      loadCandles();

      particles = [];
      burstSignal(dir);
      updateSidebar();
      // zoom to show the signal candle + context
      viewEnd   = candles.length + RIGHT_PAD;
      viewStart = Math.max(0, viewEnd - 60);
    },

    loadDots(dotArray) {
      precisionDots = dotArray || [];
    },

    destroy() {
      if (animId)     cancelAnimationFrame(animId);
      if (priceTimer) clearInterval(priceTimer);
      if (candleTimer)clearInterval(candleTimer);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', ()=>{});
      window.removeEventListener('mouseup',  ()=>{});
    },
  };

})();
