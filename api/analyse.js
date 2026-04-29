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

  const focusInstruction = focusItem
    ? `The user wants to focus on: "${focusItem}". Prioritise that item but still list everything visible.`
    : 'Identify every clothing item and accessory head to toe. Be exhaustive.';

  // ── PHASE 1: Vision ──
  const visionSystem = `You are the world's foremost sneaker authenticator and fashion forensics expert. You have encyclopedic knowledge of every brand, collab, and limited edition piece.

RULES:
1. Read ALL visible text — brand names, dates, quotes. Most important clues.
2. Quoted labels like "SHOELACES" or "AIR" = Virgil Abloh / Off-White.
3. Shooting star/lightning bolt logo = BAPE Bapesta.
4. NEVER say "custom" unless you have strong evidence.
5. If collab indicators from multiple brands appear, name BOTH.
6. Be DECISIVE. "BAPE x Off-White Bapesta" not "possibly custom."
7. Include cultural context.
8. Generate 3 distinct search queries per item for cross-referencing.

Return ONLY valid JSON, no markdown:
{
  "subject": {
    "description": "Detailed description of person/setting",
    "style_summary": "Overall aesthetic"
  },
  "items": [
    {
      "id": 1,
      "position": "head/outerwear/top/bottom/footwear/bag/belt/jewelry/glasses/watch/socks/other",
      "item_type": "Most specific name e.g. BAPE x Off-White Bapesta Low",
      "color": "Exact colorway",
      "material_guess": "Precise material",
      "brand_guess": "Full brand/collab credit",
      "brand_confidence": "High/Medium/Low",
      "vision_confidence": 88,
      "brand_clues": "Every visual clue",
      "style_name_guess": "Most specific product name",
      "cultural_context": "Why this item matters",
      "search_query_1": "brand + exact model + colorway + site:ssense.com OR site:mrporter.com OR site:farfetch.com",
      "search_query_2": "brand + model + colorway + retail price buy now",
      "search_query_3": "item name + SKU + price stockx OR goat OR grailed"
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
    if (!phase1 || !phase1.items) throw new Error('Vision parse failed: ' + raw1.slice(0, 200));
  } catch (err) {
    return res.status(500).json({ error: 'Vision analysis failed: ' + err.message });
  }

  // ── PHASE 2: Per-item — search, fetch product page, extract real price ──
  const enriched = [];

  for (const item of (phase1.items || [])) {
    try {
      // Run 3 searches in parallel
      const [r1, r2, r3] = await Promise.allSettled([
        searchAndFetchPrice(apiKey, item, 1),
        searchAndFetchPrice(apiKey, item, 2),
        searchAndFetchPrice(apiKey, item, 3)
      ]);

      const results = [r1, r2, r3].map(r => r.status === 'fulfilled' ? r.value : null);

      // Synthesise all 3 into final answer
      const synthSystem = `You are a fashion pricing expert. You have 3 sets of search results each trying to find the retail price of the same item.

Your job:
1. Find what all 3 results AGREE on for brand and model name
2. Extract the ACTUAL RETAIL PRICE — the price the brand or an authorised retailer sells it for NEW
3. If retail is sold out, find the lowest current ask on resale (StockX, GOAT, Grailed)
4. Return a direct product URL if one was found
5. Be DEFINITIVE — no hedging

IMPORTANT: We want the RETAIL price (what it costs brand new from the brand or authorised stores). Only use resale if retail is unavailable.

Return ONLY valid JSON:
{
  "brand_verified": "Definitive confirmed brand",
  "brand_verification_confidence": "Confirmed/Likely/Uncertain",
  "final_confidence_score": 88,
  "style_name": "Official product name",
  "style_code": "SKU if found else —",
  "retail_price": "RETAIL price e.g. $340 — from brand site or authorised retailer. This is the most important field.",
  "retail_source": "Where the retail price was found e.g. Nike.com / SSENSE / Mr Porter / Farfetch",
  "product_url": "Direct URL to the product page if found, else —",
  "resale_price": "Current resale ask from StockX/GOAT/Grailed if retail unavailable, else —",
  "resale_source": "StockX / GOAT / Grailed etc, else —",
  "availability": "In Stock / Sold Out at Retail / Resale Only / Limited",
  "fabric_confirmed": "Official material from product page",
  "colorway_official": "Official colorway name",
  "release_info": "Release date and details",
  "cross_reference_summary": "2 sentences: what the 3 searches confirmed and what price was found where"
}`;

      const synthPrompt = `Item being researched:
Type: ${item.item_type}
Brand guess: ${item.brand_guess}
Style guess: ${item.style_name_guess}
Color: ${item.color}
Visual clues: ${item.brand_clues}

SEARCH RESULT 1:
${results[0] || 'No result'}

SEARCH RESULT 2:
${results[1] || 'No result'}

SEARCH RESULT 3:
${results[2] || 'No result'}

Extract the retail price. Look for dollar amounts on product pages. Return only JSON.`;

      const synthRaw = await callClaude(apiKey, synthSystem, [{ type: 'text', text: synthPrompt }]);
      const synth = safeParseJSON(synthRaw);
      enriched.push({ ...item, research: synth || fallbackResearch(item) });

    } catch (err) {
      enriched.push({ ...item, research: fallbackResearch(item) });
    }
  }

  return res.status(200).json({ subject: phase1.subject, items: enriched });
}

// Search for item AND fetch the product page to get real price
async function searchAndFetchPrice(apiKey, item, queryNum) {
  const query = item[`search_query_${queryNum}`] || `${item.brand_guess} ${item.item_type} ${item.color} retail price buy`;

  const searchSystem = `You are a fashion price researcher. Search for the item, find a direct product page URL, fetch it, and extract the exact retail price shown on the page.

Steps:
1. Search for the item using the query
2. Find the most relevant product listing URL (brand site, SSENSE, Mr Porter, Farfetch, END, Selfridges, Nike.com, etc.)
3. Fetch that URL to get the actual price from the page
4. Report: the brand name, product name, price (with currency), URL, and availability status

Be specific about the price — extract the exact dollar/pound/euro amount shown. If you see "$340" or "£280" report it exactly.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      system: searchSystem,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Search query: ${query}\n\nFind the product page and extract the exact retail price. Report the URL and price.`
      }]
    })
  });

  const text = await r.text();
  if (!r.ok) return null;

  try {
    const data = JSON.parse(text);
    return (data.content || []).map(b => b.text || '').filter(Boolean).join('').trim().slice(0, 800);
  } catch (_) { return null; }
}

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
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: contentArr }]
    })
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
    cross_reference_summary: 'Search unavailable for this item.'
  };
}
