/**
 * Settling a multi-leg ticket, shared by every board that can post one.
 *
 * Pixel's Picks has run two-leg bankroll builders since 2026-09-02 and the
 * Play of the Day can now be one too, so the rule for "did this ticket land"
 * lives in exactly one place. It used to be a closure inside tracking.js's
 * runGrading, which meant a second board posting a parlay had the choice of
 * importing a private helper or writing the rule again — and a parlay graded
 * two slightly different ways on two boards is a tracking record that can't
 * be trusted.
 *
 * The rule itself, unchanged from where it started and the same one the Prop
 * Play's own parlay already used: every leg must land, any losing leg loses
 * the ticket, and a voided leg voids the ticket rather than being quietly
 * dropped to leave a "parlay" of one. A ticket whose legs can't all be
 * settled yet stays pending — half-settled is not settled.
 */

import { gradePick } from '../../docs/learning.js';
import { isMma, isTennis } from '../../docs/insights.js';
import { gradeMmaPickWithFallback } from './ufc-events.js';
import { gradeTennisPickWithEspn } from './tennis-espn.js';

/**
 * A pick's legs — itself, when it's a straight. Every caller that walks legs
 * (fetching the sports in play, settling, reporting) goes through this, so a
 * combo's SECOND leg can never be missed: its sport can differ from the
 * record's own, whose sportKey is the anchor's, and a leg whose scores were
 * never fetched can never settle, leaving the whole ticket pending forever.
 */
export function legsOf(pick) {
  return pick?.type === 'combo' && Array.isArray(pick.legs) ? pick.legs : [pick];
}

/** Whether this record is a multi-leg ticket rather than a straight. */
export function isComboPick(pick) {
  return pick?.type === 'combo' && Array.isArray(pick.legs) && pick.legs.length > 1;
}

/**
 * A function that settles ONE leg to won/lost/void through the same
 * per-sport graders a single pick uses, or null while it can't be settled
 * yet. Only the verdict is read: a parlay pays once, off the ticket's own
 * combined price, so the nominal stake here never reaches a stored number.
 */
export function makeLegGrader({ scoreEventsBySport, mmaResults = [], tennisResults = [], env, ctx, now }) {
  return async (leg) => {
    const scoreEvent = (scoreEventsBySport.get(leg.sportKey) ?? []).find((e) => e.id === leg.eventId);
    const probe = { ...leg, decimal: leg.decimal ?? 2, suggested_stake: 1 };
    if (isMma(leg.sportKey)) return gradeMmaPickWithFallback(probe, scoreEvent, mmaResults);
    if (isTennis(leg.sportKey)) return gradeTennisPickWithEspn(probe, scoreEvent, tennisResults, env, ctx, now);
    return gradePick(probe, scoreEvent, now);
  };
}

/**
 * Settle a ticket from its legs' verdicts, stamping each leg's own outcome
 * onto the record so the card can show which leg let it down. Returns null
 * while any leg is unsettleable, leaving the ticket pending.
 */
export async function gradeComboTicket(pick, gradeLeg) {
  const outcomes = await Promise.all(pick.legs.map(gradeLeg));
  if (outcomes.some((o) => !o)) return null;
  pick.legs = pick.legs.map((leg, i) => ({
    ...leg,
    status: outcomes[i].void ? 'void' : outcomes[i].won ? 'won' : 'lost',
    ...(outcomes[i].void ? { voidReason: outcomes[i].reason } : {}),
    ...(outcomes[i].detail ? { detail: outcomes[i].detail } : {}),
  }));
  if (outcomes.some((o) => o.void)) {
    return { void: true, reason: 'a leg voided, so the ticket voids with it' };
  }
  const won = outcomes.every((o) => o.won);
  return {
    won,
    payout: won ? (pick.decimal - 1) * pick.suggested_stake : -pick.suggested_stake,
  };
}

/**
 * The per-leg slice of a stored ticket: everything a grader needs to settle
 * that leg on its own, and nothing else. Payout is deliberately absent — a
 * parlay pays once, off the COMBINED price on the record, never per leg.
 *
 * Shared so Pixel's Picks and the Play of the Day store their tickets in the
 * identical shape; every reader (grading above, the tracker, the cards, the
 * cross-board contradiction check) then works on either board's ticket
 * without knowing which board wrote it.
 */
export function comboLegRecord(leg) {
  return {
    legId: leg.id,
    eventId: leg.eventId,
    sportKey: leg.sportKey,
    sportTitle: leg.sportTitle,
    marketKey: leg.marketKey,
    marketLabel: leg.marketLabel,
    outcomeName: leg.outcomeName,
    point: leg.point ?? null,
    selection: leg.selection,
    american: leg.american,
    decimal: leg.decimal,
    book: leg.book,
    home: leg.home,
    away: leg.away,
    commenceMs: leg.commenceMs,
    status: 'pending',
  };
}
