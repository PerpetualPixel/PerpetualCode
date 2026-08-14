/**
 * Shared pick-grading and summary math — used by the client (docs/app.js,
 * for a Full Slate game's live win/loss border) and by the Cloudflare
 * Worker (worker/src/tracking.js, full-slate-tracking.js, potd.js, which
 * all import gradePick from here directly rather than duplicating it).
 * Pure functions only, no DOM/IndexedDB/network, so the same file runs
 * unmodified in both the browser and the Worker runtime.
 */

import { gradeBtts, gradeDoubleChance } from './soccer-markets.js';

/** A settled-but-not-a-bet outcome: stake returned, nothing won or lost. */
function voidResult(reason) {
  return { void: true, reason, payout: 0 };
}

/**
 * Tennis settles differently from every other sport here, for two verified
 * reasons — both confirmed against the live feed rather than assumed:
 *
 * 1. THE UNIT MISMATCH. This feed prices tennis spreads and totals in GAMES
 *    (a −4.5 handicap, a 21.5 total) while its /scores endpoint reports
 *    SETS (0/1/2). There is no games-level result anywhere in the pipeline
 *    to settle a games-level line against. The generic path below would
 *    happily compute `2 sets + (−4.5 games) − 1 set` and record a loss, and
 *    would grade EVERY tennis total as Under (3 sets is always < 21.5
 *    games). Those aren't edge cases; they're systematic fabrication. So
 *    tennis spreads and totals are voided outright until a games-level
 *    score source exists. See docs/tennis-tiers.js, which also keeps them
 *    out of the tracked markets for the lower tiers.
 *
 * 2. RETIREMENTS. A best-of-3 match ends when someone reaches 2 sets. A
 *    `completed` match where nobody has is a retirement or walkover, which
 *    is the standard sportsbook settlement case. The near-universal rule is
 *    applied: at least one full set completed → match-winner bets stand and
 *    the advancing player wins; nothing completed (a walkover) → void.
 *
 * 3. THE "0-0 COMPLETED" TRAP. `completed:true` with zero sets played
 *    almost always means a genuine walkover (a scratched player, reported
 *    near-instantly) — but confirmed live, this feed can also mark a match
 *    completed:true and simply never post real set data for it at all,
 *    for a match that actually played out normally (one TIER_1 ATP match
 *    sat at 0-0, completed:true, 7+ hours after commence). A real walkover
 *    is knowable almost immediately; a data gap for a real match isn't
 *    distinguishable from one at the instant it's first seen, only by
 *    whether it's still unresolved well after any real match could have
 *    finished. So "0 sets played" isn't voided as a walkover until
 *    WALKOVER_GRACE_HOURS have passed since commence — before that it
 *    stays pending, same as an ordinary still-in-progress match, and gets
 *    a fresh look on the next grading pass (worker/src/tracking.js's
 *    runGrading runs every 20 minutes) or a rescue from the secondary
 *    source (worker/src/tennis-results.js) if one's configured.
 */
// Comfortably longer than any realistic best-of-3/best-of-5 match,
// including rain delays — a judgment call, not a measured bound. TIER_1
// (this function's only caller for h2h — see docs/tennis-tiers.js) includes
// Grand Slams, so this has to clear a best-of-5 with delays, not just a
// best-of-3. Voiding too early risks the exact wrong-permanent-void bug
// this guards against; voiding too late just means a genuine walkover
// shows "pending" a bit longer, which is harmless since grading is
// idempotent and re-run every 20 minutes.
const WALKOVER_GRACE_HOURS = 6;

/**
 * The void reason a tennis spread/total gets when only a SETS score is
 * available. Exported because it's load-bearing beyond this file:
 * worker/src/tennis-espn.js matches on it to reopen picks voided for this
 * reason once a games-level source can actually settle them, and a silent
 * drift between the two strings would turn that reopen into a no-op that
 * still reads as working.
 */
export const UNSETTLEABLE_TENNIS_GAME_MARKET = 'tennis spreads/totals are priced in games but scored in sets — not settleable';

function gradeTennis(pick, homeSets, awaySets, now = Date.now()) {
  if (pick.marketKey !== 'h2h') {
    return voidResult(UNSETTLEABLE_TENNIS_GAME_MARKET);
  }

  const setsPlayed = homeSets + awaySets;
  const decided = Math.max(homeSets, awaySets) >= 2; // best-of-3; a best-of-5 winner clears this too

  if (!decided) {
    // Retirement or walkover.
    if (setsPlayed < 1) {
      // pick.commenceMs is missing for at least one call site (docs/app.js's
      // slateGameOutcome, a live UI indicator built from a partial pick
      // object) — Number.isFinite guards that back to the old
      // immediate-void behavior rather than NaN-comparing into always
      // voiding or always staying pending.
      if (Number.isFinite(pick.commenceMs) && (now - pick.commenceMs) / 3600000 < WALKOVER_GRACE_HOURS) {
        return null; // too soon to tell a real walkover from a data gap — stay pending
      }
      return voidResult('walkover — no completed set');
    }
    if (homeSets === awaySets) return voidResult('retirement with sets level — no advancing player to settle to');
    // One player was ahead on completed sets and advances.
    const pickedIsHome = pick.outcomeName === pick.home;
    const pickedAhead = pickedIsHome ? homeSets > awaySets : awaySets > homeSets;
    return { won: pickedAhead, retired: true };
  }

  const pickedIsHome = pick.outcomeName === pick.home;
  const pickedSets = pickedIsHome ? homeSets : awaySets;
  const otherSets = pickedIsHome ? awaySets : homeSets;
  if (pickedSets === otherSets) return null; // shouldn't happen once decided; stay pending rather than guess
  return { won: pickedSets > otherSets };
}

/**
 * Whether a tennis match's free /scores entry shows a clean, decided result
 * (not a retirement/walkover) — exported so worker/src/tennis-results.js
 * can decide whether it's even worth spending a metered second-source API
 * call on this match BEFORE making one: a spread/total on a retired match
 * is unsettleable regardless of which data source is asked, so there's no
 * reason to spend part of a tight daily budget finding that out twice.
 * Returns null when the match isn't completed/parseable yet (stays pending).
 */
export function tennisMatchDecided(pick, scoreEvent) {
  if (!scoreEvent?.completed || !Array.isArray(scoreEvent.scores)) return null;
  const scoreFor = (teamName) => {
    const entry = scoreEvent.scores.find((s) => s.name === teamName);
    const value = entry ? Number(entry.score) : NaN;
    return Number.isFinite(value) ? value : null;
  };
  const homeSets = scoreFor(pick.home);
  const awaySets = scoreFor(pick.away);
  if (homeSets == null || awaySets == null) return null;
  return { decided: Math.max(homeSets, awaySets) >= 2, homeSets, awaySets };
}

/**
 * Decide the outcome of a tracked pick against the matching /scores event.
 *
 * Returns one of:
 *   - `{ won, payout }`      — a real win or loss
 *   - `{ void: true, ... }`  — settled with the stake returned (push,
 *                              walkover, or an unsettleable market)
 *   - `null`                 — not resolvable yet; stays pending
 *
 * Pushes used to return null, which meant a spread landing exactly on its
 * number sat pending forever and was never resolved by any later pass.
 * They now settle as a void with zero payout, which is what a push actually
 * is. Callers must handle the void case explicitly — summarizePicks() and
 * the learning/health reviews all exclude voids from win rate and ROI,
 * since a returned stake is neither a win nor a loss nor money at risk.
 */
export function gradePick(pick, scoreEvent, now = Date.now()) {
  if (!scoreEvent?.completed || !Array.isArray(scoreEvent.scores)) return null;

  const scoreFor = (teamName) => {
    const entry = scoreEvent.scores.find((s) => s.name === teamName);
    const value = entry ? Number(entry.score) : NaN;
    return Number.isFinite(value) ? value : null;
  };

  const homeScore = scoreFor(pick.home);
  const awayScore = scoreFor(pick.away);
  if (homeScore == null || awayScore == null) return null;

  let outcome;
  if (String(pick.sportKey ?? '').startsWith('tennis_')) {
    outcome = gradeTennis(pick, homeScore, awayScore, now);
  } else {
    outcome = gradeGeneric(pick, homeScore, awayScore);
  }
  if (!outcome) return null;
  if (outcome.void) return outcome;

  const payout = outcome.won ? (pick.decimal - 1) * pick.suggested_stake : -pick.suggested_stake;
  return { ...outcome, payout };
}

/** Team-sport settlement: final scores, straightforward market math. */
function gradeGeneric(pick, homeScore, awayScore) {
  const pickedIsHome = pick.outcomeName === pick.home;
  const pickedScore = pickedIsHome ? homeScore : awayScore;
  const otherScore = pickedIsHome ? awayScore : homeScore;
  const point = pick.point ?? 0;

  if (pick.marketKey === 'h2h') {
    if (pickedScore === otherScore) return voidResult('draw');
    return { won: pickedScore > otherScore };
  }
  if (pick.marketKey === 'spreads') {
    const margin = pickedScore + point - otherScore;
    if (margin === 0) return voidResult('push — margin landed exactly on the spread');
    return { won: margin > 0 };
  }
  if (pick.marketKey === 'totals') {
    const total = homeScore + awayScore;
    if (total === point) return voidResult('push — total landed exactly on the number');
    return { won: pick.outcomeName === 'Over' ? total > point : total < point };
  }
  if (pick.marketKey === 'btts') return gradeBtts(pick, homeScore, awayScore);
  if (pick.marketKey === 'double_chance') return gradeDoubleChance(pick, homeScore, awayScore);
  return null; // unrecognized market — leave pending rather than guess
}

/**
 * W-L/ROI/net summary over any picks array — used by every one of the
 * Tracking Dashboard's server-tracked panels (Full Slate, Pixel's Picks,
 * Play of the Day), each passing in its own picks array so they can share
 * this exact math without disagreeing on how a win rate or ROI is computed.
 */
export function summarizePicks(picks) {
  // A void (push, walkover, unsettleable market) is settled but was never
  // money at risk — counting its stake would dilute ROI toward zero and
  // counting it as graded would inflate the sample the win rate is drawn
  // from. It's reported on its own instead.
  const settled = picks.filter((p) => p.status !== 'pending');
  const voided = settled.filter((p) => p.status === 'void');
  const graded = settled.filter((p) => p.status !== 'void');
  const wins = graded.filter((p) => p.status === 'won').length;
  const losses = graded.filter((p) => p.status === 'lost').length;
  const staked = graded.reduce((sum, p) => sum + p.suggested_stake, 0);
  const net = graded.reduce((sum, p) => sum + (p.result?.payout ?? 0), 0);
  return {
    picks,
    total: picks.length,
    graded: graded.length,
    pending: picks.length - settled.length,
    voided: voided.length,
    wins,
    losses,
    staked,
    net,
    roi: staked ? (net / staked) * 100 : 0,
  };
}
