/**
 * Match MMA fighters from The Odds API to their real event — sourced live
 * from ESPN's own MMA scoreboards rather than a hand-maintained list.
 *
 * This used to be a static, manually-updated fighter-to-event mapping
 * (worker/src/ufc-events-upcoming.js, "updated weekly") that went stale and
 * produced actively wrong results — e.g. it buried "Gamrot vs. Salkilld" as
 * one fight inside a different event's roster ("UFC Fight Night: Miller vs.
 * Goff") instead of recognizing it as its own separate card. ESPN's own
 * scoreboards (site.web.api.espn.com — the same host already proven reachable
 * from a Cloudflare Worker for MLB stats, unlike the 403-blocked
 * site.api.espn.com) carry the real, current event name and full fight card
 * for weeks out, so this is read live and cached instead of hand-kept.
 *
 * The Odds API's "mma_mixed_martial_arts" market blends multiple promotions
 * (UFC and PFL both post fights under it), and each promotion has its own
 * separate ESPN scoreboard endpoint — a PFL fighter is never on UFC's board
 * or vice versa — so both are fetched and merged into one lookup index.
 */

const ESPN_MMA_SCOREBOARDS = {
  ufc: 'https://site.web.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard',
  pfl: 'https://site.web.api.espn.com/apis/site/v2/sports/mma/pfl/scoreboard',
};
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

function parseSchedule(data) {
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
 * Every upcoming UFC + PFL event ESPN has scheduled over the next 30 days,
 * each with its real name and the normalized fighter-pair for every fight on
 * the card — built once per cache window, not once per fight, since a single
 * request per promotion already covers the whole window. A promotion whose
 * fetch fails is simply left out of the merged schedule rather than failing
 * the whole lookup; only a total failure across every promotion falls
 * through to the caller's date-grouping fallback.
 */
export async function fetchMmaSchedule(ctx, now = Date.now()) {
  const dates = dateRangeParam(now);
  const results = await Promise.allSettled(
    Object.values(ESPN_MMA_SCOREBOARDS).map((base) => cachedJson(`${base}?dates=${dates}`, SCHEDULE_TTL, ctx)),
  );

  const schedule = results.filter((r) => r.status === 'fulfilled').flatMap((r) => parseSchedule(r.value));
  if (schedule.length === 0 && results.every((r) => r.status === 'rejected')) {
    throw results[0].reason;
  }
  return schedule;
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
 *
 * `schedule` is optional: pass an already-fetched schedule (see
 * `fetchMmaSchedule`) when matching many fights in the same request — a
 * whole event slate enriches its fights concurrently (`Promise.all`), and
 * without a shared schedule each fight would independently re-fetch both
 * ESPN scoreboards with no request coalescing, which is exactly what blew
 * through Cloudflare's per-invocation subrequest limit once a second
 * promotion (PFL) doubled the outbound calls. Omit it only for one-off
 * lookups outside that batch path.
 */
export async function getUfcEventDetails(fighterA, fighterB, commenceMs, ctx, schedule) {
  if (!fighterA || !fighterB) return null;

  const normA = normalizeName(fighterA);
  const normB = normalizeName(fighterB);

  let sched = schedule;
  if (sched === undefined) {
    try {
      sched = await fetchMmaSchedule(ctx);
    } catch {
      sched = [];
    }
  }

  for (const event of sched) {
    const matched = event.fights.some(
      (f) => (f.a === normA && f.b === normB) || (f.a === normB && f.b === normA),
    );
    if (matched) return { event: event.name };
  }

  if (commenceMs) {
    return { event: `Card - ${formatEventDate(commenceMs)}` };
  }
  return null;
}
