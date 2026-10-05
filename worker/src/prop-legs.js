/**
 * Player-prop legs for the boards, across every league that supplies them
 * — the one entry point worker/src/tracking.js and worker/src/potd.js call
 * at the 2am draw, and the one stats reader the ticket grader settles a
 * prop leg through. Each league's own module knows its markets, ESPN paths
 * and boxscore shape; this file only dispatches.
 */

import { collectNflPropLegs, fetchFinalNflStats, NFL_SPORT_KEY } from './football-props.js';
import {
  collectBasketballPropLegs, fetchFinalBasketballStats, isBasketballSport, listBasketballGames, BASKETBALL_SPORTS,
} from './basketball-props.js';

/** The leagues whose alternate-line props become legs. */
export const PROP_SPORT_KEYS = new Set([NFL_SPORT_KEY, ...Object.keys(BASKETBALL_SPORTS)]);

/**
 * Every gated prop leg from today's games, all leagues. `games` is the
 * day's slate (Odds API event objects); a prop league the slate doesn't
 * carry — the NBA is not a Full Slate sport — has its day's games listed
 * through the (free) events endpoint, kept to the same day by `sameDay`.
 * A league whose scan fails contributes nothing rather than failing the
 * draw — props widen the anchor supply, they are never a dependency of the
 * board.
 */
export async function collectPropLegs(games, env, ctx, now = Date.now(), {
  trace = [],
  sameDay = (ms) => ms > now && ms - now < 22 * 3.6e6,
} = {}) {
  const slate = (games ?? []).filter((g) => PROP_SPORT_KEYS.has(g?.sport_key));
  const present = new Set(slate.map((g) => g.sport_key));
  const extra = await Promise.all(Object.keys(BASKETBALL_SPORTS)
    .filter((key) => !present.has(key))
    .map((key) => listBasketballGames(key, env, ctx).catch(() => [])));
  const pool = [...slate, ...extra.flat().filter((g) => sameDay(new Date(g.commence_time).getTime()))];

  const [nfl, basketball] = await Promise.all([
    collectNflPropLegs(pool, env, ctx, now, { trace }).catch((e) => { console.error('NFL prop legs failed:', e); return []; }),
    collectBasketballPropLegs(pool, env, ctx, now, { trace }).catch((e) => { console.error('basketball prop legs failed:', e); return []; }),
  ]);
  return [...nfl, ...basketball];
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
        : isBasketballSport(sportKey)
          ? fetchFinalBasketballStats(sportKey, espnEventId, ctx)
          : Promise.resolve(null));
    }
    return cache.get(key);
  };
}
