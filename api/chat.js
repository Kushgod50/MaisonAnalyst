export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set.' });

  const { message, context } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Missing message.' });

  const system = `You are Maison, an expert fashion analyst, sneaker authenticator, and personal stylist with deep knowledge of luxury fashion, streetwear, designer collabs, and resale markets.

You have already analysed the user's outfit photo. Use that context to answer their question accurately.

If they ask about a specific item — find the exact model, collab name, colorway, and current cheapest price. Search the web if needed.
If they ask for alternatives — suggest specific real products with prices.
If they ask about authenticity or rarity — give expert context.

Keep responses concise, direct, and conversational. No bullet points unless listing multiple items.

${context ? 'OUTFIT ALREADY ANALYSED:\n' + context : 'No outfit context available — answer generally.'}`;

  try {
    // Always read response as text first to avoid JSON parse crashes
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 800,
        system,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: message }]
      })
    });

    const rawText = await r.text();

    if (!r.ok) {
      // Extract readable error message without trying to JSON parse the whole thing
      let errMsg = 'Anthropic API error ' + r.status;
      try {
        const j = JSON.parse(rawText);
        errMsg = j?.error?.message || errMsg;
      } catch (_) {
        // rawText might be plain text error — just use status
      }
      return res.status(200).json({ reply: 'Sorry, I ran into an issue: ' + errMsg });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (_) {
      return res.status(200).json({ reply: 'Sorry, I got an unexpected response. Please try again.' });
    }

    const reply = (data.content || [])
      .map(b => b.text || '')
      .filter(Boolean)
      .join('')
      .trim();

    return res.status(200).json({ reply: reply || 'No response generated — please try again.' });

  } catch (err) {
    // Network or other hard failure — return graceful message not a crash
    return res.status(200).json({ reply: 'Connection error: ' + (err.message || 'unknown error') });
  }
}
