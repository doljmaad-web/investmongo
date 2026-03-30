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
  let candles      = [];
  let plan         = null;
  let particles    = [];
  let currentPrice = 0;
  let frame        = 0;
  let priceTimer   = null;
  let candleTimer  = null;

  let activeCoin     = 'BTC';
  let activeYear     = new Date().getFullYear();
  let activeInterval = '1D';
  let precisionDots  = []; // { index, type: 'yellow'|'pink', price }

  // ── View (zoom / pan) ──────────────────────────────────────
  let viewStart = 0;   // float index into candles[]
  let viewEnd   = 0;   // float index, exclusive
  let isDragging        = false;
  let dragStartX        = 0;
  let dragStartViewStart= 0;
  let pinchDist         = 0;
  let mouseX = -1, mouseY = -1;

  // ── Layout ─────────────────────────────────────────────────
  const PAD = { top: 34, bot: 24, left: 64, right: 82 };

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

  // ── Zoom / pan ─────────────────────────────────────────────
  function clampView() {
    const n    = candles.length || 1;
    const span = viewEnd - viewStart;
    const s    = Math.max(5, Math.min(n, span));
    if (viewStart < 0)  { viewStart = 0; viewEnd = s; }
    if (viewEnd   > n)  { viewEnd = n; viewStart = n - s; }
    viewStart = Math.max(0, viewStart);
    viewEnd   = Math.min(n, viewEnd);
  }

  function zoomAt(focalX, factor) {
    const fi   = xToIdx(focalX);
    const span = viewEnd - viewStart;
    const ns   = Math.max(5, Math.min(candles.length, span / factor));
    const ratio= (fi - viewStart) / span;
    viewStart  = fi - ratio * ns;
    viewEnd    = viewStart + ns;
    clampView();
  }

  // ── Data ───────────────────────────────────────────────────
  async function loadCandles() {
    try {
      let url;
      if (activeInterval === '1D') {
        url = `/api/spatial/candles?coin=${activeCoin}&interval=1d&year=${activeYear}`;
      } else if (activeInterval === '1W') {
        url = `/api/spatial/candles?coin=${activeCoin}&interval=1w&bars=200`;
      } else if (activeInterval === '4h') {
        url = `/api/spatial/candles?coin=${activeCoin}&interval=4h&bars=300`;
      } else if (activeInterval === '1h') {
        url = `/api/spatial/candles?coin=${activeCoin}&interval=1h&bars=200`;
      }
      const r = await fetch(url);
      if (!r.ok) return;
      const d = await r.json();
      if (d.candles && d.candles.length) {
        candles   = d.candles;
        viewStart = Math.max(0, candles.length - 80);
        viewEnd   = candles.length;
      }
    } catch (_) {}
  }

  async function fetchPrice() {
    try {
      const r = await fetch('/api/spatial/price');
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

  // ── Draw: grid ─────────────────────────────────────────────
  function drawGrid() {
    const steps = 6;
    ctx.setLineDash([2,5]); ctx.lineWidth = .35;
    for (let i = 0; i <= steps; i++) {
      const p = cachedLo + (cachedHi-cachedLo)*(i/steps);
      const y = priceY(p);
      ctx.strokeStyle = rgba(C.border,.7);
      ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(W-PAD.right,y); ctx.stroke();
      ctx.fillStyle = rgba(C.muted,.7); ctx.font='10px "JetBrains Mono","Courier New",monospace'; ctx.textAlign='right';
      ctx.fillText('$'+p.toLocaleString('en-US',{maximumFractionDigits:0}), PAD.left-3, y+3.5);
    }
    ctx.setLineDash([]);

    // X labels: months or days
    const span = viewEnd - viewStart;
    const s = Math.max(0,Math.floor(viewStart));
    const e = Math.min(candles.length,Math.ceil(viewEnd));
    ctx.fillStyle=rgba(C.muted,.45); ctx.font='8px Courier New'; ctx.textAlign='center';
    const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (span > 20) {
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
      ctx.fillStyle=rgba(bull?C.green:C.red,.06);
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
      ctx.strokeStyle=rgba(col, isLast?.9:.55); ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(x,wTop); ctx.lineTo(x,wBot); ctx.stroke();

      // body fill
      ctx.fillStyle=rgba(dim, isLast?.7:.5); ctx.fillRect(x-bw/2,bTop,bw,bH);

      // border stroke — clean, no glow
      ctx.strokeStyle=rgba(col, isLast?1:.85); ctx.lineWidth=isLast?1.2:.8;
      ctx.strokeRect(x-bw/2,bTop,bw,bH);
    }
  }

  // ── Draw: Precision V9 dots ────────────────────────────────
  function drawPrecisionDots() {
    if (!precisionDots.length) return;
    const s=Math.max(0,Math.floor(viewStart));
    const e=Math.min(candles.length,Math.ceil(viewEnd));
    precisionDots.forEach(dot => {
      if (dot.index<s || dot.index>=e) return;
      const x=candleX(dot.index);
      const c=candles[dot.index];
      if (!c) return;
      if (dot.type==='yellow') {
        const y=priceY(c.low)+8;
        ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2);
        ctx.fillStyle='#f5c518'; ctx.fill();
        ctx.strokeStyle=rgba('#f5c518',.4); ctx.lineWidth=.5; ctx.stroke();
      } else if (dot.type==='pink') {
        const y=priceY(c.high)-8;
        ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2);
        ctx.fillStyle='#e879a0'; ctx.fill();
        ctx.strokeStyle=rgba('#e879a0',.4); ctx.lineWidth=.5; ctx.stroke();
      }
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
      const str='$'+Math.round(p).toLocaleString('en-US');
      const txt=lbl+' '+str;
      const pw=txt.length*5.6+8; const ph=13; const px=W-PAD.right+3;
      ctx.fillStyle=rgba(col,.15); rr(ctx,px,y-ph/2,pw,ph,2); ctx.fill();
      ctx.strokeStyle=rgba(col,.55); ctx.lineWidth=.5; rr(ctx,px,y-ph/2,pw,ph,2); ctx.stroke();
      ctx.fillStyle=col; ctx.font='bold 7.5px Courier New'; ctx.textAlign='left';
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
    const lbl='$'+currentPrice.toLocaleString('en-US',{maximumFractionDigits:0});
    const tw=lbl.length*7.8+14; const ph=18;
    ctx.fillStyle=col; rr(ctx,PAD.left-tw-2,y-ph/2,tw,ph,2); ctx.fill();
    ctx.fillStyle='#000'; ctx.font='bold 11px "JetBrains Mono","Courier New",monospace'; ctx.textAlign='right';
    ctx.fillText(lbl, PAD.left-4, y+4);
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
    ctx.fillStyle=rgba(C.muted,.8); ctx.font='8px Courier New'; ctx.textAlign='right';
    ctx.fillText('$'+price.toLocaleString('en-US',{maximumFractionDigits:0}), PAD.left-3, mouseY+3);
    const idx=Math.round(xToIdx(mouseX));
    if (idx>=0 && idx<candles.length) {
      const c=candles[idx]; const bull=c.close>=c.open;
      const col=bull?C.green:C.red;
      const d=new Date(c.time);
      const dStr=d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
      const pct=((c.close-c.open)/c.open*100).toFixed(2);
      const info=`${dStr}   O:${c.open.toFixed(0)}  H:${c.high.toFixed(0)}  L:${c.low.toFixed(0)}  C:${c.close.toFixed(0)}  (${pct>0?'+':''}${pct}%)`;
      const tw=info.length*5.3+16;
      let tx=mouseX-tw/2;
      tx=Math.max(PAD.left, Math.min(W-PAD.right-tw,tx));
      ctx.fillStyle=rgba(C.panel,.94); rr(ctx,tx,PAD.top+4,tw,16,2); ctx.fill();
      ctx.strokeStyle=rgba(col,.4); ctx.lineWidth=.5; rr(ctx,tx,PAD.top+4,tw,16,2); ctx.stroke();
      ctx.fillStyle=col; ctx.font='8px Courier New'; ctx.textAlign='left';
      ctx.fillText(info, tx+8, PAD.top+15);
    }
  }

  // ── Draw: header bar ───────────────────────────────────────
  function drawHeader() {
    ctx.fillStyle=rgba(C.bg,.9); ctx.fillRect(0,0,W,PAD.top);
    // asset pill
    ctx.fillStyle=rgba(C.border,1); rr(ctx,PAD.left,7,46,18,2); ctx.fill();
    ctx.fillStyle=C.amber; ctx.font='bold 9px Courier New'; ctx.textAlign='center';
    ctx.fillText(activeCoin, PAD.left+23, 20);

    // Interval selector buttons
    const btnLabels=['1h','4h','1D','1W'];
    const btnW=28, btnH=16, btnGap=4;
    let bx=PAD.left+54;
    btnLabels.forEach(lbl => {
      const isActive=lbl===activeInterval;
      ctx.fillStyle=isActive?C.amber:rgba(C.border,1);
      rr(ctx,bx,8,btnW,btnH,2); ctx.fill();
      if (isActive) { ctx.strokeStyle=rgba(C.amber,.6); ctx.lineWidth=.5; rr(ctx,bx,8,btnW,btnH,2); ctx.stroke(); }
      ctx.fillStyle=isActive?'#000':rgba(C.muted,.8);
      ctx.font=isActive?'bold 8px Courier New':'8px Courier New';
      ctx.textAlign='center';
      ctx.fillText(lbl, bx+btnW/2, 19);
      bx+=btnW+btnGap;
    });

    // candle count
    const vc=Math.round(viewEnd-viewStart);
    ctx.fillStyle=rgba(C.muted,.35); ctx.font='8px Courier New'; ctx.textAlign='center';
    ctx.fillText(`${vc} candles`, W/2, 20);

    if (plan) {
      const dir=plan.direction; const dc=dir==='LONG'?C.green:C.red; const db=dir==='LONG'?'#052e16':'#450a0a';
      ctx.fillStyle=db; rr(ctx,W-PAD.right-134,7,46,18,2); ctx.fill();
      ctx.strokeStyle=dc; ctx.lineWidth=.6; rr(ctx,W-PAD.right-134,7,46,18,2); ctx.stroke();
      ctx.fillStyle=dc; ctx.font='bold 9px Courier New'; ctx.textAlign='center';
      ctx.fillText(dir, W-PAD.right-111, 20);
      const conv=Math.min(1,(plan.conviction||5)/10);
      const cc=conv>.7?C.green:conv>.4?C.amber:C.red;
      const barX=W-PAD.right-84;
      ctx.fillStyle=C.border; rr(ctx,barX,11,74,6,2); ctx.fill();
      ctx.fillStyle=cc;       rr(ctx,barX,11,74*conv,6,2); ctx.fill();
      ctx.fillStyle=rgba(C.muted,.6); ctx.font='7.5px Courier New'; ctx.textAlign='left';
      ctx.fillText('CONV '+Math.round(conv*100)+'%', barX+77, 19);
    } else {
      ctx.fillStyle=rgba(C.muted,.28); ctx.font='8px Courier New'; ctx.textAlign='right';
      ctx.fillText('Waiting for signal', W-PAD.right, 20);
    }
  }

  // ── Sidebar panel ──────────────────────────────────────────
  function updateSidebar() {
    if (!plan) return;
    const set=(id,v)=>{ const el=document.getElementById(id); if(el&&v!=null) el.textContent=v; };
    const fmt=p=>p?'$'+Math.round(p).toLocaleString('en-US'):'--';
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

  // ── Idle animation ─────────────────────────────────────────
  function drawIdle() {
    const sy=((frame*.25)%(H-PAD.top-PAD.bot))+PAD.top;
    ctx.fillStyle=rgba(C.purple,.03); ctx.fillRect(PAD.left,sy,plotW(),2);
    ctx.fillStyle=rgba(C.muted,.22); ctx.font='10px Courier New'; ctx.textAlign='center';
    ctx.fillText('▸ SPATIAL TRADE PLANNER', W/2, H/2-8);
    ctx.fillStyle=rgba(C.muted,.12); ctx.font='8px Courier New';
    ctx.fillText('Loading '+activeCoin+' '+activeYear+' data...', W/2, H/2+8);
  }

  // ── Resize ─────────────────────────────────────────────────
  function resize() {
    if (!canvas) return;
    const p = canvas.parentElement.getBoundingClientRect();
    W = p.width  || 600;
    H = p.height || 300;
    canvas.width  = W;
    canvas.height = H;
  }

  // ── Events ─────────────────────────────────────────────────
  function attachEvents() {
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      zoomAt(e.offsetX, e.deltaY < 0 ? 1.13 : 0.88);
    }, { passive: false });

    canvas.addEventListener('mousedown', e => {
      isDragging = true; dragStartX = e.offsetX; dragStartViewStart = viewStart;
      canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      mouseX = e.clientX - rect.left;
      mouseY = e.clientY - rect.top;
      if (!isDragging) return;
      const dx = e.offsetX - dragStartX;
      const span = viewEnd - viewStart;
      viewStart = dragStartViewStart - dx / slotW();
      viewEnd   = viewStart + span;
      clampView();
    });
    window.addEventListener('mouseup', () => {
      isDragging = false;
      if (canvas) canvas.style.cursor = 'crosshair';
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

    // Interval button clicks (header area only)
    canvas.addEventListener('click', e => {
      if (e.offsetY > PAD.top) return;
      const btnLabels=['1h','4h','1D','1W'];
      const btnW=28, btnH=16, btnGap=4;
      let bx=PAD.left+54;
      for (const lbl of btnLabels) {
        if (e.offsetX>=bx && e.offsetX<=bx+btnW && e.offsetY>=8 && e.offsetY<=8+btnH) {
          if (lbl!==activeInterval) {
            activeInterval=lbl; candles=[]; loadCandles();
          }
          return;
        }
        bx+=btnW+btnGap;
      }
    });
  }

  // ── Main loop ───────────────────────────────────────────────
  function loop() {
    animId = requestAnimationFrame(loop);
    frame++;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0,0,W,H);

    if (!candles.length) { drawIdle(); drawHeader(); return; }

    const range = visRange();
    cachedHi = range.hi; cachedLo = range.lo;

    drawVolume();
    drawGrid();
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
      ctx.fillStyle=rgba(C.dim,1); ctx.font='8px Courier New'; ctx.textAlign='right';
      ctx.fillText('PLAN @ '+new Date(plan.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),
        W-PAD.right, H-6);
    }
  }

  // ── Public API ─────────────────────────────────────────────
  window.SpatialPlanner = {

    init() {
      canvas = document.getElementById('spatial-canvas');
      if (!canvas) return;
      ctx = canvas.getContext('2d');
      resize();
      canvas.style.cursor = 'crosshair';
      attachEvents();
      if (animId) cancelAnimationFrame(animId);
      loop();
      loadCandles();
      priceTimer  = setInterval(fetchPrice, 5000);
      candleTimer = setInterval(loadCandles, 15*60*1000);
      fetchPrice();
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

      // Place precision dot at current candle
      const sigIdx=candles.length-1;
      if (sigIdx>=0) {
        precisionDots.push({ index:sigIdx, type:plan._signal.dotType, price:decision.entry||price });
        if (precisionDots.length>50) precisionDots.shift();
      }

      particles = [];
      burstSignal(dir);
      updateSidebar();
      // zoom to last 45 candles to show context around signal
      viewEnd   = candles.length;
      viewStart = Math.max(0, viewEnd-45);
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
