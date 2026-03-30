// ============================================================
// GEMINI 2.5 FLASH — Signal Validation Engine
// Using FREE tier (~10-20 calls/day, well within 500/day limit)
// ============================================================
import { GoogleGenerativeAI } from '@google/generative-ai';

const SYSTEM_INSTRUCTION = `You are the execution engine for INVEST MONGO, a crypto trading bot.

The Precision v9 indicator has already identified a trading signal. Your default is to CONFIRM and execute the trade. Only VETO for serious, specific reasons.

CONFIRM by default when:
- No major breaking news about the asset
- No FOMC/CPI announcement within 4 hours
- Fear & Greed is not at extreme (not above 90 on BUY, not below 10 on SELL)
- The indicator signal is valid

REDUCE (half size) when:
- Moderate risk present (macro event within 24h, mixed sentiment)
- Fear & Greed above 80 on BUY or below 20 on SELL

VETO only when:
- Major negative news directly about the asset (hack, ban, crash news)
- FOMC or CPI announcement within 4 hours
- Extreme Fear & Greed (above 90 on BUY or below 10 on SELL)

For 5m timeframe (short-term scalp):
- Use tighter stop loss (0.4% from entry) and take profit (0.8% from entry)
- Be more willing to CONFIRM — short trades close fast, risk is limited
- Ignore macro events beyond 1 hour away

For 1h/4h timeframe (swing):
- Stop loss: 1.5% for 1h, 2% for 4h
- Take profit: minimum 1.5x stop loss distance

RESPOND ONLY WITH THIS EXACT JSON — no other text, no markdown, no explanation outside JSON:
{
  "verdict": "CONFIRMED",
  "confidence": 78,
  "size_pct": 3,
  "entry": 84200,
  "stop_loss": 82516,
  "take_profit": 86884,
  "rr_ratio": 1.6,
  "reasoning": {
    "news_sentiment": "bullish",
    "macro_risk": "low",
    "whale_signal": "neutral",
    "fear_greed_status": "greed",
    "key_factors": ["Fed pause narrative", "BTC ETF inflows positive", "No macro events next 48h"],
    "veto_reason": null,
    "summary": "Signal confirmed. RSI oversold with bullish engulfing pattern. News flow supports upside with no near-term macro risk. Whale data neutral."
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

  // ATR scales with timeframe — tighter for scalps, wider for swings
  const atrPct = signal.timeframe === '5m' ? 0.004
               : signal.timeframe === '1h' ? 0.015
               : 0.02; // 4h default
  const atr = signal.price * atrPct;
  const suggestedSL = signal.signal === 'BUY'
    ? (signal.price - atr).toFixed(2)
    : (signal.price + atr).toFixed(2);
  const suggestedTP = signal.signal === 'BUY'
    ? (signal.price + atr * 2).toFixed(2)
    : (signal.price - atr * 2).toFixed(2);

  const prompt = `
SIGNAL FROM PRECISION v9 INDICATOR:
Direction: ${signal.signal}
Type: ${signal.type} (${signal.strength} signal)
Asset: ${signal.asset}
Price: $${signal.price}
RSI: ${signal.rsi}
Pattern: ${signal.pattern}
Trend: ${signal.trend} (SMA50 ${signal.sma50 > signal.sma200 ? 'above' : 'below'} SMA200)
Suggested SL: $${suggestedSL}
Suggested TP: $${suggestedTP}

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
