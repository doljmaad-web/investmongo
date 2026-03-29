// Test script — sends a fake BUY signal to the webhook
// Run with: node scripts/test-signal.js

const BOT_URL = process.env.BOT_SERVER_URL || 'http://localhost:3000';
const SECRET  = process.env.WEBHOOK_SECRET || 'investmongo_webhook_2024';

const testSignal = {
  signal:    'BUY',
  type:      'yellow_dot',
  strength:  'normal',
  asset:     'BTC',
  price:     84200,
  rsi:       34.2,
  sma50:     82100,
  sma200:    79400,
  pattern:   'bullish_engulfing',
  trend:     'uptrend',
  timeframe: '4h',
  source:    'test',
  timestamp: new Date().toISOString(),
};

console.log('Sending test signal:', testSignal);

fetch(`${BOT_URL}/webhook/extension`, {
  method:  'POST',
  headers: {
    'Content-Type':     'application/json',
    'x-webhook-secret': SECRET,
  },
  body: JSON.stringify(testSignal),
})
.then(r => r.json())
.then(data => console.log('Response:', data))
.catch(err => console.error('Error:', err.message));
