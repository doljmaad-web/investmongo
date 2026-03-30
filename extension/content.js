// INVEST MONGO — TradingView Signal Detector
// Watches for Precision v9 yellow dots (BUY) and pink dots (SELL)

const WEBHOOK_SECRET = 'ab7383fba12d67ff287ba87de0fc87ed733ccf23c66a2372d3a65ed055c7643d';  // Must match server .env
const COOLDOWN_MS    = 60 * 60 * 1000;              // 1 hour cooldown per asset+direction

// BOT_URL is loaded from chrome.storage (set via extension popup)
let BOT_URL = '';
chrome.storage.sync.get({ botUrl: '' }, ({ botUrl }) => {
  BOT_URL = botUrl;
  if (!BOT_URL) {
    console.warn('[INVEST MONGO] Bot URL not configured. Open the extension popup to set it.');
  } else {
    console.log('[INVEST MONGO] Bot URL loaded:', BOT_URL);
  }
});

const lastSignals = new Map();

// ============================================================
// DOM Observer — watches TradingView chart for new elements
// ============================================================
const observer = new MutationObserver(mutations => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      checkNode(node);
      // Also check children
      node.querySelectorAll?.('[fill]')?.forEach(checkNode);
    }
    // Check attribute changes on existing nodes
    if (m.type === 'attributes' && m.attributeName === 'fill') {
      checkNode(m.target);
    }
  }
});

function checkNode(node) {
  const fill = getFill(node);
  const text = node.textContent?.trim() || '';

  // STRONG BUY / STRONG SELL labels
  if (text === 'STRONG BUY')  return fireSignal('BUY',  'strong_buy',  'strong');
  if (text === 'STRONG SELL') return fireSignal('SELL', 'strong_sell', 'strong');

  // Yellow dot = BUY (yellow / gold color)
  if (isYellow(fill)) return fireSignal('BUY',  'yellow_dot', 'normal');

  // Pink/magenta dot = SELL
  if (isPink(fill))   return fireSignal('SELL', 'pink_dot',   'normal');
}

function getFill(node) {
  return (
    node.getAttribute?.('fill') ||
    node.style?.fill ||
    node.querySelector?.('[fill]')?.getAttribute('fill') ||
    ''
  ).toLowerCase();
}

function isYellow(fill) {
  return fill && (
    fill.includes('ffff00') || fill.includes('ffd700') ||
    fill.includes('ffeb3b') || fill === 'yellow' ||
    fill === 'rgb(255, 255, 0)' || fill === 'rgb(255, 215, 0)'
  );
}

function isPink(fill) {
  return fill && (
    fill.includes('ff00ff') || fill.includes('ff69b4') ||
    fill.includes('e91e8c') || fill === 'magenta' || fill === 'fuchsia' ||
    fill === 'rgb(255, 0, 255)' || fill === 'rgb(233, 30, 140)'
  );
}

// ============================================================
// Signal firing with cooldown check
// ============================================================
function fireSignal(action, type, strength) {
  const chartInfo = getChartInfo();
  const key       = `${chartInfo.asset}_${action}`;
  const now       = Date.now();
  const last      = lastSignals.get(key) || 0;

  if (now - last < COOLDOWN_MS) return; // Respect cooldown
  lastSignals.set(key, now);

  const signal = {
    signal:    action,
    type,
    strength,
    asset:     chartInfo.asset,
    price:     chartInfo.price,
    timeframe: chartInfo.timeframe,
    source:    'extension',
    timestamp: new Date().toISOString(),
  };

  console.log('[INVEST MONGO] Signal detected:', signal);
  sendToBot(signal);
  showNotification(action, chartInfo.asset, chartInfo.price);
}

function getChartInfo() {
  // Extract current asset and price from TradingView UI
  const titleEl    = document.querySelector('[data-name="legend-series-item"] .title-bqlSPmMp') ||
                     document.querySelector('.pane-legend-title__description');
  const priceEl    = document.querySelector('.price-axis__last-value') ||
                     document.querySelector('[data-label="Last price"]');
  const tfEl       = document.querySelector('[data-active="true"] .text-yyMB5Hlu') ||
                     document.querySelector('.item-active-ZhLMbJLu');

  const rawAsset   = titleEl?.textContent?.trim() || 'BTC';
  const asset      = rawAsset.replace(/USDT$|USD$|PERP$/i, '').trim().toUpperCase();
  const price      = parseFloat(priceEl?.textContent?.replace(/[,$]/g, '')) || 0;
  const timeframe  = tfEl?.textContent?.trim() || '4h';

  return { asset, price, timeframe };
}

async function sendToBot(signal) {
  if (!BOT_URL) {
    console.error('[INVEST MONGO] Cannot send signal — Bot URL not configured. Open the extension popup to set it.');
    return;
  }
  try {
    const res = await fetch(`${BOT_URL}/webhook/extension`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-webhook-secret':  WEBHOOK_SECRET,
      },
      body: JSON.stringify(signal),
    });
    if (res.ok) {
      console.log('[INVEST MONGO] Signal sent successfully');
    } else {
      console.error('[INVEST MONGO] Server rejected signal:', res.status);
    }
  } catch (err) {
    console.error('[INVEST MONGO] Failed to send signal:', err.message);
  }
}

function showNotification(action, asset, price) {
  // Visual feedback on the TradingView page
  const div = document.createElement('div');
  div.style.cssText = `
    position: fixed; top: 20px; right: 20px; z-index: 99999;
    background: ${action === 'BUY' ? '#052e16' : '#450a0a'};
    border: 1px solid ${action === 'BUY' ? '#4ade80' : '#f87171'};
    color: ${action === 'BUY' ? '#4ade80' : '#f87171'};
    padding: 12px 20px; border-radius: 8px; font-family: monospace;
    font-size: 13px; font-weight: bold;
  `;
  div.textContent = `INVEST MONGO: ${action} ${asset} @ $${price} → Sent to bot`;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 4000);
}

// ============================================================
// Start observing
// ============================================================
function startObserver() {
  const target = document.querySelector('.chart-markup-table') ||
                 document.querySelector('#tv-chart-container') ||
                 document.body;

  observer.observe(target, {
    childList:  true,
    subtree:    true,
    attributes: true,
    attributeFilter: ['fill', 'style'],
  });

  console.log('[INVEST MONGO Extension] Watching TradingView for Precision v9 signals...');
}

// Wait for TradingView to fully load
if (document.readyState === 'complete') {
  setTimeout(startObserver, 4000);
} else {
  window.addEventListener('load', () => setTimeout(startObserver, 4000));
}
