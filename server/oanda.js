// OANDA v20 practice REST API — Bearer token auth
// Provides candle + price data for SILVER and OIL
// Set OANDA_API_KEY in environment variables

const OANDA_BASE = 'https://api-fxpractice.oanda.com/v3';

// Internal ticker → OANDA instrument mapping
const OANDA_INSTRUMENT_MAP = {
  SILVER: 'XAG_USD',   // Silver spot
  OIL:    'BCO_USD',   // Brent Crude Oil
};

export function isOandaAsset(coin) {
  return coin in OANDA_INSTRUMENT_MAP;
}

function getHeaders() {
  const key = process.env.OANDA_API_KEY;
  if (!key) throw new Error('OANDA_API_KEY not set in environment');
  return { 'Authorization': `Bearer ${key}` };
}

const GRANULARITY_MAP = {
  '1m': 'M1', '5m': 'M5', '15m': 'M15', '30m': 'M30',
  '1h': 'H1', '4h': 'H4', '1d': 'D',   '1w':  'W',
};

export async function fetchCandles(coin, interval = '30m', bars = 300) {
  const instrument = OANDA_INSTRUMENT_MAP[coin];
  if (!instrument) {
    console.error(`[OANDA] Unknown coin: ${coin}`);
    return [];
  }
  const granularity = GRANULARITY_MAP[interval] || 'M30';
  try {
    const url = `${OANDA_BASE}/instruments/${instrument}/candles` +
                `?count=${bars + 1}&granularity=${granularity}&price=M`;
    const res = await fetch(url, {
      headers: getHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`OANDA API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.candles || []).map(c => ({
      time:   new Date(c.time).getTime(),
      open:   parseFloat(c.mid.o),
      high:   parseFloat(c.mid.h),
      low:    parseFloat(c.mid.l),
      close:  parseFloat(c.mid.c),
      volume: c.volume,
    }));
  } catch (err) {
    console.error(`[OANDA] fetchCandles ${coin}:`, err.message);
    return [];
  }
}

// ── Account ID (lazy-fetched + cached) ─────────────────────
let cachedAccountId = null;
export async function getAccountId() {
  if (cachedAccountId) return cachedAccountId;
  const res = await fetch(`${OANDA_BASE}/accounts`, {
    headers: getHeaders(),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`OANDA /accounts ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const accounts = data.accounts || [];
  if (accounts.length === 0) throw new Error('No OANDA accounts found for this token');
  cachedAccountId = accounts[0].id;
  console.log(`[OANDA] Using accountId=${cachedAccountId}`);
  return cachedAccountId;
}

// ── Place a market order ────────────────────────────────────
// units: positive = LONG, negative = SHORT (instrument units, not USD)
// Returns { oandaTradeId, fillPrice }
export async function placeOandaOrder(coin, units, stopLossPrice) {
  const instrument = OANDA_INSTRUMENT_MAP[coin];
  if (!instrument) throw new Error(`No OANDA instrument for ${coin}`);
  const accountId = await getAccountId();

  const body = {
    order: {
      type:        'MARKET',
      instrument,
      units:       String(units),
      timeInForce: 'FOK',
      stopLossOnFill: {
        price:       stopLossPrice.toFixed(5),
        timeInForce: 'GTC',
      },
    },
  };

  const res = await fetch(`${OANDA_BASE}/accounts/${accountId}/orders`, {
    method:  'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OANDA order failed ${res.status}: ${JSON.stringify(data)}`);

  const fill = data.orderFillTransaction;
  if (!fill) throw new Error(`Order not filled: ${JSON.stringify(data)}`);

  return {
    oandaTradeId: fill.tradeOpened?.tradeID ?? null,
    fillPrice:    parseFloat(fill.price),
  };
}

// ── Close an open OANDA trade ───────────────────────────────
export async function closeOandaTrade(oandaTradeId) {
  const accountId = await getAccountId();
  const res = await fetch(`${OANDA_BASE}/accounts/${accountId}/trades/${oandaTradeId}/close`, {
    method:  'PUT',
    headers: getHeaders(),
    signal:  AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OANDA close trade ${oandaTradeId} failed ${res.status}: ${text}`);
  }
  return res.json();
}

export async function getCurrentPrices(coins) {
  const prices = {};
  for (const coin of coins) {
    const instrument = OANDA_INSTRUMENT_MAP[coin];
    if (!instrument) continue;
    try {
      const url = `${OANDA_BASE}/instruments/${instrument}/candles` +
                  `?count=2&granularity=M1&price=M`;
      const res = await fetch(url, {
        headers: getHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`OANDA API ${res.status}`);
      const data = await res.json();
      const candles = data.candles || [];
      if (candles.length > 0) prices[coin] = parseFloat(candles.at(-1).mid.c);
    } catch (err) {
      console.error(`[OANDA] getCurrentPrices ${coin}:`, err.message);
    }
  }
  return prices;
}
