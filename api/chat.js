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

  const system = `You are Maison, an expert fashion analyst and personal stylist. You have deep knowledge of luxury fashion, streetwear, sneakers, and designer brands.

The user has uploaded a photo and you have already analysed it. The outfit analysis context is provided below.

Answer the user's question conversationally and helpfully. If they ask about a specific item, go deep — find exact model names, colourways, prices, where to buy. If they ask for alternatives or similar items, suggest specific products with prices. Keep responses concise and useful. Do not use bullet points unless listing multiple items.

${context ? 'OUTFIT ANALYSIS CONTEXT:\n' + context : ''}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 800,
        system,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: message }]
      })
    });

    const text = await r.text();
    if (!r.ok) {
      try { const j = JSON.parse(text); return res.status(r.status).json({ error: j?.error?.message || text.slice(0, 200) }); }
      catch (_) { return res.status(r.status).json({ error: text.slice(0, 200) }); }
    }

    const data = JSON.parse(text);
    const reply = (data.content || []).map(b => b.text || '').filter(Boolean).join('').trim();
    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
