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

function makeEspnEvent(name, fights, date) {
  return {
    name,
    ...(date ? { date } : {}),
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

test('matches despite an unstripped diacritic mismatch (José vs Jose)', async () => {
  // Confirmed live on UFC 330: ESPN lists "Joel Álvarez", the Odds API
  // offers "Joel Alvarez" — a plain [^a-z0-9] strip on the un-normalized
  // string mangles "é" into nothing ("jos" instead of "jose"), silently
  // breaking the match.
  stubEspnScoreboard([
    makeEspnEvent('UFC 330: Makhachev vs. Machado Garry', [['Chidi Njokuani', 'Joel Álvarez']]),
  ]);
  const result = await getUfcEventDetails('Chidi Njokuani', 'Joel Alvarez', Date.now(), ctx);
  assert.equal(result.event, 'UFC 330: Makhachev vs. Machado Garry');
});

test('matches despite a missing/extra middle name (Billy Ray Goff vs Billy Goff)', async () => {
  stubEspnScoreboard([
    makeEspnEvent('UFC Fight Night: Gamrot vs Salkilld', [['Billy Ray Goff', 'Ty Miller']]),
  ]);
  const result = await getUfcEventDetails('Ty Miller', 'Billy Goff', Date.now(), ctx);
  assert.equal(result.event, 'UFC Fight Night: Gamrot vs Salkilld');
});

test('matches despite a missing given name (Carlos Diego Ferreira vs Diego Ferreira)', async () => {
  stubEspnScoreboard([
    makeEspnEvent('UFC Fight Night: Gamrot vs Salkilld', [['Diego Ferreira', 'Billy Quarantillo']]),
  ]);
  const result = await getUfcEventDetails('Carlos Diego Ferreira', 'Billy Quarantillo', Date.now(), ctx);
  assert.equal(result.event, 'UFC Fight Night: Gamrot vs Salkilld');
});

test('matches despite a two-word surname one source concatenates (del Valle vs DelValle)', async () => {
  stubEspnScoreboard([
    makeEspnEvent('UFC Fight Night: Gamrot vs Salkilld', [['Darren Elkins', 'Yadier del Valle']]),
  ]);
  const result = await getUfcEventDetails('Darren Elkins', 'Yadier DelValle', Date.now(), ctx);
  assert.equal(result.event, 'UFC Fight Night: Gamrot vs Salkilld');
});

test('matches despite a nickname used as a first name (Gigi vs Giovanna)', async () => {
  stubEspnScoreboard([
    makeEspnEvent('UFC Fight Night: Gamrot vs Salkilld', [['Gigi Canuto', 'Carol Foro']]),
  ]);
  const result = await getUfcEventDetails('Giovanna Canuto', 'Carol Foro', Date.now(), ctx);
  assert.equal(result.event, 'UFC Fight Night: Gamrot vs Salkilld');
});

test('a wholly unrelated fighter pair still falls back to date grouping, not a false surname match', async () => {
  stubEspnScoreboard([
    makeEspnEvent('UFC 330: Makhachev vs. Machado Garry', [['Islam Makhachev', 'Ian Machado Garry']]),
  ]);
  const commenceMs = Date.parse('2026-09-01T20:00:00Z');
  const result = await getUfcEventDetails('Conor McGregor', 'Jorge Masvidal', commenceMs, ctx);
  assert.equal(result.event, 'Card - 09/01');
});

test('a PFL fighter matches against PFL\'s own scoreboard, separate from UFC\'s', async () => {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    const isPfl = String(url).includes('/mma/pfl/');
    const events = isPfl
      ? [makeEspnEvent('PFL Charlotte: Battle vs. Rosta', [['Trey Waters', 'Trukon Carson']])]
      : [makeEspnEvent('UFC Fight Night: Gamrot vs Salkilld', [['Mateusz Gamrot', 'Quillan Salkilld']])];
    return { ok: true, text: async () => JSON.stringify({ events }) };
  };

  const pfl = await getUfcEventDetails('Trey Waters', 'Trukon Carson', Date.now(), ctx);
  assert.equal(pfl.event, 'PFL Charlotte: Battle vs. Rosta');

  const ufc = await getUfcEventDetails('Mateusz Gamrot', 'Quillan Salkilld', Date.now(), ctx);
  assert.equal(ufc.event, 'UFC Fight Night: Gamrot vs Salkilld');
});

test('UFC scoreboard failing does not block PFL fighters from matching', async () => {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    if (String(url).includes('/mma/ufc/')) return { ok: false, status: 500 };
    return {
      ok: true,
      text: async () => JSON.stringify({ events: [makeEspnEvent('PFL Charlotte: Battle vs. Rosta', [['Trey Waters', 'Trukon Carson']])] }),
    };
  };

  const result = await getUfcEventDetails('Trey Waters', 'Trukon Carson', Date.now(), ctx);
  assert.equal(result.event, 'PFL Charlotte: Battle vs. Rosta');
});

test('an unmatched fighter pair still lands on the real card when it starts the same day (untelevised early prelim)', async () => {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    // Only UFC's own scoreboard carries this card — PFL's returns nothing,
    // same as fetchMmaSchedule always merges two separate promotions.
    const events = String(url).includes('/mma/ufc/')
      ? [makeEspnEvent('UFC Fight Night: Gamrot vs Salkilld', [['Mateusz Gamrot', 'Quillan Salkilld']], '2026-08-08T21:00Z')]
      : [];
    return { ok: true, text: async () => JSON.stringify({ events }) };
  };
  // Neither fighter is on the listed card at all — ESPN's scoreboard just
  // never listed this early-prelim bout as its own competition — but it
  // starts the same UTC day as the one event ESPN did list.
  const commenceMs = Date.parse('2026-08-08T21:40:00Z');
  const result = await getUfcEventDetails('Miles Johns', 'Gianni Vazquez', commenceMs, ctx);
  assert.equal(result.event, 'UFC Fight Night: Gamrot vs Salkilld');
});

test('same-day fallback stays quiet (plain date label) when two events land on the same day', async () => {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    const events = String(url).includes('/mma/ufc/')
      ? [makeEspnEvent('UFC Fight Night: Gamrot vs Salkilld', [['Mateusz Gamrot', 'Quillan Salkilld']], '2026-08-08T21:00Z')]
      : [makeEspnEvent('PFL Charlotte: Battle vs. Rosta', [['Someone Else', 'Another Fighter']], '2026-08-08T23:00Z')];
    return { ok: true, text: async () => JSON.stringify({ events }) };
  };
  const commenceMs = Date.parse('2026-08-08T22:00:00Z');
  const result = await getUfcEventDetails('Unmatched One', 'Unmatched Two', commenceMs, ctx);
  assert.equal(result.event, 'Card - 08/08');
});

test('same-day fallback never fires when ESPN omits a date on every event', async () => {
  // Every existing fixture in this file omits `date` — this locks in that
  // those tests' plain-date-fallback behavior can never accidentally start
  // matching once a schedule entry does carry a date.
  stubEspnScoreboard([makeEspnEvent('UFC 305: Makhachev vs. Garry', [['Islam Makhachev', 'Ian Garry']])]);
  const commenceMs = Date.parse('2026-08-15T22:00:00Z');
  const result = await getUfcEventDetails('Unknown Fighter A', 'Unknown Fighter B', commenceMs, ctx);
  assert.equal(result.event, 'Card - 08/15');
});
