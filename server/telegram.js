const BASE = 'https://api.telegram.org';

export async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[TELEGRAM] Not configured — message:', text.slice(0, 80));
    return;
  }

  try {
    await fetch(`${BASE}/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (err) {
    console.error('[TELEGRAM] Send failed:', err.message);
  }
}
