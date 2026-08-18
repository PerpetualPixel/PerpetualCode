import test from 'node:test';
import assert from 'node:assert/strict';

import { quickTakeCap, analysisCacheKey, getOrGenerateAnalysis, tennisFactSheet } from '../worker/src/analysis.js';

const EPOCH = Date.UTC(2000, 0, 1);
const day = (iso) => Math.round((Date.parse(iso) - EPOCH) / 86400000);

/**
 * quickTakeCap and analysisCacheKey are the two pure pieces of the
 * POTD/audit/default three-way split — everything else in this module makes
 * a real Anthropic call, which these tests don't attempt to mock. What
 * matters most here, and what a regression would most easily break, is that
 * the three variants never collide: same event/pick must never resolve to
 * the same cache key or the same bullet cap across variants, because that's
 * exactly the class of bug that would make one surface's write-up silently
 * leak onto another (see the module's own comments on this).
 */

test('quickTakeCap: default caps at 4, POTD and audit both cap at 8', () => {
  assert.equal(quickTakeCap(false, false), 4);
  assert.equal(quickTakeCap(true, false), 8);
  assert.equal(quickTakeCap(false, true), 8);
});

test('quickTakeCap: POTD wins if both flags are somehow set', () => {
  assert.equal(quickTakeCap(true, true), 8);
});

test('analysisCacheKey: three variants for the same event/pick never collide', () => {
  const base = { dateKey: '2026-08-17', eventId: 'evt1', outcomeName: 'Iga Swiatek' };
  const game = analysisCacheKey({ ...base, isPotd: false, isAudit: false });
  const potd = analysisCacheKey({ ...base, isPotd: true, isAudit: false });
  const audit = analysisCacheKey({ ...base, isPotd: false, isAudit: true });

  assert.notEqual(game, potd);
  assert.notEqual(game, audit);
  assert.notEqual(potd, audit);
  // Each carries its own namespace prefix, not just a differing suffix, so a
  // careless prefix match elsewhere in the codebase can't accidentally
  // treat one variant's keys as another's.
  assert.match(game, /^analysis:/);
  assert.match(potd, /^potd-analysis:/);
  assert.match(audit, /^audit-analysis:/);
});

test('analysisCacheKey: same variant/event/pick is stable (a real cache key, not a random one)', () => {
  const base = { dateKey: '2026-08-17', eventId: 'evt1', outcomeName: 'Iga Swiatek', isPotd: false, isAudit: true };
  assert.equal(analysisCacheKey(base), analysisCacheKey({ ...base }));
});

test('analysisCacheKey: different pick on the same event is a different key (per-pick, not per-game)', () => {
  const key = (outcomeName) => analysisCacheKey({
    dateKey: '2026-08-17', eventId: 'evt1', outcomeName, isPotd: false, isAudit: true,
  });
  assert.notEqual(key('Iga Swiatek'), key('Yulia Putintseva'));
});

test('getOrGenerateAnalysis: isAudit still returns null with no ANTHROPIC_API_KEY configured, same as every other variant', async () => {
  const env = { POTD_KV: { async get() { return null; }, async put() {} } };
  const ctx = { waitUntil: (p) => p };
  const candidate = {
    eventId: 'evt1', sportKey: 'tennis_atp_us_open', sportTitle: 'ATP US Open',
    home: 'Elena Rybakina', away: 'Marta Kostyuk', outcomeName: 'Over',
  };
  const result = await getOrGenerateAnalysis(candidate, env, ctx, Date.parse('2026-08-17T12:00:00Z'), { isAudit: true });
  assert.equal(result, null);
});

/* ---------------------------------------------------------------- */
/* tennisFactSheet — the LLM "known facts" block                     */
/* ---------------------------------------------------------------- */

// Fields: [day, surface, court, round, winner, loser, wRank, lRank, retired,
//          sets, tbWinnerSets, tbLoserSets]
const TENNIS_DATA = {
  tour: 'atp',
  seasons: [2026],
  surfaces: ['Hard', 'Clay'],
  courts: ['Outdoor'],
  rounds: ['R1'],
  players: ['Alpha A.', 'Bravo B.', 'Opp1 O.', 'Opp2 O.', 'Opp3 O.', 'Opp4 O.', 'Opp5 O.', 'Opp6 O.'],
  matches: [
    [day('2026-07-01'), 0, 0, 0, 0, 2, 10, 50, 0, 2, 0, 0],
    [day('2026-07-02'), 0, 0, 0, 0, 3, 10, 50, 0, 3, 1, 0],
    [day('2026-07-03'), 0, 0, 0, 0, 4, 10, 50, 0, 3, 0, 1],
    [day('2026-07-04'), 0, 0, 0, 0, 5, 10, 50, 0, 2, 0, 0],
    [day('2026-07-05'), 0, 0, 0, 6, 0, 50, 10, 0, 2, 0, 0],
    [day('2026-07-06'), 0, 0, 0, 0, 1, 10, 20, 0, 3, 1, 0],
  ],
};

test('tennisFactSheet adds surface form, tiebreak record, and grind load for a tournament with a known surface', () => {
  const sheet = tennisFactSheet(TENNIS_DATA, 'Alpha A.', 'Bravo B.', 'tennis_atp_us_open'); // US Open -> Hard
  assert.match(sheet, /on Hard:/);
  assert.match(sheet, /in tiebreaks/);
  assert.match(sheet, /averaged .* sets/);
});

test('tennisFactSheet skips surface-form lines entirely for a tournament with no known surface', () => {
  const sheet = tennisFactSheet(TENNIS_DATA, 'Alpha A.', 'Bravo B.', 'tennis_atp_some_250_event');
  // The surface-form line's own distinct shape ("<name> on <Surface>: ..."),
  // not the generic recent-form line's parenthetical "(Hard, R1)" mentions.
  assert.doesNotMatch(sheet, /on Hard:/);
  assert.doesNotMatch(sheet, /on Clay:/);
  // Non-surface facts are unaffected by an unknown tournament.
  assert.match(sheet, /recent form/);
  assert.match(sheet, /in tiebreaks/);
});

test('tennisFactSheet still always states the head-to-head situation, even absent', () => {
  const sheet = tennisFactSheet(TENNIS_DATA, 'Alpha A.', 'Bravo B.', 'tennis_atp_us_open');
  assert.match(sheet, /Head-to-head/);
});

test('tennisFactSheet returns null when the archive has no matches at all', () => {
  assert.equal(tennisFactSheet({ matches: [] }, 'Alpha A.', 'Bravo B.', 'tennis_atp_us_open'), null);
  assert.equal(tennisFactSheet(null, 'Alpha A.', 'Bravo B.', 'tennis_atp_us_open'), null);
});
