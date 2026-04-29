export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY environment variable is not set.' });

  const { base64, mimeType } = req.body || {};
  if (!base64 || !mimeType) return res.status(400).json({ error: 'Missing base64 or mimeType in request body.' });

  const systemPrompt = `You are a senior fashion expert and luxury garment analyst with 30 years of experience at major fashion houses: Chanel, Dior, Gucci, Saint Laurent, Prada, Balenciaga, Valentino, Bottega Veneta, Loro Piana, Brunello Cucinelli, Celine, Loewe, Jacquemus, Rick Owens, and more. You have deep expertise in designer identification, fabric analysis, garment construction, sizing standards, and measurement estimation.

Analyze the garment image and return ONLY a valid JSON object — no markdown fences, no preamble, no trailing text. Use exactly this structure:

{
  "garment_type": "Specific garment type e.g. Straight-leg trouser, Oversized blazer, Bias-cut slip dress",
  "designer": "Most likely designer or brand. If not identifiable, write: Indeterminate",
  "designer_confidence": "High or Medium or Low",
  "designer_notes": "Specific reasoning: silhouette tells, logo, construction signatures, fabric choices, hardware, stitching details",
  "collection": "Likely season and year e.g. SS24, FW23, or Unknown",
  "material_primary": "Primary fabric e.g. 100% Cashmere, Silk-wool blend",
  "material_secondary": "Lining or secondary fabric, or: Not visible",
  "fabric_details": "Weave type, weight, finish, texture e.g. Medium-weight double-faced wool crepe, matte finish, tightly woven 2x2 twill",
  "cut": "Detailed cut description e.g. Relaxed straight leg, mid-rise, wide hem opening, cropped at ankle",
  "silhouette": "A-line or Column or Boxy or Fitted or Cocoon or Oversized or Draped",
  "fit_category": "Slim or Regular or Relaxed or Oversized or Boxy or Tailored",
  "size_range": "e.g. EU 36-46 / IT 38-48 / US XS-XL",
  "inseam_estimate": "e.g. 32 inches / 81cm, or N/A",
  "rise_estimate": "e.g. Mid-rise approx 10 inches / 25cm, or N/A",
  "construction": "Finishing technique, likely origin, lining, closures e.g. Hand-finished seams, likely made in Italy, fully canvas-lined, functional horn buttons",
  "notable_details": "Distinctive elements: hardware, prints, embroidery, pleating, vents, pockets",
  "care": "Likely care requirements e.g. Dry clean only",
  "estimated_retail": "Price range e.g. $2,400 - $3,800, or Unable to estimate",
  "tags": ["max 8 lowercase style keywords"]
}`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: 'Analyse this garment in full detail.' }
          ]
        }]
      })
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      const msg = data?.error?.message || JSON.stringify(data);
      return res.status(anthropicRes.status).json({ error: `Anthropic error: ${msg}` });
    }

    const raw = (data.content || []).map(b => b.text || '').join('');
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: 'Model returned invalid JSON. Try again with a clearer image.' });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
