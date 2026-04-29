export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set.' });

  const { base64, mimeType, focusItem } = req.body || {};
  if (!base64 || !mimeType) return res.status(400).json({ error: 'Missing base64 or mimeType.' });

  const isFocused = focusItem && focusItem.trim().length > 0;

  const visionInstruction = isFocused
    ? `The user ONLY wants to analyse: "${focusItem}". Identify ONLY that specific item. Do not list anything else. Return only that one item in the items array.`
    : 'Identify every clothing item and accessory visible head to toe. Be exhaustive.';

  // ── PHASE 1: Vision ──
  const visionSystem = `You are the world's foremost sneaker authenticator and fashion forensics expert with 20+ years experience. Encyclopedic knowledge of every brand, collab, and limited edition piece ever made.

RULES:
1. Read ALL visible text — brand names, dates, quotes. These are your most important clues.
2. Quoted labels like "SHOELACES" or "AIR" = Virgil Abloh / Off-White. Identify immediately.
3. Shooting star/lightning bolt logo = BAPE Bapesta. Always.
4. NEVER say "custom" unless you have strong evidence it was not produced officially.
5. If collab indicators from multiple brands appear on one item, name BOTH.
6. Be DECISIVE. "BAPE x Off-White Bapesta" not "possibly custom sneaker."
7. Include cultural context — who made it, why it matters, rarity.

${visionInstruction}

Return ONLY valid JSON, no markdown:
{
  "subject": {
    "description": "Description of person/setting",
    "style_summary": "Overall aesthetic"
  },
  "items": [
    {
      "id": 1,
      "position": "head/outerwear/top/bottom/footwear/bag/belt/jewelry/glasses/watch/socks/other",
      "item_type": "Most specific name possible e.g. BAPE x Off-White Bapesta Low",
      "color": "Exact colorway description",
      "material_guess": "Precise material",
      "brand_guess": "Full brand/collab credit",
      "brand_confidence": "High/Medium/Low",
      "vision_confidence": 88,
      "brand_clues": "Every visual clue — text, logos, silhouette, hardware, sole, stitching",
      "style_name_guess": "Most specific product name with colorway",
      "cultural_context": "Why this item matters — designer history, collab backstory, rarity"
    }
  ]
}`;

  let phase1;
  try {
    const raw1 = await callClaude(apiKey, visionSystem, [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
      { type: 'text', text: visionInstruction + ' Return only the JSON object.' }
    ]);
    phase1 = safeParseJSON(raw1);
    if (!phase1 || !phase1.items) throw new Error('Vision parse failed: ' + raw1.slice(0, 200));
  } catch (err) {
    return res.status(500).json({ error: 'Vision analysis failed: ' + err.message });
  }

  // ── PHASE 2: Deep iterative research per item ──
  const enriched = [];

  for (const item of (phase1.items || [])) {
    try {
      const research = await deepResearchItem(apiKey, item);
      enriched.push({ ...item, research });
    } catch (err) {
      enriched.push({ ...item, research: fallbackResearch(item) });
    }
  }

  return res.status(200).json({ subject: phase1.subject, items: enriched });
}

// Deep iterative research — searches as many times as needed to confirm the item and get a real price
async function deepResearchItem(apiKey, item) {
  const researchSystem = `You are a luxury fashion and sneaker pricing expert with access to web search. Your job is to definitively identify this item and find its exact current retail price from a real product page.

PROCESS:
1. Start with the most specific search you can based on the item description
2. If results are inconclusive, search again from a different angle
3. If you find a product page URL, note it and the price shown
4. Keep searching until you are confident in: (a) the exact brand and model name, (b) a real retail price from an authorised source
5. Check: brand official sites (Nike.com, gucci.com, etc), authorised retailers (SSENSE, Mr Porter, Farfetch, END, Selfridges, Matches, Browns, Mytheresa, Nordstrom), then resale (StockX, GOAT, Grailed, Vestiaire) only if retail is unavailable

PRICING PRIORITY:
- Retail price from brand or authorised retailer = BEST
- Sale price from authorised retailer = good
- Resale price from StockX/GOAT = use only if retail unavailable, mark as resale

After your research, return ONLY valid JSON (no markdown):
{
  "brand_verified": "Confirmed brand name — be specific",
  "brand_verification_confidence": "Confirmed/Likely/Uncertain",
  "final_confidence_score": 88,
  "style_name": "Official product name",
  "style_code": "SKU or style code if found, else —",
  "retail_price": "Exact retail price e.g. $340 or £280 — from brand site or authorised retailer. MOST IMPORTANT FIELD.",
  "retail_source": "Site where retail price was found e.g. Nike.com / SSENSE / Mr Porter",
  "product_url": "Direct product page URL if found, else —",
  "resale_price": "Resale price from StockX/GOAT/Grailed if retail unavailable, else —",
  "resale_source": "StockX / GOAT / Grailed / Vestiaire, else —",
  "availability": "In Stock / Sold Out at Retail / Resale Only / Limited / Discontinued",
  "fabric_confirmed": "Official material from product listing",
  "colorway_official": "Official colorway name if found",
  "release_info": "Release date and how it was sold",
  "searches_performed": "Brief note on what angles you searched",
  "confidence_note": "Why you are or are not confident in this identification and price"
}`;

  const prompt = `Item to research and price:
Type: ${item.item_type}
Brand guess: ${item.brand_guess} (confidence: ${item.brand_confidence})
Style guess: ${item.style_name_guess || 'unknown'}
Color: ${item.color}
Material: ${item.material_guess}
Visual clues: ${item.brand_clues}
Cultural context: ${item.cultural_context || ''}

Search the web now. Be thorough — search as many times as needed to find the real retail price. Check official brand sites and authorised retailers. Return only JSON.`;

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
      system: researchSystem,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const text = await r.text();
  if (!r.ok) {
    try { const j = JSON.parse(text); throw new Error(j?.error?.message || 'Search failed'); }
    catch (_) { throw new Error('Search request failed'); }
  }

  const data = JSON.parse(text);
  const raw = (data.content || []).map(b => b.text || '').filter(Boolean).join('');
  return safeParseJSON(raw) || fallbackResearch(item);
}

async function callClaude(apiKey, system, contentArr) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4000, system, messages: [{ role: 'user', content: contentArr }] })
  });
  const text = await r.text();
  if (!r.ok) {
    try { const j = JSON.parse(text); throw new Error(j?.error?.message || text.slice(0, 200)); }
    catch (_) { throw new Error(text.slice(0, 200)); }
  }
  const data = JSON.parse(text);
  return (data.content || []).map(b => b.text || '').join('');
}

function safeParseJSON(raw) {
  if (!raw) return null;
  let s = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const m = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  try {
    const lc = Math.max(s.lastIndexOf(',\n    {'), s.lastIndexOf(',\n  {'));
    if (lc > 100) s = s.slice(0, lc);
    const ob = (s.match(/\{/g)||[]).length - (s.match(/\}/g)||[]).length;
    const oa = (s.match(/\[/g)||[]).length - (s.match(/\]/g)||[]).length;
    for (let i=0;i<ob;i++) s+='}';
    for (let i=0;i<oa;i++) s+=']';
    const r2 = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (r2) return JSON.parse(r2[0]);
  } catch (_) {}
  return null;
}

function fallbackResearch(item) {
  return {
    brand_verified: item.brand_guess || 'Unknown',
    brand_verification_confidence: 'Uncertain',
    final_confidence_score: 40,
    style_name: item.style_name_guess || '—',
    style_code: '—',
    retail_price: 'Unable to retrieve',
    retail_source: '—',
    product_url: '—',
    resale_price: '—',
    resale_source: '—',
    availability: 'Unknown',
    fabric_confirmed: item.material_guess || '—',
    colorway_official: item.color || '—',
    release_info: '—',
    searches_performed: '—',
    confidence_note: 'Research unavailable'
  };
}
