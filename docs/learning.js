/**
 * Shared pick-grading and summary math — used by the client (docs/app.js,
 * for a Full Slate game's live win/loss border) and by the Cloudflare
 * Worker (worker/src/tracking.js, full-slate-tracking.js, potd.js, which
 * all import gradePick from here directly rather than duplicating it).
 * Pure functions only, no DOM/IndexedDB/network, so the same file runs
 * unmodified in both the browser and the Worker runtime.
 */

/**
 * Decide win/loss for a tracked pick against the matching /scores event, and
 * the resulting payout. Returns null if the game isn't completed yet, its
 * score is missing/unparseable, or the result is a push — a push isn't a
 * win or a loss, so it's left pending rather than graded either way.
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

  const pickedIsHome = pick.outcomeName === pick.home;
  const pickedScore = pickedIsHome ? homeScore : awayScore;
  const otherScore = pickedIsHome ? awayScore : homeScore;
  const point = pick.point ?? 0;

  let won;
  if (pick.marketKey === 'h2h') {
    if (pickedScore === otherScore) return null; // push (extra-innings/OT ties settle it elsewhere)
    won = pickedScore > otherScore;
  } else if (pick.marketKey === 'spreads') {
    const margin = pickedScore + point - otherScore;
    if (margin === 0) return null; // push
    won = margin > 0;
  } else if (pick.marketKey === 'totals') {
    const total = homeScore + awayScore;
    if (total === point) return null; // push
    won = pick.outcomeName === 'Over' ? total > point : total < point;
  } else {
    return null; // unrecognized market — leave pending rather than guess
  }

  const payout = won ? (pick.decimal - 1) * pick.suggested_stake : -pick.suggested_stake;
  return { won, payout };
}

/**
 * W-L/ROI/net summary over any picks array — used by every one of the
 * Tracking Dashboard's server-tracked panels (Full Slate, Pixel's Picks,
 * Play of the Day), each passing in its own picks array so they can share
 * this exact math without disagreeing on how a win rate or ROI is computed.
 */
export function summarizePicks(picks) {
  const graded = picks.filter((p) => p.status !== 'pending');
  const wins = graded.filter((p) => p.status === 'won').length;
  const losses = graded.filter((p) => p.status === 'lost').length;
  const staked = graded.reduce((sum, p) => sum + p.suggested_stake, 0);
  const net = graded.reduce((sum, p) => sum + (p.result?.payout ?? 0), 0);
  return {
    picks,
    total: picks.length,
    graded: graded.length,
    pending: picks.length - graded.length,
    wins,
    losses,
    staked,
    net,
    roi: staked ? (net / staked) * 100 : 0,
  };
}
