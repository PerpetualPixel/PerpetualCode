/**
 * Head-to-head player photos for tennis "More Info", from Wikipedia's
 * public REST API — the only free, no-key photo source with real coverage
 * of ATP/WTA pros. ESPN's tennis surface is a dead end (see context.js's
 * own header: no athlete ids, its tennis endpoints reject requests
 * outright), and the app's one paid tennis source (worker/src/
 * tennis-results.js, RapidAPI) is capped at ~30 calls/day and reserved for
 * grading finished picks — nowhere near enough budget to photo every match
 * on the board.
 *
 * Wikipedia's images are freely licensed for reuse (public domain / CC),
 * unlike official tour or retailer photography, which is why this is the
 * source rather than scraping wtatennis.com/atptour.com/a retailer's
 * gallery page.
 *
 * A name -> Wikipedia page lookup is inherently fuzzy — it can land on a
 * disambiguation page, or on an unrelated person who happens to share the
 * name — so every hit is checked against its own short description/extract
 * for the word "tennis" before being trusted, same "null over wrong"
 * discipline as every other photo/record attribution in this app. No
 * match, or no "tennis" mention, is null — the card falls back to the
 * initials circle the MMA photo row already shows when a fighter has no
 * photo on file.
 */

const WIKI_SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const PHOTO_TTL = 3600 * 6; // a player's Wikipedia photo doesn't change day to day

async function cachedJson(url, ttl, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/wikipedia/${encodeURIComponent(url)}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      // Wikimedia asks non-browser clients to identify themselves; an
      // unlabeled default UA is the one thing that gets a caller
      // throttled on their API, unlike ESPN/Sherdog which just want any
      // ordinary browser UA (see cachedJson in context.js).
      'User-Agent': 'PerpetualPicksBot/1.0 (https://perpetualpicks.com)',
    },
  });
  if (!response.ok) return null;

  const body = await response.text();
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
      }),
    ),
  );

  try { return JSON.parse(body); } catch { return null; }
}

/**
 * "Carlos Alcaraz" -> "Carlos_Alcaraz" — the summary endpoint already
 * resolves ordinary redirects (nicknames, alternate spellings that have a
 * redirect page) on its own, so no other transform is needed.
 */
export function toTitle(name) {
  return String(name ?? '').trim().replace(/\s+/g, '_');
}

/**
 * Pure confidence check on an already-fetched Wikipedia summary — split
 * from photoFor so this decision is unit-testable without a network, same
 * split as boxscore.js's boxFromScoreboard vs fetchBoxScore. Null on
 * anything not confidently matched: no page, a disambiguation page, a bio
 * that never says "tennis" (the common-name-collision case — a page
 * landing on an unrelated person or place), or no photo on the page at all.
 */
export function photoFromSummary(summary) {
  if (!summary || summary.type === 'disambiguation') return null;

  const bioText = `${summary.description ?? ''} ${summary.extract ?? ''}`.toLowerCase();
  if (!bioText.includes('tennis')) return null;

  return summary.thumbnail?.source ?? null;
}

/** One player's Wikipedia summary, fetched and confidence-checked. */
async function photoFor(name, ctx) {
  const title = toTitle(name);
  if (!title) return null;

  const summary = await cachedJson(`${WIKI_SUMMARY}${encodeURIComponent(title)}`, PHOTO_TTL, ctx);
  const photo = photoFromSummary(summary);
  return photo ? { name, photo } : null;
}

/**
 * Head-to-head photos for two named tennis players. Independent lookups —
 * one player having no Wikipedia page (a lower-ranked player, a qualifier)
 * never blocks the other's photo from showing.
 */
export async function fetchTennisPhotos({ a, b }, ctx) {
  const [photoA, photoB] = await Promise.all([photoFor(a, ctx), photoFor(b, ctx)]);
  if (!photoA && !photoB) return null;
  return { a: photoA, b: photoB };
}
