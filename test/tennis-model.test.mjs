import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rng, serveRates, matchServeProbs, simulate, winShare, fitToTarget, distributions, shareOver, shareUnder, aceCounts, devig, impliedOf, highestLineAt } from '../worker/src/tennis-model.js';

test('rng is seeded and uniform enough', () => {
  const r1 = rng(3); const r2 = rng(3);
  assert.equal(r1(), r2());
  const xs = Array.from({ length: 5000 }, () => r1());
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean > 0.47 && mean < 0.53, `mean ${mean}`);
});

test('serveRates reads a serve-point share, the first-serve share, the return share and the ace rate; a thin sample is null', () => {
  const agg = { svpt: 1000, firstIn: 620, firstWon: 460, secondWon: 200, aces: 90, oppSvpt: 1000, oppFirstWon: 420, oppSecondWon: 190 };
  const r = serveRates(agg);
  assert.deepEqual([r.serve, r.firstIn, r.return, r.ace], [0.66, 0.62, 0.39, 0.09]);
  assert.equal(serveRates({ ...agg, svpt: 100 }), null);
});

test('matchServeProbs moves a serve by the opponent\'s return against the tour average', () => {
  const a = { serve: 0.66, return: 0.38 }; const b = { serve: 0.60, return: 0.40 };
  const { pA, pB } = matchServeProbs(a, b, 'atp');
  assert.ok(Math.abs(pA - (0.66 - (0.40 - 0.36))) < 1e-9, `pA ${pA}`);
  assert.ok(Math.abs(pB - (0.60 - (0.38 - 0.36))) < 1e-9, `pB ${pB}`);
});

test('a simulated match: even servers split near 50-50; a stronger server wins most, in straight sets more often; the games land where tennis lands them', () => {
  const even = simulate(0.63, 0.63, { n: 2000, seed: 1 });
  const share = winShare(even);
  assert.ok(share > 0.46 && share < 0.54, `even share ${share}`);
  const d = distributions(even);
  assert.ok(d.meanGames > 20 && d.meanGames < 27, `mean games ${d.meanGames}`);
  assert.ok(d.set1.every((g) => g >= 6 && g <= 13));
  const strong = distributions(simulate(0.70, 0.58, { n: 2000, seed: 2 }));
  assert.ok(strong.pA > 0.85, `strong ${strong.pA}`);
  assert.ok(strong.straightSets > d.straightSets);
  assert.ok(strong.meanGames < d.meanGames, 'a one-sided match is shorter');
  assert.ok(strong.bWinsASet < 0.35 && strong.aWinsASet > 0.97);
});

test('fitToTarget moves the pair until the simulated winner matches the market', () => {
  const fit = fitToTarget(0.63, 0.63, 0.72, { n: 1200, seed: 5 });
  assert.ok(Math.abs(fit.share - 0.72) < 0.03, `share ${fit.share}`);
  assert.ok(fit.pA > fit.pB);
  assert.ok(Math.abs((fit.pA + fit.pB) / 2 - 0.63) < 1e-9, 'moved together: the sum is kept');
});

test('shares over and under a line, aces from service points, de-vigged prices and the highest line a count clears', () => {
  assert.equal(shareOver([20, 21, 22, 23], 21.5), 0.5);
  assert.equal(shareUnder([20, 21, 22, 23], 21.5), 0.5);
  const aces = aceCounts([80, 80, 80, 80, 80], 0.10, { seed: 2, tour: 'atp', samplePoints: 3000 });
  assert.equal(aces.length, 5); assert.ok(aces.every((k) => k >= 0 && k <= 80));
  const many = aceCounts(Array(500).fill(80), 0.10, { seed: 3, tour: 'atp', samplePoints: 3000 });
  const mean = many.reduce((a, b) => a + b, 0) / many.length;
  assert.ok(mean > 6.5 && mean < 9.5, `ace mean ${mean}`);
  assert.ok(Math.abs(impliedOf(-150) - 0.6) < 1e-9); assert.ok(Math.abs(impliedOf(150) - 0.4) < 1e-9);
  const dv = devig(-150, 120); assert.ok(Math.abs(dv.a + dv.b - 1) < 1e-9 && dv.a > dv.b);
  assert.equal(highestLineAt([8, 9, 10, 8, 9, 12, 7, 9, 10, 8], 0.8), 7.5);
  assert.equal(highestLineAt([0, 0, 1], 0.8), null);
});
