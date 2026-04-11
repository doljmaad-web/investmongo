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
