import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clvProbPts,
  oddsBand,
  featureKeysFor,
  featureStats,
  weightFromStats,
  learnWeights,
  combinedWeightFor,
  applyLearningToCandidates,
  buildDailyReport,
  runDailyLearning,
  getLearningProfile,
  getLearningLog,
  MIN_FEATURE_N,
} from '../worker/src/daily-learning.js';

/** A graded pick record in the exact shape tracking.js's pickRecordFrom stores. */
function pick({
  won = true,
  prob = 0.55,
  sportKey = 'baseball_mlb',
  marketKey = 'h2h',
  american = -130,
  open = american,
  close = american,
  dateKey = '2026-08-07',
  stake = 20,
  payout,
  meetsStandard = true,
  status,
} = {}) {
  return {
    sportKey,
    marketKey,
    american,
    consensusProb: prob,
    dateKey,
    suggested_stake: stake,
    status: status ?? (won ? 'won' : 'lost'),
    result: { payout: payout ?? (won ? stake * 0.8 : -stake) },
    clv: { openAmerican: open, closeAmerican: close },
    meetsStandard,
  };
}

/** n graded picks with a fixed win pattern: wins of the first `wins`, losses after. */
function bucket(n, wins, overrides = {}) {
  return Array.from({ length: n }, (_, i) => pick({ won: i < wins, ...overrides }));
}

function makeEnv(store = new Map()) {
  return {
    POTD_KV: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => void store.set(k, v),
    },
    _store: store,
  };
}

const ctx = { waitUntil() {} };

/* ---------------------------------------------------------------- */
/* CLV and feature axes                                              */
/* ---------------------------------------------------------------- */

test('clvProbPts is positive when the market moved toward the pick (we beat the close)', () => {
  // Took -120, closed -150: the close implies a higher win probability than
  // the price we got — we beat the close.
  const beat = clvProbPts(pick({ open: -120, close: -150 }));
  assert.ok(beat > 0, `expected positive, got ${beat}`);
  // Took -150, closed -120: the market walked our edge back.
  const lost = clvProbPts(pick({ open: -150, close: -120 }));
  assert.ok(lost < 0, `expected negative, got ${lost}`);
});

test('clvProbPts returns null rather than a fake 0 when a snapshot is missing', () => {
  assert.equal(clvProbPts({ clv: { openAmerican: -120 } }), null);
  assert.equal(clvProbPts({}), null);
});

test('oddsBand buckets the four price ranges', () => {
  assert.equal(oddsBand(-250), 'heavyfav');
  assert.equal(oddsBand(-180), 'heavyfav');
  assert.equal(oddsBand(-179), 'fav');
  assert.equal(oddsBand(-120), 'fav');
  assert.equal(oddsBand(-119), 'close');
  assert.equal(oddsBand(119), 'close');
  assert.equal(oddsBand(120), 'dog');
  assert.equal(oddsBand(240), 'dog');
});

test('featureKeysFor yields a segment key and an odds-band key, with tennis normalized', () => {
  const keys = featureKeysFor(pick({ sportKey: 'tennis_atp_canadian_open', marketKey: 'h2h', american: 130 }));
  assert.deepEqual(keys, ['seg:tennis_atp|h2h', 'odds:dog']);
});

/* ---------------------------------------------------------------- */
/* Stats and weights                                                 */
/* ---------------------------------------------------------------- */

test('featureStats excludes pending and padding picks from the evidence', () => {
  const picks = [
    ...bucket(10, 5),
    pick({ status: 'pending' }),
    pick({ won: false, meetsStandard: false }), // padding pick — never claimed the sharp bar
  ];
  assert.equal(featureStats(picks).n, 10);
});

test('a feature below MIN_FEATURE_N graded picks gets no weight at all', () => {
  const stats = featureStats(bucket(MIN_FEATURE_N - 1, 0)); // 14 straight losses!
  assert.equal(weightFromStats(stats), null);
});

test('a badly underperforming feature is penalized below 1', () => {
  // 40 picks at 55% expected → ~22 expected wins; 12 actual is a deep miss.
  const w = weightFromStats(featureStats(bucket(40, 12)));
  assert.ok(w !== null && w < 1, `expected a penalty, got ${w}`);
});

test('shrinkage: the same miss rate moves the weight less on a small sample', () => {
  const small = weightFromStats(featureStats(bucket(16, 5))); // 31% win vs 55% expected
  const large = weightFromStats(featureStats(bucket(80, 25)));
  assert.ok(large !== null && large < 1);
  // Either the small sample is a no-op (null) or a visibly milder penalty.
  if (small !== null) assert.ok(small > large, `small=${small} should be milder than large=${large}`);
});

test('weights are bounded: penalty never below 0.85, boost never above 1.05', () => {
  const worst = weightFromStats(featureStats(bucket(200, 40))); // catastrophic
  assert.ok(worst >= 0.85, `penalty floor breached: ${worst}`);
  const best = weightFromStats(featureStats(bucket(200, 160, { prob: 0.55 }))); // running impossibly hot
  assert.ok(best === null || best <= 1.05, `boost cap breached: ${best}`);
});

test('a feature performing exactly as expected gets no weight (no-op dropped)', () => {
  // 40 picks at 55% expected, 22 wins — dead on expectation.
  assert.equal(weightFromStats(featureStats(bucket(40, 22))), null);
});

test('persistently negative CLV deepens a penalty even at the same win rate', () => {
  const flat = weightFromStats(featureStats(bucket(40, 16)));
  const badClv = weightFromStats(featureStats(bucket(40, 16, { open: -150, close: -120 })));
  assert.ok(badClv !== null && flat !== null && badClv < flat, `CLV should deepen: flat=${flat}, badClv=${badClv}`);
});

test('learnWeights groups evidence by feature and only emits weights with enough sample', () => {
  const picks = [
    ...bucket(40, 12, { sportKey: 'baseball_mlb', marketKey: 'totals', american: -110 }),
    ...bucket(5, 1, { sportKey: 'icehockey_nhl', marketKey: 'h2h', american: -110 }),
  ];
  const { weights } = learnWeights(picks);
  assert.ok(weights['seg:baseball_mlb|totals'] < 1);
  assert.equal(weights['seg:icehockey_nhl|h2h'], undefined); // 5 picks: no verdict
  // Both buckets share the 'close' odds band (45 graded picks, 13 wins) — it earns its own penalty.
  assert.ok(weights['odds:close'] < 1);
});

/* ---------------------------------------------------------------- */
/* Applying weights to candidates                                    */
/* ---------------------------------------------------------------- */

test('applyLearningToCandidates adjusts score, keeps rawScore, and never mutates the input', () => {
  const profile = { weights: { 'seg:baseball_mlb|h2h': 0.9 } };
  const input = [{ sportKey: 'baseball_mlb', marketKey: 'h2h', american: -130, score: 80 }];
  const out = applyLearningToCandidates(input, profile);
  assert.equal(out[0].score, 72);
  assert.equal(out[0].rawScore, 80);
  assert.equal(out[0].learnWeight, 0.9);
  assert.equal(input[0].score, 80); // untouched
});

test('a candidate matching no weighted feature passes through unchanged', () => {
  const profile = { weights: { 'seg:baseball_mlb|totals': 0.9 } };
  const c = { sportKey: 'icehockey_nhl', marketKey: 'h2h', american: 140, score: 75 };
  const out = applyLearningToCandidates([c], profile);
  assert.equal(out[0].score, 75);
  assert.equal(out[0].rawScore, undefined);
});

test('stacked penalties multiply but clamp at the combined floor', () => {
  const profile = { weights: { 'seg:baseball_mlb|h2h': 0.85, 'odds:heavyfav': 0.85 } };
  const c = { sportKey: 'baseball_mlb', marketKey: 'h2h', american: -220, score: 100 };
  // 0.85 × 0.85 = 0.7225 would breach the combined floor of 0.78.
  assert.equal(combinedWeightFor(c, profile), 0.78);
  assert.equal(applyLearningToCandidates([c], profile)[0].score, 78);
});

test('an empty or missing profile is a pure pass-through', () => {
  const input = [{ sportKey: 'baseball_mlb', marketKey: 'h2h', american: -130, score: 80 }];
  assert.equal(applyLearningToCandidates(input, null), input);
  assert.equal(applyLearningToCandidates(input, { weights: {} }), input);
});

test('re-ranking: a penalized segment loses its lead to a clean one', () => {
  const profile = { weights: { 'seg:baseball_mlb|totals': 0.88 } };
  const out = applyLearningToCandidates(
    [
      { sportKey: 'baseball_mlb', marketKey: 'totals', american: -110, score: 82 },
      { sportKey: 'icehockey_nhl', marketKey: 'h2h', american: -130, score: 78 },
    ],
    profile,
  ).sort((a, b) => b.score - a.score);
  assert.equal(out[0].sportKey, 'icehockey_nhl'); // 78 beats 82×0.88=72.2
});

/* ---------------------------------------------------------------- */
/* The daily report                                                  */
/* ---------------------------------------------------------------- */

test('the report explains a new penalty with its evidence, in plain English', () => {
  const picks = bucket(40, 12, { sportKey: 'baseball_mlb', marketKey: 'totals', american: 130, dateKey: '2026-08-07' });
  const { weights, evidence } = learnWeights(picks);
  const report = buildDailyReport({
    dateKey: '2026-08-08',
    yesterdayStats: featureStats(picks),
    windowStats: featureStats(picks),
    weights,
    evidence,
    prevWeights: undefined,
  });
  const text = report.lines.join('\n');
  assert.match(text, /Penalizing baseball_mlb totals/);
  assert.match(text, /12\/40/);
  assert.match(text, /Yesterday: 12-28/);
});

test('the report says so honestly when there is nothing to learn from yet', () => {
  const report = buildDailyReport({
    dateKey: '2026-08-08',
    yesterdayStats: featureStats([]),
    windowStats: featureStats([]),
    weights: {},
    evidence: {},
    prevWeights: undefined,
  });
  const text = report.lines.join('\n');
  assert.match(text, /no graded picks to review/);
  assert.match(text, /still accumulating graded evidence/);
});

test('a weight that disappears is reported as cleared', () => {
  const report = buildDailyReport({
    dateKey: '2026-08-08',
    yesterdayStats: featureStats([]),
    windowStats: featureStats(bucket(40, 22)),
    weights: {},
    evidence: {},
    prevWeights: { 'odds:dog': 0.9 },
  });
  assert.match(report.lines.join('\n'), /Cleared adjustment on underdogs/);
});

/* ---------------------------------------------------------------- */
/* Orchestration                                                     */
/* ---------------------------------------------------------------- */

test('runDailyLearning stores a profile + report and is idempotent within the same ET day', async () => {
  const env = makeEnv();
  const now = Date.UTC(2026, 7, 8, 6, 0); // 2am ET on Aug 8
  const picks = bucket(40, 12, { sportKey: 'baseball_mlb', marketKey: 'totals', american: -110 });

  const first = await runDailyLearning(env, ctx, now, { getPicks: async () => picks });
  assert.equal(first.skipped, false);
  assert.ok(first.weights['seg:baseball_mlb|totals'] < 1);

  const profile = await getLearningProfile(env);
  assert.equal(profile.dateKey, '2026-08-08');

  const again = await runDailyLearning(env, ctx, now + 20 * 60000, { getPicks: async () => picks });
  assert.equal(again.skipped, true);
  assert.equal((await getLearningLog(env)).length, 1);
});

test('the next day relearns from scratch — a recovered feature is not punished forever', async () => {
  const env = makeEnv();
  const day1 = Date.UTC(2026, 7, 8, 6, 0);
  const bad = bucket(40, 12, { sportKey: 'baseball_mlb', marketKey: 'totals', american: -110 });
  await runDailyLearning(env, ctx, day1, { getPicks: async () => bad });
  assert.ok((await getLearningProfile(env)).weights['seg:baseball_mlb|totals'] < 1);

  // By the next day the window's evidence has normalized (recovered form).
  const recovered = bucket(40, 22, { sportKey: 'baseball_mlb', marketKey: 'totals', american: -110 });
  const day2 = day1 + 86400000;
  await runDailyLearning(env, ctx, day2, { getPicks: async () => recovered });
  const profile = await getLearningProfile(env);
  assert.equal(profile.weights['seg:baseball_mlb|totals'], undefined);
  const log = await getLearningLog(env);
  assert.equal(log.length, 2);
  assert.match(log[0].report.join('\n'), /Cleared adjustment/);
});
