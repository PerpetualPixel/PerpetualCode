/**
 * Player-prop legs for the boards, across every league that supplies them
 * — the one entry point worker/src/tracking.js, worker/src/potd.js and
 * worker/src/ladder.js call at the 2am draw, and the one stats reader the
 * ticket grader settles a prop leg through. Each league's own module knows
 * its markets, ESPN paths and boxscore shape; this file only dispatches.
 */

import { collectNflPropLegs, fetchFinalNflStats, NFL_SPORT_KEY } from './football-props.js';
import { collectBasketballPropLegs, fetchFinalBasketballStats, isBasketballSport, BASKETBALL_SPORTS } from './basketball-props.js';
import { collectNhlPropLegs, fetchFinalNhlStats, NHL_SPORT_KEY } from './hockey-props.js';
import { UPSTREAM } from './odds.js';

/** The leagues whose player props become legs: NFL, NBA, NHL. */
export const PROP_SPORT_KEYS = new Set([NFL_SPORT_KEY, ...Object.keys(BASKETBALL_SPORTS), NHL_SPORT_KEY]);

const ODDS_TTL = 3600;

/**
 * A league's upcoming games from the Odds API's (credit-free) events list,
 * as the same event objects the slate carries — for a prop league the day's
 * slate happens not to carry. An outage lists nothing.
 */
export async function listLeagueGames(sportKey, env, ctx) {
  const url = new URL(`${UPSTREAM}/sports/${sportKey}/events`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('dateFormat', 'iso');
  const cache = globalThis.caches?.default ?? null;
  const cacheKey = cache ? new Request(`https://pixel-pick.cache/prop-legs/${encodeURIComponent(url.toString())}`) : null;
  try {
    const hit = cache ? await cache.match(cacheKey) : null;
    if (hit) return hit.json();
    const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const body = await res.text();
    if (cache) {
      ctx.waitUntil(cache.put(cacheKey, new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ODDS_TTL}` },
      })));
    }
    const list = JSON.parse(body);
    return Array.isArray(list) ? list.filter((g) => g?.id && g?.commence_time) : [];
  } catch {
    return [];
  }
}

/**
 * Every gated prop leg from today's games, all leagues. `games` is the
 * day's slate (Odds API event objects); a prop league the slate doesn't
 * carry has its day's games listed through the events endpoint, kept to
 * the same day by `sameDay`. A league whose scan fails contributes nothing
 * rather than failing the draw — props widen the supply, they are never a
 * dependency of a board.
 */
export async function collectPropLegs(games, env, ctx, now = Date.now(), {
  trace = [],
  sameDay = (ms) => ms > now && ms - now < 22 * 3.6e6,
} = {}) {
  const slate = (games ?? []).filter((g) => PROP_SPORT_KEYS.has(g?.sport_key));
  const present = new Set(slate.map((g) => g.sport_key));
  const extra = await Promise.all([...PROP_SPORT_KEYS]
    .filter((key) => !present.has(key))
    .map((key) => listLeagueGames(key, env, ctx).catch(() => [])));
  const pool = [...slate, ...extra.flat().filter((g) => sameDay(new Date(g.commence_time).getTime()))];

  const guarded = (label, p) => p.catch((e) => { console.error(`${label} prop legs failed:`, e); return []; });
  const [nfl, basketball, hockey] = await Promise.all([
    guarded('NFL', collectNflPropLegs(pool, env, ctx, now, { trace })),
    guarded('NBA', collectBasketballPropLegs(pool, env, ctx, now, { trace })),
    guarded('NHL', collectNhlPropLegs(pool, env, ctx, now, { trace })),
  ]);
  return [...nfl, ...basketball, ...hockey];
}

/**
 * A memoised final-stats reader for the prop legs of one grading pass: one
 * ESPN summary per game, however many legs ride on it. `read(sportKey,
 * espnEventId)` returns the game's per-player rows, or null while it isn't
 * final (or the league isn't one props come from).
 */
export function propStatsReader(ctx) {
  const cache = new Map();
  return async (sportKey, espnEventId) => {
    if (!espnEventId) return null;
    const key = `${sportKey}|${espnEventId}`;
    if (!cache.has(key)) {
      cache.set(key, sportKey === NFL_SPORT_KEY
        ? fetchFinalNflStats(espnEventId, ctx)
        : sportKey === NHL_SPORT_KEY
          ? fetchFinalNhlStats(espnEventId, ctx)
          : isBasketballSport(sportKey)
            ? fetchFinalBasketballStats(sportKey, espnEventId, ctx)
            : Promise.resolve(null));
    }
    return cache.get(key);
  };
}
