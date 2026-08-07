/**
 * Shared Odds API fetch/cache helpers. Originally lived in index.js as the
 * implementation behind the /odds, /sports, and /scores routes; split out so
 * worker/src/tracking.js's scheduled batch jobs (the 6am Top 5 generation,
 * hourly CLV snapshots, nightly grading) can call the exact same
 * fetch-and-cache logic the client's own requests use, without a circular
 * import back into index.js (index.js calls into tracking.js from its
 * scheduled() handler, so tracking.js can't import from index.js).
 */
import { getUfcEventDetails } from './ufc-events.js';
import { fetchBaseballContext } from './baseball.js';

export const UPSTREAM = 'https://api.the-odds-api.com/v4';

export const ALLOWED_SPORTS = new Set([
  'upcoming',
  'americanfootball_nfl',
  'americanfootball_ncaaf',
  'basketball_nba',
  'basketball_wnba',
  'basketball_ncaab',
  'baseball_mlb',
  'icehockey_nhl',
  'mma_mixed_martial_arts',
  'soccer_epl',
  'soccer_usa_mls',
]);

// Tennis is keyed per tournament (tennis_atp_canadian_open, and a different key
// next week), so an exact allowlist would go stale every few days. Prefixes let
// the tour through without opening the door to arbitrary sport keys.
export const ALLOWED_SPORT_PREFIXES = ['tennis_atp_', 'tennis_wta_'];

export function isAllowedSport(key) {
  return (
    ALLOWED_SPORTS.has(key) ||
    ALLOWED_SPORT_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

export const MARKETS = 'h2h,spreads,totals';
export const REGIONS = 'us';
export const DEFAULT_CACHE_SECONDS = 900;
// The sports catalogue is free to fetch and changes on the order of days.
export const SPORTS_LIST_CACHE_SECONDS = 3600;

async function enrichMmaEvents(events, ctx) {
  if (!events || !Array.isArray(events)) return events;

  const enriched = await Promise.all(
    events.map(async (event) => {
      const commenceMs = event.commence_time
        ? new Date(event.commence_time).getTime()
        : null;
      const eventDetails = await getUfcEventDetails(
        event.home_team,
        event.away_team,
        commenceMs,
      );
      return eventDetails ? { ...event, ufc_event: eventDetails } : event;
    }),
  );

  return enriched;
}

async function enrichBaseballEvents(events, ctx) {
  if (!events || !Array.isArray(events)) return events;

  const enriched = await Promise.all(
    events.map(async (event) => {
      // Odds API doesn't include pitchers, so we'll note that for manual future enhancement
      const baseballContext = await fetchBaseballContext(
        {
          awayTeam: event.away_team,
          homeTeam: event.home_team,
          awayPitcher: null, // TODO: Pull from external source when available
          homePitcher: null,
        },
        ctx,
      );
      return baseballContext
        ? { ...event, baseball_context: baseballContext }
        : event;
    }),
  );

  return enriched;
}

/**
 * One league's odds, cached at the edge for env.CACHE_SECONDS (default 15
 * min) and shared across every caller hitting the same sport key — a
 * client's own tap, the scheduled Top 5 batch, and a CLV snapshot check all
 * draw from and contribute to the same cache entry, so none of them pay for
 * a redundant fetch within the window.
 */
export async function fetchSport(sport, env, ctx) {
  const url = new URL(`${UPSTREAM}/sports/${sport}/odds`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('regions', REGIONS);
  url.searchParams.set('markets', MARKETS);
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');

  const ttl = Number(env.CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS);
  const cacheKey = new Request(
    `https://pixel-pick.cache/odds/${sport}?markets=${MARKETS}&regions=${REGIONS}`,
  );
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    let events = await cached.json();
    if (sport === 'mma_mixed_martial_arts') {
      events = await enrichMmaEvents(events, ctx);
    } else if (sport === 'baseball_mlb') {
      events = await enrichBaseballEvents(events, ctx);
    }
    return { events, cached: true, quota: null };
  }

  const upstream = await fetch(url.toString());
  if (!upstream.ok) {
    const detail = await upstream.text();
    return { error: { sport, status: upstream.status, detail: detail.slice(0, 300) } };
  }

  let events = await upstream.json();
  const quota = {
    remaining: upstream.headers.get('x-requests-remaining'),
    used: upstream.headers.get('x-requests-used'),
    lastCost: upstream.headers.get('x-requests-last'),
  };

  if (sport === 'mma_mixed_martial_arts') {
    events = await enrichMmaEvents(events, ctx);
  } else if (sport === 'baseball_mlb') {
    events = await enrichBaseballEvents(events, ctx);
  }

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(events), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
      }),
    ),
  );

  return { events, cached: false, quota };
}

/**
 * Completed/live scores for a sport, used to grade tracked picks (both the
 * client's "Check Results" button and the worker's own nightly grading job).
 * `daysFrom=3` is the widest lookback The Odds API's scores endpoint takes —
 * plenty, since picks are graded the same day or the next. Cached for 5
 * minutes regardless of CACHE_SECONDS: scores don't need odds-tap freshness,
 * and this keeps repeated checks from burning credits.
 */
export async function fetchScores(sport, env, ctx) {
  const ttl = 300;
  const cacheKey = new Request(`https://pixel-pick.cache/scores/${sport}`);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return { events: await cached.json(), cached: true };

  const url = new URL(`${UPSTREAM}/sports/${sport}/scores`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('daysFrom', '3');
  url.searchParams.set('dateFormat', 'iso');

  const upstream = await fetch(url.toString());
  if (!upstream.ok) {
    const detail = await upstream.text();
    return { error: { sport, status: upstream.status, detail: detail.slice(0, 300) } };
  }

  const events = await upstream.json();

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(events), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
      }),
    ),
  );

  return { events, cached: false };
}

/**
 * The catalogue of requestable leagues — same free, cached (1hr) fetch the
 * /sports route serves to the client, extracted so the scheduled Top 5 batch
 * can discover this week's live tennis_atp_ and tennis_wta_ tournament keys
 * the exact same way the client's own populateTennisGroups() does, rather
 * than hardcoding a list that goes stale the moment the tour moves on.
 */
export async function fetchCatalogue(env, ctx) {
  const cacheKey = new Request('https://pixel-pick.cache/sports');
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return { sports: await cached.json(), cached: true };

  const url = new URL(`${UPSTREAM}/sports`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());

  const upstream = await fetch(url.toString());
  if (!upstream.ok) {
    return { error: { status: upstream.status } };
  }

  const sports = (await upstream.json())
    .filter((s) => s.active && !s.has_outrights && isAllowedSport(s.key))
    .map(({ key, title, group }) => ({ key, title, group }));

  sports.unshift({ key: 'upcoming', title: 'Next up (all sports)', group: 'Any' });

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(sports), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${SPORTS_LIST_CACHE_SECONDS}`,
        },
      }),
    ),
  );

  return { sports, cached: false };
}
