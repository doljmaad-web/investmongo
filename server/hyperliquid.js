// Hyperliquid public API — no auth needed for market data
const HL_URL = 'https://api.hyperliquid.xyz/info';

async function hlPost(body, timeout = 10000) {
  const res = await fetch(HL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HL API ${res.status}`);
  return res.json();
}

const INTERVAL_MS = {
  '1m':60000,'5m':300000,'15m':900000,'30m':1800000,
  '1h':3600000,'4h':14400000,'1d':86400000,'1w':604800000,
};

export async function fetchCandles(coin, interval = '1h', bars = 250) {
  try {
    const endTime   = Date.now();
    const startTime = endTime - bars * (INTERVAL_MS[interval] || 3600000);
    const data = await hlPost({ type:'candleSnapshot', req:{ coin, interval, startTime, endTime } }, 8000);
    return data.map(c => ({
      time:   c.t,
      open:   parseFloat(c.o),
      high:   parseFloat(c.h),
      low:    parseFloat(c.l),
      close:  parseFloat(c.c),
      volume: parseFloat(c.v),
    }));
  } catch (err) {
    console.error(`[HL] fetchCandles ${coin}:`, err.message);
    return [];
  }
}

export async function getCurrentPrices(coins) {
  try {
    const data   = await hlPost({ type: 'allMids' });
    const prices = {};
    for (const coin of coins) {
      if (data[coin]) prices[coin] = parseFloat(data[coin]);
    }
    return prices;
  } catch (err) {
    console.error('[HL] getCurrentPrices:', err.message);
    return {};
  }
}

export async function getFundingRate(coin) {
  try {
    const data = await hlPost({ type: 'metaAndAssetCtxs' });
    const meta  = data[0]?.universe || [];
    const ctx   = data[1] || [];
    const idx   = meta.findIndex(a => a.name === coin);
    if (idx >= 0 && ctx[idx]) return parseFloat(ctx[idx].funding || 0);
    return 0;
  } catch {
    return 0;
  }
}

// LIVE TRADING STUB — only logs, does not execute
// Uncomment and implement when ready to go live
export async function executeTrade(signal, decision) {
  console.log('[HL STUB] Would execute:', {
    coin:      signal.asset,
    direction: signal.signal,
    entry:     decision.entry,
    sl:        decision.stop_loss,
    tp:        decision.take_profit,
    sizePct:   decision.size_pct,
  });
  return { success: false, reason: 'PAPER_MODE — execution disabled' };
}
