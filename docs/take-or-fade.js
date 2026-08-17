/**
 * TakeOrFadeEngine — the quantitative decision layer behind Tail or Fade.
 *
 * Five weighted pillars produce a composite Take/Fade Score (TPS), which
 * with the bet's own expected value resolves to one of five verdicts:
 * STRONG TAKE, TAKE, LEAN / PASS, FADE, STRONG FADE.
 *
 *   TPS = 0.30·market + 0.25·matchup + 0.20·distribution
 *       + 0.15·context + 0.10·variance
 *
 * THE ONE RULE THAT SHAPES EVERYTHING HERE: a pillar with no real data
 * behind it scores `null`, not a neutral 50, and its weight is
 * redistributed across the pillars that DO have data (see compositeScore).
 *
 * That is not a stylistic preference. A neutral midpoint makes "we have no
 * matchup data for this sport" render identically to "the matchup is
 * average", and a user cannot tell those apart from the output. This app
 * shipped a version of Tail or Fade whose entire evidence section was
 * hardcoded prose, and the lesson taken from it is that a confident-looking
 * number with nothing behind it is worse than an admitted gap. Every
 * evaluator here therefore reports `unavailable: [...]` naming the factors
 * it could not compute, and those names are shown to the user.
 *
 * Consequently the sport evaluators below are honest about being partial.
 * The specification this implements calls for court speed indices, EPA/play,
 * barrel rates, GSAx, play-type defense ranks and pass-rush win rates. This
 * app holds none of those today. What it does hold — de-vigged market
 * consensus across books, a recent-form and injury differential
 * (docs/qualitative.js), MMA capper consensus, prop hit-rate profiles from
 * real game logs, and spread points — is computed here in full, and
 * everything else is named as missing rather than approximated. When a feed
 * for one of them lands, it becomes a factor in the relevant evaluator and
 * the pillar's weight stops being redistributed away from it.
 *
 * Pure and synchronous. No DOM, no network, no fetches — same contract as
 * engine.js, so every formula below is unit-testable without a browser.
 */

import {
  RULES,
  KELLY,
  americanToDecimal,
  impliedProb,
  formatAmerican,
  kellyFraction,
  isNflPreseasonKey,
} from './engine.js';

/* ------------------------------------------------------------------ */
/* Verdicts                                                            */
/* ------------------------------------------------------------------ */

export const STRONG_TAKE = 'STRONG TAKE';
export const TAKE = 'TAKE';
export const LEAN_PASS = 'LEAN / PASS';
export const FADE = 'FADE';
export const STRONG_FADE = 'STRONG FADE';
/** Not a grade — the state of having nothing to grade against. */
export const NO_READ = 'NO READ';

/** Best-to-worst, so a floor or ceiling is an index comparison. */
export const VERDICT_ORDER = [STRONG_TAKE, TAKE, LEAN_PASS, FADE, STRONG_FADE];

export const isTakeSide = (v) => v === STRONG_TAKE || v === TAKE;
export const isFadeSide = (v) => v === FADE || v === STRONG_FADE;

/* ------------------------------------------------------------------ */
/* De-vigging and market efficiency                                    */
/* ------------------------------------------------------------------ */

/**
 * Multiplicative (proportional) de-vig: scale every implied probability by
 * the same factor until they sum to 1.
 *
 * Fast, standard, and the right default for a roughly balanced two-way
 * market. Its known weakness is favorite-longshot bias — it removes the
 * same PROPORTION of vig from every outcome, while books in practice load
 * more of it onto the longshot, so it systematically overstates a longshot's
 * fair probability. devigPower below is the correction for that, which is
 * why both are implemented rather than one.
 */
export function devigMultiplicative(implied) {
  const probs = (implied ?? []).map(Number).filter((p) => Number.isFinite(p) && p > 0);
  const overround = probs.reduce((s, p) => s + p, 0);
  if (!probs.length || overround <= 0) return null;
  return probs.map((p) => p / overround);
}

/**
 * Power de-vig: find the exponent k where Σ(qᵢ^k) = 1, then pᵢ = qᵢ^k.
 *
 * Because k > 1 for an overround book, raising to k shrinks a small
 * probability by proportionally MORE than a large one — which is the
 * empirically observed shape of how books distribute vig, and why this is
 * the more accurate method on a lopsided market (a heavy favorite against a
 * long shot) even though it costs an iterative solve.
 *
 * Solved by bisection rather than Newton's method: the function is
 * monotonic in k, bisection cannot diverge, and 60 iterations over a bracket
 * of [0.5, 10] is exact to well past the precision any price carries.
 */
export function devigPower(implied, { iterations = 60 } = {}) {
  const probs = (implied ?? []).map(Number).filter((p) => Number.isFinite(p) && p > 0 && p < 1);
  if (probs.length < 2) return null;
  const sumAt = (k) => probs.reduce((s, p) => s + p ** k, 0);
  let lo = 0.5;
  let hi = 10;
  if (sumAt(lo) < 1) return devigMultiplicative(probs); // degenerate book, fall back rather than guess
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;
  const out = probs.map((p) => p ** k);
  const total = out.reduce((s, p) => s + p, 0);
  return out.map((p) => p / total); // renormalise away the last bisection residue
}

/**
 * Sharp fair probability for the FIRST outcome of a two-way market quoted
 * in American odds.
 *
 * `method` is 'power' by default for the reason in devigPower's comment.
 * Returns null rather than a number when the market isn't two-sided — a
 * one-sided quote carries no vig information at all, and inventing a fair
 * price from it would be exactly the fabrication this module exists to
 * avoid.
 */
export function fairProbability(americanPair, { method = 'power' } = {}) {
  if (!Array.isArray(americanPair) || americanPair.length !== 2) return null;
  const implied = americanPair.map((a) => (Number.isFinite(Number(a)) ? impliedProb(Number(a)) : NaN));
  if (implied.some((p) => !Number.isFinite(p))) return null;
  const fair = method === 'multiplicative' ? devigMultiplicative(implied) : devigPower(implied);
  return fair ? fair[0] : null;
}

/** EV per unit staked: p_fair × decimal − 1. */
export function expectedValue(pFair, decimal) {
  if (!Number.isFinite(pFair) || !Number.isFinite(decimal) || decimal <= 1) return null;
  return pFair * decimal - 1;
}

/**
 * Conservative fractional Kelly, f* = fraction × (b·p − q) / b.
 *
 * Delegates the full-Kelly term to engine.js's kellyFraction and the
 * fraction to KELLY.FRACTION (0.25) rather than restating either, so this
 * engine can never drift from the stake sizing the rest of the app already
 * uses. The MAX_STAKE cap is applied for the same reason: a single-bet
 * ceiling is protection against model error, and it should not be optional
 * depending on which surface asked.
 */
export function fractionalKelly(pFair, decimal, { fraction = KELLY.FRACTION } = {}) {
  const full = kellyFraction(pFair, decimal);
  return Math.min(full * fraction, KELLY.MAX_STAKE);
}

/** The price at which extra juice starts demanding proportionally more edge. */
export const JUICE_THRESHOLD_AMERICAN = -125;

/**
 * Whether a price is charging more juice than its edge justifies.
 *
 * "Proportional edge" is not a second heuristic bolted on beside Kelly — it
 * is what Kelly already measures. At -125 you risk 1.25 to win 1; at -300
 * you risk 3. The same win probability therefore supports a much smaller
 * fraction of bankroll as the price gets heavier, so the requirement scales
 * with exactly that ratio: b(-125) / b(price). At -125 the bar is the app's
 * ordinary MIN_KELLY_FRACTION; at -300 it is 2.4× that.
 *
 * Returns { flagged, required, actual } rather than a bare boolean so the
 * UI can say how far short a price fell instead of only that it did.
 */
export function juiceCheck(american, kelly) {
  const price = Number(american);
  if (!Number.isFinite(price) || price >= JUICE_THRESHOLD_AMERICAN) {
    return { flagged: false, required: RULES.MIN_KELLY_FRACTION, actual: kelly ?? null };
  }
  const bRef = americanToDecimal(JUICE_THRESHOLD_AMERICAN) - 1;
  const b = americanToDecimal(price) - 1;
  const ratio = b > 0 ? Math.max(1, bRef / b) : Infinity;
  const required = RULES.MIN_KELLY_FRACTION * ratio;
  return { flagged: !(Number(kelly) >= required), required, actual: kelly ?? null, ratio };
}

/* ------------------------------------------------------------------ */
/* Pillars                                                             */
/* ------------------------------------------------------------------ */

export const PILLAR_WEIGHTS = {
  market: 0.30,
  matchup: 0.25,
  distribution: 0.20,
  context: 0.15,
  variance: 0.10,
};

/**
 * Ceiling on the context and variance pillars.
 *
 * Those two are risk MODIFIERS, not merit: they measure the absence of
 * problems — a fresh line, no preseason flag, no benched segment, no wild
 * book disagreement — and the absence of problems is not maximal evidence
 * FOR a bet. Left uncapped they both pin at 100 on any ordinary wager, and
 * because compositeScore redistributes the weight of missing pillars onto
 * the surviving ones, two saturated modifiers were dragging a break-even
 * bet to a TPS of 81. Caught by a fixture that priced a candidate at exactly
 * its own implied probability and still scored in the eighties.
 *
 * The market and matchup pillars are deliberately NOT capped: those measure
 * merit, and a genuinely excellent price against a genuinely favourable
 * matchup should be able to reach the top of the scale.
 */
export const MODIFIER_PILLAR_CEILING = 85;

/** Map a value in [lo, hi] onto 0..100, clamped. */
const norm100 = (value, lo, hi) => {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, ((value - lo) / (hi - lo)) * 100));
};

const pillar = (score, signals = [], unavailable = []) => ({ score, signals, unavailable });
const sig = (text, tone = 'neutral') => ({ text, tone });

/**
 * Market pillar (0.30) — price quality against the sharp consensus.
 *
 * The only pillar that is essentially always available, because it needs
 * nothing but the prices the board already carries.
 */
export function marketPillar(leg, candidate) {
  if (!candidate) {
    return pillar(null, [], ['de-vigged fair price', 'expected value', 'line agreement', 'line shopping']);
  }

  const decimal = Number.isFinite(leg?.american)
    ? americanToDecimal(leg.american)
    : Number(candidate.decimal) || americanToDecimal(candidate.american);
  const pFair = Number(candidate.consensusProb);
  const ev = expectedValue(pFair, decimal);
  const kelly = fractionalKelly(pFair, decimal);
  const juice = juiceCheck(leg?.american ?? candidate.american, kelly);

  // The best price actually on the board for this same side, and what the
  // bet would be worth at it. The gap between the two is EXECUTION — did you
  // take the number you could have — as distinct from EDGE, which is whether
  // that number beats the de-vigged consensus at all.
  //
  // Keeping them apart matters more than it looks. De-vigging removes the
  // hold, so every side of an ordinary market prices out at roughly minus
  // the hold: a -175 favourite and the +150 dog in the same match are both
  // about -3.5% EV. Judging a leg on absolute EV alone therefore said
  // STRONG FADE about every bet available at any book, both sides of every
  // market, which is true in the sense that the vig is real and useless in
  // the sense that it cannot tell a bad leg from an ordinary one. Caught by
  // a 13-leg tennis slip that came back 13/13 STRONG FADE.
  const bestDecimal = Number(candidate.decimal) || americanToDecimal(candidate.american);
  const evAtBest = expectedValue(pFair, bestDecimal);
  const evVsMarket = Number.isFinite(ev) && Number.isFinite(evAtBest) ? ev - evAtBest : null;

  const signals = [];
  // -3% to +6% EV spans terrible to genuinely strong — the same span
  // engine.js's own scoreCandidate normalises its edge component over, so
  // the two surfaces agree about what a big edge is.
  const evScore = norm100(ev, -0.03, 0.06);
  // Execution, on its own scale: 0 means you hold the best number on the
  // board, and five points of implied probability worse than that is as bad
  // as this term gets. Unlike the edge term it is not pinned to the floor by
  // an ordinary price, so it is what separates the legs of a slip that were
  // all taken at one book.
  const executionScore = norm100(evVsMarket, -0.05, 0);
  const agreementScore = norm100(-Number(candidate.disagreement), -0.05, -0.005);
  const liquidityScore = norm100(Number(candidate.bookCount), RULES.MIN_BOOKS, 10);
  const shopScore = norm100(Number(candidate.shopGain), 0, 0.04);

  signals.push(sig(
    `De-vigged fair probability ${(pFair * 100).toFixed(1)}% (fair price ${formatAmerican(candidate.fairAmerican)}); `
    + `you are getting ${formatAmerican(leg?.american ?? candidate.american)}, worth ${(ev * 100).toFixed(2)}% per unit.`,
    ev > 0 ? 'good' : 'bad',
  ));
  signals.push(sig(
    `Quarter-Kelly stake ${(kelly * 100).toFixed(2)}% of bankroll`
    + (kelly >= RULES.MIN_KELLY_FRACTION ? '.' : ` — below the ${(RULES.MIN_KELLY_FRACTION * 100).toFixed(2)}% floor this app treats as a real bet.`),
    kelly >= RULES.MIN_KELLY_FRACTION ? 'good' : 'bad',
  ));
  signals.push(sig(
    `${candidate.bookCount} books priced it, disagreeing by ±${(Number(candidate.disagreement) * 100).toFixed(1)}%`
    + (Number(candidate.disagreement) < 0.015 ? ' — a tight consensus, so an outlier price means something.' : ' — a soft market, so the edge is less reliable.'),
    Number(candidate.disagreement) < 0.015 ? 'good' : 'warn',
  ));
  // The gap between the price the user actually holds and the best one on
  // the board. Named explicitly rather than left implicit in the EV, because
  // "this is a good bet, but not at your number" is a different and more
  // actionable message than "this is a bad bet" — and the two are otherwise
  // indistinguishable from a single EV figure.
  if (Number.isFinite(leg?.american) && Number.isFinite(candidate.american) && leg.american !== candidate.american) {
    const yours = impliedProb(leg.american);
    const best = impliedProb(candidate.american);
    signals.push(sig(
      `You have ${formatAmerican(leg.american)} against ${formatAmerican(candidate.american)} available at ${candidate.book} — `
      + (yours > best
        ? `worse than the board's best price by ${((yours - best) * 100).toFixed(1)} points of implied probability.`
        : "better than the board's best price."),
      yours > best ? 'warn' : 'good',
    ));
  }

  if (juice.flagged) {
    signals.push(sig(
      `Juice at ${formatAmerican(leg?.american ?? candidate.american)} demands ${(juice.required * 100).toFixed(2)}% Kelly to justify it; `
      + `this returns ${(juice.actual * 100).toFixed(2)}%.`,
      'bad',
    ));
  }

  const parts = [evScore, executionScore, agreementScore, liquidityScore, shopScore].filter(Number.isFinite);
  // Edge still carries the largest single share, because beating the
  // consensus is the only thing that makes a bet genuinely profitable. But
  // execution now carries real weight beside it: on a slip where no leg
  // beats the consensus, which is most slips, the number you took is the
  // only price information left to rank the legs by.
  const score = parts.length
    ? Math.max(0, Math.min(100,
      0.35 * (evScore ?? 0) + 0.20 * (executionScore ?? 0) + 0.15 * (agreementScore ?? 0)
      + 0.15 * (liquidityScore ?? 0) + 0.15 * (shopScore ?? 0)))
    : null;

  return { ...pillar(score, signals, []), ev, evAtBest, evVsMarket, kelly, pFair, juice, decimal };
}

/**
 * Matchup pillar (0.25) — dispatched to the sport evaluator, since what
 * "matchup" even means differs completely between a tennis singles match
 * and an MLB game.
 */
export function matchupPillar(leg, candidate) {
  if (!candidate) return pillar(null, [], ['matchup evaluation (no market matched)']);
  return evaluatorFor(candidate.sportKey).matchup(leg, candidate);
}

/**
 * Distribution pillar (0.20) — how the outcome is actually shaped, not just
 * its mean.
 *
 * Available only where a real per-game distribution exists: a prop with a
 * hit-rate profile from actual game logs (worker/src/prop-play.js's
 * hitProfile), or a football spread sitting near a key number, where the
 * distribution of margins is genuinely lumpy rather than smooth. A team
 * moneyline has a two-point distribution and nothing to say here, which is
 * reported as unavailable rather than scored as average.
 */
export function distributionPillar(leg, candidate) {
  const profile = leg?.profile ?? candidate?.profile ?? null;
  if (profile && Number.isFinite(profile.season) && Number.isFinite(profile.l10)) {
    const season = profile.season;
    const l10 = profile.l10;
    const l5 = Number.isFinite(profile.l5) ? profile.l5 : null;
    const signals = [
      sig(`Cleared this number in ${(season * 100).toFixed(0)}% of games this season and ${(l10 * 100).toFixed(0)}% over the last 10.`,
        l10 >= season ? 'good' : 'warn'),
    ];
    if (l5 != null) {
      signals.push(sig(
        `Last 5: ${(l5 * 100).toFixed(0)}%${l5 < l10 ? ' — trending down against the recent baseline.' : '.'}`,
        l5 >= l10 ? 'good' : 'warn',
      ));
    }
    if (Number.isFinite(profile.avgSeason) && Number.isFinite(profile.avgL5)) {
      // Median-vs-mean in the form the data supports: a recent average well
      // above the season average means the recent hits are being carried by
      // a few big games rather than by consistently clearing the line.
      signals.push(sig(
        `Averaging ${profile.avgL5} over the last 5 against ${profile.avgSeason} on the season`
        + (profile.avgL5 > profile.avgSeason * 1.25 ? ' — a spike, so the recent rate is less repeatable than it looks.' : '.'),
        profile.avgL5 > profile.avgSeason * 1.25 ? 'warn' : 'good',
      ));
    }
    // Weighted toward recent form but not to the exclusion of the season,
    // which is the larger sample.
    return pillar(Math.max(0, Math.min(100, (0.45 * l10 + 0.35 * season + 0.20 * (l5 ?? l10)) * 100)), signals, []);
  }

  const key = keyNumberAnalysis(candidate);
  if (key) return key;

  return pillar(null, [], ['outcome distribution (no per-game profile or key-number structure for this market)']);
}

/**
 * Football margins cluster hard on 3, 7, 6, 10 and 14, so a spread's exact
 * point matters far more than its distance from the next number suggests.
 * Real, computable structure — no external feed needed, only the point the
 * board already carries.
 */
export const KEY_NUMBERS = [3, 7, 6, 10, 14, 4];

export function keyNumberAnalysis(candidate) {
  if (!candidate || candidate.marketKey !== 'spreads') return null;
  if (!isFootball(candidate.sportKey)) return null;
  const point = Number(candidate.point);
  if (!Number.isFinite(point)) return null;

  const abs = Math.abs(point);
  const laying = point < 0;
  const nearest = KEY_NUMBERS.reduce((a, b) => (Math.abs(abs - a) <= Math.abs(abs - b) ? a : b));
  const distance = abs - nearest;

  const signals = [];
  let score;
  if (Math.abs(distance) < 0.01) {
    signals.push(sig(`Sitting exactly on the key number ${nearest} — the single most likely margin, so this pushes far more often than a half-point either side.`, 'warn'));
    score = 50;
  } else if (laying === (distance < 0)) {
    // Laying a number BELOW a key number, or taking one above it: the key
    // number is on your side of the line.
    signals.push(sig(`${laying ? 'Laying' : 'Taking'} ${abs} with the key number ${nearest} on your side of the line — the most common margins fall your way.`, 'good'));
    score = 72;
  } else {
    signals.push(sig(`${laying ? 'Laying' : 'Taking'} ${abs} across the key number ${nearest} — the most common margin sits against you, which is what the extra half-point is charging for.`, 'bad'));
    score = 32;
  }
  return pillar(score, signals, ['drive-level EPA', 'success rate vs havoc', 'pass rush win rate vs pass block win rate']);
}

/**
 * Context pillar (0.15) — everything true about the bet's situation rather
 * than its price or its matchup.
 */
export function contextPillar(leg, candidate, { postedSide = null, postedLabel = null, now = Date.now() } = {}) {
  const signals = [];
  const parts = [];
  const unavailable = [];

  if (postedSide === 'same') {
    signals.push(sig(`This app has already posted this exact bet as ${postedLabel}.`, 'good'));
    parts.push(90);
  } else if (postedSide === 'opposite') {
    signals.push(sig(`This is the opposite side of ${postedLabel}, a bet this app has published today.`, 'bad'));
    parts.push(10);
  }

  if (candidate) {
    const hoursOut = (Number(candidate.commenceMs) - now) / 3.6e6;
    const hoursStale = (now - Number(candidate.updatedMs)) / 3.6e6;
    if (Number.isFinite(hoursStale)) {
      // A price quoted 12 hours ago on a game starting in an hour is not a
      // price, it's a memory.
      const freshness = norm100(-hoursStale, -12, -0.5);
      parts.push(freshness);
      if (hoursStale > 6) signals.push(sig(`This line was last quoted ${hoursStale.toFixed(1)} hours ago — stale enough that the real price may have moved.`, 'warn'));
    } else {
      unavailable.push('line freshness');
    }
    if (Number.isFinite(hoursOut) && hoursOut > 48) {
      signals.push(sig(`${Math.round(hoursOut / 24)} days out — lineups, injuries and weather are all still unknown.`, 'warn'));
      parts.push(35);
    }
    if (isNflPreseasonKey(candidate.sportKey)) {
      signals.push(sig('NFL preseason: starters play a series or two and roster churn is total, so the result says little about either team.', 'bad'));
      parts.push(15);
    }
    if (candidate.benchedSegment) {
      signals.push(sig('This market segment is currently benched by the weekly algorithm health review for underperforming its own expectation.', 'bad'));
      parts.push(20);
    }
  } else {
    unavailable.push('situational context (no market matched)');
  }

  const score = parts.length ? Math.min(MODIFIER_PILLAR_CEILING, parts.reduce((s, p) => s + p, 0) / parts.length) : null;
  return pillar(score, signals, unavailable);
}

/**
 * Variance pillar (0.10) — how wide the outcome distribution is around the
 * edge, independent of whether the edge is real.
 */
export function variancePillar(leg, candidate) {
  if (!candidate) return pillar(null, [], ['variance profile (no market matched)']);
  const signals = [];
  const parts = [];

  const p = Number(candidate.consensusProb);
  if (Number.isFinite(p)) {
    // Long shots are penalised on this app's own graded record, not on
    // theory: see UNDERDOG_PROB_PENALTY in engine.js, sized from a window
    // where +120-and-longer dogs were 57% of picks and won 29.6% of them.
    const longShot = norm100(p, 0.30, 0.72);
    parts.push(longShot);
    if (p < 0.40) {
      signals.push(sig(`A ${(p * 100).toFixed(1)}% shot — real underdog variance, and this app's own record on long shots is why it discounts them.`, 'warn'));
    } else if (p > 0.75) {
      signals.push(sig(`A ${(p * 100).toFixed(1)}% favourite — low variance, but the price is paying for that certainty.`, 'neutral'));
    }
  }

  const disagreement = Number(candidate.disagreement);
  if (Number.isFinite(disagreement)) {
    parts.push(norm100(-disagreement, -0.06, -0.005));
    if (disagreement >= 0.05) {
      signals.push(sig('Books are spread wide on this number, which usually means late news the market has not settled on.', 'warn'));
    }
  }

  return pillar(parts.length ? Math.min(MODIFIER_PILLAR_CEILING, parts.reduce((s, x) => s + x, 0) / parts.length) : null, signals, []);
}

/* ------------------------------------------------------------------ */
/* Sport-specific evaluators                                           */
/* ------------------------------------------------------------------ */

const isFootball = (k) => String(k ?? '').startsWith('americanfootball');
const isTennisKey = (k) => String(k ?? '').startsWith('tennis_');
const isMmaKey = (k) => String(k ?? '').startsWith('mma_');
const isBasketball = (k) => String(k ?? '').startsWith('basketball');
const isBaseball = (k) => String(k ?? '').startsWith('baseball');
const isPuckOrPitch = (k) => String(k ?? '').startsWith('icehockey') || String(k ?? '').startsWith('soccer');

/**
 * The form/injury differential every team sport shares, as a matchup
 * pillar. `formSignal` is docs/qualitative.js's -1..+1 output, attached to
 * a candidate by the worker's selection pass (worker/src/team-form.js) or
 * by the browser's own enrichment.
 */
function formSignalPillar(candidate, missing) {
  const signal = Number(candidate?.formSignal);
  if (!Number.isFinite(signal)) return pillar(null, [], ['recent form and injury differential', ...missing]);
  const signals = [sig(
    `Recent form and injuries put this side ${signal > 0 ? 'ahead of' : signal < 0 ? 'behind' : 'level with'} its opponent `
    + `(${signal > 0 ? '+' : ''}${signal.toFixed(2)} on a -1 to +1 scale).`,
    signal > 0.1 ? 'good' : signal < -0.1 ? 'bad' : 'neutral',
  )];
  return pillar(norm100(signal, -0.6, 0.6), signals, missing);
}

/**
 * Each evaluator names what it cannot compute. Those names reach the user,
 * and they are also the to-do list for this module: every entry disappears
 * the day a real feed for it exists.
 */
export const EVALUATORS = {
  tennis: {
    name: 'Tennis (singles)',
    matchup: (leg, c) => formSignalPillar(c, [
      'court speed index', 'surface hold/break dominance ratio', 'tiebreak regression', 'prior-round fatigue (>2.5h)',
    ]),
  },
  basketball: {
    name: 'Basketball',
    matchup: (leg, c) => formSignalPillar(c, [
      'opponent play-type defence ranks', 'injury usage reallocation', 'pace mismatch', 'blowout minute discounting',
    ]),
  },
  baseball: {
    name: 'Baseball',
    matchup: (leg, c) => formSignalPillar(c, [
      'pitcher arsenal vs lineup splits', 'barrel rates', 'park factor and weather physics', 'bullpen leverage state',
    ]),
  },
  football: {
    name: 'Football',
    matchup: (leg, c) => formSignalPillar(c, [
      'EPA/play', 'success rate vs havoc', 'pass rush win rate vs pass block win rate',
    ]),
  },
  mma: {
    name: 'MMA',
    matchup: (leg, c) => {
      // MMA's evidence source in this app is capper consensus, not form.
      const consensus = Number(c?.consensusSignal ?? c?.capperSignal);
      if (!Number.isFinite(consensus)) {
        return pillar(null, [], [
          'striking differential (SLpM − SApM)', 'takedown defence %', 'control time', 'cardio drop-off by round',
        ]);
      }
      return pillar(
        norm100(consensus, -1, 1),
        [sig(`Capper consensus leans ${consensus > 0 ? 'toward' : 'against'} this side (${consensus.toFixed(2)}).`,
          consensus > 0 ? 'good' : 'bad')],
        ['striking differential (SLpM − SApM)', 'takedown defence %', 'control time', 'cardio drop-off by round'],
      );
    },
  },
  hockeySoccer: {
    name: 'Hockey / Soccer',
    matchup: (leg, c) => formSignalPillar(c, [
      'GSAx goalie modelling', '5v5 high-danger chances', 'xG/xGA differential', 'draw bias',
    ]),
  },
  generic: {
    name: 'General',
    matchup: (leg, c) => formSignalPillar(c, []),
  },
};

export function evaluatorFor(sportKey) {
  if (isTennisKey(sportKey)) return EVALUATORS.tennis;
  if (isMmaKey(sportKey)) return EVALUATORS.mma;
  if (isBasketball(sportKey)) return EVALUATORS.basketball;
  if (isBaseball(sportKey)) return EVALUATORS.baseball;
  if (isFootball(sportKey)) return EVALUATORS.football;
  if (isPuckOrPitch(sportKey)) return EVALUATORS.hockeySoccer;
  return EVALUATORS.generic;
}

/* ------------------------------------------------------------------ */
/* Composite score and classification                                  */
/* ------------------------------------------------------------------ */

/**
 * Weighted composite over only the pillars that produced a real score, with
 * the missing pillars' weight redistributed proportionally across the rest.
 *
 * Returns null when nothing scored — which becomes NO READ rather than 0,
 * because a zero would order below a genuinely terrible bet.
 */
export const MERIT_PILLARS = ['market', 'matchup', 'distribution'];
export const MODIFIER_PILLARS = ['context', 'variance'];

export function compositeScore(pillars) {
  const has = (k) => Number.isFinite(pillars?.[k]?.score);
  const liveMerit = MERIT_PILLARS.filter(has);
  const liveModifier = MODIFIER_PILLARS.filter(has);
  if (!liveMerit.length && !liveModifier.length) return { score: null, coverage: 0, weights: {} };

  // Redistribute WITHIN the group first. A missing merit pillar's weight
  // belongs to the other merit pillars, not to the modifiers: context and
  // variance measure the absence of problems, and letting them inherit 45%
  // of the model because no matchup feed exists for this sport would mean a
  // bet with terrible expected value still scoring in the sixties on the
  // strength of a fresh line and a tight book spread. Caught exactly that
  // way — an -8.3% EV wager scored 64 before this split existed.
  //
  // Only when a whole group is empty does its weight cross over, because at
  // that point the alternative is discarding the model's weight entirely.
  const meritWeight = MERIT_PILLARS.reduce((s, k) => s + PILLAR_WEIGHTS[k], 0);
  const modifierWeight = MODIFIER_PILLARS.reduce((s, k) => s + PILLAR_WEIGHTS[k], 0);
  const meritShare = liveMerit.length ? meritWeight + (liveModifier.length ? 0 : modifierWeight) : 0;
  const modifierShare = liveModifier.length ? modifierWeight + (liveMerit.length ? 0 : meritWeight) : 0;

  const weights = {};
  const spread = (group, share) => {
    const total = group.reduce((s, k) => s + PILLAR_WEIGHTS[k], 0);
    for (const k of group) weights[k] = (PILLAR_WEIGHTS[k] / total) * share;
  };
  if (liveMerit.length) spread(liveMerit, meritShare);
  if (liveModifier.length) spread(liveModifier, modifierShare);

  const score = Object.entries(weights).reduce((s, [k, w]) => s + w * pillars[k].score, 0);
  return {
    score: Math.max(0, Math.min(100, score)),
    // What fraction of the model's DESIGNED weight had real data behind it —
    // reported unchanged by the redistribution above, because that is the
    // honest disclosure: a 78 built on 55% coverage and a 78 built on 100%
    // are not the same claim, however the surviving weight was shared out.
    coverage: [...liveMerit, ...liveModifier].reduce((s, k) => s + PILLAR_WEIGHTS[k], 0),
    weights,
  };
}

export const VERDICT_THRESHOLDS = {
  STRONG_TAKE: { tps: 74, ev: 0.02 },
  TAKE: { tps: 60, ev: 0 },
  LEAN_PASS: { tps: 48 },
  // Two ways into the bottom tier, because there are two ways to be there.
  //
  //   ev  — how far below the best number on the board this price is. Zero
  //         when you hold the best number, so paying the hold does not
  //         trigger it.
  //   evAbsolute — a price so far below the de-vigged consensus that the
  //         hold cannot explain it. No ordinary two-way market pushes a side
  //         past about -5% by vig alone (checked across holds from 2.6% to
  //         the -1000/+600 range), so -7% means the consensus genuinely
  //         disagrees with the price rather than the book taking its cut.
  STRONG_FADE: { tps: 36, ev: -0.03, evAbsolute: -0.07 },
};

/**
 * TPS plus EV onto one of the five verdicts.
 *
 * EV is a gate rather than another weighted term: a bet with a negative
 * expectation is not a take at any composite score, because the composite
 * blends in things (liquidity, freshness, form) that describe how sound the
 * read is, not whether the price pays for it.
 */
export function classify(tps, ev, { juiceFlagged = false, evVsMarket = null } = {}) {
  if (!Number.isFinite(tps)) return NO_READ;
  const e = Number.isFinite(ev) ? ev : 0;
  // The bottom tier asks a different question from the rest: not "does this
  // price beat the consensus" but "is this price materially worse than one
  // you could have had". Paying the hold is what every bet at every book
  // costs, and a scale whose worst grade fires on that has no room left to
  // say anything about a bet that is actually bad.
  //
  // Absolute EV is the fallback when no board is matched, so a caller with
  // no market context still gets the old, stricter reading rather than a
  // free pass for being unmeasurable.
  const shortfall = Number.isFinite(evVsMarket) ? evVsMarket : e;

  if (shortfall <= VERDICT_THRESHOLDS.STRONG_FADE.ev
    || e <= VERDICT_THRESHOLDS.STRONG_FADE.evAbsolute
    || tps < VERDICT_THRESHOLDS.STRONG_FADE.tps) return STRONG_FADE;
  if (e < 0 || tps < VERDICT_THRESHOLDS.LEAN_PASS.tps) return FADE;
  if (tps >= VERDICT_THRESHOLDS.STRONG_TAKE.tps && e >= VERDICT_THRESHOLDS.STRONG_TAKE.ev && !juiceFlagged) return STRONG_TAKE;
  if (tps >= VERDICT_THRESHOLDS.TAKE.tps && e > VERDICT_THRESHOLDS.TAKE.ev && !juiceFlagged) return TAKE;
  return LEAN_PASS;
}

/** Verdict onto the 1-10 confidence the card shows. */
export function confidenceFor(tps, verdict) {
  if (verdict === NO_READ || !Number.isFinite(tps)) return null;
  return Math.max(1, Math.min(10, Math.round(tps / 10)));
}

/**
 * One leg, fully graded. `postedSide`/`postedLabel` carry whether this leg
 * is a bet the app itself has published (see docs/tail-fade.js) — a fact
 * about the bet's context, fed to the context pillar like any other.
 */
export function evaluateLeg(leg, { candidate = null, postedSide = null, postedLabel = null, now = Date.now() } = {}) {
  const market = marketPillar(leg, candidate);
  const pillars = {
    market,
    matchup: matchupPillar(leg, candidate),
    distribution: distributionPillar(leg, candidate),
    context: contextPillar(leg, candidate, { postedSide, postedLabel, now }),
    variance: variancePillar(leg, candidate),
  };

  const { score: tps, coverage } = compositeScore(pillars);
  const ev = market.ev ?? null;
  let verdict = classify(tps, ev, {
    juiceFlagged: market.juice?.flagged,
    evVsMarket: market.evVsMarket ?? null,
  });

  // Floors, and why they are not a fudge: the app's own selection pipeline
  // already applied every gate this engine re-derives — the score floor, the
  // EV floor, the Kelly floor, the form gate, the benched-segment check —
  // to the SAME numbers, before publishing the pick. A second pass over the
  // same inputs concluding "fade" would not be a second opinion, it would be
  // the two halves of one app disagreeing about arithmetic. That is a bug,
  // and this is where it is made unrepresentable.
  if (postedSide === 'same' && verdict !== NO_READ) verdict = betterOf(verdict, TAKE);
  if (postedSide === 'opposite' && verdict !== NO_READ) verdict = worseOf(verdict, FADE);

  return {
    leg,
    candidate,
    postedSide,
    postedLabel,
    pillars,
    tps,
    coverage,
    ev,
    kelly: market.kelly ?? null,
    pFair: market.pFair ?? null,
    juice: market.juice ?? null,
    verdict,
    confidence: confidenceFor(tps, verdict),
    unavailable: Object.values(pillars).flatMap((p) => p.unavailable ?? []),
    signals: Object.entries(pillars).flatMap(([name, p]) => (p.signals ?? []).map((s) => ({ ...s, pillar: name }))),
  };
}

const betterOf = (a, b) => (VERDICT_ORDER.indexOf(a) <= VERDICT_ORDER.indexOf(b) ? a : b);
const worseOf = (a, b) => (VERDICT_ORDER.indexOf(a) >= VERDICT_ORDER.indexOf(b) ? a : b);

/* ------------------------------------------------------------------ */
/* Parlay: correlation and cannibalization                             */
/* ------------------------------------------------------------------ */

/** Legs sharing a game, which is where every correlation effect lives. */
function groupByEvent(reads) {
  const byEvent = new Map();
  for (const r of reads) {
    const id = r.candidate?.eventId;
    if (!id) continue;
    if (!byEvent.has(id)) byEvent.set(id, []);
    byEvent.get(id).push(r);
  }
  return byEvent;
}

export const CORRELATION_BOOST = 'synergy';
export const CORRELATION_CONFLICT = 'conflict';
export const CORRELATION_CANNIBAL = 'cannibalization';

/**
 * Correlation findings across a ticket.
 *
 * The honest limit, stated rather than hidden: without a fitted correlation
 * coefficient the TRUE joint probability of correlated legs is not
 * computable here. What this does is identify the direction the independent
 * product is wrong in, which is the actionable part — a synergy means the
 * real number is higher than the multiplication says, a conflict or
 * cannibalization means it is lower, and the recommendation changes
 * accordingly.
 */
export function correlationFindings(reads) {
  const findings = [];
  for (const [eventId, group] of groupByEvent(reads)) {
    if (group.length < 2) continue;
    const label = `${group[0].candidate.away} @ ${group[0].candidate.home}`;

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const sameSide = a.candidate.outcomeName === b.candidate.outcomeName;
        const bothTeamMarkets = ['h2h', 'spreads'].includes(a.candidate.marketKey)
          && ['h2h', 'spreads'].includes(b.candidate.marketKey);

        if (bothTeamMarkets && sameSide) {
          findings.push({
            kind: CORRELATION_BOOST, eventId, legs: [a, b],
            text: `${a.leg.selection} and ${b.leg.selection} are the same side of ${label} — one game script carries both, `
              + 'so the real joint probability is higher than multiplying the two prices suggests. The book is not paying you for that.',
          });
        } else if (bothTeamMarkets && !sameSide) {
          findings.push({
            kind: CORRELATION_CONFLICT, eventId, legs: [a, b],
            text: `${a.leg.selection} and ${b.leg.selection} are opposite sides of ${label}. They cannot both land in the way this ticket needs; `
              + 'split them into straight bets or drop one.',
          });
        } else if (a.leg.profile || b.leg.profile) {
          findings.push({
            kind: CORRELATION_CANNIBAL, eventId, legs: [a, b],
            text: `${a.leg.selection} and ${b.leg.selection} are both on ${label} and draw from the same pool of possessions. `
              + 'One player\'s big night comes partly out of the other\'s, so the real joint probability is lower than the product.',
          });
        }
      }
    }
  }
  return findings;
}

/** Independent-product joint probability, and the ticket's combined price. */
export function ticketMath(reads) {
  const priced = reads.filter((r) => Number.isFinite(r.pFair) && Number.isFinite(r.market?.decimal ?? r.pillars?.market?.decimal));
  const usable = reads.filter((r) => Number.isFinite(r.pFair) && Number.isFinite(r.pillars?.market?.decimal));
  const legs = usable.length ? usable : priced;
  if (!legs.length) return { jointProb: null, combinedDecimal: null, combinedAmerican: null, ev: null, kelly: null };
  const jointProb = legs.reduce((p, r) => p * r.pFair, 1);
  const combinedDecimal = legs.reduce((d, r) => d * r.pillars.market.decimal, 1);
  return {
    jointProb,
    combinedDecimal,
    combinedAmerican: combinedDecimal >= 2
      ? Math.round((combinedDecimal - 1) * 100)
      : Math.round(-100 / (combinedDecimal - 1)),
    ev: expectedValue(jointProb, combinedDecimal),
    kelly: fractionalKelly(jointProb, combinedDecimal),
    legCount: legs.length,
  };
}

/**
 * The legs ranked against each other, best first, whatever they graded.
 *
 * A verdict-filtered list goes empty exactly when it is most needed: a slip
 * taken entirely at one book's posted prices has no leg that beats the
 * de-vigged consensus, so `solidLegs` and `straights` are both empty and the
 * tool answers a thirteen-leg ticket with nothing but "fade". The legs are
 * not equal, though — the pillars separate them by twenty-odd points — and
 * naming the strongest is the difference between a verdict and advice.
 *
 * This is an ORDERING, not an endorsement, and every caller that renders it
 * has to say so: the top leg of a bad ticket is still a bad bet.
 */
export function rankedLegs(reads, limit = 3) {
  return reads
    .filter((r) => r.verdict !== NO_READ && Number.isFinite(r.tps))
    .sort((a, b) => b.tps - a.tps)
    .slice(0, limit);
}

/**
 * An anchor is the leg you build a ticket AROUND: likely enough to land that
 * it is not what breaks the ticket, and not priced badly enough to be the
 * reason the ticket is bad.
 *
 * Deliberately two conditions rather than one. Probability alone would
 * nominate every heavy chalk price on the board, including the -450 that is
 * paying you nothing for the risk it still carries; grade alone would
 * nominate value bets that land 45% of the time, which is the opposite of
 * what an anchor is for. A leg has to clear both to carry a parlay.
 */
export const ANCHOR_MIN_PROB = 0.68;

export function anchorLegs(reads, limit = 3) {
  return reads
    .filter((r) => r.verdict !== NO_READ && r.verdict !== STRONG_FADE)
    .filter((r) => Number.isFinite(r.pFair) && r.pFair >= ANCHOR_MIN_PROB)
    .sort((a, b) => b.pFair - a.pFair)
    .slice(0, limit);
}

/**
 * The shortlist a sub-ticket is built from: best leg first, at most one per
 * game.
 *
 * One-per-game is not a preference. Every correlation effect this engine
 * knows about lives inside a single game, and ticketMath multiplies as
 * though the legs were independent, so two legs off one match make the
 * quoted joint probability wrong in a direction the number itself cannot
 * show. Dropping the weaker of the pair keeps the arithmetic honest.
 */
export function subTicketPool(reads) {
  const seen = new Set();
  const pool = [];
  for (const r of rankedLegs(reads, Infinity)) {
    const id = r.candidate?.eventId;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    pool.push(r);
  }
  return pool;
}

/**
 * Every sub-ticket worth considering out of the legs posted, from two legs
 * up, each with its real price and expectation.
 *
 * A ladder rather than a single recommendation, because the choice it
 * presents is the actual one: each extra leg multiplies the payout and
 * multiplies the bleed, and which trade a bettor wants is not something this
 * engine can decide for them. What it CAN do is price every rung, which is
 * the part that is otherwise invisible — the reason a ten-leg slip is a
 * worse bet than the same handicapping in three legs is not that the picks
 * got worse, it is that ten prices' worth of hold compounds.
 *
 * Note what this deliberately does NOT do: it never claims a rung is a good
 * bet. If every leg is negative expectation then every combination of them
 * is too, and no cut of a bad slip fixes it — it only bleeds less.
 */
export function subTicketLadder(reads, { max = 4 } = {}) {
  const pool = subTicketPool(reads);
  const rungs = [];
  for (let n = 2; n <= Math.min(max, pool.length); n++) {
    const legs = pool.slice(0, n);
    const math = ticketMath(legs);
    if (!Number.isFinite(math.jointProb)) continue;
    rungs.push({ legs, size: n, ...math });
  }
  return rungs;
}

/**
 * Keep / drop, as a straight answer.
 *
 * How many legs to keep is decided by the LEGS, not by comparing tickets.
 * Comparing tickets sounds principled and is vacuous: every cut of a ten-leg
 * slip beats the ten-leg, so "the largest cut that improves on what was
 * posted" always returns the cap and the recommendation stops depending on
 * the legs at all. A slip with two decent legs and eight bad ones would get
 * the same four-leg answer as a slip of four good ones.
 *
 * So the bar is per-leg: keep the legs that reach the pass tier on their own
 * merits, capped at four, and never fewer than the two it takes to be a
 * parlay at all. That makes the size of the answer carry information — two
 * legs back means only two were worth keeping.
 */
export const SUB_TICKET_MAX = 4;

export function suggestSubTicket(reads, { max = SUB_TICKET_MAX } = {}) {
  const ladder = subTicketLadder(reads, { max });
  if (!ladder.length) return null;
  const posted = ticketMath(reads);
  const pool = subTicketPool(reads);

  const worthKeeping = pool.filter((r) => r.tps >= VERDICT_THRESHOLDS.LEAN_PASS.tps);
  const size = Math.min(max, Math.max(2, worthKeeping.length));
  const best = ladder.find((r) => r.size === size) ?? ladder[ladder.length - 1];
  const keptIds = new Set(best.legs);
  return {
    ...best,
    ladder,
    posted,
    keep: best.legs,
    drop: reads.filter((r) => r.verdict !== NO_READ && !keptIds.has(r)),
    // How much of the posted ticket's expected loss the cut gives back.
    evGain: Number.isFinite(posted.ev) && Number.isFinite(best.ev) ? best.ev - posted.ev : null,
  };
}

/**
 * Why a ticket produced no takes, when the answer is the prices rather than
 * the picks.
 *
 * Worth saying out loud because the two causes look identical in the output
 * and call for opposite responses: picks the model dislikes are fixed by
 * picking differently, whereas prices that merely carry the standard hold
 * are fixed by shopping — or not at all, if the user is happy to pay it.
 */
export function noTakeReason(reads) {
  const graded = reads.filter((r) => r.verdict !== NO_READ);
  if (!graded.length || graded.some((r) => isTakeSide(r.verdict))) return null;
  const priced = graded.filter((r) => Number.isFinite(r.pillars?.market?.ev));
  if (!priced.length) return null;
  const atMarket = priced.filter((r) => (r.pillars.market.evVsMarket ?? 0) > -0.01);
  if (atMarket.length < priced.length / 2) return null;
  return `No leg here grades as a take, and the reason is the prices rather than the picks: `
    + `${atMarket.length} of ${priced.length} are at or near the best number on the board, which still means paying `
    + `the book's hold. This tool only calls TAKE when a price beats the de-vigged consensus — that is a line-shopping `
    + `result, not a handicapping one, so a stronger opinion on these matches would not change it.`;
}

/**
 * Grade a ticket as ONE parlay.
 *
 * A parlay's verdict is not an average — it needs every leg, so one bad leg
 * is fatal to the ticket even when the others are excellent. That is exactly
 * why the return still carries the per-leg reads and a `solidLegs` list: the
 * ticket can be a FADE while three of its five legs are worth betting
 * straight, and saying only "fade" would throw that away.
 */
export function evaluateParlay(reads) {
  const graded = reads.filter((r) => r.verdict !== NO_READ);
  const findings = correlationFindings(reads);
  const math = ticketMath(reads);

  const badLegs = graded.filter((r) => isFadeSide(r.verdict));
  const marginalLegs = graded.filter((r) => r.verdict === LEAN_PASS);
  const solidLegs = graded.filter((r) => isTakeSide(r.verdict));
  const conflicts = findings.filter((f) => f.kind === CORRELATION_CONFLICT);
  const cannibal = findings.filter((f) => f.kind === CORRELATION_CANNIBAL);

  let verdict;
  if (!graded.length) verdict = NO_READ;
  else if (conflicts.length) verdict = STRONG_FADE;
  else if (badLegs.length) verdict = badLegs.some((r) => r.verdict === STRONG_FADE) ? STRONG_FADE : FADE;
  else if (cannibal.length) verdict = FADE;
  else if (Number.isFinite(math.ev) && math.ev < 0) verdict = FADE;
  else if (marginalLegs.length) verdict = LEAN_PASS;
  else {
    // Every leg is a take. The ticket is still only as strong as its weakest
    // leg, and each extra leg multiplies the ways it can break.
    const weakest = graded.reduce((a, b) => (a.tps <= b.tps ? a : b));
    verdict = classify(weakest.tps, math.ev, {});
  }

  return {
    mode: 'parlay',
    verdict,
    confidence: graded.length ? Math.min(...graded.map((r) => r.confidence ?? 10)) : null,
    reads,
    findings,
    ...math,
    badLegs,
    marginalLegs,
    solidLegs,
    bestLegs: rankedLegs(graded),
    anchors: anchorLegs(graded),
    // The answer to "if this ten-leg is a fade, what SHOULD I play out of
    // it" — which is a different question from "is this ticket good", and
    // the one a bettor holding a built slip is actually asking.
    suggestion: suggestSubTicket(reads),
    noTakeReason: noTakeReason(reads),
  };
}

/**
 * Grade a slate: each leg on its own, plus what to do with them.
 *
 * The recommendation splits three ways rather than two. Legs worth betting
 * straight are the takes. Legs worth PARLAYING are the takes that are also
 * mutually uncorrelated — a synergy pair is a better parlay than two
 * unrelated legs but the book prices it as though it weren't, and a
 * cannibalizing pair is worse, so pairs from the same game are kept out of
 * the suggested ticket and named instead.
 */
export function evaluateSlate(reads) {
  const graded = reads.filter((r) => r.verdict !== NO_READ);
  const findings = correlationFindings(reads);

  const straights = graded.filter((r) => isTakeSide(r.verdict))
    .sort((a, b) => b.tps - a.tps);
  const avoid = graded.filter((r) => isFadeSide(r.verdict)).sort((a, b) => a.tps - b.tps);
  const marginal = graded.filter((r) => r.verdict === LEAN_PASS);

  // One leg per game for the suggested ticket, best first — every
  // correlation effect in correlationFindings lives inside a single game,
  // so one-per-game is what makes the independent product honest.
  const seenEvents = new Set();
  const parlayable = [];
  for (const r of straights) {
    const id = r.candidate?.eventId;
    if (id && seenEvents.has(id)) continue;
    if (id) seenEvents.add(id);
    parlayable.push(r);
  }

  const suggestedTicket = parlayable.length >= 2 ? ticketMath(parlayable.slice(0, 4)) : null;

  return {
    mode: 'slate',
    reads,
    findings,
    straights,
    marginal,
    avoid,
    parlayable,
    suggestedTicket,
    bestLegs: rankedLegs(graded),
    noTakeReason: noTakeReason(reads),
    // A slate has no single verdict, but the headline still has to say
    // something true: the best available action across the board.
    verdict: straights.length
      ? (straights[0].verdict === STRONG_TAKE ? STRONG_TAKE : TAKE)
      : (graded.length ? (avoid.length && !marginal.length ? FADE : LEAN_PASS) : NO_READ),
    confidence: straights.length ? straights[0].confidence : (graded.length ? Math.max(...graded.map((r) => r.confidence ?? 1)) : null),
  };
}
