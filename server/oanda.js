// Twelve Data REST API — candle + price data for SILVER and OIL
// Replaces OANDA v20. Set TWELVEDATA_API_KEY in environment variables.
// Free tier: 800 requests/day  |  https://twelvedata.com

const TWELVEDATA_BASE = 'https://api.twelvedata.com';

const ASSET_MAP = {
  SILVER: 'XAG/USD',
  OIL:    'WTI/USD',
};

export function isOandaAsset(coin) {
  return coin in ASSET_MAP;
}

function getApiKey() {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new Error('TWELVEDATA_API_KEY not set in environment');
  return key;
}

const INTERVAL_MAP = {
  '1m':  '1min',  '3m':  '3min',  '5m':  '5min',
  '15m': '15min', '30m': '30min', '1h':  '1h',
  '4h':  '4h',    '1d':  '1day',  '1w':  '1week',
};

export async function fetchCandles(coin, interval = '30m', bars = 300) {
  const symbol = ASSET_MAP[coin];
  if (!symbol) { console.error(`[TWELVEDATA] Unknown coin: ${coin}`); return []; }
  const tdInterval = INTERVAL_MAP[interval] || '30min';
  try {
    const url = `${TWELVEDATA_BASE}/time_series` +
      `?symbol=${encodeURIComponent(symbol)}` +
      `&interval=${tdInterval}` +
      `&outputsize=${bars}` +
      `&apikey=${getApiKey()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Twelve Data ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.status === 'error') throw new Error(`Twelve Data: ${data.message}`);
    // Twelve Data returns newest-first — reverse to chronological order
    return (data.values || []).reverse().map(c => ({
      time:   new Date(c.datetime).getTime(),
      open:   parseFloat(c.open),
      high:   parseFloat(c.high),
      low:    parseFloat(c.low),
      close:  parseFloat(c.close),
      volume: parseFloat(c.volume || 0),
    }));
  } catch (err) {
    console.error(`[TWELVEDATA] fetchCandles ${coin}:`, err.message);
    return [];
  }
}

export async function getCurrentPrices(coins) {
  const prices = {};
  for (const coin of coins) {
    const symbol = ASSET_MAP[coin];
    if (!symbol) continue;
    try {
      const url = `${TWELVEDATA_BASE}/price` +
        `?symbol=${encodeURIComponent(symbol)}` +
        `&apikey=${getApiKey()}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`Twelve Data ${res.status}`);
      const data = await res.json();
      if (data.price) prices[coin] = parseFloat(data.price);
    } catch (err) {
      console.error(`[TWELVEDATA] getCurrentPrices ${coin}:`, err.message);
    }
  }
  return prices;
}
