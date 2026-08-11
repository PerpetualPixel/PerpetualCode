/**
 * The plain-language algorithm-change briefing (worker/src/
 * learning-brief-email.js) and the structured-changes plumbing it rides on
 * (daily-learning.js's buildDailyReport `changes` array, which the
 * dashboard's "algorithm adjusted" banner also reads via the log entry).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendLearningBriefEmail, describeChange } from '../worker/src/learning-brief-email.js';
import { buildDailyReport } from '../worker/src/daily-learning.js';

const STATS = { wins: 12, n: 31, expectedWins: 18.2, z: -2.1, avgClvPts: -0.8 };

test('buildDailyReport emits structured changes matching its narrated lines', () => {
  const report = buildDailyReport({
    dateKey: '2026-08-12',
    yesterdayStats: { n: 13, wins: 4, expectedWins: 7.1, z: -1.8, roi: -22.4, avgClvPts: -0.4 },
    windowStats: { n: 200, wins: 102, expectedWins: 104, z: -0.3, roi: 2.1, avgClvPts: 0.1 },
    weights: { 'seg:baseball_mlb|totals': 0.92 },
    evidence: { 'seg:baseball_mlb|totals': STATS },
    prevWeights: { 'odds:dog': 0.9 }, // cleared this run
  });

  assert.equal(report.changes.length, 2);
  const added = report.changes.find((c) => c.kind === 'added');
  assert.equal(added.key, 'seg:baseball_mlb|totals');
  assert.equal(added.now, 0.92);
  assert.deepEqual(added.stats, STATS);
  const cleared = report.changes.find((c) => c.kind === 'cleared');
  assert.equal(cleared.key, 'odds:dog');
  assert.equal(cleared.before, 0.9);
});

test('an unchanged carried-over weight produces no change entry', () => {
  const report = buildDailyReport({
    dateKey: '2026-08-12',
    yesterdayStats: { n: 0, wins: 0, expectedWins: 0, z: 0, roi: 0, avgClvPts: null },
    windowStats: { n: 50, wins: 25, expectedWins: 25, z: 0, roi: 0, avgClvPts: 0 },
    weights: { 'seg:baseball_mlb|totals': 0.92 },
    evidence: { 'seg:baseball_mlb|totals': STATS },
    prevWeights: { 'seg:baseball_mlb|totals': 0.92 },
  });
  assert.equal(report.changes.length, 0, 'same weight as yesterday is not a change');
});

test('describeChange keeps the briefing jargon-free', () => {
  const line = describeChange({ kind: 'added', label: 'baseball_mlb totals', now: 0.92, stats: STATS });
  assert.match(line, /12 of 31/);
  assert.match(line, /expected ~18/);
  assert.match(line, /8% better case/);
  assert.doesNotMatch(line, /z[= ]/i, 'no z-scores in the boss briefing');
  assert.doesNotMatch(line, /x0\.9/, 'no raw multipliers in the boss briefing');
});

test('the briefing sends only on days with actual changes, with key numbers in the body', async () => {
  let sent = null;
  const env = { EMAIL: { send: async (m) => { sent = m; } } };
  const review = {
    dateKey: '2026-08-12',
    changes: [{ kind: 'added', label: 'baseball_mlb totals', now: 0.92, stats: STATS }],
    yesterdayStats: { n: 13, wins: 4, expectedWins: 7.1, z: -1.8, roi: -22.4, avgClvPts: -0.4 },
    windowStats: { n: 200, wins: 102, expectedWins: 104, z: -0.3, roi: 2.1, avgClvPts: 0.1 },
  };

  const r = await sendLearningBriefEmail(env, review);
  assert.equal(r.sent, true);
  assert.match(sent.subject, /1 adjustment/);
  assert.match(sent.text, /4-9/, 'yesterday record present');
  assert.match(sent.text, /-22\.4%/, 'yesterday ROI present');
  assert.match(sent.text, /102-98/, '30-day record present');
  assert.match(sent.text, /nothing already picked or graded gets touched/, 'transparency note present');

  const quiet = await sendLearningBriefEmail(env, { ...review, changes: [] });
  assert.equal(quiet.sent, false, 'a no-change day must not email');
});

test('a missing EMAIL binding degrades to a no-op, never a throw', async () => {
  const r = await sendLearningBriefEmail({}, { dateKey: '2026-08-12', changes: [{ kind: 'added', label: 'x', now: 0.9, stats: null }] });
  assert.equal(r.sent, false);
});
