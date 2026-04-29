export const config = { maxDuration: 90 };

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

  const focusInstruction = focusItem
    ? `The user specifically wants to focus on: "${focusItem}". Prioritise that item above all others but still list everything visible.`
    : 'Identify every clothing item and accessory visible, head to toe. Be exhaustive.';

  // ── PHASE 1: Vision — read every clue like a forensic sneaker/fashion expert ──
  const visionSystem = `You are the world's foremost sneaker authenticator and fashion forensics expert. You have:
- 20+ years authenticating sneakers and streetwear for Christie's, Sotheby's, GOAT, and StockX
- encyclopedic knowledge of every Nike, Adidas, Jordan, New Balance, Salomon, BAPE, Off-White, Supreme, Fear of God, Amiri, Chrome Hearts, Dior, Gucci, Balenciaga, Prada, Saint Laurent, Celine, Rick Owens, and 500+ other brand collaborations
- deep knowledge of Virgil Abloh's entire body of work — every Off-White collab, every Nike "The Ten" shoe, BAPE collabs, MCA Chicago pieces, posthumous releases
- ability to read branding text, collab signatures, construction details, and limited edition markers from photos

YOUR RULES:
1. NEVER say "custom" or "aftermarket" unless you have strong evidence it wasn't produced officially. Many things that look custom ARE official collabs.
2. READ ALL TEXT visible in the image — brand names, city names, dates, quotation marks, labels, hang tags, stamps. These are your most important clues.
3. Quoted text on clothing/shoes (e.g. "SHOELACES", "AIR", "LACES") is a signature Virgil Abloh / Off-White design language — identify it as such immediately.
4. A shooting star / lightning bolt star logo = BAPE Bapesta. Always.
5. Crocodile or exotic-embossed leather on a cupsole sneaker = premium material collab.
6. Cross-reference ALL visual clues together to reach the most specific possible identification.
7. If you see collab indicators from multiple brands on one item, it IS a collaboration — name both brands.
8. Be DECISIVE and SPECIFIC. Say "BAPE x Off-White Bapesta" not "possibly a custom sneaker."
9. Include the historical/cultural context of the item — who designed it, when, why it matters.
10. Your search query must be the most specific possible to find THIS exact item.

Return ONLY valid JSON. No markdown, no text outside the JSON.

{
  "subject": {
    "description": "Detailed description of the person/setting — build, pose, setting, what is and isn't visible",
    "style_summary": "Overall aesthetic and cultural context — what world does this outfit belong to?"
  },
  "items": [
    {
      "id": 1,
      "position": "head / outerwear / top / bottom / footwear / bag / belt / jewelry / glasses / watch / socks / other",
      "item_type": "Most specific possible item name — e.g. BAPE x Off-White Bapesta Low, NOT just sneaker",
      "color": "Exact colorway with material description",
      "material_guess": "Precise material — e.g. crocodile-embossed full-grain leather upper, vulcanized rubber cupsole",
      "brand_guess": "Full collab credit if applicable — e.g. A Bathing Ape (BAPE) x Off-White by Virgil Abloh",
      "brand_confidence": "High / Medium / Low",
      "brand_clues": "Every visual clue read forensically — text visible, logos, star shape, midsole profile, lace jewel, colorway, label text, dates, city names",
      "style_name_guess": "Most specific product name with collab name and colorway — e.g. BAPE x Off-White Bapesta Low Black Croc",
      "cultural_context": "Why this item matters — designer history, collab backstory, rarity, cultural significance",
      "search_query": "Hyper-specific search query — e.g. BAPE Off-White Virgil Abloh Bapesta black crocodile shoelaces collab price"
    }
  ]
}`;

  let phase1;
  try {
    const raw1 = await callClaude(apiKey, visionSystem, [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
      { type: 'text', text: focusInstruction + ' Read every piece of text, every logo, every design detail forensically. Be decisive and specific. Return only the JSON object.' }
    ]);
    phase1 = safeParseJSON(raw1);
    if (!phase1 || !phase1.items) throw new Error('Response parsed but missing items array. Raw start: ' + raw1.slice(0, 300));
  } catch (err) {
    return res.status(500).json({ error: 'Vision analysis failed: ' + err.message });
  }

  // ── PHASE 2: Deep web search — find the exact item and cheapest real price ──
  const enriched = [];
  for (const item of (phase1.items || [])) {
    try {
      const searchSystem = `You are a sneaker and luxury fashion market researcher with access to real-time web search. 

Your job: verify the exact item identified and find the cheapest legitimate price available right now.

Search strategy:
1. Search the exact collab name + colorway first
2. Search the style code / SKU if identifiable  
3. Check StockX, GOAT, Grailed, Vestiaire, then brand sites, then retailers
4. If it's a rare collab, check auction results too
5. Note if the item is sold out at retail (meaning resale only) and give the lowest resale ask

For rare collabs by deceased designers (e.g. Virgil Abloh), note the cultural significance and how it affects price.

Return ONLY valid JSON — no markdown, no text outside JSON:
{
  "brand_verified": "Full verified brand/collab credit",
  "brand_verification_confidence": "Confirmed / Likely / Uncertain",
  "style_name": "Official full product name",
  "style_code": "SKU or style code if found",
  "cheapest_price": "Lowest current asking price found e.g. $1,200",
  "cheapest_source": "Platform where that price was found e.g. GOAT / StockX / Grailed",
  "retail_price": "Original retail price when released",
  "price_context": "Context e.g. Sold out at retail. Resale only. / In stock at retail. / Limited auction piece.",
  "fabric_confirmed": "Official materials from product listing",
  "colorway_official": "Official colorway name",
  "release_info": "Release date, quantity, how it was sold (raffle, retail, online drop etc.)"
}`;

      const prompt = `Find the exact item and cheapest current price:
Item: ${item.item_type}
Brand/Collab: ${item.brand_guess}
Style: ${item.style_name_guess || 'unknown'}
Color: ${item.color}
Cultural context: ${item.cultural_context || ''}
Search query to use: ${item.search_query}

Search thoroughly. This may be a rare collab — check StockX, GOAT, Grailed, and auction sites. Return only JSON.`;

      const raw2 = await callClaudeWithSearch(apiKey, searchSystem, prompt);
      const parsed = safeParseJSON(raw2);
      enriched.push({ ...item, research: parsed || fallbackResearch(item) });
    } catch (err) {
      enriched.push({ ...item, research: fallbackResearch(item) });
    }
  }

  return res.status(200).json({ subject: phase1.subject, items: enriched });
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

  // 1. Try clean full parse
  const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }

  // 2. Response was truncated — try to recover by closing open structures
  try {
    let s = cleaned;
    // Strip any trailing partial field (e.g. cut off mid-string)
    const lastComma = Math.max(s.lastIndexOf(',\n    {'), s.lastIndexOf(',\n  {'));
    if (lastComma > 100) s = s.slice(0, lastComma);
    // Count open braces/brackets and close them
    const openBraces = (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
    const openBrackets = (s.match(/\[/g) || []).length - (s.match(/\]/g) || []).length;
    for (let i = 0; i < openBraces; i++) s += '}';
    for (let i = 0; i < openBrackets; i++) s += ']';
    const recovered = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (recovered) return JSON.parse(recovered[0]);
  } catch (_) {}

  return null;
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
    colorway_official: item.color || '—',
    release_info: '—'
  };
}
