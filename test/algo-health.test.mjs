import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  segmentStats,
  segmentBreakdown,
  evaluateSegment,
  evaluateGlobalTuning,
  isSegmentPaused,
  normalizeSportKey,
  runAlgoHealthReview,
  getAlgoConfig,
  getPausedSegments,
  resetAlgoConfigToDefaults,
  defaultAlgoConfig,
  TUNABLE_BOUNDS,
  MIN_SEGMENT_SAMPLE,
  MIN_OVERALL_SAMPLE,
  PAUSE_Z,
  RESUME_Z,
  WARN_Z,
  TIGHTEN_Z,
} from '../worker/src/algo-health.js';

function makeKvStore() {
  const store = new Map();
  return {
    store,
    env: {
      POTD_KV: {
        async get(key) { return store.get(key) ?? null; },
        async put(key, value) { store.set(key, value); },
        async delete(key) { store.delete(key); },
      },
    },
  };
}

const ctx = { waitUntil: (p) => p };
const NOW = Date.parse('2026-08-10T12:00:00Z');

/** One graded pick record, matching worker/src/tracking.js's pickRecordFrom shape. */
function makePick({
  sportKey = 'baseball_mlb',
  marketKey = 'h2h',
  status = 'won',
  consensusProb = 0.55,
  stake = 20,
  meetsStandard = true,
} = {}) {
  const payout = status === 'won' ? stake * 0.9 : status === 'lost' ? -stake : 0;
  return {
    sportKey,
    marketKey,
    status,
    consensusProb,
    suggested_stake: stake,
    result: status === 'pending' ? null : { payout, roiPercent: (payout / stake) * 100 },
    meetsStandard,
  };
}

test('segmentStats: empty input returns a zeroed, non-throwing result', () => {
  const s = segmentStats([]);
  assert.equal(s.n, 0);
  assert.equal(s.z, 0);
});

test('segmentStats: excludes pending, flagged, and no-consensusProb picks from the sample', () => {
  const picks = [
    makePick({ status: 'won' }),
    makePick({ status: 'pending' }),
    makePick({ status: 'lost', meetsStandard: false }),
    { ...makePick({ status: 'won' }), consensusProb: undefined },
  ];
  const s = segmentStats(picks);
  assert.equal(s.n, 1);
});

test('segmentStats: a coin-flip segment (consensusProb 0.5) that wins exactly half the time has z near 0', () => {
  const picks = [];
  for (let i = 0; i < 40; i++) picks.push(makePick({ status: i % 2 === 0 ? 'won' : 'lost', consensusProb: 0.5 }));
  const s = segmentStats(picks);
  assert.equal(s.n, 40);
  assert.equal(s.wins, 20);
  assert.ok(Math.abs(s.z) < 0.5, `expected z near 0, got ${s.z}`);
});

test('segmentStats: a segment that wins far less than its own consensusProb predicted has a strongly negative z', () => {
  // consensusProb says these should win ~65% of the time; only 20% actually won.
  const picks = [];
  for (let i = 0; i < 30; i++) picks.push(makePick({ status: i < 6 ? 'won' : 'lost', consensusProb: 0.65 }));
  const s = segmentStats(picks);
  assert.equal(s.n, 30);
  assert.ok(s.z < -2, `expected a strongly negative z, got ${s.z}`);
  assert.ok(s.roi < 0, 'a segment this far under its own fair-win-rate expectation should show negative ROI');
});

test('segmentStats: net/ROI reflect real payouts, not just win count', () => {
  const picks = [
    makePick({ status: 'won', stake: 20, consensusProb: 0.5 }),
    makePick({ status: 'lost', stake: 20, consensusProb: 0.5 }),
  ];
  const s = segmentStats(picks);
  assert.equal(s.staked, 40);
  assert.equal(s.net, 20 * 0.9 - 20);
});

test('segmentBreakdown: groups by sport+market, ignoring picks missing either field', () => {
  const picks = [
    makePick({ sportKey: 'baseball_mlb', marketKey: 'h2h' }),
    makePick({ sportKey: 'baseball_mlb', marketKey: 'h2h' }),
    makePick({ sportKey: 'baseball_mlb', marketKey: 'spreads' }),
    makePick({ sportKey: 'mma_mixed_martial_arts', marketKey: 'h2h' }),
    { ...makePick(), sportKey: undefined },
  ];
  const groups = segmentBreakdown(picks);
  const keys = groups.map((g) => g.key).sort();
  assert.deepEqual(keys, ['baseball_mlb|h2h', 'baseball_mlb|spreads', 'mma_mixed_martial_arts|h2h']);
  assert.equal(groups.find((g) => g.key === 'baseball_mlb|h2h').stats.n, 2);
});

test('normalizeSportKey: collapses any tennis tournament key into one ATP or WTA virtual segment', () => {
  assert.equal(normalizeSportKey('tennis_atp_canadian_open'), 'tennis_atp');
  assert.equal(normalizeSportKey('tennis_wta_us_open'), 'tennis_wta');
  assert.equal(normalizeSportKey('baseball_mlb'), 'baseball_mlb');
});

test('segmentBreakdown: two different weeks of tennis tournaments land in the same segment', () => {
  const picks = [
    makePick({ sportKey: 'tennis_atp_canadian_open', marketKey: 'h2h' }),
    makePick({ sportKey: 'tennis_atp_us_open', marketKey: 'h2h' }),
  ];
  const groups = segmentBreakdown(picks);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'tennis_atp|h2h');
  assert.equal(groups[0].stats.n, 2);
});

test('evaluateSegment: takes no action below MIN_SEGMENT_SAMPLE, no matter how bad the z-score', () => {
  const picks = [];
  for (let i = 0; i < MIN_SEGMENT_SAMPLE - 1; i++) picks.push(makePick({ status: 'lost', consensusProb: 0.7 }));
  const stats = segmentStats(picks);
  assert.ok(stats.z < PAUSE_Z, 'sanity: the z-score alone would clear the pause bar');
  assert.equal(evaluateSegment(stats, false).action, 'none');
});

test('evaluateSegment: pauses a segment that clears PAUSE_Z with a real sample and negative ROI', () => {
  const picks = [];
  for (let i = 0; i < MIN_SEGMENT_SAMPLE + 5; i++) picks.push(makePick({ status: i < 4 ? 'won' : 'lost', consensusProb: 0.7 }));
  const stats = segmentStats(picks);
  assert.ok(stats.n >= MIN_SEGMENT_SAMPLE);
  const decision = evaluateSegment(stats, false);
  assert.equal(decision.action, 'pause');
});

test('evaluateSegment: a segment between WARN_Z and PAUSE_Z produces a proposal, never an auto-pause', () => {
  // Constructed to land in the warn band, not deep enough to pause.
  const picks = [];
  for (let i = 0; i < 25; i++) picks.push(makePick({ status: i < 11 ? 'won' : 'lost', consensusProb: 0.6 }));
  const stats = segmentStats(picks);
  assert.ok(stats.z <= WARN_Z && stats.z > PAUSE_Z, `expected z between PAUSE_Z and WARN_Z, got ${stats.z}`);
  assert.equal(evaluateSegment(stats, false).action, 'proposal');
});

test('evaluateSegment: a healthy segment (z near or above 0) takes no action', () => {
  const picks = [];
  for (let i = 0; i < 25; i++) picks.push(makePick({ status: i < 15 ? 'won' : 'lost', consensusProb: 0.5 }));
  const stats = segmentStats(picks);
  assert.ok(stats.z > WARN_Z);
  assert.equal(evaluateSegment(stats, false).action, 'none');
});

test('evaluateSegment: resume requires clearing RESUME_Z, not just crossing back over the pause line (hysteresis)', () => {
  // z sits between PAUSE_Z and RESUME_Z — recovered from "pause-worthy" but not yet "clearly fine."
  const picks = [];
  for (let i = 0; i < 25; i++) picks.push(makePick({ status: i < 11 ? 'won' : 'lost', consensusProb: 0.55 }));
  const stats = segmentStats(picks);
  assert.ok(stats.z > PAUSE_Z, 'sanity: no longer bad enough to (re-)pause');
  if (stats.z <= RESUME_Z) {
    assert.equal(evaluateSegment(stats, true).action, 'none', 'still paused — has not cleared the stricter resume bar yet');
  }
});

test('evaluateSegment: resumes once a paused segment clearly recovers past RESUME_Z', () => {
  const picks = [];
  for (let i = 0; i < 25; i++) picks.push(makePick({ status: i < 15 ? 'won' : 'lost', consensusProb: 0.5 }));
  const stats = segmentStats(picks);
  assert.ok(stats.z > RESUME_Z);
  assert.equal(evaluateSegment(stats, true).action, 'resume');
});

test('evaluateGlobalTuning: no action below MIN_OVERALL_SAMPLE', () => {
  const picks = [];
  for (let i = 0; i < MIN_OVERALL_SAMPLE - 5; i++) picks.push(makePick({ status: 'lost', consensusProb: 0.7 }));
  const stats = segmentStats(picks);
  assert.equal(evaluateGlobalTuning(stats, defaultAlgoConfig()).action, 'none');
});

test('evaluateGlobalTuning: tightens exactly one param (EV floor first) when overall performance clears TIGHTEN_Z', () => {
  const picks = [];
  for (let i = 0; i < 40; i++) picks.push(makePick({ status: i < 8 ? 'won' : 'lost', consensusProb: 0.65 }));
  const stats = segmentStats(picks);
  assert.ok(stats.z <= TIGHTEN_Z);
  const decision = evaluateGlobalTuning(stats, defaultAlgoConfig());
  assert.equal(decision.action, 'tighten');
  assert.equal(decision.param, 'MIN_EV_PCT');
  assert.equal(decision.before, TUNABLE_BOUNDS.MIN_EV_PCT.min);
  assert.ok(Math.abs(decision.after - (TUNABLE_BOUNDS.MIN_EV_PCT.min + TUNABLE_BOUNDS.MIN_EV_PCT.step)) < 1e-9);
});

test('evaluateGlobalTuning: never tightens a param past its configured max', () => {
  const picks = [];
  for (let i = 0; i < 40; i++) picks.push(makePick({ status: i < 8 ? 'won' : 'lost', consensusProb: 0.65 }));
  const stats = segmentStats(picks);
  const maxedConfig = { MIN_EV_PCT: TUNABLE_BOUNDS.MIN_EV_PCT.max, MIN_KELLY_FRACTION: TUNABLE_BOUNDS.MIN_KELLY_FRACTION.min, MIN_SCORE: TUNABLE_BOUNDS.MIN_SCORE.min };
  const decision = evaluateGlobalTuning(stats, maxedConfig);
  assert.equal(decision.action, 'tighten');
  assert.equal(decision.param, 'MIN_KELLY_FRACTION', 'EV floor is maxed, so the next param in order should move instead');
});

test('evaluateGlobalTuning: no action left once every tunable param is already at its ceiling', () => {
  const picks = [];
  for (let i = 0; i < 40; i++) picks.push(makePick({ status: i < 8 ? 'won' : 'lost', consensusProb: 0.65 }));
  const stats = segmentStats(picks);
  const allMaxed = {
    MIN_EV_PCT: TUNABLE_BOUNDS.MIN_EV_PCT.max,
    MIN_KELLY_FRACTION: TUNABLE_BOUNDS.MIN_KELLY_FRACTION.max,
    MIN_SCORE: TUNABLE_BOUNDS.MIN_SCORE.max,
  };
  assert.equal(evaluateGlobalTuning(stats, allMaxed).action, 'none');
});

test('isSegmentPaused: matches on normalized sport+market, blind to which specific tennis tournament', () => {
  const paused = [{ key: 'tennis_atp|h2h' }];
  assert.equal(isSegmentPaused({ sportKey: 'tennis_atp_us_open', marketKey: 'h2h' }, paused), true);
  assert.equal(isSegmentPaused({ sportKey: 'tennis_wta_us_open', marketKey: 'h2h' }, paused), false);
  assert.equal(isSegmentPaused({ sportKey: 'baseball_mlb', marketKey: 'h2h' }, paused), false);
});

test('isSegmentPaused: an empty paused list pauses nothing', () => {
  assert.equal(isSegmentPaused({ sportKey: 'baseball_mlb', marketKey: 'h2h' }, []), false);
});

test('runAlgoHealthReview: a healthy history produces no config or paused-segment changes', async () => {
  const { env } = makeKvStore();
  const picks = [];
  for (let i = 0; i < 40; i++) picks.push(makePick({ status: i < 22 ? 'won' : 'lost', consensusProb: 0.5 }));
  const result = await runAlgoHealthReview(env, ctx, NOW, { getPicks: async () => picks });

  assert.equal(result.skipped, false);
  assert.deepEqual(result.config, defaultAlgoConfig());
  assert.deepEqual(result.paused, []);
});

test('runAlgoHealthReview: pauses an underperforming segment and persists it to KV', async () => {
  const { env } = makeKvStore();
  const badMma = [];
  for (let i = 0; i < 25; i++) badMma.push(makePick({ sportKey: 'mma_mixed_martial_arts', marketKey: 'h2h', status: i < 4 ? 'won' : 'lost', consensusProb: 0.7 }));

  const result = await runAlgoHealthReview(env, ctx, NOW, { getPicks: async () => badMma });
  assert.equal(result.paused.length, 1);
  assert.equal(result.paused[0].key, 'mma_mixed_martial_arts|h2h');

  const persisted = await getPausedSegments(env);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].key, 'mma_mixed_martial_arts|h2h');
});

test('runAlgoHealthReview: is idempotent within the same ISO week', async () => {
  const { env } = makeKvStore();
  const picks = [];
  for (let i = 0; i < 25; i++) picks.push(makePick({ sportKey: 'mma_mixed_martial_arts', status: i < 4 ? 'won' : 'lost', consensusProb: 0.7 }));

  const first = await runAlgoHealthReview(env, ctx, NOW, { getPicks: async () => picks });
  assert.equal(first.skipped, false);

  const sameWeekLater = NOW + 2 * 86400000; // two days later, same ISO week
  const second = await runAlgoHealthReview(env, ctx, sameWeekLater, { getPicks: async () => picks });
  assert.equal(second.skipped, true);

  // Confirm it didn't double-pause or duplicate log entries.
  const persisted = await getPausedSegments(env);
  assert.equal(persisted.length, 1);
});

test('runAlgoHealthReview: a manual reset earlier in the week does not block that week\'s real review from running', async () => {
  const { env } = makeKvStore();
  // A manual reset (e.g. from the dashboard's "Reset Tuning to Defaults"
  // button) logs its own entry with the current week — this must not be
  // mistaken for "the weekly review already ran."
  await resetAlgoConfigToDefaults(env, NOW - 3600000);

  const picks = [];
  for (let i = 0; i < 25; i++) picks.push(makePick({ sportKey: 'mma_mixed_martial_arts', status: i < 4 ? 'won' : 'lost', consensusProb: 0.7 }));
  const result = await runAlgoHealthReview(env, ctx, NOW, { getPicks: async () => picks });

  assert.equal(result.skipped, false, 'the manual reset log entry must not satisfy the idempotency check');
  assert.equal(result.paused.length, 1);
});

test('runAlgoHealthReview: runs again the following ISO week', async () => {
  const { env } = makeKvStore();
  const picks = [];
  for (let i = 0; i < 25; i++) picks.push(makePick({ sportKey: 'mma_mixed_martial_arts', status: i < 4 ? 'won' : 'lost', consensusProb: 0.7 }));

  await runAlgoHealthReview(env, ctx, NOW, { getPicks: async () => picks });
  const nextWeek = NOW + 8 * 86400000;
  const result = await runAlgoHealthReview(env, ctx, nextWeek, { getPicks: async () => picks });
  assert.equal(result.skipped, false);
});

test('runAlgoHealthReview: a paused segment that recovers shows up as resumed the following week', async () => {
  const { env } = makeKvStore();
  const badPicks = [];
  for (let i = 0; i < 25; i++) badPicks.push(makePick({ sportKey: 'mma_mixed_martial_arts', status: i < 4 ? 'won' : 'lost', consensusProb: 0.7 }));
  await runAlgoHealthReview(env, ctx, NOW, { getPicks: async () => badPicks });
  assert.equal((await getPausedSegments(env)).length, 1);

  const recoveredPicks = [];
  for (let i = 0; i < 25; i++) recoveredPicks.push(makePick({ sportKey: 'mma_mixed_martial_arts', status: i < 15 ? 'won' : 'lost', consensusProb: 0.5 }));
  const nextWeek = NOW + 8 * 86400000;
  const result = await runAlgoHealthReview(env, ctx, nextWeek, { getPicks: async () => recoveredPicks });

  assert.equal(result.paused.length, 0);
  assert.equal((await getPausedSegments(env)).length, 0);
});

test('runAlgoHealthReview: getAlgoConfig defaults to shipped RULES values when nothing is stored yet', async () => {
  const { env } = makeKvStore();
  const config = await getAlgoConfig(env);
  assert.deepEqual(config, defaultAlgoConfig());
});

test('runAlgoHealthReview: tightens the global config when overall (non-paused) performance is weak but no single segment', async () => {
  const { env } = makeKvStore();
  // Three separate segments, each below MIN_SEGMENT_SAMPLE on its own (so
  // none individually triggers a pause/proposal), but combined they clear
  // MIN_OVERALL_SAMPLE and TIGHTEN_Z — this is the case global tuning exists
  // for: broad, cross-segment underperformance that no single circuit
  // breaker would catch.
  const picks = [
    ...Array.from({ length: 12 }, (_, i) => makePick({ sportKey: 'baseball_mlb', status: i < 2 ? 'won' : 'lost', consensusProb: 0.65 })),
    ...Array.from({ length: 12 }, (_, i) => makePick({ sportKey: 'basketball_wnba', status: i < 2 ? 'won' : 'lost', consensusProb: 0.65 })),
    ...Array.from({ length: 12 }, (_, i) => makePick({ sportKey: 'icehockey_nhl', status: i < 2 ? 'won' : 'lost', consensusProb: 0.65 })),
  ];

  const result = await runAlgoHealthReview(env, ctx, NOW, { getPicks: async () => picks });
  assert.equal(result.paused.length, 0, 'no individual segment has enough sample to be paused on its own');
  assert.ok(result.config.MIN_EV_PCT > TUNABLE_BOUNDS.MIN_EV_PCT.min, 'the global floor should have tightened');

  const persisted = await getAlgoConfig(env);
  assert.equal(persisted.MIN_EV_PCT, result.config.MIN_EV_PCT);
});
