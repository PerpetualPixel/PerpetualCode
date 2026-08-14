import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchTennisResults,
  findTennisMatch,
  buildTennisScoreEvent,
  gradeTennisPickWithEspn,
} from '../worker/src/tennis-espn.js';

/**
 * Fixtures below mirror the exact shapes read off a live ESPN tennis
 * scoreboard response (site.web.api.espn.com/.../tennis/wta/scoreboard) —
 * events -> groupings -> competitions, per-set `linescores` carrying their
 * own `winner` flag, doubles competitors carrying a `roster` instead of an
 * `athlete`, and STATUS_FINAL / STATUS_RETIRED / STATUS_WALKOVER as the
 * three completed states. Anything here that looks oddly specific (the
 * "Zhu Lin" name-order case, the walkover's missing linescores) is copied
 * from a real match in that response, not invented.
 */

const ctx = { waitUntil: (p) => p };

function stubEspn(payloadByUrl) {
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async (url) => {
    const key = Object.keys(payloadByUrl).find((k) => String(url).includes(k));
    if (!key) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, text: async () => JSON.stringify(payloadByUrl[key]) };
  };
}

/** One completed singles competition, given per-set [a, b] game pairs. */
function singles(nameA, nameB, sets, { status = 'STATUS_FINAL', winner = 'a', note = null } = {}) {
  const linescores = (side) => sets.map(([av, bv]) => {
    const mine = side === 'a' ? av : bv;
    const theirs = side === 'a' ? bv : av;
    // A set with no decided winner (an in-progress set at retirement time)
    // is expressed by passing equal games, matching how ESPN leaves the
    // `winner` flag off both sides of an unfinished set.
    return mine === theirs ? { value: mine } : { value: mine, winner: mine > theirs };
  });
  return {
    status: { type: { name: status, completed: true } },
    type: { slug: 'womens-singles' },
    notes: note ? [{ text: note, type: 'event' }] : [],
    competitors: [
      { homeAway: 'home', winner: winner === 'a', athlete: { displayName: nameA }, ...(sets.length ? { linescores: linescores('a') } : {}) },
      { homeAway: 'away', winner: winner === 'b', athlete: { displayName: nameB }, ...(sets.length ? { linescores: linescores('b') } : {}) },
    ],
  };
}

function doubles(displayA, displayB) {
  return {
    status: { type: { name: 'STATUS_FINAL', completed: true } },
    type: { slug: 'womens-doubles' },
    competitors: [
      { winner: true, roster: { displayName: displayA, athletes: [] }, linescores: [{ value: 6, winner: true }, { value: 6, winner: true }] },
      { winner: false, roster: { displayName: displayB, athletes: [] }, linescores: [{ value: 3, winner: false }, { value: 4, winner: false }] },
    ],
  };
}

function scoreboard(competitions, { doublesComps = [] } = {}) {
  return {
    events: [{
      id: '718-2026',
      name: 'Cincinnati Open',
      groupings: [
        { grouping: { slug: 'womens-singles' }, competitions },
        { grouping: { slug: 'womens-doubles' }, competitions: doublesComps },
      ],
    }],
  };
}

const pickOf = (over) => ({
  sportKey: 'tennis_wta_cincinnati_open',
  marketKey: 'h2h',
  home: 'Lilli Tagger',
  away: 'Lin Zhu',
  outcomeName: 'Lilli Tagger',
  decimal: 1.8,
  suggested_stake: 20,
  commenceMs: Date.parse('2026-08-13T16:00Z'),
  ...over,
});

/* ---------------------------------------------------------------- */
/* Fetch + parse                                                     */
/* ---------------------------------------------------------------- */

test('pulls completed singles results off the tour scoreboard', async () => {
  stubEspn({
    '/tennis/wta/scoreboard': scoreboard([
      singles('Lilli Tagger', 'Zhu Lin', [[3, 6], [6, 1], [6, 1]], { note: 'Lilli Tagger (AUT) bt Zhu Lin (CHN) 3-6 6-1 6-1' }),
    ]),
    '/tennis/atp/scoreboard': { events: [] },
  });

  const results = await fetchTennisResults(ctx, Date.parse('2026-08-13T20:00Z'));
  assert.equal(results.length, 1);
  assert.equal(results[0].tour, 'wta');
  assert.equal(results[0].setsA, 2);
  assert.equal(results[0].setsB, 1);
  assert.equal(results[0].aWon, true);
});

test('the same tournament draw returned under several dates is counted once', async () => {
  // Every requested date returns the whole active draw, so the identical
  // match arrives once per date — a duplicate here would look like the
  // ambiguity guard's "two matches" and strand the pick.
  stubEspn({
    '/tennis/wta/scoreboard': scoreboard([singles('Lilli Tagger', 'Zhu Lin', [[6, 3], [6, 1]])]),
    '/tennis/atp/scoreboard': { events: [] },
  });
  const results = await fetchTennisResults(ctx, Date.parse('2026-08-13T20:00Z'));
  assert.equal(results.length, 1);
});

test('leaves out matches that have not finished', async () => {
  stubEspn({
    '/tennis/wta/scoreboard': {
      events: [{
        name: 'Cincinnati Open',
        groupings: [{
          grouping: { slug: 'womens-singles' },
          competitions: [{
            status: { type: { name: 'STATUS_IN_PROGRESS', completed: false } },
            competitors: [
              { athlete: { displayName: 'Lilli Tagger' }, linescores: [{ value: 6, winner: true }] },
              { athlete: { displayName: 'Zhu Lin' }, linescores: [{ value: 4, winner: false }] },
            ],
          }],
        }],
      }],
    },
    '/tennis/atp/scoreboard': { events: [] },
  });
  assert.deepEqual(await fetchTennisResults(ctx, Date.now()), []);
});

test('excludes doubles entirely, so a pairing never settles a singles bet', async () => {
  // "Lilli Tagger / Zhu Lin" contains both singles names as substrings; a
  // matcher that saw doubles at all would settle the singles pick off it.
  stubEspn({
    '/tennis/wta/scoreboard': scoreboard([], {
      doublesComps: [doubles('Lilli Tagger / Janice Tjen', 'Zhu Lin / Katarzyna Piter')],
    }),
    '/tennis/atp/scoreboard': { events: [] },
  });
  assert.deepEqual(await fetchTennisResults(ctx, Date.now()), []);
});

test('one tour failing to load does not sink the other', async () => {
  stubEspn({ '/tennis/wta/scoreboard': scoreboard([singles('Lilli Tagger', 'Zhu Lin', [[6, 3], [6, 1]])]) });
  const results = await fetchTennisResults(ctx, Date.now());
  assert.equal(results.length, 1);
});

/* ---------------------------------------------------------------- */
/* Name matching                                                     */
/* ---------------------------------------------------------------- */

const results = [
  {
    tour: 'wta',
    a: 'lilli tagger',
    b: 'zhu lin',
    displayA: 'Lilli Tagger',
    displayB: 'Zhu Lin',
    setsA: 2,
    setsB: 1,
    aWon: true,
    bWon: false,
    statusName: 'STATUS_FINAL',
    setScoreAB: '3-6, 6-1, 6-1',
    note: null,
  },
];

test('matches a player the two feeds name in opposite order', () => {
  // ESPN lists "Zhu Lin"; the odds feed lists "Lin Zhu". Same player, and
  // neither a surname comparison nor a substring check catches it.
  assert.ok(findTennisMatch(pickOf({ away: 'Lin Zhu' }), results));
});

test('matches through an accent the odds feed drops', () => {
  const accented = [{ ...results[0], a: 'karolina muchova', displayA: 'Karolina Muchová' }];
  assert.ok(findTennisMatch(pickOf({ home: 'Karolina Muchova', away: 'Lin Zhu' }), accented));
});

test('never crosses tours', () => {
  assert.equal(findTennisMatch(pickOf({ sportKey: 'tennis_atp_cincinnati_open' }), results), null);
});

test('refuses to guess when two matches fit the same name pair', () => {
  // A shared surname is common in tennis, and the loose fallbacks can
  // plausibly hit twice in a big draw. Pending is recoverable; settled off
  // the wrong match is not.
  const ambiguous = [results[0], { ...results[0], displayA: 'Someone Else' }];
  assert.equal(findTennisMatch(pickOf({ away: 'Lin Zhu' }), ambiguous), null);
});

test('returns null rather than a partial match when only one player fits', () => {
  assert.equal(findTennisMatch(pickOf({ away: 'Aryna Sabalenka' }), results), null);
});

/* ---------------------------------------------------------------- */
/* Synthetic score events + settlement                               */
/* ---------------------------------------------------------------- */

test('builds a sets-won score event oriented to the pick\'s own home/away', () => {
  const event = buildTennisScoreEvent(pickOf({ away: 'Lin Zhu' }), results);
  assert.deepEqual(event, {
    completed: true,
    scores: [
      { name: 'Lilli Tagger', score: 2 },
      { name: 'Lin Zhu', score: 1 },
    ],
  });
});

test('settles a finished match the odds feed never posted', async () => {
  const pick = pickOf({ away: 'Lin Zhu' });
  const oddsFeedEvent = { id: 'abc', completed: false, scores: null }; // what tennis actually returns
  const outcome = await gradeTennisPickWithEspn(pick, oddsFeedEvent, results, {}, ctx, Date.now(), {
    secondarySource: async () => null,
  });
  assert.equal(outcome.won, true);
  assert.equal(outcome.payout, 16);
  assert.deepEqual(outcome.detail, { setScore: '3-6, 6-1, 6-1', winner: 'Lilli Tagger' });
});

test('a retirement settles to whoever was ahead on completed sets', async () => {
  // "Popyrin bt Kokkinakis 6-4 2-3 ret" — one completed set, so 1-0, which
  // docs/learning.js's gradeTennis already awards to the player ahead.
  const retired = [{
    ...results[0],
    a: 'alexei popyrin',
    b: 'thanasi kokkinakis',
    displayA: 'Alexei Popyrin',
    displayB: 'Thanasi Kokkinakis',
    setsA: 1,
    setsB: 0,
    statusName: 'STATUS_RETIRED',
    setScoreAB: '6-4, 2-3',
  }];
  const pick = pickOf({
    sportKey: 'tennis_atp_cincinnati_open',
    home: 'Alexei Popyrin',
    away: 'Thanasi Kokkinakis',
    outcomeName: 'Alexei Popyrin',
  });
  const outcome = await gradeTennisPickWithEspn({ ...pick, sportKey: 'tennis_wta_cincinnati_open' }, null, retired, {}, ctx, Date.now(), {
    secondarySource: async () => null,
  });
  assert.equal(outcome.won, true);
  assert.equal(outcome.retired, true);
});

test('a walkover voids rather than paying out ESPN\'s nominal winner', async () => {
  const walkover = [{ ...results[0], setsA: 0, setsB: 0, statusName: 'STATUS_WALKOVER', setScoreAB: null }];
  const pick = pickOf({ away: 'Lin Zhu', commenceMs: Date.parse('2026-08-13T16:00Z') });
  const outcome = await gradeTennisPickWithEspn(pick, null, walkover, {}, ctx, Date.parse('2026-08-14T20:00Z'), {
    secondarySource: async () => null,
  });
  assert.equal(outcome.void, true);
  assert.match(outcome.reason, /walkover/);
});

test('falls back to the odds feed when ESPN has no matching match', async () => {
  const pick = pickOf({ home: 'Aryna Sabalenka', away: 'Coco Gauff', outcomeName: 'Aryna Sabalenka' });
  const oddsFeedEvent = {
    completed: true,
    scores: [{ name: 'Aryna Sabalenka', score: 2 }, { name: 'Coco Gauff', score: 0 }],
  };
  const outcome = await gradeTennisPickWithEspn(pick, oddsFeedEvent, results, {}, ctx, Date.now(), {
    secondarySource: async () => null,
  });
  assert.equal(outcome.won, true);
});

test('leaves a pick pending when neither source has the match', async () => {
  const pick = pickOf({ home: 'Aryna Sabalenka', away: 'Coco Gauff', outcomeName: 'Aryna Sabalenka' });
  const outcome = await gradeTennisPickWithEspn(pick, { completed: false, scores: null }, results, {}, ctx, Date.now(), {
    secondarySource: async () => null,
  });
  assert.equal(outcome, null);
});

test('the metered source now sees a completed event, and its answer wins', async () => {
  // The whole reason tennis-results.js never fired: it hard-gates on
  // scoreEvent.completed, which the odds feed never set for tennis.
  let sawCompleted = null;
  const pick = pickOf({ away: 'Lin Zhu', marketKey: 'spreads', point: -3.5, outcomeName: 'Lilli Tagger' });
  const outcome = await gradeTennisPickWithEspn(pick, { completed: false, scores: null }, results, {}, ctx, Date.now(), {
    secondarySource: async (_p, scoreEvent) => {
      sawCompleted = scoreEvent?.completed;
      return { won: true, payout: 16, detail: { setScore: '3-6, 6-1, 6-1', winner: 'Lilli Tagger' } };
    },
  });
  assert.equal(sawCompleted, true);
  assert.equal(outcome.won, true);
});
