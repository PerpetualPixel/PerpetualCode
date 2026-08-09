/**
 * Shared pick-grading and summary math — used by the client (docs/app.js,
 * for a Full Slate game's live win/loss border) and by the Cloudflare
 * Worker (worker/src/tracking.js, full-slate-tracking.js, potd.js, which
 * all import gradePick from here directly rather than duplicating it).
 * Pure functions only, no DOM/IndexedDB/network, so the same file runs
 * unmodified in both the browser and the Worker runtime.
 */

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
 */
function gradeTennis(pick, homeSets, awaySets) {
  if (pick.marketKey !== 'h2h') {
    return voidResult('tennis spreads/totals are priced in games but scored in sets — not settleable');
  }

  const setsPlayed = homeSets + awaySets;
  const decided = Math.max(homeSets, awaySets) >= 2; // best-of-3; a best-of-5 winner clears this too

  if (!decided) {
    // Retirement or walkover.
    if (setsPlayed < 1) return voidResult('walkover — no completed set');
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
export function gradePick(pick, scoreEvent) {
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
    outcome = gradeTennis(pick, homeScore, awayScore);
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
