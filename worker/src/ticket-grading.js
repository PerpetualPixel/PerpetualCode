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
import { gradePropLeg } from '../../docs/prop-legs.js';
import { gradeMmaPickWithFallback } from './ufc-events.js';
import { gradeTennisPickWithEspn } from './tennis-espn.js';
import { propStatsReader } from './prop-legs.js';

export { propStatsReader };

/** Player names compared the way every props module compares them. */
const foldName = (name) => String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The legs a record settles on: its `legs` for a ticket, itself for a single. */
export function legsOf(pick) {
  return pick?.type === 'combo' && Array.isArray(pick.legs) ? pick.legs : [pick];
}

/**
 * Settle ONE leg to won/lost/void. Only the verdict is read: a ticket pays
 * once, off its own combined price, so the nominal stake here never
 * reaches a stored number. Returns null while the leg can't be settled.
 *
 * `deps.scoreEventFor(leg)` returns the odds feed's score event for the
 * leg's game; `deps.mmaResults`/`deps.tennisResults` are the ESPN result
 * sets already fetched for the pass; `deps.propStatsFor(sportKey,
 * espnEventId)` the final boxscore rows (see propStatsReader).
 */
export async function gradeTicketLeg(leg, deps) {
  if (leg.kind === 'prop') {
    if (!deps.propStatsFor) return null;
    const rows = await deps.propStatsFor(leg.sportKey, leg.espnEventId);
    if (!rows) return null;
    const row = rows.find((r) => foldName(r.name) === foldName(leg.playerName)) ?? null;
    return gradePropLeg(leg, row);
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

/**
 * Settle a straight player-prop play (a single whose record is itself a
 * prop leg) — the same boxscore read, paying at the record's own price.
 */
export async function gradePropSingle(pick, deps) {
  const outcome = await gradeTicketLeg(pick, deps);
  if (!outcome) return null;
  if (outcome.void) return { ...outcome, payout: 0 };
  return {
    ...outcome,
    payout: outcome.won ? (pick.decimal - 1) * pick.suggested_stake : -pick.suggested_stake,
  };
}
