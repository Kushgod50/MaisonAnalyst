export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set.' });

  const { base64, mimeType } = req.body || {};
  if (!base64 || !mimeType) return res.status(400).json({ error: 'Missing base64 or mimeType.' });

  // PHASE 1: Vision - identify subject and itemize every garment/accessory
  const visionSystem = `You are a world-class fashion analyst and stylist with 30 years at top fashion houses including Chanel, Dior, Gucci, Saint Laurent, Prada, Balenciaga, Valentino, Bottega Veneta, Rick Owens, Celine, Loewe, Off-White, Supreme, Fear of God, Amiri, Chrome Hearts, and more.

You have encyclopedic knowledge of designer silhouettes, logos, stitching patterns, hardware, labels, fabric textures, sole units, brand-specific colorways, and all signature design details.

Your job:
1. Describe the subject(s) in the photo thoroughly
2. Itemize EVERY visible clothing item and accessory from head to toe — miss nothing
3. For each item give your sharpest expert identification using every visual clue available

Return ONLY valid JSON, no markdown, no preamble:
{
  "subject": {
    "description": "Detailed description — build, gender presentation, approximate age, pose, setting/background, lighting",
    "style_summary": "Overall style aesthetic in 1-2 sentences e.g. 'Old Money casual with streetwear undertones'"
  },
  "items": [
    {
      "id": 1,
      "position": "head / outerwear / top / bottom / footwear / bag / belt / jewelry / glasses / watch / socks / other",
      "item_type": "Specific item name e.g. Oversized zip hoodie, Straight-leg raw denim, Chunky lug-sole boot, Fitted baseball cap",
      "color": "Full color description including any graphics, logos, washes, patterns",
      "material_guess": "Best fabric/material guess e.g. heavyweight 400gsm fleece, 12oz selvedge denim, full-grain leather",
      "brand_guess": "Specific brand/designer — if unsure list top 2-3 separated by /. Never say just 'luxury brand' — commit to a guess",
      "brand_confidence": "High / Medium / Low",
      "brand_clues": "Precise visual evidence — logo shape and placement, specific colorway, silhouette signature, hardware finish, sole unit shape, label color, stitching color, zipper pull style, etc.",
      "style_name_guess": "Specific product line or model name if identifiable e.g. 'Nike Air Force 1 Low', 'Carhartt WIP Chase Hoodie', 'Acne Studios Blå Konst jeans'",
      "search_query": "Precise web search query to verify and price this exact item e.g. 'Rick Owens DRKSHDW Pusher jacket black retail price 2024'"
    }
  ]
}`;

  let phase1;
  try {
    const r1 = await callClaude(apiKey, visionSystem, [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
      { type: 'text', text: 'Analyse this photo in full detail. Identify every single item of clothing and every accessory visible on the subject, from head to toe. Be exhaustive.' }
    ]);
    phase1 = parseJSON(r1);
  } catch (err) {
    return res.status(500).json({ error: 'Vision analysis failed: ' + err.message });
  }

  // PHASE 2: Web search per item for brand verification + pricing
  const items = phase1.items || [];
  const enriched = [];

  for (const item of items) {
    try {
      const searchSystem = `You are a luxury fashion researcher with access to web search. Your job is to verify the brand of a described garment and find its exact current retail price.

Search strategically:
- First search the specific style name + brand
- Then search brand + item type + colorway  
- Check brand official site, SSENSE, Mr Porter, Farfetch, END, StockX, Grailed, Vestiaire Collective
- Cross-reference multiple sources for price accuracy

Return ONLY valid JSON — no markdown, no preamble:
{
  "brand_verified": "Confirmed or best-supported brand name",
  "brand_verification_confidence": "Confirmed / Likely / Uncertain",
  "brand_verification_notes": "What specific evidence was found — product page URLs, retailer names, press mentions, any conflicting info",
  "style_name": "Official product/style name if found, else best guess",
  "retail_price": "Current retail price e.g. '$340' or range '$280 - $420'. Include currency.",
  "resale_price": "Secondary market price from StockX/Grailed/Vestiaire if relevant, or 'N/A'",
  "where_to_buy": "Best places to buy this item right now",
  "fabric_confirmed": "Official fabric composition from product page, or best estimate",
  "additional_details": "Season, collab status, limited edition info, colorway official name, any other useful context"
}`;

      const searchPrompt = `Research this exact fashion item and find the brand + retail price:

Item type: ${item.item_type}
Color/colorway: ${item.color}
Brand guess: ${item.brand_guess} (confidence: ${item.brand_confidence})
Style name guess: ${item.style_name_guess || 'unknown'}
Visual clues: ${item.brand_clues}
Material: ${item.material_guess}
Suggested search: ${item.search_query}

Search the web thoroughly now. Try at least 2-3 different search queries to verify the brand and get an accurate retail price.`;

      const r2 = await callClaudeWithSearch(apiKey, searchSystem, searchPrompt);
      const parsed = parseJSON(r2);
      enriched.push({ ...item, research: parsed });
    } catch (err) {
      enriched.push({
        ...item,
        research: {
          brand_verified: item.brand_guess,
          brand_verification_confidence: 'Uncertain',
          brand_verification_notes: 'Web research could not be completed.',
          style_name: item.style_name_guess || 'Unknown',
          retail_price: 'Unable to retrieve',
          resale_price: 'N/A',
          where_to_buy: 'N/A',
          fabric_confirmed: item.material_guess,
          additional_details: ''
        }
      });
    }
  }

  return res.status(200).json({ subject: phase1.subject, items: enriched });
}

async function callClaude(apiKey, system, contentArr) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: contentArr }]
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || JSON.stringify(d));
  return (d.content || []).map(b => b.text || '').join('');
}

async function callClaudeWithSearch(apiKey, system, userText) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      system,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: userText }]
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || JSON.stringify(d));
  return (d.content || []).map(b => b.text || '').filter(Boolean).join('');
}

function parseJSON(raw) {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!match) throw new Error('No JSON found in response');
  return JSON.parse(match[0]);
}
