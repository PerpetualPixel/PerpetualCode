/**
 * UFC.com's own athlete pages — official bio, career rate stats, and photos
 * for fighters who've actually competed in the UFC.
 *
 * This exists because UFCStats.com (the obvious first choice for these exact
 * numbers) serves a JS proof-of-work "checking your browser" challenge to
 * every non-browser request — confirmed live, and confirmed it isn't a
 * Cloudflare-Worker-specific block: a plain curl from an ordinary machine
 * gets the identical challenge page. ufc.com's own /athlete/<slug> pages
 * carry the same core numbers (significant-strike and takedown accuracy,
 * career totals, win-method and strike-position breakdowns) with no such
 * wall and a permissive robots.txt — confirmed live before writing this.
 *
 * robots.txt DOES disallow /athletes/all?* (the search/listing page with
 * query params) — so name resolution here is a direct slug guess
 * ("Jon Jones" -> "jon-jones"), never that disallowed endpoint. A fighter
 * whose slug doesn't match this simple pattern (a nickname suffix, a
 * disambiguation number, an accented name UFC.com transliterates
 * differently) just isn't found — a real, expected "no data" outcome here,
 * the same honesty policy as every other scraper in this app, not a bug to
 * chase with a fallback crawl of a page the site has asked not to be
 * crawled.
 *
 * mma-fantasy.com was also confirmed live — reachable, real data, a
 * genuinely better visual match for the original ask — but its robots.txt
 * explicitly disallows ClaudeBot (alongside GPTBot, CCBot, and other AI
 * crawlers) with an accompanying `Content-Signal: ai-train=no`. That's a
 * deliberate policy call by the site, not a technical wall, and it's
 * respected here by not scraping that site at all, regardless of what's
 * technically reachable.
 */

const UFC = 'https://www.ufc.com';
const PROFILE_TTL = 3600 * 6;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** "Jon Jones" -> "jon-jones" — ufc.com's own slug convention for the common case. */
function slugify(name) {
  const folded = fold(name).replace(/[^a-z0-9\s-]/g, '');
  return folded.replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

async function cachedText(url, ttl, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/ufc/${encodeURIComponent(url)}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit.text();

  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
  });
  if (!response.ok) return null;

  const body = await response.text();
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(body, {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': `max-age=${ttl}` },
      }),
    ),
  );
  return body;
}

/**
 * One `c-bio__label` / `c-bio__text` pair — confirmed live against Jon
 * Jones' page before writing this. Age's value has an extra nested field
 * div around the number; stripping all tags from the captured text handles
 * that case the same way as every other field.
 */
function bioField(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`c-bio__label">${escaped}<\\/div>\\s*<div class="c-bio__text">([\\s\\S]*?)<\\/div>\\s*<\\/div>`, 'i');
  const raw = html.match(re)?.[1];
  if (!raw) return null;
  const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

/** The SVG chart-circle stats — confirmed live: a `<title>Label N%</title>`
 * inside each `e-chart-circle--athlete-stat` element. */
function chartPercent(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<title>${escaped} (\\d+)%<\\/title>`, 'i');
  const n = html.match(re)?.[1];
  return n != null ? Number(n) : null;
}

/**
 * One `c-stat-3bar` group — "Sig. Str. By Position" (Standing/Clinch/Ground)
 * or "Win by Method" (KO/TKO/DEC/SUB) are the two this app reads, each a
 * `c-stat-3bar__title` followed by three `c-stat-3bar__group` label/value
 * pairs. Scoped between this title and the next one (or 1500 chars, a safe
 * upper bound for a 3-item group) so the two groups never bleed into each
 * other.
 */
function statBarGroup(html, title) {
  const marker = html.indexOf(title);
  if (marker < 0) return [];
  const nextTitle = html.indexOf('c-stat-3bar__title', marker + title.length);
  const scoped = html.slice(marker, nextTitle > 0 ? nextTitle : marker + 1500);

  const rows = [...scoped.matchAll(
    /c-stat-3bar__label">([^<]+)<\/div>\s*<div class="c-stat-3bar__value">\s*([\d.]+)\s*\((\d+)%\)/g,
  )];
  return rows.map(([, label, count, pct]) => ({
    label: label.trim(),
    count: Number(count),
    pct: Number(pct),
  }));
}

/**
 * One fighter's UFC.com bundle, or null if the direct slug guess didn't
 * resolve to a real athlete page — a common, expected outcome (a PFL/
 * Bellator-only fighter, a name UFC.com slugs differently) rather than an
 * error.
 */
export async function fetchUfcProfile(name, ctx) {
  const slug = slugify(name);
  if (!slug) return null;

  const url = `${UFC}/athlete/${slug}`;
  const html = await cachedText(url, PROFILE_TTL, ctx);
  if (!html || !html.includes('c-bio__field')) return null;

  const photo = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? null;

  const bio = {
    age: bioField(html, 'Age'),
    height: bioField(html, 'Height'),
    weight: bioField(html, 'Weight'),
    reach: bioField(html, 'Reach'),
    legReach: bioField(html, 'Leg reach'),
    placeOfBirth: bioField(html, 'Place of Birth'),
    trainsAt: bioField(html, 'Trains at'),
  };

  const strikingAccuracy = chartPercent(html, 'Striking accuracy');
  const takedownAccuracy = chartPercent(html, 'Takedown Accuracy');
  const strikePosition = statBarGroup(html, 'Sig. Str. By Position');
  const winMethod = statBarGroup(html, 'Win by Method');

  const hasBio = Object.values(bio).some((v) => v != null);
  const hasAnything = hasBio || strikingAccuracy != null || takedownAccuracy != null
    || strikePosition.length > 0 || winMethod.length > 0;
  if (!hasAnything) return null;

  return {
    name,
    profileUrl: url,
    photo,
    bio: hasBio ? bio : null,
    strikingAccuracy,
    takedownAccuracy,
    strikePosition,
    winMethod,
  };
}
