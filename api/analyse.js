export const config = { maxDuration: 300 }; // 5 minutes — accuracy over speed

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
    ? `The user ONLY wants to analyse: "${focusItem}". Identify ONLY that specific item. Return ONLY that one item in the items array.`
    : 'Identify every clothing item and accessory visible, head to toe. Miss nothing.';

  // ── PHASE 1: Initial vision scan ──
  const visionSystem = buildVisionSystem(visionInstruction);

  let phase1;
  try {
    const raw1 = await callClaude(apiKey, visionSystem, [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
      { type: 'text', text: visionInstruction + ' Apply all brand knowledge. Read every visible clue carefully. Return only the JSON object.' }
    ]);
    phase1 = safeParseJSON(raw1);
    if (!phase1 || !phase1.items) throw new Error('Vision parse failed: ' + raw1.slice(0, 300));
  } catch (err) {
    return res.status(500).json({ error: 'Vision analysis failed: ' + err.message });
  }

  // ── PHASE 2: Agentic research loop per item ──
  // Each item goes through multiple research rounds until confidence threshold met
  const enriched = [];
  for (const item of (phase1.items || [])) {
    try {
      const research = await agenticResearch(apiKey, item);
      enriched.push({ ...item, research });
    } catch (err) {
      enriched.push({ ...item, research: fallbackResearch(item) });
    }
  }

  return res.status(200).json({ subject: phase1.subject, items: enriched });
}

// ════════════════════════════════════════════════════════════
// AGENTIC RESEARCH LOOP
// Keeps searching until genuinely confident or max rounds hit
// ════════════════════════════════════════════════════════════
async function agenticResearch(apiKey, item) {
  const MAX_ROUNDS = 8; // Up to 8 search rounds per item
  const CONFIDENCE_THRESHOLD = 85; // Stop when we hit this

  let conversationHistory = [];
  let currentBest = null;
  let roundNum = 0;

  const systemPrompt = `You are an expert fashion investigator with web search access. Your job is to definitively identify a clothing item and find its exact current retail price.

You work in research rounds. Each round you:
1. Search for information about the item
2. Evaluate what you found — did it confirm the brand? Did you find a real price?
3. Decide whether to keep searching from a new angle, or conclude

SEARCH STRATEGY — go in this order:
Round 1: Search for the brand + exact model + colorway (most specific possible)
Round 2: Search the brand's official website directly for current pricing
Round 3: Search authorised retailers (SSENSE, Mr Porter, Farfetch, END, Selfridges, Mytheresa)
Round 4: If still no price, search for the specific style code or SKU
Round 5: Check if there are newer colorways or updated versions of this model
Round 6: Search recent news/releases — is this a new drop? A collaboration?
Round 7: Check resale markets (StockX, GOAT, Grailed) for comparison
Round 8: Final synthesis — make your definitive call based on everything found

BRAND WEBSITE PRIORITY LIST:
nike.com, adidas.com, newbalance.com, salomon.com, asics.com, converse.com, vans.com, timberland.com, ugg.com, birkenstock.com
gucci.com, louisvuitton.com, dior.com, prada.com, balenciaga.com, bottegaveneta.com, ysl.com, celine.com, loewe.com, valentino.com, givenchy.com, burberry.com, versace.com, fendi.com, moncler.com
fearofgod.com, rickowens.eu, off---white.com, bape.com, supremenewyork.com, palace.com, acnestudios.com, maisonmargiela.com, carhartt-wip.com, stussy.com, kith.com, aimeleondore.com, humanmade.jp, thombrowne.com, noahny.com, rhude.com, representclo.com, goldengoose.com, alexandermcqueen.com, canadagoose.com, arcteryx.com, thenorthface.com
ssense.com, mrporter.com, farfetch.com, endclothing.com, selfridges.com, matchesfashion.com, mytheresa.com, brownsfashion.com, luisaviaroma.com, nordstrom.com

WHEN TO STOP SEARCHING:
- You have confirmed brand AND found a real price from an authorised source → stop
- You've done 8 rounds and still uncertain → report best guess with honest confidence note
- You found the item is sold out everywhere → report last known retail + resale

ALSO CHECK for recency — search "[brand] [item] 2024 2025 new release" to see if there's a newer version or recent collab that changes the identification.

After EACH search round, output your current findings as JSON inside <findings> tags. After your final round, output your DEFINITIVE answer as JSON inside <final> tags.

FINDINGS format (after each round):
<findings>
{
  "round": 1,
  "what_i_searched": "query used",
  "what_i_found": "summary of results",
  "brand_status": "confirmed/likely/uncertain",
  "price_found": "$X or null",
  "price_source": "source or null",
  "product_url": "url or null",
  "confidence": 72,
  "next_action": "what I'll search next and why"
}
</findings>

FINAL format (when done):
<final>
{
  "brand_verified": "Definitive confirmed brand",
  "brand_verification_confidence": "Confirmed/Likely/Uncertain",
  "final_confidence_score": 91,
  "style_name": "Official product name",
  "style_code": "SKU if found else —",
  "retail_price": "Exact price e.g. $340",
  "retail_source": "Nike.com / SSENSE etc",
  "product_url": "Direct URL",
  "resale_price": "Resale price if applicable",
  "resale_source": "StockX/GOAT etc",
  "availability": "In Stock / Sold Out at Retail / Resale Only / Limited / Discontinued",
  "fabric_confirmed": "Official materials",
  "colorway_official": "Official colorway name",
  "release_info": "Release date and how it was sold",
  "searches_summary": "Brief summary of what angles were searched across all rounds",
  "confidence_note": "Why you are confident — or what was ambiguous and how you resolved it"
}
</final>`;

  const initialPrompt = `Item to research:
Type: ${item.item_type}
Brand guess: ${item.brand_guess} (confidence: ${item.brand_confidence})
Style guess: ${item.style_name_guess || 'unknown'}
Color: ${item.color}
Material: ${item.material_guess}
Visual clues seen: ${item.brand_clues}
Cultural context: ${item.cultural_context || ''}

Begin Round 1. Start with your most specific possible search. Output <findings> after each round.`;

  conversationHistory.push({ role: 'user', content: initialPrompt });

  // Run research rounds
  for (let round = 0; round < MAX_ROUNDS; round++) {
    roundNum = round + 1;

    try {
      const response = await callClaudeWithSearch(apiKey, systemPrompt, conversationHistory);

      // Add assistant response to history
      conversationHistory.push({ role: 'assistant', content: response });

      // Check if we have a final answer
      const finalMatch = response.match(/<final>([\s\S]*?)<\/final>/);
      if (finalMatch) {
        const parsed = safeParseJSON(finalMatch[1]);
        if (parsed) {
          currentBest = parsed;
          break;
        }
      }

      // Extract findings to check confidence
      const findingsMatch = response.match(/<findings>([\s\S]*?)<\/findings>/);
      if (findingsMatch) {
        const findings = safeParseJSON(findingsMatch[1]);
        if (findings) {
          // Update our running best
          if (!currentBest || (findings.confidence > (currentBest.final_confidence_score || 0))) {
            currentBest = {
              brand_verified: item.brand_guess,
              brand_verification_confidence: findings.brand_status === 'confirmed' ? 'Confirmed' : findings.brand_status === 'likely' ? 'Likely' : 'Uncertain',
              final_confidence_score: findings.confidence || 50,
              style_name: item.style_name_guess || '—',
              style_code: '—',
              retail_price: findings.price_found || 'Unable to retrieve',
              retail_source: findings.price_source || '—',
              product_url: findings.product_url || '—',
              resale_price: '—',
              resale_source: '—',
              availability: findings.price_found ? 'In Stock' : 'Unknown',
              fabric_confirmed: item.material_guess || '—',
              colorway_official: item.color || '—',
              release_info: '—',
              searches_summary: `Round ${roundNum}: ${findings.what_i_searched}`,
              confidence_note: findings.what_i_found || '—'
            };
          }

          // Check if confidence threshold met and we have a price
          if (findings.confidence >= CONFIDENCE_THRESHOLD && findings.price_found) {
            // Ask for final answer
            conversationHistory.push({
              role: 'user',
              content: `Confidence is ${findings.confidence}% and we have a price. Please output your <final> answer now with all the details you've gathered.`
            });

            const finalResponse = await callClaudeWithSearch(apiKey, systemPrompt, conversationHistory);
            conversationHistory.push({ role: 'assistant', content: finalResponse });

            const fm = finalResponse.match(/<final>([\s\S]*?)<\/final>/);
            if (fm) {
              const fp = safeParseJSON(fm[1]);
              if (fp) { currentBest = fp; break; }
            }
            break;
          }

          // If not done, prompt next round
          if (round < MAX_ROUNDS - 1) {
            const nextRoundPrompt = `Round ${roundNum} complete. ${findings.next_action ? 'Your plan: ' + findings.next_action : 'Continue with Round ' + (roundNum + 1) + '.'} Search now and output <findings> with updated results.`;
            conversationHistory.push({ role: 'user', content: nextRoundPrompt });
          } else {
            // Last round — force final answer
            conversationHistory.push({
              role: 'user',
              content: 'This is the final round. Based on everything you have found across all rounds, output your <final> definitive answer now.'
            });
            const lastResponse = await callClaudeWithSearch(apiKey, systemPrompt, conversationHistory);
            const lm = lastResponse.match(/<final>([\s\S]*?)<\/final>/);
            if (lm) {
              const lp = safeParseJSON(lm[1]);
              if (lp) currentBest = lp;
            }
          }
        }
      }
    } catch (err) {
      // Round failed, continue to next
      if (round === MAX_ROUNDS - 1) break;
      conversationHistory.push({ role: 'user', content: 'That search had an issue. Try a different search angle for Round ' + (roundNum + 1) + '.' });
    }
  }

  return currentBest || fallbackResearch(item);
}

async function callClaudeWithSearch(apiKey, system, messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 3000,
      system,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages
    })
  });
  const text = await r.text();
  if (!r.ok) {
    try { const j = JSON.parse(text); throw new Error(j?.error?.message || 'API error'); }
    catch (_) { throw new Error('API error ' + r.status); }
  }
  const data = JSON.parse(text);
  return (data.content || []).map(b => b.text || '').filter(Boolean).join('');
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
    searches_summary: '—',
    confidence_note: 'Research unavailable'
  };
}

// ════════════════════════════════════════════════════════════
// BRAND ENCYCLOPEDIA — baked into vision system
// ════════════════════════════════════════════════════════════
function buildVisionSystem(instruction) {
  return `You are the world's most comprehensive fashion identification AI with encyclopedic knowledge of every clothing brand, designer label, streetwear line, and luxury house — including what's new in 2024 and 2025.

You identify clothing by reading visual signatures the way a forensic expert reads evidence. You know every logo, every sole unit, every stitching pattern, every hardware detail.

═══════════════════════════════
IDENTIFICATION RULES
═══════════════════════════════

READ ALL TEXT FIRST:
- Every word, number, date, city name, logo, tab, patch, label, hang tag
- Quoted text "LIKE THIS" with industrial styling = Virgil Abloh / Off-White
- "ESSENTIALS" rubberized/reflective patch = Fear of God Essentials (FOG)
- "FEAR OF GOD" = mainline Fear of God (higher price, darker palette)
- "1017 ALYX 9SM" = Alyx by Matthew Williams
- "PALACE" or tri-ferg triangle = Palace Skateboards
- "SUPREME" box logo red/white = Supreme (Futura Heavy Oblique font)
- "CHROME HEARTS" gothic text, crosses, daggers = Chrome Hearts
- Stone Island: removable compass badge, left sleeve
- CP Company: lens/goggle detail on sleeve or hood
- "TRAPSTAR" gothic T, "IT'S A SECRET" inner label = Trapstar London
- "CORTEIZ" or "CRTZ" Alcatraz logo = Corteiz
- "SP5DER" web graphic = Sp5der (Young Thug's brand)
- "HELLSTAR" gothic star = Hellstar Studios
- "DENIM TEARS" cotton wreath = Denim Tears (Tremaine Emory)
- "HUMAN MADE" duck graphic, NIGO's brand
- "KITH" wordmark = Kith
- "ALD" or "AIME LEON DORE" = Aimé Leon Dore
- "NOAH" anchor logo = Noah NYC
- "REPRESENT" embossed R = Represent Clothing
- "RHUDE" text = Rhude (Rhuigi Villaseñor)
- "SPORTY & RICH" script = Sporty & Rich
- "MADHAPPY" or "Local Optimist" = Madhappy

LOGO RECOGNITION:
- Nike Swoosh: angle identifies era/model. Check if reversed (Travis Scott collab)
- Adidas 3 stripes: spacing/width varies by model. Trefoil (heritage) vs Performance (sport)
- Jordan Jumpman: angle and size varies. Wings logo = vintage
- New Balance "N": thick=lifestyle, thin=performance
- Salomon "S/LAB": quicklace system, XT-6 sole
- BAPE: camo shark pattern, shooting star/lightning bolt logo = Bapesta
- Gucci: interlocking GG, red-green-red web stripe
- LV: LV monogram, Damier checkerboard
- Dior: CD oblique, "DIOR" in serif vs sans serif (era indicator)
- Prada: inverted triangle logo, Saffiano cross-hatch leather
- Bottega Veneta: Intrecciato woven pattern (no logo needed — weave IS the brand)
- Loewe: Anagram pattern, puzzle bag hardware
- Celine: "CELINE" no accent (Hedi era) vs "CÉLINE" with accent (Phoebe era)
- Saint Laurent: "SAINT LAURENT PARIS" Hedi era vs old YSL logo
- Balenciaga: Track sole massive profile, Triple S three-layer sole, Speed sock stretchy
- Rick Owens: "OWENS" text, asymmetric construction, pod boots, Ramones sole
- Maison Margiela: four white stitches at label position, Tabi split toe, "MM6" sub-label
- Comme des Garçons: heart with eyes logo (Play), "CDG" = collab line
- Thom Browne: 4-bar grosgrain stripe (red/white/blue/white), shrunken proportions
- Golden Goose: distressed star patch, intentionally scuffed leather, "GGDB" text
- Alexander McQueen: skull hardware, "McQUEEN" on sole of Oversized Sneaker
- Valentino: Rockstud pyramid spikes, Roman stud flat pattern, VLTN logo
- Moncler: tricolour badge (red/white/blue), quilted ripstop nylon
- Canada Goose: Arctic Programme badge, red maple leaf, down fill weight on badge
- Arc'teryx: bird logo, visible Gore-Tex seam tape, Atom/Beta/Zeta line
- The North Face: Half Dome logo, Nuptse quilted squares, "700" fill power on tag
- Patagonia: mountain wave logo, synchilla fleece texture, "R2" or "R1" regulator series
- Carhartt WIP: "C" logo vs full "WIP" label, Detroit jacket silhouette, Chase logo
- Stussy: interlocking S logo, Stussy script font
- Supreme: box logo red rectangle or script logo on accessories and hats
- Acne Studios: face logo, "ACNE STUDIOS" clean sans serif
- Ami Paris: "AMI DE COEUR" heart = signature piece, "AMI" text
- Jacquemus: extreme mini or oversized proportions, Le Chiquito bag, Le Bob hat
- Vetements: "VETEMENTS" across chest, DHL collab, extreme oversized
- Raf Simons: slim lapels, "RAF SIMONS" text, graphic tee prints
- Yohji Yamamoto: "Y-3" = Adidas collab, "Yohji Yamamoto" script, asymmetric hems
- Dsquared2: "D2" or "DSQ2" logo, Canadian maple leaf, distressed denim
- Philipp Plein: skull with crown, "PP" or "PLEIN" rhinestone text
- Moschino: teddy bear, "MOSCHINO" belt text
- Vivienne Westwood: orb logo, tartan pattern, Saturn earring/pendant
- Fendi: FF logo, baguette bag silhouette, Peekaboo structured bag
- Burberry: nova check (tan/black/red/white), equestrian knight logo, "BURBERRY" text
- Versace: Medusa head, Greek key border, Baroque all-over print
- Givenchy: 4G logo, Antigona bag hard structure, "GIVENCHY" text
- Lanvin: "LANVIN" embossed, curb sneaker extra-chunky sole
- Issey Miyake: Pleats Please accordion pleating, A-POC cut
- Dries Van Noten: floral prints, no logo — identified by aesthetic
- Ann Demeulemeester: no logo, dark romantic, lace-up boots signature

FOOTWEAR — EXACT SILHOUETTE ID:
Nike:
- Air Force 1: flat cupsole, perforated toebox, optional ankle strap, circle heel
- Dunk Low/High: padded collar, different heel tab to AF1, hockey stick swoosh
- Air Max 1: small heel air window, mesh upper panels
- Air Max 90: large visible heel air, plastic heel counter, different overlay pattern
- Air Max 95: gradient stripe panels (human anatomy inspiration), no-sew overlays
- Air Max 97: full-length silver bullet silhouette, reflective stripe, sealed air
- Air Jordan 1: Wings logo, "AIR JORDAN" tongue label, various collar heights
- Air Jordan 3: elephant print, visible forefoot air, Jumpman tongue
- Air Jordan 4: side mesh netting, plastic lace locks, "NIKE AIR" heel (OG versions)
- Air Jordan 11: patent leather mudguard, carbon fiber plate visible
- Nike SB Dunk: extra tongue padding, Zoom Air, skate reinforcement
- Nike Cortez: classic heritage runner, nylon/leather, minimal sole
- Sacai x Nike: double swoosh, stacked/layered build
- Travis Scott x Nike: reversed swoosh, earthy tones, Cactus Jack
- Off-White x Nike The Ten: deconstructed, zip ties, "AIR" in quotes

Adidas:
- Stan Smith: perforated 3-stripe vents, "STAN SMITH" tongue, no midsole lines
- Superstar: shell toe (rubber bumper cap), flat 3 stripes
- Samba: indoor soccer heritage, gum sole, T-toe rubber overlay, "SAMBA" on tongue
- Gazelle: suede, thinner profile than Campus, "GAZELLE" text
- Campus: thicker profile, "CAMPUS" text, used in Palace/BAPE collabs
- Forum: ankle strap basketball silhouette
- Yeezy 350 v2: Primeknit upper, full Boost sole, side stripe, "SPLY-350" on v1
- Yeezy 500: bulkier dad shoe, Adiprene+ midsole, suede/mesh upper
- Yeezy 700: "700" heel, gradient colorways, heavy layered sole

New Balance:
- 990 series: premium suede/mesh, ENCAP/ABZORB sole, Made in USA flag tag
- 992: wider toe box than 990, specific midsole tooling
- 1906R: futuristic toe cap, N-ergy sole, metallic details
- 2002R: sealed mesh, protection pack silhouette
- 550: basketball heritage, thick cupsole, "550" on tongue
- 9060: chunky updated 906, extra layered midsole
- Salomon XT-6: multi-lug sole unit, quicklace, "S/LAB" text
- ASICS: Gel visible in heel/forefoot cutout, Tiger stripes angle
- Saucony Shadow/Jazz: specific stripe pattern, heritage runner profile

MATERIALS — KEY IDENTIFIERS:
Leather: pebbled, smooth, Saffiano cross-hatch (Prada), Vachetta raw trim (LV), nubuck (matte sanded), suede (soft nap split leather), patent (high gloss)
Fabric: ripstop grid nylon, Gore-Tex membrane tape seams visible, ECONYL recycled nylon, Cordura high-tenacity, sherpa/teddy looped fleece, boucle knotted yarn, French terry loop-back, Primeknit (Adidas stretchy sock), Flyknit (Nike engineered knit)
Luxury weaves: Intrecciato (Bottega — hand-woven strips), GG canvas, LV monogram coated canvas, quilted diamond (Chanel), cashmere ultra-fine, merino fine wool

CURRENT TRENDS — 2024/2025 AWARENESS:
- Gorpcore: Arc'teryx, Salomon, TNF, Patagonia, techwear
- Quiet luxury: Loro Piana, Brunello Cucinelli, The Row, Jil Sander — no logos
- New Balance dominance: 1906R, 9060, 650 in rotation
- Adidas Samba/Gazelle/Campus super-cycle continuing
- Asics resurgence: Gel-Kayano 14, Gel-NYC, Gel-1130
- On Running: Cloudmonster, Cloudrunner mainstream
- Hoka: Clifton, Bondi, Mafate in fashion contexts
- Retro basketball: Nike Dunk variants, Air Jordan 1/3/4 retros
- Luxury sneaker: Loewe Flow Runner, Bottega Veneta puddle boots, Celine sneakers
- Sp5der, Hellstar, Corteiz dominating streetwear 2024
- Aimé Leon Dore collaboration pieces
- Carhartt WIP collaborations (new season pieces)
- Japan-exclusive releases often seen on secondhand market

${instruction}

Return ONLY valid JSON, no markdown:
{
  "subject": {
    "description": "Detailed person/setting description",
    "style_summary": "Specific aesthetic category — e.g. Gorpcore, Quiet Luxury, NYC Streetwear, Luxury Casual"
  },
  "items": [
    {
      "id": 1,
      "position": "head/outerwear/top/bottom/footwear/bag/belt/jewelry/glasses/watch/socks/other",
      "item_type": "Most specific name — never just sneaker or hoodie",
      "color": "Exact colorway, official name if known",
      "material_guess": "Precise material",
      "brand_guess": "Full brand including collab partners",
      "brand_confidence": "High/Medium/Low",
      "vision_confidence": 88,
      "brand_clues": "Every visual clue: text read, logo details, hardware, construction, sole, stitching",
      "style_name_guess": "Specific model + colorway + style code if identifiable",
      "cultural_context": "Designer history, collab backstory, current cultural relevance, rarity"
    }
  ]
}`;
}

