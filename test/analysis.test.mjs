import test from 'node:test';
import assert from 'node:assert/strict';

import { quickTakeCap, analysisCacheKey, getOrGenerateAnalysis } from '../worker/src/analysis.js';

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
