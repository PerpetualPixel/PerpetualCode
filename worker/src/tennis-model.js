/**
 * The tennis model (2026-11-06, the Tennis tab: "very picky ... aces, over
 * games, over in the first or second set, plus spreads for games and
 * sets"). Pure: no fetches, no KV, so the runner, the worker and the tests
 * share it.
 *
 * A match is simulated point by point from each player's serve-point win
 * probability (the share of points a player wins on serve, from the serve
 * numbers in the match data: first serves in, first-serve points won,
 * second-serve points won), with the opponent's return strength folded in.
 * Thousands of matches give the distributions the plays are read from: the
 * total games, the games in the first and the second set, the game margin,
 * the sets each side wins, and each player's service points (the aces come
 * from those at the player's ace rate). The pair of serve probabilities is
 * shifted together until the simulated match winner agrees with the
 * market's price, so the model never argues with the book about who wins,
 * only about the shape of the match.
 */

/** A small seeded generator (mulberry32): the same card reads the same twice, and the tests are exact. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Tour averages (2024-25 seasons, rounded): serve points won, and so return points won, on the main tours. */
export const TOUR_AVG = { atp: { serve: 0.64, ace: 0.078 }, wta: { serve: 0.57, ace: 0.040 } };

/**
 * A player's serve-point win probability and return-point win probability
 * from an aggregate of their matches: {svpt, firstIn, firstWon, secondWon,
 * oppSvpt, oppFirstWon, oppSecondWon}. Null when the sample is too small.
 */
export function serveRates(agg, { minPoints = 300 } = {}) {
  if (!agg || !(agg.svpt >= minPoints)) return null;
  const first = agg.firstIn / agg.svpt;
  const serve = (agg.firstWon + agg.secondWon) / agg.svpt;
  const ret = agg.oppSvpt > 0 ? 1 - (agg.oppFirstWon + agg.oppSecondWon) / agg.oppSvpt : null;
  const ace = agg.svpt > 0 ? (agg.aces ?? 0) / agg.svpt : null;
  return { serve, firstIn: first, return: ret, ace, points: agg.svpt };
}

/**
 * The serve-point probabilities for a match: each player's own serve rate,
 * moved by how the opponent returns against the tour's average returner.
 * A missing return rate leaves the serve rate as it is.
 */
export function matchServeProbs(a, b, tour = 'atp') {
  const avgReturn = 1 - (TOUR_AVG[tour] ?? TOUR_AVG.atp).serve;
  const adj = (own, opp) => clamp(own.serve - ((opp.return ?? avgReturn) - avgReturn), 0.4, 0.85);
  return { pA: adj(a, b), pB: adj(b, a) };
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * One simulated match: best of 3 (or 5) tiebreak sets from the two serve
 * probabilities. Returns the sets as [gamesA, gamesB] pairs, who won, each
 * player's service points, and the total games.
 */
export function simulateMatch(pA, pB, random, { bestOf = 3 } = {}) {
  const need = bestOf === 5 ? 3 : 2;
  let setsA = 0; let setsB = 0; const sets = []; let svptA = 0; let svptB = 0;
  let serverA = random() < 0.5; // who serves first alternates game by game; the toss is random
  const playPoint = (aServing) => { if (aServing) svptA++; else svptB++; const p = aServing ? pA : pB; return (random() < p) === aServing; }; // true: A wins the point
  const playGame = (aServing) => {
    let a = 0; let b = 0;
    for (;;) { if (playPoint(aServing)) a++; else b++; if ((a >= 4 || b >= 4) && Math.abs(a - b) >= 2) return a > b; if (a >= 20) return a > b; }
  };
  const playTiebreak = (aServesFirst) => {
    let a = 0; let b = 0; let n = 0;
    for (;;) {
      // The first point by the first server, then two each.
      const aServing = n === 0 ? aServesFirst : (Math.floor((n - 1) / 2) % 2 === 0) !== aServesFirst;
      if (playPoint(aServing)) a++; else b++; n++;
      if ((a >= 7 || b >= 7) && Math.abs(a - b) >= 2) return a > b;
      if (n >= 60) return a > b;
    }
  };
  while (setsA < need && setsB < need) {
    let ga = 0; let gb = 0;
    for (;;) {
      if (ga === 6 && gb === 6) { if (playTiebreak(serverA)) ga++; else gb++; serverA = !serverA; break; }
      if (playGame(serverA)) ga++; else gb++;
      serverA = !serverA;
      if ((ga >= 6 || gb >= 6) && Math.abs(ga - gb) >= 2) break;
    }
    sets.push([ga, gb]);
    if (ga > gb) setsA++; else setsB++;
  }
  return { sets, aWon: setsA > setsB, setsA, setsB, svptA, svptB, games: sets.reduce((n, [x, y]) => n + x + y, 0) };
}

/** `n` simulated matches from one seed. */
export function simulate(pA, pB, { n = 3000, seed = 7, bestOf = 3 } = {}) {
  const random = rng(seed);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = simulateMatch(pA, pB, random, { bestOf });
  return out;
}

/** The share of simulations the player wins. */
export const winShare = (sims) => sims.filter((s) => s.aWon).length / sims.length;

/**
 * The pair of serve probabilities moved together (one up, one down by the
 * same amount) until the simulated win share for A meets the target within
 * a point or so: the market's say on the winner, the model's on the shape.
 */
export function fitToTarget(pA, pB, target, { n = 1500, seed = 7, bestOf = 3, iterations = 12 } = {}) {
  if (!(target > 0.02 && target < 0.98)) return { pA, pB, share: null };
  let lo = -0.12; let hi = 0.12; let best = { pA, pB, share: winShare(simulate(pA, pB, { n, seed, bestOf })) };
  if (Math.abs(best.share - target) < 0.012) return best;
  for (let i = 0; i < iterations; i++) {
    const d = (lo + hi) / 2;
    const a = clamp(pA + d, 0.4, 0.85); const b = clamp(pB - d, 0.4, 0.85);
    const share = winShare(simulate(a, b, { n, seed, bestOf }));
    best = { pA: a, pB: b, share };
    if (Math.abs(share - target) < 0.012) break;
    if (share < target) lo = d; else hi = d;
  }
  return best;
}

/** A histogram as a Map value -> count, and the share at or above / below a line. */
export function histogram(values) { const m = new Map(); for (const v of values) m.set(v, (m.get(v) ?? 0) + 1); return m; }
export const shareOver = (values, line) => values.filter((v) => v > line).length / values.length;
export const shareUnder = (values, line) => values.filter((v) => v < line).length / values.length;

/**
 * The distributions a card's plays are read from. Every field is a share
 * (0 to 1) or a list of per-simulation values for shareOver/shareUnder.
 */
export function distributions(sims) {
  const games = sims.map((s) => s.games);
  const set1 = sims.map((s) => s.sets[0][0] + s.sets[0][1]);
  const set2 = sims.filter((s) => s.sets[1]).map((s) => s.sets[1][0] + s.sets[1][1]);
  const marginA = sims.map((s) => s.sets.reduce((m, [a, b]) => m + a - b, 0));
  return {
    n: sims.length,
    pA: winShare(sims),
    games, set1, set2, marginA,
    aWinsASet: sims.filter((s) => s.setsA >= 1).length / sims.length,
    bWinsASet: sims.filter((s) => s.setsB >= 1).length / sims.length,
    straightSets: sims.filter((s) => s.sets.length === 2).length / sims.length,
    meanGames: games.reduce((a, b) => a + b, 0) / games.length,
    svptA: sims.map((s) => s.svptA), svptB: sims.map((s) => s.svptB),
  };
}

/**
 * A player's aces over the match: each simulation's service points at the
 * player's ace rate (a binomial draw per simulation), as per-simulation
 * counts for shareOver. The rate is shaded a little toward the tour's
 * average for a thin sample.
 */
export function aceCounts(svptSamples, aceRate, { seed = 11, tour = 'atp', samplePoints = 1000 } = {}) {
  const avg = (TOUR_AVG[tour] ?? TOUR_AVG.atp).ace;
  const w = Math.min(1, samplePoints / 1500);
  const r = clamp(aceRate * w + avg * (1 - w), 0, 0.4);
  const random = rng(seed);
  return svptSamples.map((n) => { let k = 0; for (let i = 0; i < n; i++) if (random() < r) k++; return k; });
}

/** American odds to the implied share with the vig left in; the two sides of a market de-vigged by proportion. */
export const impliedOf = (american) => (american < 0 ? -american / (-american + 100) : 100 / (american + 100));
export function devig(americanA, americanB) {
  const a = impliedOf(americanA); const b = impliedOf(americanB); const s = a + b;
  return s > 0 ? { a: a / s, b: b / s } : { a: 0.5, b: 0.5 };
}

/** The highest half-line a count clears at the given share: 7.5 when 80% of the samples are 8 or more. Null when none. */
export function highestLineAt(values, share, { max = 40 } = {}) {
  let best = null;
  for (let line = 0.5; line <= max; line += 1) { if (shareOver(values, line) >= share) best = line; else break; }
  return best;
}
