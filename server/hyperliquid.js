// Hyperliquid public API — no auth needed for market data
const HL_URL = 'https://api.hyperliquid.xyz/info';

// Internal ticker → Hyperliquid ticker mapping
// GOLD maps to PAXG (PAX Gold — 1 token = 1 troy oz gold, the gold perp on Hyperliquid)
const HL_COIN_MAP = {
  GOLD: 'PAXG',
};

export function hlCoin(coin) { return HL_COIN_MAP[coin] || coin; }

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
  const hlCoin = HL_COIN_MAP[coin] || coin;
  try {
    const endTime   = Date.now();
    const startTime = endTime - bars * (INTERVAL_MS[interval] || 3600000);
    const data = await hlPost({ type:'candleSnapshot', req:{ coin: hlCoin, interval, startTime, endTime } }, 8000);
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
      const hlCoin = HL_COIN_MAP[coin] || coin;
      if (data[hlCoin]) prices[coin] = parseFloat(data[hlCoin]);
    }
    return prices;
  } catch (err) {
    console.error('[HL] getCurrentPrices:', err.message);
    return {};
  }
}

export async function getFundingRate(coin) {
  const hlCoinName = HL_COIN_MAP[coin] || coin;
  try {
    const data = await hlPost({ type: 'metaAndAssetCtxs' });
    const meta  = data[0]?.universe || [];
    const ctx   = data[1] || [];
    const idx   = meta.findIndex(a => a.name === hlCoinName);
    if (idx >= 0 && ctx[idx]) return parseFloat(ctx[idx].funding || 0);
    return 0;
  } catch {
    return 0;
  }
}

// Full market data for screener — funding, OI, prices for all HL perps
export async function getMarketData() {
  const data = await hlPost({ type: 'metaAndAssetCtxs' });
  const meta  = data[0]?.universe || [];
  const ctx   = data[1] || [];
  return meta.map((a, i) => {
    const c       = ctx[i] || {};
    const markPx  = parseFloat(c.markPx  || 0);
    const prevPx  = parseFloat(c.prevDayPx || 0);
    const oi      = parseFloat(c.openInterest || 0);
    return {
      asset:       a.name,
      markPx,
      change24h:   prevPx > 0 ? +((markPx - prevPx) / prevPx * 100).toFixed(2) : 0,
      funding8h:   +(parseFloat(c.funding || 0) * 8 * 100).toFixed(4), // % per 8 h
      openInterest: +(oi * markPx).toFixed(0),                          // USD notional
      dayVolume:   +(parseFloat(c.dayNtlVlm || 0)).toFixed(0),
    };
  }).filter(a => a.markPx > 0);
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
