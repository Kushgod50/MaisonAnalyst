export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server.' });

  const { base64, mimeType } = req.body || {};
  if (!base64 || !mimeType) return res.status(400).json({ error: 'Missing base64 or mimeType.' });

  // ── PHASE 1: Vision – describe subject + itemize every garment/accessory ──
  const visionSystem = `You are a world-class fashion analyst with 30 years at top houses: Chanel, Dior, Gucci, Saint Laurent, Prada, Balenciaga, Rick Owens, Celine, Loewe, Off-White, Supreme, Fear of God, Amiri, Chrome Hearts, and more.

Analyse the photo and return ONLY a valid JSON object. No markdown, no explanation, no text outside the JSON.

{
  "subject": {
    "description": "Detailed description of the person — build, gender presentation, approximate age, pose, setting",
    "style_summary": "Overall aesthetic in 1-2 sentences"
  },
  "items": [
    {
      "id": 1,
      "position": "head / outerwear / top / bottom / footwear / bag / belt / jewelry / glasses / watch / socks / other",
      "item_type": "Specific item e.g. Oversized zip hoodie, Straight-leg raw denim, Chunky lug-sole boot",
      "color": "Full color and pattern description",
      "material_guess": "Best fabric guess e.g. heavyweight fleece, selvedge denim, full-grain leather",
      "brand_guess": "Specific brand — list top 2-3 if unsure e.g. Rick Owens / Julius / Yohji Yamamoto",
      "brand_confidence": "High / Medium / Low",
      "brand_clues": "Exact visual evidence — logo, colorway, silhouette signature, hardware, sole unit, stitching",
      "style_name_guess": "Specific model/style name if identifiable e.g. Nike Air Force 1 Low",
      "search_query": "Precise search query to verify and price this item e.g. Rick Owens DRKSHDW Pusher jacket black retail price"
    }
  ]
}`;

  let phase1;
  try {
    const raw1 = await callClaude(apiKey, visionSystem, [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
      { type: 'text', text: 'Analyse this photo. Identify every clothing item and accessory visible, head to toe. Return only the JSON object.' }
    ]);
    phase1 = safeParseJSON(raw1);
    if (!phase1 || !phase1.items) throw new Error('Vision response missing items: ' + raw1.slice(0, 200));
  } catch (err) {
    return res.status(500).json({ error: 'Vision analysis failed: ' + err.message });
  }

  // ── PHASE 2: Web search per item ──
  const enriched = [];
  for (const item of (phase1.items || [])) {
    try {
      const searchSystem = `You are a luxury fashion researcher. Search the web to verify the brand and find the current retail price of the described item.
Search multiple angles. Check brand sites, SSENSE, Mr Porter, Farfetch, END, StockX, Grailed, Vestiaire.
Return ONLY a valid JSON object — no markdown, no text outside JSON:
{
  "brand_verified": "Confirmed brand name",
  "brand_verification_confidence": "Confirmed / Likely / Uncertain",
  "brand_verification_notes": "What evidence was found",
  "style_name": "Official product name if found",
  "retail_price": "e.g. $340 or $280-$420",
  "resale_price": "Secondary market price or N/A",
  "where_to_buy": "Key retailers",
  "fabric_confirmed": "Official fabric composition or best estimate",
  "additional_details": "Season, collab, limited edition, colorway name, etc."
}`;

      const prompt = `Research this item:\nType: ${item.item_type}\nColor: ${item.color}\nBrand guess: ${item.brand_guess} (${item.brand_confidence} confidence)\nStyle: ${item.style_name_guess || 'unknown'}\nClues: ${item.brand_clues}\nSearch: ${item.search_query}\n\nSearch the web now. Return only the JSON object.`;

      const raw2 = await callClaudeWithSearch(apiKey, searchSystem, prompt);
      const parsed = safeParseJSON(raw2);
      enriched.push({ ...item, research: parsed || fallbackResearch(item, 'Could not parse research response') });
    } catch (err) {
      enriched.push({ ...item, research: fallbackResearch(item, err.message) });
    }
  }

  return res.status(200).json({ subject: phase1.subject, items: enriched });
}

// ── Helpers ──

async function callClaude(apiKey, system, contentArr) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: contentArr }]
    })
  });

  const text = await r.text();

  if (!r.ok) {
    // Try to extract a readable error
    try {
      const j = JSON.parse(text);
      throw new Error(j?.error?.message || text.slice(0, 300));
    } catch (_) {
      throw new Error(text.slice(0, 300));
    }
  }

  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error('Non-JSON from Anthropic: ' + text.slice(0, 200)); }
  return (data.content || []).map(b => b.text || '').join('');
}

async function callClaudeWithSearch(apiKey, system, userText) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      system,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: userText }]
    })
  });

  const text = await r.text();

  if (!r.ok) {
    try {
      const j = JSON.parse(text);
      throw new Error(j?.error?.message || text.slice(0, 300));
    } catch (_) {
      throw new Error(text.slice(0, 300));
    }
  }

  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error('Non-JSON from Anthropic: ' + text.slice(0, 200)); }
  return (data.content || []).map(b => b.text || '').filter(Boolean).join('');
}

function safeParseJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Strip markdown fences
  let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  // Extract first JSON object or array
  const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (_) { return null; }
}

function fallbackResearch(item, reason) {
  return {
    brand_verified: item.brand_guess || 'Unknown',
    brand_verification_confidence: 'Uncertain',
    brand_verification_notes: 'Research unavailable: ' + (reason || 'unknown error'),
    style_name: item.style_name_guess || '—',
    retail_price: 'Unable to retrieve',
    resale_price: 'N/A',
    where_to_buy: 'N/A',
    fabric_confirmed: item.material_guess || '—',
    additional_details: '—'
  };
}
