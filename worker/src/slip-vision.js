/**
 * Bet-slip image extraction — reads a screenshot of a real sportsbook slip
 * and returns its legs.
 *
 * This replaces the mock that shipped with Tail or Fade. The mock returned
 * three fixed sample legs regardless of what was uploaded, which was
 * disclosed on screen but is not what "drop a parlay in" means: a user who
 * drops their own slip and is handed someone else's legs has not had their
 * bet read.
 *
 * Runs in the Worker rather than the browser for two reasons. The API key
 * cannot go to the client, and the browser has no OCR without shipping a
 * multi-megabyte WASM bundle to every visitor for a feature most of them
 * will never open.
 *
 * WHAT THIS DELIBERATELY WILL NOT DO
 * ----------------------------------
 * It will not guess. A slip is a photograph of numbers that decide money,
 * and a plausible-looking misread is worse than a blank: the user would
 * audit a bet they are not holding and act on the answer. So:
 *
 *   - Every leg must carry a selection the model actually read. A leg with
 *     no readable selection is dropped, not invented.
 *   - A price that is not clearly legible comes back `null`, and the client
 *     fills it from live market data (already labelled as such) rather than
 *     this module inventing a number.
 *   - `confidence` is returned per leg and surfaced, so a smudged or
 *     partially-cropped slip reads as uncertain rather than authoritative.
 *   - An image with no recognisable slip in it returns zero legs and an
 *     explicit reason, not a best guess at what a bet slip usually contains.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
// Vision-capable, and the cheapest tier that reads sportsbook slips
// reliably — this is OCR with light structure, not analysis.
const VISION_MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 1500;

// Cloudflare Workers cap request bodies, and a base64 payload is ~33%
// larger than the file. 6 MB of base64 is roughly a 4.5 MB screenshot,
// comfortably above any phone screenshot and below the limit.
export const MAX_IMAGE_BASE64_BYTES = 6 * 1024 * 1024;

const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const EXTRACTION_PROMPT = `You are reading a screenshot of a sportsbook bet slip.

Return ONLY a JSON object, no prose and no markdown fence:

{
  "legs": [
    {
      "selection": "<exactly what the slip says this leg is, e.g. 'Aja Wilson Over 24.5 Points' or 'Lakers ML'>",
      "american": <the American odds for THIS leg as an integer, e.g. -118 or 145, or null if not legible>,
      "market": "<one of: MONEYLINE, SPREAD, TOTAL, PROP, OTHER>",
      "confidence": <0.0 to 1.0, how sure you are you read this leg correctly>
    }
  ],
  "slipType": "<one of: SINGLE, PARLAY, SGP, UNKNOWN>",
  "combinedAmerican": <the total/combined odds of the whole slip as an integer, or null>,
  "stake": <the wager amount as a number, or null>,
  "note": "<empty string, or a short reason if you could not read the slip>"
}

Rules you must follow exactly:
- Transcribe selections as they appear. Do not normalise team or player names, expand abbreviations, or tidy the wording.
- If a leg's price is not clearly legible, use null. Never estimate a price.
- If the image is not a bet slip, or no legs are readable, return "legs": [] and explain briefly in "note".
- Do not invent legs to make a parlay look complete. Return only what is actually visible.
- Odds shown in decimal or fractional format must be converted to American and rounded to the nearest integer.`;

/** A JSON object out of a model reply that may or may not be fenced. */
function parseJsonReply(text) {
  if (!text) return null;
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // A reply with prose around the JSON still has usable JSON in it.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Validate one leg the model returned.
 *
 * Returns null for anything without a real selection. Everything else is
 * coerced conservatively: a price that is not a finite integer in a
 * plausible range becomes null (the client fills it from live market data
 * and labels it), and an out-of-range or missing confidence becomes a
 * middling 0.5 rather than an implied certainty.
 */
export function sanitizeLeg(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const selection = typeof raw.selection === 'string' ? raw.selection.trim() : '';
  if (!selection) return null;

  const price = Number(raw.american);
  // Real American odds are never between -99 and +99, so a value in that
  // band is a misread (a stake, a line, a leg number) rather than a price.
  const american = Number.isFinite(price) && Math.abs(price) >= 100 && Math.abs(price) <= 100000
    ? Math.round(price)
    : null;

  const confidence = Number(raw.confidence);
  return {
    selection: selection.slice(0, 200),
    american,
    market: typeof raw.market === 'string' ? raw.market.toUpperCase().slice(0, 20) : 'OTHER',
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    source: 'image',
  };
}

export function sanitizeExtraction(raw) {
  const legs = Array.isArray(raw?.legs)
    ? raw.legs.map(sanitizeLeg).filter(Boolean).slice(0, 25)
    : [];
  const combined = Number(raw?.combinedAmerican);
  const stake = Number(raw?.stake);
  return {
    legs,
    slipType: typeof raw?.slipType === 'string' ? raw.slipType.toUpperCase().slice(0, 12) : 'UNKNOWN',
    combinedAmerican: Number.isFinite(combined) && Math.abs(combined) >= 100 ? Math.round(combined) : null,
    stake: Number.isFinite(stake) && stake > 0 ? stake : null,
    note: typeof raw?.note === 'string' ? raw.note.trim().slice(0, 300) : '',
    mocked: false,
  };
}

/**
 * Read a bet slip image. `image` is raw base64 (no data: prefix).
 *
 * Throws only on caller error (bad media type, oversized payload, missing
 * key) — a model that returns something unusable resolves to zero legs with
 * a `note`, because "I could not read this" is a real answer the UI needs
 * to show, not an exception the UI has to guess the meaning of.
 */
export async function extractSlipFromImage(image, mediaType, env, { fetchFn = fetch } = {}) {
  if (!env?.ANTHROPIC_API_KEY) {
    throw new Error('Bet slip reading is not configured on this deployment.');
  }
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    throw new Error(`Unsupported image type ${mediaType || '(none)'} — use PNG, JPEG, WebP or GIF.`);
  }
  if (typeof image !== 'string' || !image) {
    throw new Error('No image data received.');
  }
  if (image.length > MAX_IMAGE_BASE64_BYTES) {
    throw new Error('That image is too large — please crop it to the slip itself or reduce its size.');
  }

  const response = await fetchFn(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: EXTRACTION_PROMPT },
        ],
      }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Bet slip reader returned ${response.status}`);
  }

  const data = await response.json();
  const parsed = parseJsonReply(data?.content?.[0]?.text);
  if (!parsed) {
    return {
      legs: [], slipType: 'UNKNOWN', combinedAmerican: null, stake: null,
      note: 'The slip reader returned something unreadable. Try a clearer screenshot, or type the bet in.',
      mocked: false,
    };
  }

  const clean = sanitizeExtraction(parsed);
  if (!clean.legs.length && !clean.note) {
    clean.note = 'No bet legs were readable in that image.';
  }
  return clean;
}
