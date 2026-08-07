import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getUfcEventDetails } from '../worker/src/ufc-events.js';

/**
 * getUfcEventDetails calls fetch() directly (module-scope, not injected —
 * matches how worker/src/mlb-stats.js's cachedJson does too), so these tests
 * stub the global fetch/caches the same way test/mlb-stats.test.mjs would if
 * it needed to exercise a live-fetching path, rather than mocking a
 * dependency-injected function.
 */

function stubEspnScoreboard(events) {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({ events }),
  });
}

const ctx = { waitUntil: (p) => p };

function makeEspnEvent(name, fights) {
  return {
    name,
    competitions: fights.map(([a, b]) => ({
      competitors: [{ athlete: { displayName: a } }, { athlete: { displayName: b } }],
    })),
  };
}

test('matches a fight to its real event name, regardless of fighter order', async () => {
  stubEspnScoreboard([
    makeEspnEvent('UFC Fight Night: Gamrot vs Salkilld', [
      ['Mateusz Gamrot', 'Quillan Salkilld'],
      ['Ty Miller', 'Billy Goff'],
    ]),
  ]);

  const forward = await getUfcEventDetails('Mateusz Gamrot', 'Quillan Salkilld', Date.now(), ctx);
  assert.equal(forward.event, 'UFC Fight Night: Gamrot vs Salkilld');

  const reversed = await getUfcEventDetails('Quillan Salkilld', 'Mateusz Gamrot', Date.now(), ctx);
  assert.equal(reversed.event, 'UFC Fight Night: Gamrot vs Salkilld');
});

test('name matching is case/punctuation-insensitive', async () => {
  stubEspnScoreboard([
    makeEspnEvent('UFC 305: Makhachev vs. Garry', [['Islam Makhachev', 'Ian Garry']]),
  ]);
  const result = await getUfcEventDetails('islam makhachev', 'IAN GARRY!', Date.now(), ctx);
  assert.equal(result.event, 'UFC 305: Makhachev vs. Garry');
});

test('two separate events never get merged into one', async () => {
  stubEspnScoreboard([
    makeEspnEvent('UFC Fight Night: Miller vs. Goff', [['Ty Miller', 'Billy Goff']]),
    makeEspnEvent('UFC Fight Night: Gamrot vs Salkilld', [['Mateusz Gamrot', 'Quillan Salkilld']]),
  ]);
  const a = await getUfcEventDetails('Ty Miller', 'Billy Goff', Date.now(), ctx);
  const b = await getUfcEventDetails('Mateusz Gamrot', 'Quillan Salkilld', Date.now(), ctx);
  assert.equal(a.event, 'UFC Fight Night: Miller vs. Goff');
  assert.equal(b.event, 'UFC Fight Night: Gamrot vs Salkilld');
  assert.notEqual(a.event, b.event);
});

test('a fighter not found on any card falls back to date grouping', async () => {
  stubEspnScoreboard([makeEspnEvent('UFC 305: Makhachev vs. Garry', [['Islam Makhachev', 'Ian Garry']])]);
  const commenceMs = Date.parse('2026-08-15T22:00:00Z');
  const result = await getUfcEventDetails('Unknown Fighter A', 'Unknown Fighter B', commenceMs, ctx);
  assert.equal(result.event, 'Card - 08/15');
});

test('a live ESPN fetch failure falls back to date grouping, never a stale guess', async () => {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  const commenceMs = Date.parse('2026-08-09T20:00:00Z');
  const result = await getUfcEventDetails('Mateusz Gamrot', 'Quillan Salkilld', commenceMs, ctx);
  assert.equal(result.event, 'Card - 08/09');
});

test('missing fighter names returns null rather than throwing', async () => {
  const result = await getUfcEventDetails(null, 'Someone', Date.now(), ctx);
  assert.equal(result, null);
});
