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

  const system = `You are DripCheck AI — an expert fashion analyst, sneaker authenticator, and personal stylist. Deep knowledge of luxury fashion, streetwear, designer collabs, and resale markets.

You already analysed the user's outfit. Use that context to answer accurately. Be direct, concise, and conversational. No bullet points unless listing multiple items.

${context ? 'OUTFIT CONTEXT:\n' + context : 'No outfit context — answer generally.'}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5', max_tokens: 800, system,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: message }]
      })
    });
    const rawText = await r.text();
    if (!r.ok) {
      let msg = 'API error ' + r.status;
      try { const j = JSON.parse(rawText); msg = j?.error?.message || msg; } catch(_) {}
      return res.status(200).json({ reply: 'Sorry, ran into an issue: ' + msg });
    }
    let data;
    try { data = JSON.parse(rawText); } catch(_) {
      return res.status(200).json({ reply: 'Unexpected response. Please try again.' });
    }
    const reply = (data.content||[]).map(b=>b.text||'').filter(Boolean).join('').trim();
    return res.status(200).json({ reply: reply || 'No response — try again.' });
  } catch(err) {
    return res.status(200).json({ reply: 'Connection error: ' + (err.message||'unknown') });
  }
}
