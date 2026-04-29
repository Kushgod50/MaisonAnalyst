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

  // ── PHASE 1: Vision — forensic identification ──
  const visionSystem = `You are the world's foremost sneaker authenticator and fashion forensics expert with 20+ years authenticating for Christie's, Sotheby's, GOAT, and StockX. You have encyclopedic knowledge of every brand, collab, limited edition, and designer piece ever made.

YOUR RULES:
1. Read ALL visible text — brand names, city names, dates, quotes. These are your most important clues.
2. Quoted labels like "SHOELACES" or "AIR" = Virgil Abloh / Off-White. Identify immediately.
3. Shooting star/lightning bolt logo = BAPE Bapesta. Always.
4. NEVER say "custom" unless you have strong evidence it was not produced officially.
5. If you see collab indicators from multiple brands on one item, name BOTH brands.
6. Be DECISIVE. Say "BAPE x Off-White Bapesta" not "possibly custom sneaker."
7. Include cultural context — who designed it, when, why it matters.
8. For every item generate 3 distinct search queries from different angles to cross-reference.
9. Assign a confidence score 0-100 for each item based on how clearly you can identify it.

Return ONLY valid JSON. No markdown, no text outside JSON.
{
  "subject": {
    "description": "Detailed description of person/setting",
    "style_summary": "Overall aesthetic and cultural world this outfit belongs to",
    "style_tags": ["tag1","tag2","tag3"]
  },
  "items": [
    {
      "id": 1,
      "position": "head/outerwear/top/bottom/footwear/bag/belt/jewelry/glasses/watch/socks/other",
      "item_type": "Most specific possible name e.g. BAPE x Off-White Bapesta Low",
      "color": "Exact colorway with material",
      "material_guess": "Precise material description",
      "brand_guess": "Full brand/collab credit",
      "brand_confidence": "High/Medium/Low",
      "vision_confidence": 92,
      "brand_clues": "Every visual clue read forensically",
      "style_name_guess": "Most specific product name with collab and colorway",
      "cultural_context": "Why this item matters — designer history, collab backstory, rarity",
      "search_query_1": "First angle: brand + exact model + colorway + retail price",
      "search_query_2": "Second angle: SKU code OR alternative style name OR collab name",
      "search_query_3": "Third angle: resale market query e.g. StockX GOAT lowest ask"
    }
  ]
}`;

  let phase1;
  try {
    const raw1 = await callClaude(apiKey, visionSystem, [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
      { type: 'text', text: focusInstruction + ' Read every text, logo, and detail forensically. Return only the JSON object.' }
    ]);
    phase1 = safeParseJSON(raw1);
    if (!phase1 || !phase1.items) throw new Error('Vision parse failed. Raw: ' + raw1.slice(0, 300));
  } catch (err) {
    return res.status(500).json({ error: 'Vision analysis failed: ' + err.message });
  }

  // ── PHASE 2: Triple cross-reference per item in parallel ──
  const enriched = [];

  for (const item of (phase1.items || [])) {
    try {
      const [r1, r2, r3] = await Promise.allSettled([
        searchItem(apiKey, item.search_query_1 || item.brand_guess + ' ' + item.item_type + ' retail price'),
        searchItem(apiKey, item.search_query_2 || item.style_name_guess + ' buy cheapest'),
        searchItem(apiKey, item.search_query_3 || item.item_type + ' StockX GOAT lowest ask')
      ]);

      const results = [r1, r2, r3].map(r => r.status === 'fulfilled' ? r.value : 'Search unavailable').filter(Boolean);

      // Phase 2b: Synthesise all 3 results into one definitive answer
      const synthSystem = `You are a fashion and sneaker market expert. You have been given 3 independent web search results about the same fashion item. Your job is to cross-reference them, find what they AGREE on, resolve contradictions, and produce one DEFINITIVE identification with the cheapest current price.

Rules:
- If 2+ sources agree on brand/model → Confirmed
- If only 1 source identifies it a certain way → Likely  
- If sources conflict without resolution → Uncertain
- Always report the SINGLE lowest legitimate price found across all sources
- Be definitive. No hedging. No "could be".

Return ONLY valid JSON:
{
  "brand_verified": "Definitive brand — no hedging",
  "brand_verification_confidence": "Confirmed/Likely/Uncertain",
  "final_confidence_score": 88,
  "style_name": "Official definitive product name",
  "style_code": "SKU or style code if found, else —",
  "cheapest_price": "Lowest price found e.g. $320 or Unable to retrieve",
  "cheapest_source": "Platform e.g. GOAT / StockX / Nike.com / Farfetch",
  "retail_price": "Original retail price",
  "resale_price": "Current resale ask if applicable",
  "price_context": "e.g. Sold out at retail, resale only / In stock at retail / Limited release",
  "fabric_confirmed": "Confirmed materials from listing",
  "colorway_official": "Official colorway name",
  "release_info": "Release date, how sold, quantity if known",
  "cross_reference_summary": "2 sentences: what all 3 searches confirmed and how you resolved any contradictions"
}`;

      const synthPrompt = `Item: ${item.item_type}
Brand guess: ${item.brand_guess} (${item.brand_confidence} confidence)
Visual clues: ${item.brand_clues}
Style guess: ${item.style_name_guess}

SEARCH 1 (${item.search_query_1}):
${results[0] || 'No result'}

SEARCH 2 (${item.search_query_2}):
${results[1] || 'No result'}

SEARCH 3 (${item.search_query_3}):
${results[2] || 'No result'}

Cross-reference all 3. Give definitive ID and cheapest price. Return only JSON.`;

      const synthRaw = await callClaude(apiKey, synthSystem, [{ type: 'text', text: synthPrompt }]);
      const synth = safeParseJSON(synthRaw);
      enriched.push({ ...item, research: synth || fallbackResearch(item) });
    } catch (err) {
      enriched.push({ ...item, research: fallbackResearch(item) });
    }
  }

  return res.status(200).json({ subject: phase1.subject, items: enriched });
}

async function searchItem(apiKey, query) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 800,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: `Search for: ${query}. Summarise what you find: brand name, exact product name, style code if listed, price, and where to buy. Plain text, concise.` }]
    })
  });
  const text = await r.text();
  if (!r.ok) return null;
  try {
    const data = JSON.parse(text);
    return (data.content || []).map(b => b.text || '').filter(Boolean).join('').trim().slice(0, 700);
  } catch (_) { return null; }
}

async function callClaude(apiKey, system, contentArr) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4000, system, messages: [{ role: 'user', content: contentArr }] })
  });
  const text = await r.text();
  if (!r.ok) {
    try { const j = JSON.parse(text); throw new Error(j?.error?.message || text.slice(0, 300)); }
    catch (_) { throw new Error(text.slice(0, 300)); }
  }
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error('Non-JSON from Anthropic'); }
  return (data.content || []).map(b => b.text || '').join('');
}

function safeParseJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (match) { try { return JSON.parse(match[0]); } catch (_) {} }
  try {
    let s = cleaned;
    const lc = Math.max(s.lastIndexOf(',\n    {'), s.lastIndexOf(',\n  {'));
    if (lc > 100) s = s.slice(0, lc);
    const ob = (s.match(/\{/g)||[]).length - (s.match(/\}/g)||[]).length;
    const oa = (s.match(/\[/g)||[]).length - (s.match(/\]/g)||[]).length;
    for (let i=0;i<ob;i++) s+='}';
    for (let i=0;i<oa;i++) s+=']';
    const rec = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (rec) return JSON.parse(rec[0]);
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
    cheapest_price: 'Unable to retrieve',
    cheapest_source: '—',
    retail_price: '—',
    resale_price: '—',
    price_context: 'Search unavailable',
    fabric_confirmed: item.material_guess || '—',
    colorway_official: item.color || '—',
    release_info: '—',
    cross_reference_summary: 'Cross-reference search unavailable for this item.'
  };
}
