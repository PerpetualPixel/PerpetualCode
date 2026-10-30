/** The UFC side's worker half (worker/src/ufc-card.js): which card the tab shows. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextUfcEvent, getUfcEvents, getUfcEvent, getUfcFighter } from '../worker/src/ufc-card.js';

const NOW = Date.UTC(2026, 9, 30, 18);
const ev = (id, daysFromNow, status = 'upcoming') => ({ id, name: `UFC ${id}`, date: NOW + daysFromNow * 864e5, status });

test('nextUfcEvent: the first card by date that is not final, so a finished card rolls to the next one at once', () => {
  assert.equal(nextUfcEvent([ev('b', 8), ev('a', 1), ev('z', -6, 'final')], NOW).id, 'a');
  assert.equal(nextUfcEvent([ev('b', 8), ev('a', 1, 'final')], NOW).id, 'b');
  assert.equal(nextUfcEvent([ev('a', 1, 'live'), ev('b', 8)], NOW).id, 'a', 'a live card is still the card');
  assert.equal(nextUfcEvent([ev('z', -6, 'final'), ev('y', -13, 'final')], NOW).id, 'z', 'nothing ahead: the most recent card stays up');
  assert.equal(nextUfcEvent([], NOW), null);
});

test('the readers answer empty when the runner has not written yet', async () => {
  const env = { POTD_KV: { get: async () => null } };
  assert.deepEqual(await getUfcEvents(env), { builtAt: null, events: [] });
  assert.equal(await getUfcEvent(env, '1'), null);
  assert.equal(await getUfcFighter(env, '1'), null);
  const kv = new Map([['ufc:event:1', JSON.stringify({ id: '1', bouts: [] })]]);
  assert.deepEqual(await getUfcEvent({ POTD_KV: { get: async (k) => kv.get(k) ?? null } }, '1'), { id: '1', bouts: [] });
});
