/**
 * Settling a two-leg ticket (docs/tickets.js) — shared by Pixel's Picks'
 * grading pass (worker/src/tracking.js) and the Play of the Day's
 * (worker/src/potd.js), so the two boards can never disagree about what a
 * ticket's result is.
 *
 * One leg at a time, through the same per-sport graders a single pick
 * uses — the odds feed's final score for team sports, ESPN for MMA and
 * tennis, the final boxscore for a player prop — and then the ticket from
 * its legs: every leg must land, any loss loses the ticket, and a void leg
 * voids it rather than being quietly dropped to leave a "parlay" of one.
 * The ticket stays pending until every leg has an answer.
 */

import { gradePick } from '../../docs/learning.js';
import { isMma, isTennis } from '../../docs/insights.js';
import { gradeMmaPickWithFallback } from './ufc-events.js';
import { gradeTennisPickWithEspn } from './tennis-espn.js';
import { fetchFinalNflStats, gradeNflPropLeg, NFL_SPORT_KEY } from './football-props.js';
import { normalizeName } from '../../docs/nfl-props.js';

/** The legs a record settles on: its `legs` for a ticket, itself for a single. */
export function legsOf(pick) {
  return pick?.type === 'combo' && Array.isArray(pick.legs) ? pick.legs : [pick];
}

/**
 * A memoised final-stats reader for the prop legs of one grading pass:
 * one ESPN summary per game, however many legs ride on it.
 */
export function nflStatsReader(ctx) {
  const cache = new Map();
  return async (espnEventId) => {
    if (!espnEventId) return null;
    if (!cache.has(espnEventId)) cache.set(espnEventId, fetchFinalNflStats(espnEventId, ctx));
    return cache.get(espnEventId);
  };
}

/**
 * Settle ONE leg to won/lost/void. Only the verdict is read: a ticket pays
 * once, off its own combined price, so the nominal stake here never
 * reaches a stored number. Returns null while the leg can't be settled.
 *
 * `deps.scoreEventFor(leg)` returns the odds feed's score event for the
 * leg's game; `deps.mmaResults`/`deps.tennisResults` are the ESPN result
 * sets already fetched for the pass; `deps.nflStatsFor(espnEventId)` the
 * final boxscore rows (see nflStatsReader).
 */
export async function gradeTicketLeg(leg, deps) {
  if (leg.kind === 'prop') {
    if (leg.sportKey !== NFL_SPORT_KEY || !deps.nflStatsFor) return null;
    const rows = await deps.nflStatsFor(leg.espnEventId);
    if (!rows) return null;
    const row = rows.find((r) => normalizeName(r.name) === normalizeName(leg.playerName)) ?? null;
    return gradeNflPropLeg(leg, row);
  }
  const scoreEvent = deps.scoreEventFor(leg);
  const probe = { ...leg, decimal: leg.decimal ?? 2, suggested_stake: 1 };
  if (isMma(leg.sportKey)) return gradeMmaPickWithFallback(probe, scoreEvent, deps.mmaResults ?? []);
  if (isTennis(leg.sportKey)) return gradeTennisPickWithEspn(probe, scoreEvent, deps.tennisResults ?? [], deps.env, deps.ctx, deps.now);
  return gradePick(probe, scoreEvent, deps.now);
}

/**
 * Settle a ticket from its legs' verdicts, writing each leg's status onto
 * the record. Returns the same shape every grader does — null while any
 * leg is still open, `{void, reason}`, or `{won, payout}` at the ticket's
 * combined price and stake.
 */
export async function gradeTicket(pick, deps) {
  const outcomes = await Promise.all(pick.legs.map((leg) => gradeTicketLeg(leg, deps)));
  if (outcomes.some((o) => !o)) return null;
  pick.legs = pick.legs.map((leg, i) => ({
    ...leg,
    status: outcomes[i].void ? 'void' : outcomes[i].won ? 'won' : 'lost',
    ...(outcomes[i].void ? { voidReason: outcomes[i].reason } : {}),
    ...(outcomes[i].detail ? { detail: outcomes[i].detail } : {}),
    ...(outcomes[i].actual != null ? { actual: outcomes[i].actual } : {}),
  }));
  if (outcomes.some((o) => o.void)) {
    return { void: true, reason: 'a leg voided, so the ticket voids with it', payout: 0 };
  }
  const won = outcomes.every((o) => o.won);
  return {
    won,
    payout: won ? (pick.decimal - 1) * pick.suggested_stake : -pick.suggested_stake,
  };
}
