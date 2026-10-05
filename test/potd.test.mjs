import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POTD_HOUR,
  runPotdDaily,
  runPotdClvSnapshot,
  runPotdGrading,
  getPotd,
  getPotdHold,
  getPotdHistory,
} from '../worker/src/potd.js';
import { seedTennisArchiveCacheForTests } from '../worker/src/tennis-archive.js';

// The tennis form gate (docs/qualitative.js) reads the static archive; unit
// tests must never hit the network, and a null archive is the honest
// degraded mode (favorites pass unscored, unsupported dogs are blocked).
seedTennisArchiveCacheForTests({ atp: null, wta: null });
import { seedTeamContextCacheForTests } from '../worker/src/team-form.js';
// Same reasoning for team sports: seeding SEALS the memo, so no fixture in
// these slates reaches cdn.espn.com. An empty seed is the honest degraded
// mode — no context, so no form re-score and no underdog gate, exactly what
// an unreachable ESPN produces in production.
seedTeamContextCacheForTests({});

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

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
const NOW = Date.parse('2026-08-05T07:00:00Z'); // 3am ET Aug 5 (EDT) — after POTD_HOUR

/**
 * A single-market h2h event, deep enough to clear RULES.MIN_SCORE.
 *
 * Today-fixture commence times sit ~2h after NOW — INSIDE each sport's
 * per-game lock lead window (tracking.js's PICK_LEAD_HOURS: 3h MLB, 2.5h
 * default) — because runPotdDaily only finalizes once every eligible game's
 * own window has opened (scheduleStillOpen). These tests predate that
 * per-game timing; the original 4pm-ET fixtures now (correctly) leave the
 * whole day "still comparing" at the tests' 3am-ET NOW.
 */
/**
 * The defaults are an anchor-grade NFL favourite (docs/tickets.js): every
 * registry book at -320/+255 and book 0 sixty cents better on the home
 * side, so the home side reads 74.5% by the market at -260 with ~3% EV.
 * Two of them pair to a -109 ticket that lands 56% of the time — which is
 * what a Play of the Day is now.
 */
function makeEvent(id, commenceIso, { sport = 'americanfootball_nfl', sportTitle = 'NFL', outlier = 60, favoritePrice = -320, dogPrice = 255, lastUpdate = NOW - 600000 } = {}) {
  // Registry (bettable) books: the curated boards refuse a best price at a
  // book the reader can't use, so a fixture priced at fake keys would never
  // post at all.
  const books = ['draftkings', 'fanduel', 'betmgm', 'williamhill_us', 'betrivers', 'espnbet', 'fanatics', 'hardrockbet'];
  return {
    id,
    sport_key: sport,
    sport_title: sportTitle,
    commence_time: commenceIso,
    home_team: `${id} Home`,
    away_team: `${id} Away`,
    bookmakers: books.map((key, i) => ({
      key,
      title: key,
      last_update: new Date(lastUpdate).toISOString(),
      markets: [{
        key: 'h2h',
        last_update: new Date(lastUpdate).toISOString(),
        outcomes: [
          { name: `${id} Home`, price: favoritePrice + (i === 0 ? outlier : 0) },
          { name: `${id} Away`, price: dogPrice },
        ],
      }],
    })),
  };
}

/* ---------------------------------------------------------------- */
/* runPotdDaily — odds band                                          */
/* ---------------------------------------------------------------- */

test('POTD_HOUR is 2am ET', () => {
  assert.equal(POTD_HOUR, 2);
});

const tennis = { sport: 'tennis_atp_canadian_open', sportTitle: 'ATP Canadian Open' };
const pair = (a, b, opts = {}) => [makeEvent(a, '2026-08-05T09:00:00Z', opts), makeEvent(b, '2026-08-05T09:30:00Z', opts)];

test('the Play of the Day is a two-leg ticket: an anchor and a partner from two games, -200..+100 together', async () => {
  const { env } = makeKvStore();
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => pair('a', 'b') });
  assert.equal(result.skipped, false);
  const { pick } = result;
  assert.equal(pick.type, 'combo');
  assert.equal(pick.legs.length, 2);
  assert.notEqual(pick.legs[0].eventId, pick.legs[1].eventId);
  assert.ok(pick.american >= -200 && pick.american <= 100, `priced ${pick.american}`);
  assert.ok(pick.consensusProb > 0.5, 'both legs more likely than not to land');
  assert.equal(pick.meetsStandard, true);
});

test('the richest pair by expected value is the day\'s play', async () => {
  const { env } = makeKvStore();
  const events = [
    ...pair('a', 'b'),
    // A bigger outlier is more edge on the same market read.
    makeEvent('standout', '2026-08-05T10:00:00Z', { outlier: 85 }),
  ];
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, false);
  assert.ok(result.pick.legs.some((l) => l.eventId === 'standout'));
});

test('legs that never pair inside the band post nothing — and the hold says so', async () => {
  const { env, store } = makeKvStore();
  // A -900 chalk (a fine anchor with a real edge, but 1.11x) and a -105
  // favourite-side partner (1.95x): 2.17 together, past +100. No ticket,
  // no fallback.
  const events = [
    makeEvent('chalk', '2026-08-05T09:00:00Z', { favoritePrice: -1800, dogPrice: 1200, outlier: 900 }),
    makeEvent('light', '2026-08-05T09:30:00Z', { favoritePrice: -140, dogPrice: 120, outlier: 35 }),
  ];
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /no two pair inside/);
  assert.equal(store.has('potd:2026-08-05'), false);
  assert.match((await getPotdHold(env, NOW)).reason, /no two pair/);
});

test('a candidate whose segment the weekly algorithm health review has paused is never a leg, even if it scores best', async () => {
  const { env } = makeKvStore();
  await env.POTD_KV.put('algo:paused', JSON.stringify([{ key: 'americanfootball_nfl|h2h', pausedAt: NOW, reason: 'test' }]));
  const events = [...pair('nfl-a', 'nfl-b', { outlier: 85 }), ...pair('atp-a', 'atp-b', tennis)];
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, false);
  assert.ok(result.pick.legs.every((l) => l.sportKey === 'tennis_atp_canadian_open'));
});

test('the boards draw from NFL, NCAA football, MMA and tennis only', async () => {
  const { env } = makeKvStore();
  const events = [...pair('mlb-a', 'mlb-b', { sport: 'baseball_mlb', sportTitle: 'MLB', outlier: 85 }), ...pair('nfl-a', 'nfl-b')];
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, false);
  assert.deepEqual(result.pick.legs.map((l) => l.eventId).sort(), ['nfl-a', 'nfl-b']);
});

test('a slate with no edge posts NO Play of the Day — and records why', async () => {
  const { env, store } = makeKvStore();
  // Every book at exactly the same price: the best price IS the consensus,
  // so the "edge" is the vig, negative. A bet the engine grades as a loser
  // is not a Play of the Day at any label.
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => pair('weak-a', 'weak-b', { outlier: 0 }) });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /clears the edge floor/);
  assert.equal(store.has('potd:2026-08-05'), false, 'no pick written');
  const hold = await getPotdHold(env, NOW);
  assert.ok(hold, 'the hold is recorded so the card can say why');
  assert.match(hold.reason, /edge floor/);
  assert.equal(await getPotd(env, NOW), null);
});

test('a slate with literally no gradeable game posts nothing — and says so', async () => {
  const { env, store } = makeKvStore();
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => [] });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no gradeable NFL, NCAA football, MMA or tennis game on the slate today');
  // The only write is the day's hold record — never a pick.
  assert.deepEqual([...store.keys()], ['potd:hold:2026-08-05']);
});

test('a slate priced only at books the reader cannot bet posts no Play of the Day', async () => {
  const { env } = makeKvStore();
  const events = pair('offshore-a', 'offshore-b');
  for (const e of events) e.bookmakers.forEach((b, i) => { b.key = `offshore${i}`; b.title = `Offshore ${i}`; });
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /clears the edge floor/);
});

test('a pick posting later in the day clears an earlier hold', async () => {
  const { env } = makeKvStore();
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => [] });
  assert.ok(await getPotdHold(env, NOW));
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => pair('late-a', 'late-b') });
  assert.equal(result.skipped, false);
  assert.equal(await getPotdHold(env, NOW), null);
});

test('an NFL prop leg anchors the ticket when a game offers one', async () => {
  const { env } = makeKvStore();
  const propLeg = {
    id: 'b:player_reception_yds_alternate:some player:49.5:Over', kind: 'prop', eventId: 'b',
    sportKey: 'americanfootball_nfl', sportTitle: 'NFL', commenceMs: Date.parse('2026-08-05T09:30:00Z'), home: 'b Home', away: 'b Away',
    marketKey: 'player_reception_yds_alternate', marketLabel: 'Receiving Yards (alt)', statKey: 'recYds', playerName: 'Some Player',
    outcomeName: 'Over', point: 49.5, need: 50, selection: 'Some Player 50+ Rec Yds', american: -380, decimal: 1.263, book: 'DraftKings',
    bookKey: 'draftkings', bettable: true, consensusProb: 0.86, ev: 0.086, score: 92, espnEventId: '401',
    profile: { games: 5, season: 1, l10: 1, l5: 1, streak: 5, avgSeason: 78, avgL5: 81 }, edge: 0.07,
  };
  const events = [makeEvent('a', '2026-08-05T09:00:00Z'), makeEvent('b', '2026-08-05T09:30:00Z', { outlier: 0 })];
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events, fetchPropLegs: async () => [propLeg] });
  assert.equal(result.skipped, false);
  assert.equal(result.pick.legs[0].kind, 'prop');
  assert.equal(result.pick.legs[1].eventId, 'a');
  const record = await getPotd(env, NOW);
  assert.equal(record.writeup.legs[0].kind, 'prop');
  assert.match(record.writeup.legs[0].note, /cleared 50\+ in 100% of 5 games/);
});

test('before the generation hour, the day is not drawn at all', async () => {
  const { env, store } = makeKvStore();
  const oneAmEt = Date.parse('2026-08-05T05:00:00Z'); // 1am ET Aug 5 (EDT)
  const events = [makeEvent('early', '2026-08-05T23:00:00Z', { outlier: 30 })];
  const result = await runPotdDaily(env, ctx, oneAmEt, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'before generation hour');
  assert.equal(store.size, 0);
});

test('an exhibition-format game is never a leg even if it scores well', async () => {
  const { env } = makeKvStore();
  const events = [makeEvent('allstar', '2026-08-05T09:00:00Z'), makeEvent('b', '2026-08-05T09:30:00Z')];
  events[0].home_team = 'Team LeBron';
  events[0].away_team = 'Team Giannis';
  events[0].bookmakers.forEach((b) => b.markets[0].outcomes.forEach((o) => {
    o.name = o.name.includes('Home') ? 'Team LeBron' : 'Team Giannis';
  }));
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, true, 'with the exhibition out, one leg is left, and one leg is not a ticket');
});

/* ---------------------------------------------------------------- */
/* runPotdDaily — eligibility window                                 */
/* ---------------------------------------------------------------- */

test('excludes games on other calendar dates', async () => {
  const { env } = makeKvStore();
  const events = [
    makeEvent('yesterday', '2026-08-04T20:00:00Z'),
    makeEvent('yesterday-b', '2026-08-04T20:30:00Z'),
    makeEvent('tomorrow', '2026-08-06T20:00:00Z'),
    makeEvent('tomorrow-b', '2026-08-06T20:30:00Z'),
  ];
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, true);
});

test('tennis next-day carve-out: a just-past-midnight match is eligible, an ordinary tomorrow match is not', async () => {
  // Positive: 11pm ET Aug 5 with a 1am ET Aug 6 match — a night session
  // rolling past midnight, inside the midnight-2am ET carve-out and its own
  // 2.5h lock window.
  {
    const { env } = makeKvStore();
    const lateNow = Date.parse('2026-08-06T03:00:00Z'); // 11pm ET Aug 5
    const events = [
      makeEvent('tennis-1am', '2026-08-06T05:00:00Z', { ...tennis, lastUpdate: lateNow - 600000 }),
      makeEvent('tennis-1am-b', '2026-08-06T05:30:00Z', { ...tennis, lastUpdate: lateNow - 600000 }),
    ];
    const result = await runPotdDaily(env, ctx, lateNow, { fetchFullSlate: async () => events });
    assert.equal(result.skipped, false, 'matches rolling just past midnight can be today\'s Play of the Day');
  }
  // Negative: an ordinary tomorrow-4pm-ET match must NOT be selectable as
  // TODAY's Play of the Day. POTD previously had NO hour cutoff at all here
  // (it accepted the entire next day) — this is the regression test for
  // that fix; only midnight-2am ET next-day starts count, per explicit
  // product direction.
  {
    const { env } = makeKvStore();
    const events = [
      makeEvent('tomorrow-tennis-pm', '2026-08-06T20:00:00Z', tennis),
      makeEvent('tomorrow-tennis-pm-b', '2026-08-06T20:30:00Z', tennis),
    ];
    const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
    assert.equal(result.skipped, true, 'an ordinary tomorrow match must never be today\'s Play of the Day');
  }
});

test('excludes a game that has already started', async () => {
  const { env } = makeKvStore();
  const events = [makeEvent('underway', '2026-08-05T06:00:00Z'), makeEvent('underway-b', '2026-08-05T06:30:00Z')]; // before NOW (7am UTC)
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, true);
});

test('an empty slate skips cleanly, writing only the hold record', async () => {
  const { env, store } = makeKvStore();
  const result = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => [] });
  assert.equal(result.skipped, true);
  assert.deepEqual([...store.keys()], ['potd:hold:2026-08-05']);
});

/* ---------------------------------------------------------------- */
/* runPotdDaily — idempotency                                        */
/* ---------------------------------------------------------------- */

test('a date already generated is never regenerated', async () => {
  const { env, store } = makeKvStore();
  const events = pair('a', 'b');

  const first = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(first.skipped, false);
  const storedAfterFirst = store.get('potd:2026-08-05');

  const second = await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already generated');
  assert.equal(store.get('potd:2026-08-05'), storedAfterFirst);
});

/* ---------------------------------------------------------------- */
/* runPotdDaily — write-up + tracking fields                         */
/* ---------------------------------------------------------------- */

test('the stored record carries a ticket headline, both legs, the combined price, and tracking fields', async () => {
  const { env, store } = makeKvStore();
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => pair('a', 'b') });

  const record = JSON.parse(store.get('potd:2026-08-05'));
  assert.equal(record.date, '2026-08-05');
  assert.match(record.writeup.headline, /^[ab] Home to win \+ [ab] Home to win \([+-]\d+\)$/);
  assert.equal(record.writeup.marketLabel, '2-leg ticket');
  assert.equal(record.writeup.legs.length, 2);
  assert.ok(record.writeup.legs.every((l) => l.selection && l.price && l.matchup && l.note));
  assert.match(record.writeup.pairReason, /Anchor: .* Partner: /);
  // The quantitative price case is no longer a writeup section (it duplicated
  // the dedicated book-price table) — confirm it's gone rather than present.
  assert.equal(record.writeup.sections.find((s) => s.title === 'The Market & Price Case'), undefined);

  assert.equal(record.pick.type, 'combo');
  assert.equal(record.pick.legs.length, 2);
  assert.equal(record.pick.status, 'pending');
  assert.equal(record.pick.american, record.writeup.american);
  // The flagship's own confidence-scaled unit band at $25/1U.
  assert.ok(record.pick.stakeUnits >= 1 && record.pick.stakeUnits <= 3, `POTD units in [1, 3], got ${record.pick.stakeUnits}`);
  assert.equal(record.pick.suggested_stake, record.pick.stakeUnits * 25);
  assert.equal(record.pick.dateKey, '2026-08-05');
  // A ticket spans two markets: no single closing line to track.
  assert.equal(record.pick.clv, null);
  assert.equal(record.pick.result, null);
});

test('the writeup carries the feature leg\'s quotes for the book price table, and degrades cleanly with no sharp-analysis fields when ANTHROPIC_API_KEY is unset', async () => {
  const { env, store } = makeKvStore();
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => pair('a', 'b') });

  const record = JSON.parse(store.get('potd:2026-08-05'));
  // makeEvent's own bookmakers array (8 books) flows through to quotes.
  assert.ok(Array.isArray(record.writeup.quotes));
  assert.equal(record.writeup.quotes.length, 8);

  // No ANTHROPIC_API_KEY in this test's env — getOrGenerateAnalysis returns
  // null immediately, and buildRecord must still post the pick with the
  // sharp-analysis fields simply absent, never throwing or blocking.
  assert.equal(record.writeup.analysis, null);
  assert.equal(record.writeup.reasons, null);
  assert.equal(record.writeup.devilsAdvocate, null);
});

/* ---------------------------------------------------------------- */
/* runPotdClvSnapshot                                                 */
/* ---------------------------------------------------------------- */

test('runPotdClvSnapshot leaves a ticket alone — a parlay has no single closing line', async () => {
  const { env } = makeKvStore();
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => pair('a', 'b') });
  const before = await getPotd(env, NOW);
  assert.equal(before.pick.clv, null);
  const moved = pair('a', 'b', { outlier: 90 });
  const r = await runPotdClvSnapshot(env, ctx, NOW + 3.6e6, { fetchSportFn: async () => ({ events: moved }) });
  assert.equal(r.updated, false);
});

/* ---------------------------------------------------------------- */
/* runPotdGrading                                                     */
/* ---------------------------------------------------------------- */

const finalScore = (id, homeScore, awayScore) => ({
  id, completed: true, scores: [{ name: `${id} Home`, score: String(homeScore) }, { name: `${id} Away`, score: String(awayScore) }],
});

test('runPotdGrading settles the ticket leg by leg: both legs win, the ticket wins at its combined price', async () => {
  const { env } = makeKvStore();
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => pair('a', 'b') });
  const before = await getPotd(env, NOW);
  const games = before.pick.legs.map((l) => l.eventId);

  const result = await runPotdGrading(env, ctx, NOW + 6 * 3.6e6, {
    fetchScoresFn: async () => ({ events: games.map((g) => finalScore(g, 27, 10)) }),
  });
  assert.equal(result.graded, true);

  const after = await getPotd(env, NOW);
  assert.equal(after.pick.status, 'won');
  assert.ok(after.pick.legs.every((l) => l.status === 'won'));
  assert.ok(Math.abs(after.pick.result.payout - (after.pick.decimal - 1) * after.pick.suggested_stake) < 1e-6);
});

test('one losing leg loses the ticket', async () => {
  const { env } = makeKvStore();
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => pair('a', 'b') });
  const before = await getPotd(env, NOW);
  const [anchorGame, partnerGame] = before.pick.legs.map((l) => l.eventId);
  await runPotdGrading(env, ctx, NOW + 6 * 3.6e6, {
    fetchScoresFn: async () => ({ events: [finalScore(anchorGame, 27, 10), finalScore(partnerGame, 3, 30)] }),
  });
  const after = await getPotd(env, NOW);
  assert.equal(after.pick.status, 'lost');
  assert.equal(after.pick.result.payout, -after.pick.suggested_stake);
  assert.deepEqual(after.pick.legs.map((l) => l.status), ['won', 'lost']);
});

test('runPotdGrading leaves the ticket pending while any leg has no completed score', async () => {
  const { env } = makeKvStore();
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => pair('a', 'b') });
  const before = await getPotd(env, NOW);
  const [anchorGame] = before.pick.legs.map((l) => l.eventId);
  const result = await runPotdGrading(env, ctx, NOW + 3.6e6, { fetchScoresFn: async () => ({ events: [finalScore(anchorGame, 27, 10)] }) });
  assert.equal(result.graded, false);
  const potd = await getPotd(env, NOW);
  assert.equal(potd.pick.status, 'pending');
});

/* ---------------------------------------------------------------- */
/* getPotd — read path                                                */
/* ---------------------------------------------------------------- */

test('getPotd returns today\'s record when present', async () => {
  const { env, store } = makeKvStore();
  store.set('potd:2026-08-05', JSON.stringify({ date: '2026-08-05', pick: { selection: 'Today' } }));
  const potd = await getPotd(env, NOW);
  assert.equal(potd.pick.selection, 'Today');
  assert.equal(potd.stale, undefined);
});

test('getPotd falls back to yesterday, labelled stale, when today has nothing', async () => {
  const { env, store } = makeKvStore();
  store.set('potd:2026-08-04', JSON.stringify({ date: '2026-08-04', pick: { selection: 'Yesterday' } }));
  const potd = await getPotd(env, NOW);
  assert.equal(potd.pick.selection, 'Yesterday');
  assert.equal(potd.stale, true);
});

test('getPotd returns null when nothing has ever been generated', async () => {
  const { env } = makeKvStore();
  const potd = await getPotd(env, NOW);
  assert.equal(potd, null);
});

/* ---------------------------------------------------------------- */
/* getPotdHistory                                                     */
/* ---------------------------------------------------------------- */

test('getPotdHistory walks multiple days and returns one pick per day generated', async () => {
  const { env } = makeKvStore();
  const day1 = NOW;
  const day2 = NOW + 86400000;

  await runPotdDaily(env, ctx, day1, { fetchFullSlate: async () => pair('d1a', 'd1b') });
  // d2: 2h after day2's own "now", quotes fresh as of day2.
  await runPotdDaily(env, ctx, day2, { fetchFullSlate: async () => [
    makeEvent('d2a', '2026-08-06T09:00:00Z', { lastUpdate: day2 - 600000 }),
    makeEvent('d2b', '2026-08-06T09:30:00Z', { lastUpdate: day2 - 600000 }),
  ] });

  const history = await getPotdHistory(env, { now: day2, days: 5 });
  assert.equal(history.length, 2);
  assert.ok(history.every((p) => p.dateKey && p.status === 'pending'));
});

test('getPotdHistory skips days with nothing generated', async () => {
  const { env } = makeKvStore();
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => pair('d1a', 'd1b') });

  const history = await getPotdHistory(env, { now: NOW, days: 5 });
  assert.equal(history.length, 1);
});

test('getPotdHistory skips a pre-migration record with no tracking fields', async () => {
  const { env, store } = makeKvStore();
  // Shape the old two-phase/per-sport system wrote: a write-up-only pick
  // with no status/clv/result/dateKey at all.
  store.set('potd:2026-08-04', JSON.stringify({
    date: '2026-08-04',
    pick: { id: 'old:h2h|Foo|', selection: 'Foo to win', american: 500 },
  }));
  await runPotdDaily(env, ctx, NOW, { fetchFullSlate: async () => pair('d1a', 'd1b') });

  const history = await getPotdHistory(env, { now: NOW, days: 5 });
  assert.equal(history.length, 1);
  assert.equal(history[0].dateKey, '2026-08-05');
});
