export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server.' });

  const { base64, mimeType, focusItem } = req.body || {};
  if (!base64 || !mimeType) return res.status(400).json({ error: 'Missing base64 or mimeType.' });

  // ── PHASE 1: Vision ──
  const focusInstruction = focusItem
    ? `The user specifically wants to focus on: "${focusItem}". Prioritise identifying that item in detail, but still list all other visible items.`
    : 'Identify every clothing item and accessory visible, head to toe. Be exhaustive.';

  const visionSystem = `You are a world-class fashion analyst and sneaker/streetwear expert with 30 years experience at top houses and deep knowledge of Nike, Adidas, Jordan Brand, New Balance, Salomon, Asics, Prada, Gucci, Balenciaga, Rick Owens, Supreme, Fear of God, Amiri, Chrome Hearts, Dior, Saint Laurent, Celine, Loewe, and more.

For footwear especially: identify the EXACT silhouette, colourway, and model. For Nike — identify whether it is Air Force 1, Dunk, Air Max (which generation), Jordan (which number), Cortez, Pegasus, etc. Describe the exact colourway using official Nike naming conventions where possible (e.g. "Panda", "University Red", "Bred", "Chicago"). Look at the toe box shape, midsole profile, heel tab, swoosh placement and size, outsole pattern, lacing system, and any visible text or branding on the tongue or heel.

Return ONLY a valid JSON object. No markdown, no text outside the JSON.

{
  "subject": {
    "description": "Detailed description — build, gender presentation, age, pose, setting",
    "style_summary": "Overall aesthetic in 1-2 sentences"
  },
  "items": [
    {
      "id": 1,
      "position": "head / outerwear / top / bottom / footwear / bag / belt / jewelry / glasses / watch / socks / other",
      "item_type": "Very specific item name e.g. Nike Dunk Low, not just sneaker",
      "color": "Exact colorway description",
      "material_guess": "Materials e.g. tumbled leather upper, rubber cupsole",
      "brand_guess": "Exact brand — for Nike always specify the sub-line e.g. Nike Sportswear / Jordan Brand / Nike SB",
      "brand_confidence": "High / Medium / Low",
      "brand_clues": "Precise visual evidence — swoosh size and angle, toe box shape, midsole height, heel tab style, tongue label colour, sole colour split",
      "style_name_guess": "Exact model name and colourway e.g. Nike Dunk Low Retro White Black Panda DD1391-100",
      "search_query": "Specific search query to find cheapest price e.g. Nike Dunk Low Panda DD1391-100 cheapest price buy"
    }
  ]
}`;

  let phase1;
  try {
    const raw1 = await callClaude(apiKey, visionSystem, [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
      { type: 'text', text: focusInstruction + ' Return only the JSON object.' }
    ]);
    phase1 = safeParseJSON(raw1);
    if (!phase1 || !phase1.items) throw new Error('Vision response missing items: ' + raw1.slice(0, 200));
  } catch (err) {
    return res.status(500).json({ error: 'Vision analysis failed: ' + err.message });
  }

  // ── PHASE 2: Deep web search per item for cheapest real price ──
  const enriched = [];
  for (const item of (phase1.items || [])) {
    try {
      const searchSystem = `You are a fashion and sneaker price researcher. Your ONLY job is to find the cheapest legitimate current price for the described item from reputable sellers.

Reputable sources (in order of preference for cheapest):
- GOAT, StockX, Kick Avenue (for sneakers/streetwear resale)
- Nike.com, Adidas.com (official retail)
- END Clothing, SSENSE, Mr Porter, Farfetch, Selfridges, Browns
- Nordstrom, ASOS, Zalando for more accessible brands
- Grailed, Vestiaire Collective for luxury secondhand

Search strategy:
1. Search the exact style name + colorway + "cheapest price" or "buy now"
2. Search the style code/SKU if identifiable
3. Compare at least 2-3 sources
4. Report the LOWEST legitimate price found, and where it was found

Return ONLY a valid JSON object — no markdown, no text outside JSON:
{
  "brand_verified": "Confirmed exact brand and sub-line",
  "brand_verification_confidence": "Confirmed / Likely / Uncertain",
  "style_name": "Official full product name",
  "style_code": "SKU or style code if found e.g. DD1391-100",
  "cheapest_price": "Lowest price found e.g. $98",
  "cheapest_source": "Where that price was found e.g. GOAT",
  "retail_price": "Original/current retail price if different",
  "price_context": "Brief note e.g. retail sold out, resale only / in stock at retail / on sale",
  "fabric_confirmed": "Official materials if found",
  "colorway_official": "Official colorway name e.g. Panda / University Red / Bred Toe"
}`;

      const prompt = `Find the cheapest legitimate price for this item:\nType: ${item.item_type}\nColor: ${item.color}\nBrand: ${item.brand_guess}\nStyle guess: ${item.style_name_guess || 'unknown'}\nSearch query: ${item.search_query}\n\nSearch now. Find the cheapest real price from a reputable seller. Return only JSON.`;

      const raw2 = await callClaudeWithSearch(apiKey, searchSystem, prompt);
      const parsed = safeParseJSON(raw2);
      enriched.push({ ...item, research: parsed || fallbackResearch(item) });
    } catch (err) {
      enriched.push({ ...item, research: fallbackResearch(item) });
    }
  }

  return res.status(200).json({ subject: phase1.subject, items: enriched });
}

// ── Chat endpoint — handles follow-up questions about specific items ──
// This is handled by the same route but with a `chatMessage` field
// We re-export a chat handler at /api/chat

async function callClaude(apiKey, system, contentArr) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 2000, system, messages: [{ role: 'user', content: contentArr }] })
  });
  const text = await r.text();
  if (!r.ok) {
    try { const j = JSON.parse(text); throw new Error(j?.error?.message || text.slice(0, 300)); }
    catch (_) { throw new Error(text.slice(0, 300)); }
  }
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error('Non-JSON from Anthropic: ' + text.slice(0, 200)); }
  return (data.content || []).map(b => b.text || '').join('');
}

async function callClaudeWithSearch(apiKey, system, userText) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5', max_tokens: 1500, system,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: userText }]
    })
  });
  const text = await r.text();
  if (!r.ok) {
    try { const j = JSON.parse(text); throw new Error(j?.error?.message || text.slice(0, 300)); }
    catch (_) { throw new Error(text.slice(0, 300)); }
  }
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error('Non-JSON from Anthropic: ' + text.slice(0, 200)); }
  return (data.content || []).map(b => b.text || '').filter(Boolean).join('');
}

function safeParseJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (_) { return null; }
}

function fallbackResearch(item) {
  return {
    brand_verified: item.brand_guess || 'Unknown',
    brand_verification_confidence: 'Uncertain',
    style_name: item.style_name_guess || '—',
    style_code: '—',
    cheapest_price: 'Unable to retrieve',
    cheapest_source: '—',
    retail_price: '—',
    price_context: 'Search unavailable',
    fabric_confirmed: item.material_guess || '—',
    colorway_official: item.color || '—'
  };
}
