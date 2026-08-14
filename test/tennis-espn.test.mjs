import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchTennisResults,
  findTennisMatch,
  buildTennisScoreEvent,
  gradeTennisPickWithEspn,
  isRegradableTennisVoid,
  isNoOpTennisRegrade,
  regradeTennisVoids,
} from '../worker/src/tennis-espn.js';
import { UNSETTLEABLE_TENNIS_GAME_MARKET } from '../docs/learning.js';

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

test('ESPN\'s free games score settles before the metered source is spent', async () => {
  // tennis-results.js is capped at 30 calls/day. ESPN gives the same
  // set-by-set games for free and unmetered, so reaching for the meter when
  // ESPN already has the match is pure waste.
  let meterCalled = false;
  const pick = pickOf({ away: 'Lin Zhu', marketKey: 'totals', outcomeName: 'Under', point: 30.5 });
  const withGames = [{ ...results[0], setScoreAB: '3-6, 6-1, 6-1' }];
  const outcome = await gradeTennisPickWithEspn(pick, { completed: false, scores: null }, withGames, {}, ctx, Date.now(), {
    secondarySource: async () => { meterCalled = true; return null; },
  });
  assert.equal(meterCalled, false, 'the metered budget must not be touched when ESPN has the match');
  assert.equal(outcome.won, true, '23 games is under 30.5');
});

test('the metered source is still reached, and now sees a completed event', async () => {
  // The whole reason tennis-results.js never fired: it hard-gates on
  // scoreEvent.completed, which the odds feed never set for tennis. It is
  // now reached only when ESPN has no games score for the match.
  let sawCompleted = null;
  const pick = pickOf({ away: 'Lin Zhu', marketKey: 'spreads', point: -3.5, outcomeName: 'Lilli Tagger' });
  const noGames = [{ ...results[0], setScoreAB: null }];
  const outcome = await gradeTennisPickWithEspn(pick, { completed: false, scores: null }, noGames, {}, ctx, Date.now(), {
    secondarySource: async (_p, scoreEvent) => {
      sawCompleted = scoreEvent?.completed;
      return { won: true, payout: 16, detail: { setScore: '3-6, 6-1, 6-1', winner: 'Lilli Tagger' } };
    },
  });
  assert.equal(sawCompleted, true);
  assert.equal(outcome.won, true);
});

/* ---------------------------------------------------------------- */
/* Games markets — the void that shouldn't have been                 */
/* ---------------------------------------------------------------- */

/**
 * Tennis spreads and totals are priced in GAMES (confirmed against the live
 * catalogue: a spread ladder running -6.5 through 6.5 in half-game steps,
 * totals of 17.5-23.5), but the only score any feed carried was sets — so
 * gradeTennis voided every one. A single WTA day put eight such picks on the
 * board and voided all eight. ESPN's linescores are the games count.
 */
const finished = [{
  tour: 'wta',
  a: 'elena rybakina',
  b: 'iga swiatek',
  displayA: 'Elena Rybakina',
  displayB: 'Iga Swiatek',
  setsA: 0,
  setsB: 2,
  aWon: false,
  bWon: true,
  statusName: 'STATUS_FINAL',
  setScoreAB: '2-6, 3-6', // 17 games total
  note: '(7) Iga Swiatek (POL) bt (2) Elena Rybakina (KAZ) 6-2 6-3',
}];

const gamesPick = (over) => ({
  sportKey: 'tennis_wta_cincinnati_open',
  home: 'Iga Swiatek',
  away: 'Elena Rybakina',
  decimal: 1.9,
  suggested_stake: 20,
  commenceMs: Date.parse('2026-08-13T16:00Z'),
  ...over,
});

const noSecondary = { secondarySource: async () => null };

test('a total settles off ESPN game counts instead of voiding', async () => {
  const pick = gamesPick({ marketKey: 'totals', outcomeName: 'Under', point: 22.5 });
  const outcome = await gradeTennisPickWithEspn(pick, null, finished, {}, ctx, Date.now(), noSecondary);
  assert.equal(outcome.won, true, '17 games is under 22.5');
  assert.equal(outcome.payout, 18);
});

test('a spread settles off the game margin', async () => {
  const pick = gamesPick({ marketKey: 'spreads', outcomeName: 'Iga Swiatek', point: -3.5 });
  const outcome = await gradeTennisPickWithEspn(pick, null, finished, {}, ctx, Date.now(), noSecondary);
  assert.equal(outcome.won, true, 'Swiatek won 12 games to 5 — covers -3.5');
});

test('a total landing exactly on the number is a push, not a win', async () => {
  // The catalogue carries whole-number rungs (-4, -3, 1, 3), so this is
  // reachable, not theoretical.
  const pick = gamesPick({ marketKey: 'totals', outcomeName: 'Over', point: 17 });
  const outcome = await gradeTennisPickWithEspn(pick, null, finished, {}, ctx, Date.now(), noSecondary);
  assert.equal(outcome.void, true);
  assert.match(outcome.reason, /push/);
});

test('a retirement still voids a games market — no fixed final total exists', async () => {
  const retired = [{ ...finished[0], statusName: 'STATUS_RETIRED', setScoreAB: '6-4, 2-3', setsA: 1, setsB: 0, aWon: true, bWon: false }];
  const pick = gamesPick({ marketKey: 'totals', outcomeName: 'Under', point: 22.5 });
  const outcome = await gradeTennisPickWithEspn(pick, null, retired, {}, ctx, Date.now(), noSecondary);
  assert.equal(outcome.void, true);
});

test('orientation follows the pick\'s own names, not ESPN\'s spelling', async () => {
  // matchHomeIndex compares names by strict equality, so handing it ESPN's
  // spelling would silently fail to orient exactly the reversed-name case
  // this module's fuzzy matcher exists for.
  const reversed = [{ ...finished[0], a: 'swiatek iga', displayA: 'Swiatek Iga', b: 'elena rybakina', displayB: 'Elena Rybakina', setScoreAB: '6-2, 6-3' }];
  const pick = gamesPick({ marketKey: 'spreads', outcomeName: 'Iga Swiatek', point: -3.5 });
  const outcome = await gradeTennisPickWithEspn(pick, null, reversed, {}, ctx, Date.now(), noSecondary);
  assert.equal(outcome.won, true);
});

test('only a void from the games/sets rule is reopened — never a retraction', async () => {
  const settled = { sportKey: 'tennis_wta_x', status: 'void', result: { voidReason: UNSETTLEABLE_TENNIS_GAME_MARKET } };
  assert.equal(isRegradableTennisVoid(settled), true);

  assert.equal(isRegradableTennisVoid({ ...settled, retracted: { at: 1, reason: 'pulled' } }), false,
    'a manual retraction stays pulled — that is its entire point');
  assert.equal(isRegradableTennisVoid({ ...settled, result: { voidReason: 'walkover — no completed set' } }), false);
  assert.equal(isRegradableTennisVoid({ ...settled, sportKey: 'baseball_mlb' }), false);
  assert.equal(isRegradableTennisVoid({ ...settled, status: 'won' }), false);
});

test('a reopened void that still cannot settle is left alone, not rewritten', () => {
  const pick = { sportKey: 'tennis_wta_x', status: 'void', result: { voidReason: UNSETTLEABLE_TENNIS_GAME_MARKET } };
  assert.equal(isNoOpTennisRegrade(pick, { void: true, reason: UNSETTLEABLE_TENNIS_GAME_MARKET }), true);
  // A different void reason IS a change worth recording.
  assert.equal(isNoOpTennisRegrade(pick, { void: true, reason: 'push — total games landed exactly on the number' }), false);
  assert.equal(isNoOpTennisRegrade(pick, { won: true, payout: 18 }), false);
});

/* ---------------------------------------------------------------- */
/* Historical backfill                                               */
/* ---------------------------------------------------------------- */

const voidedTotal = (over) => ({
  pickId: 'p1',
  dateKey: '2026-08-13',
  sportKey: 'tennis_wta_cincinnati_open',
  marketKey: 'totals',
  home: 'Iga Swiatek',
  away: 'Elena Rybakina',
  outcomeName: 'Under',
  point: 22.5,
  decimal: 1.9,
  suggested_stake: 20,
  commenceMs: Date.parse('2026-08-13T16:00Z'),
  status: 'void',
  result: { payout: 0, roiPercent: 0, voidReason: UNSETTLEABLE_TENNIS_GAME_MARKET },
  ...over,
});

test('backfill re-settles an old void and rewrites its record', async () => {
  const changed = await regradeTennisVoids([voidedTotal()], {}, ctx, Date.now(), {
    fetchTennisResultsFn: async () => finished,
  });
  assert.equal(changed.length, 1);
  assert.equal(changed[0].status, 'won');
  assert.equal(changed[0].result.payout, 18);
  assert.equal(changed[0].result.roiPercent, 90);
  assert.equal(changed[0].result.voidReason, undefined, 'the stale void reason must not survive');
});

test('backfill fetches once per day, not once per pick', async () => {
  let fetches = 0;
  const sameDay = [
    voidedTotal({ pickId: 'a' }),
    voidedTotal({ pickId: 'b', point: 10.5 }),
    voidedTotal({ pickId: 'c', dateKey: '2026-08-12' }),
  ];
  await regradeTennisVoids(sameDay, {}, ctx, Date.now(), {
    fetchTennisResultsFn: async () => { fetches++; return finished; },
  });
  assert.equal(fetches, 2, 'two distinct days -> two fetches, not three picks -> three fetches');
});

test('backfill returns nothing when no outcome changed, so a re-run writes nothing', async () => {
  // ESPN has no match for this pick, so it lands back on the same void.
  const changed = await regradeTennisVoids([voidedTotal()], {}, ctx, Date.now(), {
    fetchTennisResultsFn: async () => [],
  });
  assert.deepEqual(changed, []);
});

test('backfill skips picks it has no business touching', async () => {
  const changed = await regradeTennisVoids([
    voidedTotal({ pickId: 'retracted', retracted: { at: 1, reason: 'pulled' } }),
    voidedTotal({ pickId: 'settled', status: 'lost', result: { payout: -20 } }),
    voidedTotal({ pickId: 'walkover', result: { voidReason: 'walkover — no completed set' } }),
    voidedTotal({ pickId: 'nodate', dateKey: undefined }),
  ], {}, ctx, Date.now(), { fetchTennisResultsFn: async () => finished });
  assert.deepEqual(changed, []);
});
