/**
 * Match MMA fighters from The Odds API to their real UFC event — sourced
 * live from ESPN's own MMA scoreboard rather than a hand-maintained list.
 *
 * This used to be a static, manually-updated fighter-to-event mapping
 * (worker/src/ufc-events-upcoming.js, "updated weekly") that went stale and
 * produced actively wrong results — e.g. it buried "Gamrot vs. Salkilld" as
 * one fight inside a different event's roster ("UFC Fight Night: Miller vs.
 * Goff") instead of recognizing it as its own separate card. ESPN's own
 * scoreboard (site.web.api.espn.com — the same host already proven reachable
 * from a Cloudflare Worker for MLB stats, unlike the 403-blocked
 * site.api.espn.com) carries the real, current event name and full fight
 * card for weeks out, so this is read live and cached instead of hand-kept.
 */

const ESPN_MMA_SCOREBOARD = 'https://site.web.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard';
const SCHEDULE_TTL = 3600 * 6; // a card can still be adjusted; not worth caching longer

function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dateRangeParam(now) {
  const fmt = (d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  };
  const start = new Date(now);
  const end = new Date(now + 30 * 86400000);
  return `${fmt(start)}-${fmt(end)}`;
}

async function cachedJson(url, ttl, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/ufc-events/${encodeURIComponent(url)}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`ESPN MMA scoreboard returned ${response.status}`);
  const body = await response.text();
  ctx.waitUntil(
    cache.put(cacheKey, new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
    })),
  );
  return JSON.parse(body);
}

/**
 * Every upcoming UFC event ESPN has scheduled over the next 30 days, each
 * with its real name and the normalized fighter-pair for every fight on the
 * card — built once per cache window, not once per fight, since a single
 * request already covers the whole window.
 */
export async function fetchUfcSchedule(ctx, now = Date.now()) {
  const data = await cachedJson(`${ESPN_MMA_SCOREBOARD}?dates=${dateRangeParam(now)}`, SCHEDULE_TTL, ctx);
  const events = data?.events ?? [];

  return events.map((e) => ({
    name: e.name,
    fights: (e.competitions ?? []).map((c) => {
      const [a, b] = c.competitors ?? [];
      return {
        a: normalizeName(a?.athlete?.displayName),
        b: normalizeName(b?.athlete?.displayName),
      };
    }),
  }));
}

/**
 * Format a date from commenceMs for fallback grouping when ESPN can't be
 * reached at all (never used for a fighter ESPN simply hasn't matched —
 * only for a genuine fetch failure).
 */
function formatEventDate(commenceMs) {
  const date = new Date(commenceMs);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${month}/${day}`;
}

/**
 * Look up the real UFC/MMA event for one matchup, from ESPN's live schedule.
 * Falls back to date-based grouping only when the live fetch itself fails —
 * never falls back to a stale hardcoded guess.
 */
export async function getUfcEventDetails(fighterA, fighterB, commenceMs, ctx) {
  if (!fighterA || !fighterB) return null;

  const normA = normalizeName(fighterA);
  const normB = normalizeName(fighterB);

  try {
    const schedule = await fetchUfcSchedule(ctx);
    for (const event of schedule) {
      const matched = event.fights.some(
        (f) => (f.a === normA && f.b === normB) || (f.a === normB && f.b === normA),
      );
      if (matched) return { event: event.name };
    }
  } catch {
    /* ESPN unreachable this tick — fall through to date grouping below. */
  }

  if (commenceMs) {
    return { event: `Card - ${formatEventDate(commenceMs)}` };
  }
  return null;
}
