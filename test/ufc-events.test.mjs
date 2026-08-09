import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getUfcEventDetails, fetchMmaResults, buildMmaScoreEvent, gradeMmaPickWithFallback } from '../worker/src/ufc-events.js';

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

test('an unmatched fighter pair still lands on the real card when it starts within the card window (untelevised early prelim)', async () => {
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
  // starts 40 minutes after the one event ESPN did list.
  const commenceMs = Date.parse('2026-08-08T21:40:00Z');
  const result = await getUfcEventDetails('Miles Johns', 'Gianni Vazquez', commenceMs, ctx);
  assert.equal(result.event, 'UFC Fight Night: Gamrot vs Salkilld');
});

test('the card-window fallback survives a card that crosses UTC midnight (regression: UFC 330\'s own listed start is Aug 15, its main card runs into Aug 16)', async () => {
  // Confirmed live: "Charles Johnson vs Jose Ochoa" (commence 2026-08-16T02:00Z)
  // fell through to "Card - 08/16" under a same-UTC-calendar-day version of
  // this fallback, because ESPN lists UFC 330's own start as
  // 2026-08-15T21:00Z — a real fight on a real, already-matched card, just on
  // the other side of UTC midnight from the event's own listed date.
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    const events = String(url).includes('/mma/ufc/')
      ? [makeEspnEvent('UFC 330: Makhachev vs. Machado Garry', [['Islam Makhachev', 'Ian Machado Garry']], '2026-08-15T21:00Z')]
      : [];
    return { ok: true, text: async () => JSON.stringify({ events }) };
  };
  const commenceMs = Date.parse('2026-08-16T02:00:00Z');
  const result = await getUfcEventDetails('Charles Johnson', 'Jose Ochoa', commenceMs, ctx);
  assert.equal(result.event, 'UFC 330: Makhachev vs. Machado Garry');
});

test('card-window fallback stays quiet (plain date label) when two events are both within the window', async () => {
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

test('card-window fallback correctly stays quiet beyond the 16-hour window (two genuinely separate cards, not one that crossed midnight)', async () => {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    const events = String(url).includes('/mma/ufc/')
      ? [makeEspnEvent('UFC Fight Night: Gamrot vs Salkilld', [['Mateusz Gamrot', 'Quillan Salkilld']], '2026-08-08T21:00Z')]
      : [];
    return { ok: true, text: async () => JSON.stringify({ events }) };
  };
  // 20 hours after the event's own listed start — outside any real card's span.
  const commenceMs = Date.parse('2026-08-09T17:00:00Z');
  const result = await getUfcEventDetails('Unmatched One', 'Unmatched Two', commenceMs, ctx);
  assert.equal(result.event, 'Card - 08/09');
});

test('card-window fallback never fires when ESPN omits a date on every event', async () => {
  // Every existing fixture in this file omits `date` — this locks in that
  // those tests' plain-date-fallback behavior can never accidentally start
  // matching once a schedule entry does carry a date.
  stubEspnScoreboard([makeEspnEvent('UFC 305: Makhachev vs. Garry', [['Islam Makhachev', 'Ian Garry']])]);
  const commenceMs = Date.parse('2026-08-15T22:00:00Z');
  const result = await getUfcEventDetails('Unknown Fighter A', 'Unknown Fighter B', commenceMs, ctx);
  assert.equal(result.event, 'Card - 08/15');
});

/* ------------------------------------------------------------------ */
/* fetchMmaResults / buildMmaScoreEvent / gradeMmaPickWithFallback     */
/* ------------------------------------------------------------------ */

/** A completed-fight ESPN competition — the shape fetchMmaResults reads
 * status.type.completed and competitors[].winner from, unlike
 * makeEspnEvent's schedule-only fixtures (no status/winner at all). */
function makeCompletedEvent(name, fights) {
  return {
    name,
    competitions: fights.map(([winnerName, loserName]) => ({
      status: { type: { completed: true } },
      competitors: [
        { athlete: { displayName: winnerName }, winner: true },
        { athlete: { displayName: loserName }, winner: false },
      ],
    })),
  };
}

test('fetchMmaResults only includes completed fights, skipping ones still in progress', async () => {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    // Only the UFC scoreboard carries this card — PFL's returns nothing, so
    // the count below reflects one promotion's card, not both doubled up.
    const events = String(url).includes('/mma/ufc/')
      ? [{
          name: 'Card',
          competitions: [
            { status: { type: { completed: true } }, competitors: [{ athlete: { displayName: 'Winner' }, winner: true }, { athlete: { displayName: 'Loser' }, winner: false }] },
            { status: { type: { completed: false } }, competitors: [{ athlete: { displayName: 'Still Fighting A' }, winner: false }, { athlete: { displayName: 'Still Fighting B' }, winner: false }] },
          ],
        }]
      : [];
    return { ok: true, text: async () => JSON.stringify({ events }) };
  };
  const results = await fetchMmaResults(ctx, Date.now());
  assert.equal(results.length, 1);
  assert.equal(results[0].aWon, true);
});

test('buildMmaScoreEvent builds a gradePick-compatible scoreEvent with the winner scored 1', async () => {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({ events: [makeCompletedEvent('Card', [['Bryan Battle', 'Dalton Rosta']])] }),
  });
  const results = await fetchMmaResults(ctx, Date.now());

  const scoreEvent = buildMmaScoreEvent('Bryan Battle', 'Dalton Rosta', results);
  assert.equal(scoreEvent.completed, true);
  assert.deepEqual(scoreEvent.scores, [
    { name: 'Bryan Battle', score: 1 },
    { name: 'Dalton Rosta', score: 0 },
  ]);

  // Home/away reversed from how ESPN listed them — still resolves correctly,
  // the winner's actual name gets the 1 regardless of home/away order.
  const reversed = buildMmaScoreEvent('Dalton Rosta', 'Bryan Battle', results);
  assert.deepEqual(reversed.scores, [
    { name: 'Dalton Rosta', score: 0 },
    { name: 'Bryan Battle', score: 1 },
  ]);
});

test('buildMmaScoreEvent returns null when no ESPN fight matches either name', async () => {
  const results = [{ a: 'bryan battle', b: 'dalton rosta', aWon: true, bWon: false }];
  const scoreEvent = buildMmaScoreEvent('Unrelated Fighter', 'Another Unrelated Fighter', results);
  assert.equal(scoreEvent, null);
});

test('buildMmaScoreEvent matches despite name spelling differences, same as getUfcEventDetails', async () => {
  const results = [{ a: 'giovanna canuto', b: 'carol foro', aWon: false, bWon: true }];
  // Odds API spells it "Gigi Canuto" (nickname-as-first-name) here.
  const scoreEvent = buildMmaScoreEvent('Gigi Canuto', 'Carol Foro', results);
  assert.deepEqual(scoreEvent.scores, [
    { name: 'Gigi Canuto', score: 0 },
    { name: 'Carol Foro', score: 1 },
  ]);
});

test('gradeMmaPickWithFallback grades via ESPN when the primary scoreEvent has no result yet', () => {
  const pick = {
    home: 'Bryan Battle', away: 'Dalton Rosta',
    outcomeName: 'Bryan Battle', marketKey: 'h2h', point: null,
    decimal: 2.5, suggested_stake: 20,
  };
  const results = [{ a: 'bryan battle', b: 'dalton rosta', aWon: true, bWon: false }];

  // Primary scoreEvent is undefined — exactly what happens when the Odds
  // API's /scores hasn't posted this event at all yet.
  const outcome = gradeMmaPickWithFallback(pick, undefined, results);
  assert.equal(outcome.won, true);
  assert.equal(outcome.payout, (pick.decimal - 1) * pick.suggested_stake);
});

test('gradeMmaPickWithFallback prefers the primary scoreEvent when it already has a real result', () => {
  const pick = {
    home: 'Bryan Battle', away: 'Dalton Rosta',
    outcomeName: 'Bryan Battle', marketKey: 'h2h', point: null,
    decimal: 2.5, suggested_stake: 20,
  };
  const primaryScoreEvent = {
    completed: true,
    scores: [{ name: 'Bryan Battle', score: 0 }, { name: 'Dalton Rosta', score: 1 }],
  };
  // ESPN's own fallback data disagrees (says Battle won) — the primary,
  // already-real result wins; ESPN is only ever consulted when the primary
  // source has nothing.
  const results = [{ a: 'bryan battle', b: 'dalton rosta', aWon: true, bWon: false }];

  const outcome = gradeMmaPickWithFallback(pick, primaryScoreEvent, results);
  assert.equal(outcome.won, false);
});

test('gradeMmaPickWithFallback voids a draw/no-contest, never forces a win or loss', () => {
  const pick = {
    home: 'Bryan Battle', away: 'Dalton Rosta',
    outcomeName: 'Bryan Battle', marketKey: 'h2h', point: null,
    decimal: 2.5, suggested_stake: 20,
  };
  // Neither side marked winner — a draw or no-contest.
  const results = [{ a: 'bryan battle', b: 'dalton rosta', aWon: false, bWon: false }];
  const outcome = gradeMmaPickWithFallback(pick, undefined, results);
  // This used to stay pending forever. A draw on a two-way moneyline is a
  // push at every sportsbook, so it now settles as a void with the stake
  // returned — which still satisfies this test's actual point: no win or
  // loss is ever invented from a result that had neither.
  assert.equal(outcome.void, true);
  assert.equal(outcome.payout, 0);
  assert.equal(outcome.won, undefined);
});

test('gradeMmaPickWithFallback returns null (stays pending) when neither source has this fight', () => {
  const pick = {
    home: 'Someone Unmatched', away: 'Someone Else Unmatched',
    outcomeName: 'Someone Unmatched', marketKey: 'h2h', point: null,
    decimal: 2.5, suggested_stake: 20,
  };
  const outcome = gradeMmaPickWithFallback(pick, undefined, []);
  assert.equal(outcome, null);
});
