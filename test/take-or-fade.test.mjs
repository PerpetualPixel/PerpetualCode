import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  devigMultiplicative,
  devigPower,
  fairProbability,
  expectedValue,
  fractionalKelly,
  juiceCheck,
  compositeScore,
  classify,
  evaluateLeg,
  evaluateParlay,
  evaluateSlate,
  correlationFindings,
  rankedLegs,
  noTakeReason,
  anchorLegs,
  subTicketPool,
  subTicketLadder,
  suggestSubTicket,
  ANCHOR_MIN_PROB,
  isTakeSide,
  keyNumberAnalysis,
  evaluatorFor,
  ticketMath,
  PILLAR_WEIGHTS,
  MERIT_PILLARS,
  MODIFIER_PILLARS,
  MODIFIER_PILLAR_CEILING,
  JUICE_THRESHOLD_AMERICAN,
  STRONG_TAKE,
  TAKE,
  LEAN_PASS,
  FADE,
  STRONG_FADE,
  NO_READ,
} from '../docs/take-or-fade.js';
import { RULES, KELLY, americanToDecimal, impliedProb, kellyFraction } from '../docs/engine.js';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

/* ---------------------------------------------------------------- */
/* De-vigging                                                        */
/* ---------------------------------------------------------------- */

test('devigMultiplicative: strips the overround and the result sums to exactly 1', () => {
  // -110 both sides: 0.5238 each, overround 1.0476.
  const implied = [impliedProb(-110), impliedProb(-110)];
  const fair = devigMultiplicative(implied);
  assert.ok(close(fair[0] + fair[1], 1));
  assert.ok(close(fair[0], 0.5), 'a symmetric market de-vigs to a coin flip');
});

test('devigMultiplicative: preserves the RATIO between the two sides', () => {
  const implied = [impliedProb(-200), impliedProb(160)];
  const fair = devigMultiplicative(implied);
  assert.ok(close(fair[0] / fair[1], implied[0] / implied[1], 1e-12),
    'that ratio preservation is the definition of the multiplicative method');
});

test('devigPower: also sums to 1, and agrees with multiplicative on a symmetric market', () => {
  const implied = [impliedProb(-110), impliedProb(-110)];
  const fair = devigPower(implied);
  assert.ok(close(fair[0] + fair[1], 1, 1e-9));
  assert.ok(close(fair[0], 0.5, 1e-9), 'with nothing lopsided the two methods must not disagree');
});

test('devigPower: assigns the longshot a LOWER fair probability than multiplicative', () => {
  // The whole reason both exist. Books load more vig onto the longshot, so
  // the proportional method overstates it; the power method corrects that.
  const implied = [impliedProb(-400), impliedProb(300)];
  const mult = devigMultiplicative(implied);
  const power = devigPower(implied);
  assert.ok(power[1] < mult[1], `power ${power[1]} should be below multiplicative ${mult[1]}`);
  assert.ok(power[0] > mult[0], 'and the favourite correspondingly higher');
  assert.ok(close(power[0] + power[1], 1, 1e-9));
});

test('devigPower: solves k such that the exponentiated probabilities sum to 1', () => {
  const implied = [impliedProb(-250), impliedProb(200)];
  const fair = devigPower(implied);
  // Recover k from the first outcome and confirm it reproduces the second.
  const k = Math.log(fair[0]) / Math.log(implied[0]);
  assert.ok(close(implied[0] ** k + implied[1] ** k, 1, 1e-6), `k=${k} did not solve the constraint`);
});

test('fairProbability: returns null for a one-sided quote rather than inventing a fair price', () => {
  assert.equal(fairProbability([-110]), null);
  assert.equal(fairProbability(null), null);
  assert.equal(fairProbability([-110, NaN]), null);
});

test('fairProbability: honours the method argument', () => {
  const pair = [-400, 300];
  assert.notEqual(fairProbability(pair, { method: 'power' }), fairProbability(pair, { method: 'multiplicative' }));
});

/* ---------------------------------------------------------------- */
/* EV and Kelly                                                      */
/* ---------------------------------------------------------------- */

test('expectedValue: p x decimal - 1', () => {
  assert.ok(close(expectedValue(0.55, 2.0), 0.10));
  assert.ok(close(expectedValue(0.5, 2.0), 0));
  assert.ok(close(expectedValue(0.45, 2.0), -0.10));
});

test('expectedValue: null for an unusable price rather than NaN', () => {
  assert.equal(expectedValue(0.5, 1), null);
  assert.equal(expectedValue(NaN, 2), null);
});

test('fractionalKelly: is exactly a quarter of full Kelly', () => {
  const p = 0.6;
  const d = 2.0;
  assert.ok(close(fractionalKelly(p, d), kellyFraction(p, d) * KELLY.FRACTION));
  // (b*p - q)/b with b=1, p=0.6, q=0.4 => 0.2 full, 0.05 quarter.
  assert.ok(close(fractionalKelly(p, d), 0.05));
});

test('fractionalKelly: never exceeds the single-bet cap, however large the edge', () => {
  assert.ok(fractionalKelly(0.99, 5.0) <= KELLY.MAX_STAKE);
});

test('fractionalKelly: a negative edge stakes nothing, never a negative amount', () => {
  assert.equal(fractionalKelly(0.4, 2.0), 0);
});

test('fractionalKelly and the app\'s own stake sizing cannot drift apart', () => {
  // Delegating to engine.js's kellyFraction rather than restating the
  // formula is what guarantees this; the test pins it.
  assert.ok(close(fractionalKelly(0.62, 1.9), Math.min(kellyFraction(0.62, 1.9) * KELLY.FRACTION, KELLY.MAX_STAKE)));
});

/* ---------------------------------------------------------------- */
/* Juice                                                             */
/* ---------------------------------------------------------------- */

test('juiceCheck: never flags a price at or better than the threshold', () => {
  for (const american of [JUICE_THRESHOLD_AMERICAN, -110, 100, 250]) {
    assert.equal(juiceCheck(american, 0).flagged, false, `flagged at ${american}`);
  }
});

test('juiceCheck: heavier juice demands proportionally more Kelly', () => {
  const at150 = juiceCheck(-150, 0);
  const at300 = juiceCheck(-300, 0);
  assert.ok(at300.required > at150.required, 'a heavier price must require a bigger edge');
  // b(-125) = 0.8, b(-300) = 0.3333 -> ratio 2.4
  assert.ok(close(at300.ratio, 0.8 / (americanToDecimal(-300) - 1), 1e-9));
  assert.ok(close(at300.required, RULES.MIN_KELLY_FRACTION * at300.ratio, 1e-12));
});

test('juiceCheck: a heavy price with a genuinely big edge is NOT flagged', () => {
  const check = juiceCheck(-300, 0.05);
  assert.equal(check.flagged, false, 'proportional edge is exactly what makes heavy juice payable');
});

test('juiceCheck: a heavy price with a thin edge IS flagged', () => {
  assert.equal(juiceCheck(-300, RULES.MIN_KELLY_FRACTION).flagged, true);
});

/* ---------------------------------------------------------------- */
/* Composite scoring                                                 */
/* ---------------------------------------------------------------- */

const p = (score) => ({ score, signals: [], unavailable: [] });

test('compositeScore: with every pillar present, applies the spec weights exactly', () => {
  const { score, coverage } = compositeScore({
    market: p(100), matchup: p(0), distribution: p(0), context: p(0), variance: p(0),
  });
  assert.ok(close(score, 100 * PILLAR_WEIGHTS.market, 1e-9));
  assert.ok(close(coverage, 1, 1e-9));
});

test('compositeScore: the five weights sum to 1', () => {
  assert.ok(close(Object.values(PILLAR_WEIGHTS).reduce((s, w) => s + w, 0), 1, 1e-12));
});

test('compositeScore: a missing pillar is not scored as zero', () => {
  const allGood = compositeScore({
    market: p(80), matchup: p(80), distribution: p(80), context: p(80), variance: p(80),
  });
  const someMissing = compositeScore({
    market: p(80), matchup: p(null), distribution: p(null), context: p(80), variance: p(80),
  });
  assert.ok(close(allGood.score, 80, 1e-9));
  assert.ok(close(someMissing.score, 80, 1e-9),
    'redistribution means missing data does not drag the score down, it just narrows the evidence');
});

test('compositeScore: coverage reports the real fraction of designed weight that had data', () => {
  const { coverage } = compositeScore({
    market: p(80), matchup: p(null), distribution: p(null), context: p(80), variance: p(80),
  });
  assert.ok(close(coverage, PILLAR_WEIGHTS.market + PILLAR_WEIGHTS.context + PILLAR_WEIGHTS.variance, 1e-9));
});

test('compositeScore: missing MERIT weight goes to merit, not to the modifiers', () => {
  // The defect this split fixes: with matchup and distribution missing, the
  // modifiers were inheriting 45% of the model and holding a bad bet up.
  const { weights } = compositeScore({
    market: p(50), matchup: p(null), distribution: p(null), context: p(85), variance: p(85),
  });
  assert.ok(close(weights.market, MERIT_PILLARS.reduce((s, k) => s + PILLAR_WEIGHTS[k], 0), 1e-9),
    'market absorbs the whole merit share');
  assert.ok(close(weights.context, PILLAR_WEIGHTS.context, 1e-9), 'modifiers keep their designed weight');
  assert.ok(close(weights.variance, PILLAR_WEIGHTS.variance, 1e-9));
});

test('compositeScore: modifier weight crosses over only when no merit pillar survives', () => {
  const { weights } = compositeScore({
    market: p(null), matchup: p(null), distribution: p(null), context: p(60), variance: p(60),
  });
  assert.ok(close(weights.context + weights.variance, 1, 1e-9),
    'discarding the model entirely would be worse than letting the modifiers carry it');
});

test('compositeScore: nothing scored yields null, not zero', () => {
  const { score } = compositeScore({
    market: p(null), matchup: p(null), distribution: p(null), context: p(null), variance: p(null),
  });
  assert.equal(score, null, 'a zero would sort below a genuinely terrible bet');
});

/* ---------------------------------------------------------------- */
/* Classification                                                    */
/* ---------------------------------------------------------------- */

test('classify: negative expected value is never a take, at any composite score', () => {
  assert.ok([FADE, STRONG_FADE].includes(classify(99, -0.01)));
  assert.ok([FADE, STRONG_FADE].includes(classify(99, -0.10)));
});

test('classify: the five tiers are reachable and ordered', () => {
  assert.equal(classify(80, 0.05), STRONG_TAKE);
  assert.equal(classify(65, 0.01), TAKE);
  assert.equal(classify(55, 0.001), LEAN_PASS);
  assert.equal(classify(45, 0.01), FADE);
  assert.equal(classify(30, 0.01), STRONG_FADE);
});

test('classify: a flagged juice price cannot reach a take tier', () => {
  assert.equal(classify(90, 0.05, { juiceFlagged: true }), LEAN_PASS);
});

test('classify: an unscoreable bet is NO READ rather than the bottom tier', () => {
  assert.equal(classify(null, 0.05), NO_READ);
  assert.equal(classify(NaN, null), NO_READ);
});

test('classify: paying the hold is a fade, but not the bottom tier', () => {
  // De-vigging removes the hold, so every side of every ordinary market
  // prices out at roughly minus the hold. A bottom tier that fires there has
  // nothing left to say about a bet that is genuinely bad.
  assert.equal(classify(55, -0.035, { evVsMarket: 0 }), FADE);
  assert.equal(classify(55, -0.045, { evVsMarket: 0 }), FADE);
});

test('classify: the bottom tier is for a price materially worse than the board offers', () => {
  assert.equal(classify(55, -0.08, { evVsMarket: -0.045 }), STRONG_FADE);
});

test('classify: an expectation the hold cannot explain is the bottom tier even at the best price', () => {
  // Holding the best number on the board and STILL being 12% under the
  // de-vigged consensus is not the vig, it is the consensus disagreeing with
  // the price. Relaxing the bottom tier to make room for ordinary bets must
  // not lose this case.
  assert.equal(classify(55, -0.12, { evVsMarket: 0 }), STRONG_FADE);
  assert.equal(classify(55, -0.05, { evVsMarket: 0 }), FADE, 'but a plausible hold is not');
});

test('classify: without a matched board it still falls back to absolute EV', () => {
  // The relative reading needs a board to be relative to. Absent one, the
  // stricter absolute gate is the honest default rather than a free pass.
  assert.equal(classify(55, -0.08), STRONG_FADE);
});

/* ---------------------------------------------------------------- */
/* The 13/13 STRONG FADE defect                                      */
/* ---------------------------------------------------------------- */

const implied = (a) => (a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100));

/** Both sides of one ordinary two-sided market, de-vigged off its own prices. */
function twoSided(favAmerican, dogAmerican, extra = {}) {
  const sum = implied(favAmerican) + implied(dogAmerican);
  const side = (american, fair) => cand({
    sportKey: 'tennis_atp', american, decimal: americanToDecimal(american),
    consensusProb: fair, disagreement: 0.012, bookCount: 8, shopGain: 0, ...extra,
  });
  return {
    fav: side(favAmerican, implied(favAmerican) / sum),
    dog: side(dogAmerican, implied(dogAmerican) / sum),
    hold: sum - 1,
  };
}

test('both sides of an ordinary market are not both the worst grade available', () => {
  // The defect, exactly as reported: a 13-leg tennis slip came back 13/13
  // STRONG FADE. The cause was not the picks — backing the -175 favourite
  // and backing the +150 dog in the SAME match both graded STRONG FADE,
  // because the verdict gate sat inside the vig the de-vig had just removed.
  // A scale on which no bet available at any book can score above the floor
  // is not grading anything.
  const m = twoSided(-175, 150);
  const fav = evaluateLeg({ selection: 'Fav', american: -175 }, { candidate: m.fav });
  const dog = evaluateLeg({ selection: 'Dog', american: 150 }, { candidate: m.dog });
  assert.ok(m.hold > 0.03 && m.hold < 0.05, 'a completely ordinary hold');
  assert.notEqual(fav.verdict, STRONG_FADE, 'the favourite at the posted price');
  assert.notEqual(dog.verdict, STRONG_FADE, 'the dog at the posted price');
  assert.equal(fav.verdict, FADE, 'still a fade — paying the hold is still negative expectation');
  assert.equal(dog.verdict, FADE);
});

test('a whole slip taken at posted prices still separates its legs', () => {
  // The second half of the defect: with the EV term clamped at the floor for
  // every posted price, TPS collapsed into a three-point band and the legs
  // could not be ranked against each other at all.
  const m = twoSided(-175, 150);
  const spread = [-0.5, 0, 0.5].map((formSignal) =>
    evaluateLeg({ selection: 'P', american: -175 },
      { candidate: { ...m.fav, formSignal } }).tps);
  assert.ok(Math.max(...spread) - Math.min(...spread) > 15,
    `legs must be separable to be rankable, got a ${(Math.max(...spread) - Math.min(...spread)).toFixed(1)}-point spread`);
});

test('taking a worse number than the board offers is what earns the bottom tier', () => {
  const m = twoSided(-175, 150);
  const atBest = evaluateLeg({ selection: 'P', american: -175 }, { candidate: m.fav });
  const worse = evaluateLeg({ selection: 'P', american: -220 }, { candidate: m.fav });
  assert.equal(atBest.verdict, FADE);
  assert.equal(worse.verdict, STRONG_FADE, 'same pick, worse price, worse grade');
  assert.ok(worse.pillars.market.evVsMarket < atBest.pillars.market.evVsMarket);
  assert.equal(atBest.pillars.market.evVsMarket, 0, 'holding the best number is the zero point');
});

test('beating the de-vigged consensus is still what earns a take', () => {
  // The recalibration must not have made the tool generous: a take still
  // requires a price the consensus says is wrong.
  const m = twoSided(-175, 150);
  const read = evaluateLeg({ selection: 'P', american: -145 }, { candidate: { ...m.fav, american: -145, decimal: americanToDecimal(-145) } });
  assert.ok(read.pillars.market.ev > 0);
  assert.ok([TAKE, STRONG_TAKE].includes(read.verdict));
});

test('rankedLegs orders every graded leg, including a ticket with no takes', () => {
  const m = twoSided(-175, 150);
  const reads = [0.5, -0.5, 0.1].map((formSignal, i) =>
    evaluateLeg({ selection: `Leg ${i}`, american: -175 }, { candidate: { ...m.fav, formSignal } }));
  const ranked = rankedLegs(reads);
  assert.equal(ranked.length, 3);
  assert.ok(reads.every((r) => r.verdict === FADE), 'precondition: nothing clears the bar');
  assert.equal(ranked[0].leg.selection, 'Leg 0', 'best form first');
  assert.equal(ranked[2].leg.selection, 'Leg 1', 'worst form last');
  assert.ok(ranked[0].tps > ranked[1].tps && ranked[1].tps > ranked[2].tps);
});

test('rankedLegs leaves out legs there was nothing to grade', () => {
  const m = twoSided(-175, 150);
  const graded = evaluateLeg({ selection: 'Real', american: -175 }, { candidate: m.fav });
  const unmatched = evaluateLeg({ selection: 'Unmatched', american: -175 }, { candidate: null });
  assert.equal(unmatched.verdict, NO_READ, 'precondition');
  assert.deepEqual(rankedLegs([graded, unmatched]).map((r) => r.leg.selection), ['Real']);
});

test('a parlay with no takes still names its strongest legs', () => {
  const m = twoSided(-175, 150);
  const reads = [0.5, -0.5, 0.1].map((formSignal, i) =>
    evaluateLeg({ selection: `Leg ${i}`, american: -175 },
      { candidate: { ...m.fav, eventId: `g${i}`, formSignal } }));
  const result = evaluateParlay(reads);
  assert.equal(result.solidLegs.length, 0, 'precondition: the verdict-filtered list is empty');
  assert.ok(result.bestLegs.length > 1, 'so the ranking is the only actionable output left');
  assert.equal(result.bestLegs[0].leg.selection, 'Leg 0');
});

test('noTakeReason blames the prices only when the prices are the cause', () => {
  const m = twoSided(-175, 150);
  const atMarket = [0, 1, 2].map((i) =>
    evaluateLeg({ selection: `Leg ${i}`, american: -175 }, { candidate: { ...m.fav, eventId: `g${i}` } }));
  const reason = noTakeReason(atMarket);
  assert.ok(reason, 'every leg holds the best number, so the hold is the whole story');
  assert.match(reason, /line-shopping/i, 'and it names the response that would actually change the answer');

  const badPrices = [0, 1, 2].map((i) =>
    evaluateLeg({ selection: `Leg ${i}`, american: -260 }, { candidate: { ...m.fav, eventId: `g${i}` } }));
  assert.equal(noTakeReason(badPrices), null, 'these legs are bad on price, which the verdicts already say');
});

/* ---------------------------------------------------------------- */
/* Anchors, and building a ticket out of the legs posted             */
/* ---------------------------------------------------------------- */

/** n legs, each its own game, at the posted price of a two-sided market. */
function slip(specs) {
  return specs.map((spec, i) => {
    const { fav = -175, dog = 150, ...rest } = spec;
    const sum = implied(fav) + implied(dog);
    return evaluateLeg({ selection: spec.name ?? `Leg ${i}`, american: spec.took ?? fav }, {
      candidate: cand({
        sportKey: 'tennis_atp', eventId: `g${i}`, american: fav, decimal: americanToDecimal(fav),
        consensusProb: implied(fav) / sum, disagreement: 0.012, bookCount: 8, shopGain: 0, ...rest,
      }),
    });
  });
}

test('an anchor has to be likely to land AND not badly priced', () => {
  const [heavyChalk, coinFlip] = slip([
    { name: 'Heavy chalk', fav: -450, dog: 340 },
    { name: 'Coin flip', fav: -110, dog: -110 },
  ]);
  assert.ok(heavyChalk.pFair > ANCHOR_MIN_PROB, 'precondition: chalk is likely');
  assert.ok(coinFlip.pFair < ANCHOR_MIN_PROB, 'precondition: the coin flip is not');
  const anchors = anchorLegs([heavyChalk, coinFlip]);
  assert.deepEqual(anchors.map((r) => r.leg.selection), ['Heavy chalk']);
});

test('a likely leg taken at a terrible number is not an anchor', () => {
  // Probability alone would nominate this. The whole point of an anchor is
  // that it is not the reason the ticket is bad, and this one would be.
  const [awful] = slip([{ name: 'Chalk at a bad price', fav: -450, dog: 340, took: -900 }]);
  assert.ok(awful.pFair > ANCHOR_MIN_PROB, 'precondition: still likely to land');
  assert.equal(awful.verdict, STRONG_FADE, 'precondition: but priced far off the board');
  assert.deepEqual(anchorLegs([awful]), []);
});

test('the sub-ticket pool never takes two legs off one game', () => {
  const reads = slip([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  // Force B onto A's game, as a same-match parlay would be.
  reads[1].candidate = { ...reads[1].candidate, eventId: 'g0' };
  const pool = subTicketPool(reads);
  assert.equal(pool.length, 2, 'the weaker of the same-game pair is dropped');
  assert.deepEqual([...new Set(pool.map((r) => r.candidate.eventId))].sort(), ['g0', 'g2']);
});

test('the ladder prices every cut, and each extra leg costs expectation', () => {
  const reads = slip([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }]);
  const ladder = subTicketLadder(reads);
  assert.deepEqual(ladder.map((r) => r.size), [2, 3, 4]);
  for (const rung of ladder) {
    assert.ok(Number.isFinite(rung.combinedAmerican) && Number.isFinite(rung.jointProb));
  }
  // The whole reason a ten-leg is worse than the same handicapping in three.
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(ladder[i].ev < ladder[i - 1].ev, `${ladder[i].size} legs must bleed more than ${ladder[i - 1].size}`);
    assert.ok(ladder[i].jointProb < ladder[i - 1].jointProb);
  }
});

test('the suggestion improves on the posted ticket and says what to drop', () => {
  const reads = slip(Array.from({ length: 10 }, (_, i) => ({ name: `Leg ${i}` })));
  const s = suggestSubTicket(reads);
  assert.ok(s, 'a ten-leg slip must produce a recommendation');
  assert.ok(s.ev > s.posted.ev, 'the cut has to be better than what was posted, or it is not advice');
  assert.ok(s.evGain > 0);
  assert.equal(s.keep.length + s.drop.length, 10, 'every posted leg is either kept or dropped');
  assert.equal(s.keep.length, 4, 'capped at four — past that the payout is buying pure variance');
  assert.ok(s.drop.every((r) => !s.keep.includes(r)));
});

test('how many legs come back depends on how many are worth keeping', () => {
  // The recommendation has to be a function of the legs. A rule phrased as
  // "the biggest cut that beats what was posted" is always the cap, because
  // every cut beats a ten-leg — so a slip with two decent legs and eight bad
  // ones would get the same four-leg answer as a slip of four good ones.
  const mostlyBad = suggestSubTicket(slip([
    { name: 'Good A', formSignal: 0.6 }, { name: 'Good B', formSignal: 0.5 },
    { name: 'Bad C', formSignal: -0.9 }, { name: 'Bad D', formSignal: -0.9 },
    { name: 'Bad E', formSignal: -0.9 }, { name: 'Bad F', formSignal: -0.9 },
  ]));
  const mostlyGood = suggestSubTicket(slip([
    { name: 'Good A', formSignal: 0.6 }, { name: 'Good B', formSignal: 0.5 },
    { name: 'Good C', formSignal: 0.5 }, { name: 'Good D', formSignal: 0.45 },
    { name: 'Bad E', formSignal: -0.9 }, { name: 'Bad F', formSignal: -0.9 },
  ]));
  assert.equal(mostlyBad.keep.length, 2, 'only two legs clear the bar, so only two come back');
  assert.equal(mostlyGood.keep.length, 4);
  assert.ok(mostlyBad.keep.every((r) => /Good/.test(r.leg.selection)));
});

test('a slip where nothing clears the bar still returns the two least bad', () => {
  const s = suggestSubTicket(slip(Array.from({ length: 5 }, (_, i) => ({ name: `Leg ${i}`, formSignal: -0.9 }))));
  assert.ok(s.keep.every((r) => r.tps < 48), 'precondition: nothing reaches the pass tier');
  assert.equal(s.keep.length, 2, 'a parlay needs two, and refusing to answer helps nobody');
});

test('the suggested ticket is the best legs, not an arbitrary four', () => {
  const reads = slip([
    { name: 'Weak', formSignal: -0.6 }, { name: 'Strong', formSignal: 0.6 },
    { name: 'Middling', formSignal: 0 }, { name: 'Good', formSignal: 0.4 },
    { name: 'Bad', formSignal: -0.4 },
  ]);
  const s = suggestSubTicket(reads);
  assert.equal(s.keep[0].leg.selection, 'Strong');
  assert.ok(s.drop.some((r) => r.leg.selection === 'Weak'));
});

test('cutting a slip of negative legs never manufactures a positive ticket', () => {
  // The honest limit. If every leg is priced at the hold then every
  // combination of them is negative, and a recommendation that implied
  // otherwise would be the tool lying about arithmetic it just did.
  const reads = slip(Array.from({ length: 8 }, (_, i) => ({ name: `Leg ${i}` })));
  assert.ok(reads.every((r) => r.pillars.market.ev < 0), 'precondition');
  const s = suggestSubTicket(reads);
  assert.ok(s.ev < 0, 'the cut bleeds less, it does not turn a fade into a take');
  for (const rung of s.ladder) assert.ok(rung.ev < 0);
});

test('a two-leg slip still gets a recommendation rather than nothing', () => {
  const s = suggestSubTicket(slip([{ name: 'A' }, { name: 'B' }]));
  assert.ok(s);
  assert.equal(s.size, 2);
  assert.equal(s.drop.length, 0, 'nothing to drop when the ticket is already the shortlist');
});

test('a single-leg slip has no sub-ticket to suggest', () => {
  assert.equal(suggestSubTicket(slip([{ name: 'Only' }])), null);
});

test('evaluateParlay carries the anchors and the recommendation', () => {
  const result = evaluateParlay(slip(Array.from({ length: 6 }, (_, i) => ({ name: `Leg ${i}` }))));
  assert.ok(result.suggestion, 'the "what should I actually play" answer travels with the verdict');
  assert.ok(Array.isArray(result.anchors));
  assert.ok(result.suggestion.keep.length >= 2);
});

test('noTakeReason stays quiet when something did clear the bar', () => {
  const m = twoSided(-175, 150);
  const take = evaluateLeg({ selection: 'Good', american: -145 },
    { candidate: { ...m.fav, american: -145, decimal: americanToDecimal(-145) } });
  assert.ok(isTakeSide(take.verdict), 'precondition');
  assert.equal(noTakeReason([take]), null);
});

/* ---------------------------------------------------------------- */
/* Pillars: only-what's-real                                         */
/* ---------------------------------------------------------------- */

const cand = (o = {}) => ({
  eventId: 'g1', selection: 'X to win', marketKey: 'h2h', outcomeName: 'X',
  home: 'X', away: 'Y', sportKey: 'basketball_wnba',
  consensusProb: 0.68, american: -150, decimal: americanToDecimal(-150),
  fairAmerican: -190, book: 'DraftKings', bookCount: 9, disagreement: 0.008, shopGain: 0.02,
  commenceMs: Date.now() + 6 * 3.6e6, updatedMs: Date.now() - 6e5, ...o,
});

test('a sport with no matchup feed reports the matchup pillar as unavailable, not average', () => {
  const read = evaluateLeg({ selection: 'X to win', american: -150 }, { candidate: cand() });
  assert.equal(read.pillars.matchup.score, null);
  assert.ok(read.pillars.matchup.unavailable.length > 0, 'and it names what is missing');
  assert.ok(read.unavailable.some((u) => /play-type defence ranks/.test(u)));
});

test('the matchup pillar activates the moment a real form signal exists', () => {
  const without = evaluateLeg({ selection: 'X to win' }, { candidate: cand() });
  const with_ = evaluateLeg({ selection: 'X to win' }, { candidate: cand({ formSignal: 0.5 }) });
  assert.equal(without.pillars.matchup.score, null);
  assert.ok(Number.isFinite(with_.pillars.matchup.score));
  assert.ok(with_.coverage > without.coverage, 'and coverage rises to say so');
});

test('the distribution pillar reads a real hit-rate profile when one exists', () => {
  const read = evaluateLeg(
    { selection: 'A 24+ points', american: -118, profile: { season: 0.8, l10: 0.9, l5: 1.0, avgSeason: 26, avgL5: 27 } },
    { candidate: cand({ selection: 'A 24+ points', marketKey: 'prop' }) },
  );
  assert.ok(Number.isFinite(read.pillars.distribution.score));
  assert.ok(read.pillars.distribution.signals.some((s) => /80% of games this season/.test(s.text)));
});

test('the distribution pillar warns when a recent average is a spike rather than a trend', () => {
  const read = evaluateLeg(
    { selection: 'A 24+ points', profile: { season: 0.6, l10: 0.8, l5: 0.8, avgSeason: 20, avgL5: 30 } },
    { candidate: cand({ marketKey: 'prop' }) },
  );
  assert.ok(read.pillars.distribution.signals.some((s) => /spike/.test(s.text)));
});

test('the modifier pillars are capped so absence-of-problems cannot read as maximal evidence', () => {
  const read = evaluateLeg({ selection: 'X to win' }, { candidate: cand() });
  assert.ok(read.pillars.context.score <= MODIFIER_PILLAR_CEILING);
  assert.ok(read.pillars.variance.score <= MODIFIER_PILLAR_CEILING);
});

test('preseason and a benched segment both push the context pillar down, with a stated reason', () => {
  const preseason = evaluateLeg({ selection: 'X to win' },
    { candidate: cand({ sportKey: 'americanfootball_nfl_preseason' }) });
  const benched = evaluateLeg({ selection: 'X to win' }, { candidate: cand({ benchedSegment: true }) });
  const plain = evaluateLeg({ selection: 'X to win' }, { candidate: cand() });
  assert.ok(preseason.pillars.context.score < plain.pillars.context.score);
  assert.ok(benched.pillars.context.score < plain.pillars.context.score);
  assert.ok(benched.pillars.context.signals.some((s) => /benched/.test(s.text)));
});

/* ---------------------------------------------------------------- */
/* Key numbers — real, computable football structure                 */
/* ---------------------------------------------------------------- */

test('keyNumberAnalysis: only applies to football spreads', () => {
  assert.equal(keyNumberAnalysis(cand({ marketKey: 'h2h' })), null);
  assert.equal(keyNumberAnalysis(cand({ marketKey: 'spreads', sportKey: 'basketball_wnba', point: -3 })), null);
  assert.ok(keyNumberAnalysis(cand({ marketKey: 'spreads', sportKey: 'americanfootball_nfl', point: -3 })));
});

test('keyNumberAnalysis: sitting exactly on a key number is a push warning', () => {
  const r = keyNumberAnalysis(cand({ marketKey: 'spreads', sportKey: 'americanfootball_nfl', point: -3 }));
  assert.ok(r.signals.some((s) => /pushes far more often/.test(s.text)));
});

test('keyNumberAnalysis: laying under a key number scores above laying across it', () => {
  const under = keyNumberAnalysis(cand({ marketKey: 'spreads', sportKey: 'americanfootball_nfl', point: -2.5 }));
  const across = keyNumberAnalysis(cand({ marketKey: 'spreads', sportKey: 'americanfootball_nfl', point: -3.5 }));
  assert.ok(under.score > across.score, 'the key number on your side of the line is worth real points');
});

test('the football evaluator still names the feeds it does not have', () => {
  const r = keyNumberAnalysis(cand({ marketKey: 'spreads', sportKey: 'americanfootball_nfl', point: -3.5 }));
  assert.ok(r.unavailable.some((u) => /EPA/.test(u)));
});

test('every sport dispatches to its own evaluator', () => {
  assert.equal(evaluatorFor('tennis_atp_wimbledon').name, 'Tennis (singles)');
  assert.equal(evaluatorFor('mma_mixed_martial_arts').name, 'MMA');
  assert.equal(evaluatorFor('basketball_wnba').name, 'Basketball');
  assert.equal(evaluatorFor('baseball_mlb').name, 'Baseball');
  assert.equal(evaluatorFor('americanfootball_nfl').name, 'Football');
  assert.equal(evaluatorFor('icehockey_nhl').name, 'Hockey / Soccer');
  assert.equal(evaluatorFor('soccer_usa_mls').name, 'Hockey / Soccer');
});

test('MMA reads capper consensus, which is the evidence source it actually has', () => {
  const read = evaluateLeg({ selection: 'Fighter A' },
    { candidate: cand({ sportKey: 'mma_mixed_martial_arts', consensusSignal: 0.7 }) });
  assert.ok(Number.isFinite(read.pillars.matchup.score));
  assert.ok(read.pillars.matchup.signals.some((s) => /[Cc]apper consensus/.test(s.text)));
  assert.ok(read.pillars.matchup.unavailable.some((u) => /SLpM/.test(u)));
});

test('football reads a real epaDiff when the candidate carries one, and drops EPA/play from missing', () => {
  const withEpa = evaluateLeg({ selection: 'X to win' },
    { candidate: cand({ sportKey: 'americanfootball_nfl', epaDiff: 0.3 }) });
  assert.ok(withEpa.pillars.matchup.signals.some((s) => /EPA\/play/.test(s.text) && /\+0\.30/.test(s.text)));
  assert.ok(!withEpa.pillars.matchup.unavailable.some((u) => u === 'EPA/play'));
  assert.ok(withEpa.pillars.matchup.unavailable.some((u) => /pass rush win rate/.test(u)), 'still honestly missing');
});

test('football without an epaDiff still names EPA/play as missing, same as before', () => {
  const noEpa = evaluateLeg({ selection: 'X to win' },
    { candidate: cand({ sportKey: 'americanfootball_nfl' }) });
  assert.equal(noEpa.pillars.matchup.score, null);
  assert.ok(noEpa.pillars.matchup.unavailable.includes('EPA/play'));
});

test('football still reports formSignal alongside a real epaDiff — they are independent facts', () => {
  const read = evaluateLeg({ selection: 'X to win' },
    { candidate: cand({ sportKey: 'americanfootball_nfl', epaDiff: 0.2, formSignal: 0.5 }) });
  assert.ok(read.pillars.matchup.signals.some((s) => /recent form and injuries/i.test(s.text)));
  assert.ok(read.pillars.matchup.signals.some((s) => /EPA\/play/.test(s.text)));
});

test('tennis reports surface form, tiebreak record, and grind load as real signals when the context has them', () => {
  const tennisContext = {
    surface: 'Hard',
    subjectSurfaceForm: { matches: 6, wins: 5, winRate: 5 / 6 },
    opponentSurfaceForm: { matches: 6, wins: 2, winRate: 2 / 6 },
    subjectTiebreak: { won: 3, total: 4, rate: 0.75 },
    opponentTiebreak: { won: 1, total: 4, rate: 0.25 },
    subjectGrind: { matches: 5, avgSets: 2.0 },
    opponentGrind: { matches: 5, avgSets: 2.8 },
  };
  const read = evaluateLeg({ selection: 'X to win' },
    { candidate: cand({ sportKey: 'tennis_atp_wimbledon', formSignal: 0.4, tennisContext }) });
  assert.ok(read.pillars.matchup.signals.some((s) => /On Hard/.test(s.text)), 'surface form signal');
  assert.ok(read.pillars.matchup.signals.some((s) => /Tiebreaks recently/.test(s.text)), 'tiebreak signal');
  assert.ok(read.pillars.matchup.signals.some((s) => /grind load/.test(s.text)), 'grind load signal');
  // Tiebreak evidence exists, so it's no longer named as a gap.
  assert.ok(!read.pillars.matchup.unavailable.includes('tiebreak regression'));
  // Still honestly missing — no true speed index or serve-point data exists.
  assert.ok(read.pillars.matchup.unavailable.includes('court speed index'));
  assert.ok(read.pillars.matchup.unavailable.includes('surface hold/break dominance ratio'));
});

test('tennis with no tennisContext at all falls back to the original four missing factors', () => {
  const read = evaluateLeg({ selection: 'X to win' },
    { candidate: cand({ sportKey: 'tennis_atp_wimbledon' }) });
  assert.equal(read.pillars.matchup.score, null);
  for (const factor of ['court speed index', 'surface hold/break dominance ratio', 'tiebreak regression', 'prior-round fatigue (>2.5h)']) {
    assert.ok(read.pillars.matchup.unavailable.includes(factor), factor);
  }
});

/* ---------------------------------------------------------------- */
/* Correlation                                                       */
/* ---------------------------------------------------------------- */

const read = (selection, o = {}) => evaluateLeg({ selection, american: o.american ?? -150 }, {
  candidate: cand({ selection, ...o }),
});

test('correlationFindings: legs in different games produce no findings', () => {
  const findings = correlationFindings([read('A to win'), read('B to win', { eventId: 'g2' })]);
  assert.deepEqual(findings, []);
});

test('correlationFindings: same side of one game is synergy the book is not paying for', () => {
  const findings = correlationFindings([
    read('A to win', { outcomeName: 'A' }),
    read('A -3.5', { marketKey: 'spreads', outcomeName: 'A' }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'synergy');
});

test('correlationFindings: opposite sides of one game is a conflict', () => {
  const findings = correlationFindings([
    read('A to win', { outcomeName: 'A' }),
    read('B to win', { outcomeName: 'B' }),
  ]);
  assert.equal(findings[0].kind, 'conflict');
  assert.match(findings[0].text, /cannot both land/i);
});

test('correlationFindings: two props on one game cannibalize each other', () => {
  const a = evaluateLeg({ selection: 'P1 20+ pts', profile: { season: 0.8, l10: 0.8 } },
    { candidate: cand({ selection: 'P1 20+ pts', marketKey: 'prop' }) });
  const b = evaluateLeg({ selection: 'P2 8+ ast', profile: { season: 0.8, l10: 0.8 } },
    { candidate: cand({ selection: 'P2 8+ ast', marketKey: 'prop' }) });
  const findings = correlationFindings([a, b]);
  assert.equal(findings[0].kind, 'cannibalization');
  assert.match(findings[0].text, /same pool of possessions/i);
});

/* ---------------------------------------------------------------- */
/* Ticket maths                                                      */
/* ---------------------------------------------------------------- */

test('ticketMath: joint probability is the product, combined price the product of decimals', () => {
  const legs = [
    read('A to win', { consensusProb: 0.6, american: -150 }),
    read('B to win', { eventId: 'g2', consensusProb: 0.5, american: 100 }),
  ];
  const t = ticketMath(legs);
  assert.ok(close(t.jointProb, 0.30, 1e-9));
  assert.ok(close(t.combinedDecimal, americanToDecimal(-150) * 2, 1e-9));
  assert.equal(t.legCount, 2);
});

test('ticketMath: a ticket with nothing priced returns nulls rather than 1', () => {
  const t = ticketMath([]);
  assert.equal(t.jointProb, null);
  assert.equal(t.combinedDecimal, null);
});

/* ---------------------------------------------------------------- */
/* Parlay vs slate                                                   */
/* ---------------------------------------------------------------- */

test('evaluateParlay: a conflict is a STRONG FADE regardless of how good the legs are', () => {
  const result = evaluateParlay([
    read('A to win', { outcomeName: 'A', consensusProb: 0.8 }),
    read('B to win', { outcomeName: 'B', consensusProb: 0.8 }),
  ]);
  assert.equal(result.verdict, STRONG_FADE);
});

test('evaluateParlay: keeps the per-leg reads so good legs survive a bad ticket', () => {
  const result = evaluateParlay([
    read('A to win', { consensusProb: 0.80 }),
    read('B to win', { eventId: 'g2', consensusProb: 0.45 }),
  ]);
  assert.ok([FADE, STRONG_FADE].includes(result.verdict));
  assert.equal(result.reads.length, 2, 'the ticket verdict never replaces the leg detail');
  assert.equal(result.solidLegs.length, 1);
});

test('evaluateSlate: ranks the straights best-first', () => {
  const result = evaluateSlate([
    read('A to win', { consensusProb: 0.70 }),
    read('B to win', { eventId: 'g2', consensusProb: 0.85 }),
  ]);
  assert.ok(result.straights.length >= 2);
  assert.ok(result.straights[0].tps >= result.straights[1].tps);
});

test('evaluateSlate: the suggested ticket never contains two legs from one game', () => {
  const result = evaluateSlate([
    read('A to win', { consensusProb: 0.85 }),
    read('A -3.5', { marketKey: 'spreads', consensusProb: 0.85 }),
    read('B to win', { eventId: 'g2', consensusProb: 0.85 }),
  ]);
  const ids = result.parlayable.map((r) => r.candidate.eventId);
  assert.equal(new Set(ids).size, ids.length);
});

test('an unmatched leg is NO READ with no score, in either aggregation', () => {
  const orphan = evaluateLeg({ selection: 'nothing' }, { candidate: null });
  assert.equal(orphan.verdict, NO_READ);
  assert.equal(orphan.tps, null);
  assert.equal(evaluateParlay([orphan]).verdict, NO_READ);
  assert.equal(evaluateSlate([orphan]).verdict, NO_READ);
});
