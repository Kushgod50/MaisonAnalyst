export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const { base64, mimeType } = req.body;
  if (!base64 || !mimeType) {
    return res.status(400).json({ error: 'Missing base64 or mimeType' });
  }

  const systemPrompt = `You are a senior fashion expert and luxury garment analyst with 30 years of experience working at major fashion houses including Chanel, Dior, Gucci, Saint Laurent, Prada, Balenciaga, Valentino, Bottega Veneta, Loro Piana, Brunello Cucinelli, and more. You have deep expertise in:
- Designer identification from silhouettes, signatures, stitching, and construction details
- Fabric and material identification (weave structures, fiber types, surface textures, weights)
- Garment construction and bespoke tailoring techniques
- Sizing standards across designer brands and sizing cuts (slim, regular, relaxed, oversized, boxy)
- Inseam, rise, hem, and body measurements
- Seasonal collections and runway history

When analyzing a garment image, provide a thorough expert analysis. Return ONLY a valid JSON object with this exact structure — no markdown, no preamble, no trailing text:
{
  "garment_type": "e.g. Straight-leg trouser, Boxy blazer, Slip dress",
  "designer": "Most likely designer or brand (if identifiable). If not identifiable, say 'Indeterminate — possible luxury independent'",
  "designer_confidence": "High / Medium / Low",
  "designer_notes": "Why you identified this designer — specific tells, logo placement, construction signatures, silhouette hallmarks",
  "collection": "Likely season/year if identifiable, e.g. 'SS23' or 'Unknown'",
  "material_primary": "Primary fabric composition e.g. '100% Wool Crepe'",
  "material_secondary": "Secondary or lining fabric if visible, or 'Not visible'",
  "fabric_details": "Detailed description of weave, weight, finish, texture — e.g. 'Medium-weight double-faced wool crepe, matte finish, tightly woven'",
  "cut": "Specific cut description e.g. 'Relaxed straight leg with mid-rise waist, wide hem opening'",
  "silhouette": "Overall silhouette e.g. 'A-line', 'Column', 'Boxy', 'Fitted', 'Cocoon'",
  "fit_category": "Slim / Regular / Relaxed / Oversized / Boxy / Tailored",
  "size_range": "Likely sizing standard e.g. 'EU 36-46 / IT 38-48 / US 2-12'",
  "inseam_estimate": "Estimated inseam if applicable (trousers/jeans) e.g. '32 inches / 81cm' or 'N/A'",
  "rise_estimate": "Rise measurement estimate if applicable e.g. 'Mid-rise ~10 inches' or 'N/A'",
  "construction": "Construction technique notes e.g. 'Hand-finished seams, likely made in Italy, fully lined, functional horn buttons'",
  "notable_details": "Distinctive design details, hardware, prints, embroidery, closures etc.",
  "care": "Likely care requirements based on fabric",
  "estimated_retail": "Estimated retail price range e.g. '$2,400 - $3,800' or 'Unable to estimate'",
  "tags": ["array", "of", "style", "keywords", "max 8 tags"]
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: base64 }
            },
            { type: 'text', text: 'Analyse this garment in full detail.' }
          ]
        }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Anthropic API error' });
    }

    const raw = data.content.map(b => b.text || '').join('');
    const cleaned = raw.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: 'Failed to parse model response as JSON' });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
