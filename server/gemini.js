// ============================================================
// GEMINI 2.5 FLASH — Signal Validation Engine
// Using FREE tier (~10-20 calls/day, well within 500/day limit)
// ============================================================
import { GoogleGenerativeAI } from '@google/generative-ai';

const SYSTEM_INSTRUCTION = `You are the execution engine for INVEST MONGO, a BTC futures trading bot.

Trading model: Signal-based position flipping on BTC perpetual futures.
- Yellow dot (BUY) = go LONG — hold until pink dot (SELL) fires
- Pink dot (SELL) = go SHORT — hold until yellow dot (BUY) fires
- NO take profit — positions are held until the opposite signal
- Only an emergency stop loss is used (6% from entry) to protect against catastrophic moves
- Position size: 50% of portfolio per trade

Your default is to CONFIRM and execute. Only VETO for serious reasons.

CONFIRM when:
- No major breaking news (hack, exchange collapse, government ban)
- No FOMC or CPI announcement within 4 hours
- Fear & Greed not at extreme (not above 92 on BUY, not below 8 on SELL)

REDUCE to 25% size when:
- Macro event within 24h or mixed/uncertain sentiment

VETO only when:
- Major breaking news directly threatening BTC
- FOMC or CPI within 4 hours
- Fear & Greed above 92 on BUY or below 8 on SELL

RESPOND ONLY WITH THIS EXACT JSON — no other text, no markdown, no explanation outside JSON:
{
  "verdict": "CONFIRMED",
  "confidence": 78,
  "size_pct": 50,
  "entry": 84200,
  "stop_loss": 79228,
  "reasoning": {
    "news_sentiment": "bullish",
    "macro_risk": "low",
    "whale_signal": "neutral",
    "fear_greed_status": "greed",
    "key_factors": ["Fed pause narrative", "BTC ETF inflows positive", "No macro events next 48h"],
    "veto_reason": null,
    "summary": "Signal confirmed. RSI oversold with bullish engulfing. Holding LONG until pink dot sell signal fires."
  },
  "validated_news": ["Fed officials signal rate pause — bullish for risk assets", "BTC ETF saw $380M inflows today"]
}`;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-2.0-flash',
  systemInstruction: SYSTEM_INSTRUCTION,
});

export async function validateWithGemini(signal, marketContext) {
  const { recentNews, fearGreed, fundingRate, whaleAlerts, nextMacroEvent } = marketContext;

  // Emergency SL only — 6% from entry (position exits by opposite signal, not TP)
  const emergencySL = signal.signal === 'BUY'
    ? (signal.price * 0.94).toFixed(2)
    : (signal.price * 1.06).toFixed(2);

  const prompt = `
SIGNAL FROM PRECISION v9 INDICATOR:
Direction: ${signal.signal}
Type: ${signal.type} (${signal.strength} signal)
Asset: ${signal.asset}
Price: $${signal.price}
RSI: ${signal.rsi}
Pattern: ${signal.pattern}
Trend: ${signal.trend} (SMA50 ${signal.sma50 > signal.sma200 ? 'above' : 'below'} SMA200)
Emergency SL: $${emergencySL} (6% — position held until opposite signal, not TP)

MARKET CONTEXT:
Fear & Greed: ${fearGreed?.value ?? 50} — ${fearGreed?.classification ?? 'Neutral'}
Funding Rate: ${fundingRate ?? 0.01}%
Next macro event: ${nextMacroEvent ?? 'None in next 48h'}

RECENT NEWS (last 2 hours):
${recentNews.slice(0, 8).map(n => `[${n.source}] ${n.title}`).join('\n') || 'No recent news'}

WHALE ALERTS:
${whaleAlerts.slice(0, 4).map(w => `[${w.symbol}] ${w.type}: ${w.detail}`).join('\n') || 'No whale alerts'}

Validate this ${signal.signal} signal on ${signal.asset}. Return JSON only.`;

  try {
    const chat = model.startChat({
      generationConfig: {
        temperature: 0.1,      // Low temperature for consistent decisions
        maxOutputTokens: 800,
      },
    });

    const result = await chat.sendMessage(prompt);
    const text = result.response.text().trim();

    // Strip markdown fences if present
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);

    // Safety check — ensure required fields exist
    if (!parsed.verdict || !parsed.confidence || !parsed.reasoning) {
      throw new Error('Invalid Gemini response structure');
    }

    // Ensure RR ratio is calculated
    if (parsed.entry && parsed.stop_loss && parsed.take_profit) {
      parsed.rr_ratio = parseFloat(
        (Math.abs(parsed.take_profit - parsed.entry) /
         Math.abs(parsed.stop_loss - parsed.entry)).toFixed(2)
      );
    }

    console.log(`[GEMINI] Verdict: ${parsed.verdict} (${parsed.confidence}%) for ${signal.signal} ${signal.asset}`);
    return parsed;

  } catch (err) {
    console.error('[GEMINI] Validation error:', err.message);
    // Safe fallback — veto on error, never risk money on failed AI
    return {
      verdict: 'VETOED',
      confidence: 0,
      size_pct: 0,
      reasoning: {
        summary: `Gemini API error — vetoing for safety: ${err.message}`,
        veto_reason: 'API_ERROR',
        news_sentiment: 'neutral',
        macro_risk: 'unknown',
        whale_signal: 'unknown',
        fear_greed_status: 'unknown',
        key_factors: ['API error'],
      },
      validated_news: [],
    };
  }
}
