/**
 * Shared Odds API fetch/cache helpers. Originally lived in index.js as the
 * implementation behind the /odds, /sports, and /scores routes; split out so
 * worker/src/tracking.js's scheduled batch jobs (the 6am Top 5 generation,
 * hourly CLV snapshots, nightly grading) can call the exact same
 * fetch-and-cache logic the client's own requests use, without a circular
 * import back into index.js (index.js calls into tracking.js from its
 * scheduled() handler, so tracking.js can't import from index.js).
 */
import { getUfcEventDetails, fetchMmaSchedule } from './ufc-events.js';
import { isNflPreseasonKey } from '../../docs/engine.js';

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
//
// Deliberately tennis-only: regionsFor() below reuses this exact list as its
// "is this tennis" test to decide the UK/EU region set, so anything added
// here would also be priced off non-US books. Non-tennis dynamic keys (NFL
// preseason) are matched separately in isAllowedSport instead.
export const ALLOWED_SPORT_PREFIXES = ['tennis_atp_', 'tennis_wta_'];

export function isAllowedSport(key) {
  return (
    ALLOWED_SPORTS.has(key) ||
    ALLOWED_SPORT_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    // NFL preseason is keyed separately by The Odds API and only exists while
    // preseason is live, so it's matched by pattern rather than listed above.
    // This gate is what lets it reach the catalogue at all: fetchCatalogue
    // filters on isAllowedSport, so without this the client could never
    // discover the key to put preseason on the Full Slate.
    isNflPreseasonKey(key)
  );
}

export const MARKETS = 'h2h,spreads,totals';
export const REGIONS = 'us';
// Lower-tier tennis (WTA/ATP 125s, qualifying draws) is frequently priced
// only by international books until close to start — US books post those
// matches late or not at all. That left them coming back with fewer than
// RULES.MIN_BOOKS quoting each line, so no candidate was built and the match
// rendered as an all-dash Full Slate row even an hour out. Tennis alone
// uses the EU/UK books that actually price it — WITHOUT the us region: the
// whole point of the widening was that US books don't post these matches,
// so paying a third region's credits to re-ask them added cost (9 vs 6
// credits per fetch, the most expensive call in the app) for lines the
// uk/eu set already carries. Scoped to tennis on purpose: The Odds API
// bills per region per market, so widening every sport would multiply the
// quota cost of the whole slate.
export const TENNIS_REGIONS = 'uk,eu';
// A sport whose odds board came back EMPTY is out of season or between
// cards — nothing there can change in minutes, and The Odds API bills the
// same markets-x-regions price for an empty answer as a full one. Empty
// boards are cached this long instead of CACHE_SECONDS, which cuts the
// standing burn of NBA/NCAAB/NHL in August to a handful of calls a day
// with no seasonal allowlist to maintain.
export const EMPTY_BOARD_CACHE_SECONDS = 3 * 3600;
export const DEFAULT_CACHE_SECONDS = 900;

/**
 * The Odds API `regions` value to request for a sport key: the wider
 * US+UK+EU set for tennis tournament keys, plain `us` for everything else.
 * Tennis is matched by the same prefixes isAllowedSport uses, so a new
 * tournament key is covered the week it appears without a list to maintain.
 */
export function regionsFor(sportKey) {
  const isTennis = ALLOWED_SPORT_PREFIXES.some((prefix) => sportKey.startsWith(prefix));
  return isTennis ? TENNIS_REGIONS : REGIONS;
}
// The sports catalogue is free to fetch and changes on the order of days.
export const SPORTS_LIST_CACHE_SECONDS = 3600;

function extractMoneylineOdds(event) {
  // Extract the best h2h (moneyline) odds from the bookmakers array
  // The home_team's odds go into the `american` field, and all available
  // quotes across bookmakers go into the `quotes` array (for line shopping).
  if (!event.bookmakers?.length) return event;

  const allH2hOutcomes = [];
  for (const book of event.bookmakers) {
    const h2hMarket = book.markets?.find((m) => m.key === 'h2h');
    if (!h2hMarket?.outcomes?.length) continue;

    for (const outcome of h2hMarket.outcomes) {
      if (outcome.name === event.home_team && outcome.price != null) {
        allH2hOutcomes.push({
          book: book.key,
          american: outcome.price,
          decimal: outcome.price > 0 ? (outcome.price / 100) + 1 : (-100 / outcome.price) + 1,
        });
      }
    }
  }

  if (!allH2hOutcomes.length) return event;

  // Sort by best decimal value (highest for picking), take first as primary
  allH2hOutcomes.sort((a, b) => b.decimal - a.decimal);
  const best = allH2hOutcomes[0];

  return {
    ...event,
    american: best.american,
    quotes: allH2hOutcomes.map((q) => ({ book: q.book, american: q.american })),
  };
}

export async function enrichMmaEvents(events, ctx) {
  if (!events || !Array.isArray(events)) return events;

  // Fetch the merged UFC+PFL schedule once for the whole slate, not once per
  // fight — a slate enriches every fight concurrently below, and without a
  // shared schedule each one independently re-fetches both ESPN scoreboards
  // (no request coalescing across concurrent calls), which blows through
  // Cloudflare's per-invocation subrequest limit on a full MMA slate.
  let schedule;
  try {
    schedule = await fetchMmaSchedule(ctx);
  } catch {
    schedule = [];
  }

  const enriched = await Promise.all(
    events.map(async (event) => {
      const commenceMs = event.commence_time
        ? new Date(event.commence_time).getTime()
        : null;
      const eventDetails = await getUfcEventDetails(
        event.home_team,
        event.away_team,
        commenceMs,
        ctx,
        schedule,
      );
      const withEventName = eventDetails ? { ...event, ufc_event: eventDetails } : event;
      return extractMoneylineOdds(withEventName);
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
  const regions = regionsFor(sport);
  const url = new URL(`${UPSTREAM}/sports/${sport}/odds`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('regions', regions);
  url.searchParams.set('markets', MARKETS);
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');

  const ttl = Number(env.CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS);
  // The region set is part of the cache key, so widening tennis doesn't collide
  // with any previously-cached us-only entry for the same key — the tennis
  // pull just fetches fresh under its own key.
  const cacheKey = new Request(
    `https://pixel-pick.cache/odds/${sport}?markets=${MARKETS}&regions=${regions}`,
  );
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    let events = await cached.json();
    if (sport === 'mma_mixed_martial_arts') {
      events = await enrichMmaEvents(events, ctx);
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
  }

  // An empty board holds far longer than a live one — see
  // EMPTY_BOARD_CACHE_SECONDS. Cached AFTER the MMA enrichment on purpose:
  // enrichment never invents events, so emptiness is the upstream's answer.
  const cacheTtl = Array.isArray(events) && events.length === 0 ? EMPTY_BOARD_CACHE_SECONDS : ttl;
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(events), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${cacheTtl}` },
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
  // The cache key is scoped to the deployed version, so a deploy that changes
  // which sports are allowed serves a fresh catalogue immediately instead of
  // the previously-filtered one.
  //
  // This is not hypothetical: isAllowedSport runs BEFORE the cache write
  // below, so the stored list is already filtered. When NFL preseason was
  // added to the allowlist, a successful deploy left the new key invisible —
  // /sports kept replaying the hour-old list built by the previous code, and
  // it read as a failed deploy rather than a stale cache.
  //
  // Deliberately scoped to THIS cache and not the odds cache in fetchSport:
  // The Odds API doesn't bill /sports, so re-fetching it once per deploy
  // costs nothing, whereas the odds cache is the single biggest lever on the
  // credit bill (see CACHE_SECONDS in wrangler.toml) and busting it per
  // deploy would repay full upstream price every time.
  //
  // CF_VERSION_METADATA is a wrangler binding; the fallback keeps local dev
  // and any deployment without it working exactly as before.
  const version = env.CF_VERSION_METADATA?.id ?? 'dev';
  const cacheKey = new Request(`https://pixel-pick.cache/sports?v=${version}`);
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
