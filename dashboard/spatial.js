// INVEST MONGO — Spatial Trade Planner
// Self-contained IIFE — exposes window.SpatialPlanner
(function () {
  'use strict';

  const C = {
    bg:      '#080b0f',
    green:   '#4ade80',
    red:     '#f87171',
    amber:   '#f59e0b',
    blue:    '#38bdf8',
    purple:  '#a78bfa',
    muted:   '#64748b',
    border:  '#1e2d3d',
  };

  let canvas, ctx, animId;
  let plan         = null;
  let particles    = [];
  let priceHistory = [];
  let currentPrice = null;
  let frameCount   = 0;
  let priceInterval = null;

  // ============================================================
  // PARTICLE
  // ============================================================
  class Particle {
    constructor(x, y, type) {
      this.x    = x;
      this.y    = y;
      this.vx   = (Math.random() - 0.7) * 1.8;
      this.vy   = (Math.random() - 0.5) * 1.4;
      this.life = 1.0;
      this.decay = 0.008 + Math.random() * 0.014;
      this.size  = 1.5 + Math.random() * 2;
      this.type  = type;
      this.trail = [];
    }

    color() {
      switch (this.type) {
        case 'bull':     return C.green;
        case 'bear':     return C.red;
        case 'entry':    return C.amber;
        case 'breakout': return C.blue;
        default:         return C.muted;
      }
    }

    update() {
      this.trail.push({ x: this.x, y: this.y });
      if (this.trail.length > 8) this.trail.shift();

      if (currentPrice !== null && plan) {
        const py = priceToY(currentPrice);
        this.vy += (py - this.y) * 0.0002;
      }

      this.x  += this.vx;
      this.y  += this.vy;
      this.vy *= 0.98;
      this.life -= this.decay;
    }

    draw() {
      if (this.life <= 0) return;
      const col = this.color();

      // Trail
      for (let i = 0; i < this.trail.length; i++) {
        const alpha = (i / this.trail.length) * this.life * 0.35;
        ctx.globalAlpha = alpha;
        ctx.fillStyle   = col;
        ctx.beginPath();
        ctx.arc(this.trail[i].x, this.trail[i].y, this.size * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = this.life;
      ctx.fillStyle   = col;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    dead() { return this.life <= 0 || this.x < -20; }
  }

  // ============================================================
  // LAYOUT HELPERS
  // ============================================================
  const PAD = { l: 72, r: 90, t: 32, b: 18 };

  function bounds() {
    return {
      x: PAD.l,
      y: PAD.t,
      w: canvas.width  - PAD.l - PAD.r,
      h: canvas.height - PAD.t - PAD.b,
    };
  }

  function priceRange() {
    const lo = Math.min(plan.rangeLow,  plan.sl)  * 0.9985;
    const hi = Math.max(plan.rangeHigh, plan.tp3) * 1.0015;
    return { lo, hi, span: hi - lo };
  }

  function priceToY(price) {
    if (!plan) return canvas.height / 2;
    const b = bounds();
    const { lo, span } = priceRange();
    return b.y + b.h - ((price - lo) / span) * b.h;
  }

  // ============================================================
  // PRICE FEED
  // ============================================================
  async function fetchPrice() {
    try {
      const r = await fetch('/api/spatial/price');
      const d = await r.json();
      if (d.price) {
        currentPrice = d.price;
        const now = Date.now();
        priceHistory.push({ price: d.price, ts: now });
        priceHistory = priceHistory.filter(p => p.ts >= now - 5 * 60 * 1000);
      }
    } catch (_) {}
  }

  // ============================================================
  // PARTICLE SPAWNING
  // ============================================================
  function spawnSignalBurst() {
    if (!plan) return;
    const b      = bounds();
    const entryY = priceToY(plan.entry);
    for (let i = 0; i < 80; i++) {
      const x    = b.x + Math.random() * b.w;
      const y    = entryY + (Math.random() - 0.5) * 24;
      const type = plan.direction === 'LONG' ? 'bull' : 'bear';
      particles.push(new Particle(x, y, type));
    }
  }

  function spawnLiveParticles() {
    if (currentPrice === null) return;
    const b      = bounds();
    const priceY = plan ? priceToY(currentPrice) : canvas.height / 2;
    const n      = 1 + Math.floor(Math.random() * 3);
    const type   = plan ? (plan.direction === 'LONG' ? 'bull' : 'bear') : 'breakout';
    for (let i = 0; i < n; i++) {
      particles.push(new Particle(
        b.x + b.w,
        priceY + (Math.random() - 0.5) * 12,
        type
      ));
    }
  }

  // ============================================================
  // DRAW FUNCTIONS
  // ============================================================
  function drawGrid() {
    const b             = bounds();
    const { lo, span }  = priceRange();
    ctx.strokeStyle     = C.border;
    ctx.lineWidth       = 0.5;
    ctx.fillStyle       = C.muted;
    ctx.font            = '9px monospace';
    ctx.textAlign       = 'right';

    for (let i = 0; i <= 5; i++) {
      const price = lo + (span / 5) * i;
      const y     = b.y + b.h - (i / 5) * b.h;
      ctx.beginPath();
      ctx.moveTo(b.x, y); ctx.lineTo(b.x + b.w, y);
      ctx.stroke();
      ctx.fillText(`$${price.toFixed(0)}`, b.x - 4, y + 3);
    }
  }

  function drawZone(y1, y2, color) {
    const b = bounds();
    ctx.fillStyle = color;
    ctx.fillRect(b.x, Math.min(y1, y2), b.w, Math.abs(y2 - y1));
  }

  function drawConsolidationBox() {
    const b  = bounds();
    const y1 = priceToY(plan.rangeHigh);
    const y2 = priceToY(plan.rangeLow);
    ctx.fillStyle   = 'rgba(245,158,11,0.04)';
    ctx.fillRect(b.x, y1, b.w, y2 - y1);
    ctx.strokeStyle = C.amber;
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 5]);
    ctx.strokeRect(b.x, y1, b.w, y2 - y1);
    ctx.setLineDash([]);
  }

  function drawLevelLine(price, label, color, dashed) {
    const b   = bounds();
    const y   = priceToY(price);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.setLineDash(dashed ? [4, 4] : []);
    ctx.beginPath();
    ctx.moveTo(b.x, y); ctx.lineTo(b.x + b.w, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Pill label
    const txt = `${label} $${price.toFixed(0)}`;
    ctx.font  = '8px monospace';
    const lw  = ctx.measureText(txt).width + 10;
    const lh  = 14;
    const lx  = b.x + b.w + 3;
    const ly  = y - lh / 2;
    ctx.fillStyle = color + '22';
    ctx.fillRect(lx, ly, lw, lh);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 0.5;
    ctx.strokeRect(lx, ly, lw, lh);
    ctx.fillStyle   = color;
    ctx.textAlign   = 'left';
    ctx.fillText(txt, lx + 5, y + 3);
  }

  function drawPriceHistory() {
    if (priceHistory.length < 2) return;
    const b   = bounds();
    const now = Date.now();
    const win = 5 * 60 * 1000;
    const toX = ts => b.x + ((ts - (now - win)) / win) * b.w;

    ctx.strokeStyle = C.blue;
    ctx.lineWidth   = 1.5;
    ctx.shadowColor = C.blue;
    ctx.shadowBlur  = 5;
    ctx.setLineDash([]);
    ctx.beginPath();
    priceHistory.forEach((p, i) => {
      const x = toX(p.ts);
      const y = plan ? priceToY(p.price) : b.y + b.h / 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function drawCurrentPriceTag() {
    if (currentPrice === null) return;
    const b = bounds();
    const y = plan ? priceToY(currentPrice) : b.y + b.h / 2;

    ctx.strokeStyle = C.blue;
    ctx.lineWidth   = 0.5;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(b.x, y); ctx.lineTo(b.x + b.w, y);
    ctx.stroke();
    ctx.setLineDash([]);

    const label = `$${currentPrice.toFixed(0)}`;
    ctx.font     = 'bold 9px monospace';
    const lw     = ctx.measureText(label).width + 10;
    const lh     = 14;
    ctx.fillStyle = C.blue;
    ctx.fillRect(b.x - lw - 3, y - lh / 2, lw, lh);
    ctx.fillStyle   = '#000';
    ctx.textAlign   = 'center';
    ctx.fillText(label, b.x - lw / 2 - 3, y + 3);
  }

  function drawCanvasHeader() {
    const W = canvas.width;
    ctx.fillStyle = 'rgba(13,17,23,0.85)';
    ctx.fillRect(0, 0, W, PAD.t);

    if (!plan) {
      ctx.fillStyle = C.muted;
      ctx.font      = '9px monospace';
      ctx.textAlign = 'left';
      ctx.fillText('SPATIAL TRADE PLANNER', 10, 18);
      return;
    }

    const dirColor = plan.direction === 'LONG' ? C.green : C.red;

    // Direction badge
    ctx.fillStyle   = dirColor + '33';
    ctx.fillRect(8, 8, 48, 16);
    ctx.strokeStyle = dirColor;
    ctx.lineWidth   = 0.5;
    ctx.strokeRect(8, 8, 48, 16);
    ctx.fillStyle   = dirColor;
    ctx.font        = 'bold 10px monospace';
    ctx.textAlign   = 'center';
    ctx.fillText(plan.direction, 32, 19);

    // Asset
    ctx.fillStyle = '#fff';
    ctx.font      = 'bold 11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(plan.asset, 64, 19);

    // R:R
    ctx.fillStyle = C.purple;
    ctx.font      = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`R:R ${plan.rr}`, W - 78, 19);

    // Conviction mini bar
    const barX = W - 72;
    const barW = 64;
    ctx.fillStyle = C.border;
    ctx.fillRect(barX, 12, barW, 6);
    ctx.fillStyle = dirColor;
    ctx.fillRect(barX, 12, barW * (plan.conviction / 10), 6);
    ctx.fillStyle   = C.muted;
    ctx.font        = '8px monospace';
    ctx.textAlign   = 'right';
    ctx.fillText(`${plan.conviction * 10}%`, W - 4, 19);
  }

  function drawIdleState() {
    const W = canvas.width;
    const H = canvas.height;

    // Scanning purple sweep
    const scanY = H / 2 + Math.sin(frameCount * 0.018) * H * 0.28;
    const grad  = ctx.createLinearGradient(0, scanY - 50, 0, scanY + 50);
    grad.addColorStop(0,   'transparent');
    grad.addColorStop(0.5, 'rgba(167,139,250,0.07)');
    grad.addColorStop(1,   'transparent');
    ctx.fillStyle = grad;
    ctx.fillRect(0, scanY - 50, W, 100);

    ctx.strokeStyle = C.purple;
    ctx.lineWidth   = 0.8;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(0, scanY); ctx.lineTo(W, scanY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    ctx.fillStyle = C.muted;
    ctx.font      = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for Precision v9 signal...', W / 2, H / 2 + 4);
    ctx.fillStyle = C.border;
    ctx.font      = '9px monospace';
    ctx.fillText('SPATIAL TRADE PLANNER · IDLE', W / 2, H / 2 + 20);
  }

  // ============================================================
  // MAIN LOOP
  // ============================================================
  function loop() {
    if (!canvas) return;
    const W = canvas.width;
    const H = canvas.height;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    if (!plan) {
      drawIdleState();
      if (priceHistory.length >= 2) drawPriceHistory();
      if (currentPrice !== null)    drawCurrentPriceTag();
    } else {
      drawGrid();

      const entryY = priceToY(plan.entry);
      const tp2Y   = priceToY(plan.tp2);
      const slY    = priceToY(plan.sl);

      if (plan.direction === 'LONG') {
        drawZone(tp2Y,   entryY, 'rgba(74,222,128,0.06)');
        drawZone(entryY, slY,    'rgba(248,113,113,0.06)');
      } else {
        drawZone(entryY, tp2Y,   'rgba(74,222,128,0.06)');
        drawZone(slY,    entryY, 'rgba(248,113,113,0.06)');
      }

      drawConsolidationBox();
      drawLevelLine(plan.tp3,   'TP3',   'rgba(74,222,128,0.45)', true);
      drawLevelLine(plan.tp2,   'TP2',   C.green + 'bb',          true);
      drawLevelLine(plan.tp1,   'TP1',   C.green,                 true);
      drawLevelLine(plan.entry, 'ENTRY', C.amber,                 false);
      drawLevelLine(plan.sl,    'SL',    C.red,                   true);

      drawPriceHistory();
      drawCurrentPriceTag();
    }

    // Particles
    particles = particles.filter(p => !p.dead());
    particles.forEach(p => { p.update(); p.draw(); });
    if (frameCount % 6 === 0) spawnLiveParticles();

    drawCanvasHeader();
    frameCount++;
    animId = requestAnimationFrame(loop);
  }

  // ============================================================
  // SIDEBAR
  // ============================================================
  function updateSidebar() {
    if (!plan) return;
    const fmt = v => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    set('sp-asset',  plan.asset);
    set('sp-entry',  fmt(plan.entry));
    set('sp-tp1',    fmt(plan.tp1));
    set('sp-tp2',    fmt(plan.tp2));
    set('sp-tp3',    fmt(plan.tp3));
    set('sp-sl',     fmt(plan.sl));
    set('sp-rr',     plan.rr);
    set('sp-conv',   `${plan.conviction * 10}%`);
    set('sp-thesis', plan.reasoning || 'No reasoning available.');

    const dirEl = document.getElementById('sp-direction');
    if (dirEl) {
      dirEl.textContent = plan.direction;
      dirEl.className   = `sp-dir-badge ${plan.direction === 'LONG' ? 'long' : 'short'}`;
    }

    const bar = document.getElementById('sp-conv-bar');
    if (bar) bar.style.width = `${plan.conviction * 10}%`;

    const panel = document.getElementById('sp-panel');
    if (panel) panel.classList.add('active');
  }

  // ============================================================
  // CANVAS SIZING
  // ============================================================
  function sizeCanvas() {
    const wrap = document.getElementById('spatial-canvas-wrap');
    if (!wrap || !canvas) return;
    canvas.width  = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
  }

  // ============================================================
  // PUBLIC API
  // ============================================================
  window.SpatialPlanner = {

    init() {
      canvas = document.getElementById('spatial-canvas');
      if (!canvas) return;
      ctx = canvas.getContext('2d');
      sizeCanvas();
      window.addEventListener('resize', sizeCanvas);
      fetchPrice();
      priceInterval = setInterval(fetchPrice, 5000);
      loop();
    },

    onSignal(signalData, decision) {
      if (!signalData || !decision) return;

      const price     = signalData.price || 0;
      const direction = signalData.signal === 'BUY' ? 'LONG' : 'SHORT';
      const sl        = decision.stop_loss || (direction === 'LONG' ? price * 0.94 : price * 1.06);
      const risk      = Math.abs(price - sl);
      const tp1       = direction === 'LONG' ? price + risk * 1.5 : price - risk * 1.5;
      const tp2       = direction === 'LONG' ? tp1 * 1.012 : tp1 * 0.988;
      const tp3       = direction === 'LONG' ? tp1 * 1.025 : tp1 * 0.975;
      const reward    = Math.abs(tp1 - price);
      const rr        = risk > 0 ? (reward / risk).toFixed(1) : '--';
      const conviction = Math.min(10, Math.round((decision.confidence || 75) / 10));

      plan = {
        asset:      signalData.asset || 'BTC',
        direction,
        entry:      price,
        sl,
        tp1, tp2, tp3,
        rr,
        conviction,
        rangeHigh:  price * 1.015,
        rangeLow:   price * 0.985,
        timestamp:  new Date().toISOString(),
        reasoning:  decision.reasoning?.summary || '',
      };

      particles = [];
      setTimeout(spawnSignalBurst, 80);
      updateSidebar();
    },

    destroy() {
      cancelAnimationFrame(animId);
      clearInterval(priceInterval);
      window.removeEventListener('resize', sizeCanvas);
    },
  };

})();
