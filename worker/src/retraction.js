/**
 * Manual pick retraction — the one path by which a pick that was already
 * locked in and tracked gets pulled back out of the live record.
 *
 * This exists because the algorithm itself can change underneath a day
 * that's already been picked. The tennis form gate (docs/qualitative.js's
 * applyTennisFormSignal) shipped mid-slate, which left the board in a state
 * no automatic path can fix: picks made that morning under the pure-price
 * engine, sitting alongside picks made that afternoon under the gate. The
 * batches are all self-healing top-ups — they only ever ADD games they
 * haven't seen — so nothing in the normal run loop will ever revisit a game
 * whose pick already exists.
 *
 * A retraction is deliberately NOT a delete. A deleted pick is
 * indistinguishable from one that was never made, which is exactly the kind
 * of quietly-improved record this tracker exists to not have. Instead the
 * record stays, settled as a **void**: stake returned, no win, no loss, and
 * excluded from win rate and ROI by the same summarizePicks() path that
 * already excludes pushes and walkovers (see docs/learning.js). The reason
 * travels with it, so the dashboard can say why rather than just showing a
 * gap.
 *
 * Shared rather than duplicated across the three trackers for the same
 * reason full-slate-tracking.js imports pickRecordFrom instead of
 * re-implementing it: this is correctness-critical record-shape mapping, and
 * every dashboard summary/render helper depends on its exact field list.
 */

import { tourOf } from '../../docs/tennis-tiers.js';

/**
 * Stamps a tracked pick as retracted-and-void, returning a new record (the
 * caller persists it). `status: 'void'` with a zero payout is the same
 * settled-but-ungraded shape a push or walkover produces, so every existing
 * consumer — summarizePicks, the calibration report, the learning review —
 * already handles it correctly with no changes: it counts as action taken
 * and settled, but never as a win or a loss.
 *
 * `voidReason` is what the dashboard already renders for any void (see
 * docs/app.js), so the reason shows up in the UI without a special case.
 * The separate `retracted` block is what distinguishes a MANUAL pull from an
 * ordinary settlement void, since only the former deserves the badge and the
 * user-facing notice.
 */
export function retractedRecord(pick, { reason, at }) {
  return {
    ...pick,
    status: 'void',
    result: {
      payout: 0,
      roiPercent: 0,
      voidReason: reason,
    },
    retracted: { at, reason },
  };
}

/** Whether a tracked pick is on the WTA tour, from its own stored sportKey. */
export function isWtaPick(pick) {
  return tourOf(pick?.sportKey) === 'wta';
}
