import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runFullSlateBatch,
  runFullSlateClvSnapshot,
  runFullSlateGrading,
  getFullSlateTracked,
  getAllFullSlateTracked,
  resetFullSlateTracking,
  diagnosePendingFullSlate,
  regradeFullSlateTennisVoids,
  backfillMmaFinishDetail,
  manualMmaResult,
  auditMmaTotalsGrading,
  regradeMmaTotals,
} from '../worker/src/full-slate-tracking.js';
import { seedTennisArchiveCacheForTests } from '../worker/src/tennis-archive.js';
import { UNSETTLEABLE_TENNIS_GAME_MARKET } from '../docs/learning.js';

// The tennis form gate (docs/qualitative.js) reads the static archive; unit
// tests must never hit the network, and a null archive is the honest
// degraded mode (favorites pass unscored, unsupported dogs are blocked).
seedTennisArchiveCacheForTests({ atp: null, wta: null });

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
const NOW = Date.parse('2026-08-05T12:00:00Z'); // 8am ET Aug 5 (EDT)

const BOOKS = ['DraftKings', 'FanDuel', 'BetMGM', 'Caesars', 'BetRivers', 'ESPN BET', 'Fanatics', 'Hard Rock Bet'];
const BOOK_KEYS = {
  DraftKings: 'draftkings', FanDuel: 'fanduel', BetMGM: 'betmgm', Caesars: 'williamhill_us',
  BetRivers: 'betrivers', 'ESPN BET': 'espnbet', Fanatics: 'fanatics', 'Hard Rock Bet': 'hardrockbet',
};

/**
 * A single-market h2h event — deep enough to clear RULES.MIN_SCORE with
 * outlier>=35, a thin near-coin-flip line with outlier=0.
 *
 * hoursOut defaults to 2, INSIDE every sport's per-game lock lead time
 * (PICK_LEAD_HOURS: 3h MLB/WNBA, 2.5h tennis/MMA) — same reasoning as
 * test/tracking.test.mjs's own fixture comment: these tests predate
 * per-game lock timing, and 6h-out games are now (correctly) not lockable
 * yet at the fixture's NOW.
 */
function makeEvent(id, { hoursOut = 2, outlier = 35, sport = 'baseball_mlb', sportTitle = 'MLB', lastUpdate = NOW - 600000 } = {}) {
  return {
    id,
    sport_key: sport,
    sport_title: sportTitle,
    commence_time: new Date(NOW + hoursOut * 3.6e6).toISOString(),
    home_team: `${id} Home`,
    away_team: `${id} Away`,
    bookmakers: BOOKS.map((title, i) => ({
      key: BOOK_KEYS[title],
      title,
      last_update: new Date(lastUpdate).toISOString(),
      markets: [{
        key: 'h2h',
        last_update: new Date(lastUpdate).toISOString(),
        outcomes: [
          { name: `${id} Home`, price: -140 + (i === 0 ? outlier : 0) },
          { name: `${id} Away`, price: 120 },
        ],
      }],
    })),
  };
}

/** A game with BOTH an h2h and a spreads market on it, so the "one pick per game" logic has two real candidates to choose between. */
function makeMultiMarketEvent(id, { hoursOut = 2, h2hOutlier = 0, spreadOutlier = 0 } = {}) {
  return {
    id,
    sport_key: 'baseball_mlb',
    sport_title: 'MLB',
    commence_time: new Date(NOW + hoursOut * 3.6e6).toISOString(),
    home_team: `${id} Home`,
    away_team: `${id} Away`,
    bookmakers: BOOKS.map((title, i) => ({
      key: BOOK_KEYS[title],
      title,
      last_update: new Date(NOW - 600000).toISOString(),
      markets: [
        {
          key: 'h2h',
          last_update: new Date(NOW - 600000).toISOString(),
          outcomes: [
            { name: `${id} Home`, price: -140 + (i === 0 ? h2hOutlier : 0) },
            { name: `${id} Away`, price: 120 },
          ],
        },
        {
          key: 'spreads',
          last_update: new Date(NOW - 600000).toISOString(),
          outcomes: [
            { name: `${id} Home`, price: -110 + (i === 0 ? spreadOutlier : 0), point: -1.5 },
            { name: `${id} Away`, price: -110, point: 1.5 },
          ],
        },
      ],
    })),
  };
}

/* ---------------------------------------------------------------- */
/* runFullSlateBatch                                                 */
/* ---------------------------------------------------------------- */

test('runFullSlateBatch tracks exactly one pick per game, even when a game has multiple markets', async () => {
  const { env } = makeKvStore();
  // The spread market has a much bigger outlier price, so it should score
  // higher and win the "one pick per game" slot for this event.
  const events = [makeMultiMarketEvent('multi', { h2hOutlier: 5, spreadOutlier: 60 })];

  const result = await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.skipped, false);
  assert.equal(result.count, 1, 'only one pick should be stored for this one game, not one per market');

  const picks = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].marketKey, 'spreads', 'the higher-scoring market (spreads) should be the one tracked');
});

test('runFullSlateBatch tracks the h2h side instead when it is the stronger candidate', async () => {
  const { env } = makeKvStore();
  const events = [makeMultiMarketEvent('multi2', { h2hOutlier: 60, spreadOutlier: 5 })];

  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  const picks = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].marketKey, 'h2h');
});

test('runFullSlateBatch has no odds-band or score floor — a near-coin-flip game still gets a tracked pick', async () => {
  const { env } = makeKvStore();
  // outlier: 0 means every book quotes the exact same price — a thin,
  // near-zero-edge line that topPicks()'s EV/Kelly floor would reject.
  const events = [makeEvent('thin', { outlier: 0 })];

  const result = await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.count, 1, 'a game with essentially no edge should still be tracked — Full Slate has no floor');

  const picks = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].meetsStandard, true, 'Full Slate picks always carry meetsStandard: true — there is no standard to fail here');
});

test('runFullSlateBatch tracks a game topPicks() would reject on price alone (outside -250..+150)', async () => {
  const { env } = makeKvStore();
  const events = [{
    id: 'longshot',
    sport_key: 'baseball_mlb',
    sport_title: 'MLB',
    commence_time: new Date(NOW + 2 * 3.6e6).toISOString(),
    home_team: 'Longshot Home',
    away_team: 'Longshot Away',
    bookmakers: BOOKS.map((title, i) => ({
      key: BOOK_KEYS[title],
      title,
      last_update: new Date(NOW - 600000).toISOString(),
      markets: [{
        key: 'h2h',
        last_update: new Date(NOW - 600000).toISOString(),
        outcomes: [
          { name: 'Longshot Home', price: -900 },
          { name: 'Longshot Away', price: 600 + (i === 0 ? 100 : 0) },
        ],
      }],
    })),
  }];

  const result = await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.count, 1, 'price band is a Pixel\'s Picks/POTD concept, not a Full Slate one');
});

test('runFullSlateBatch never picks a team-sport game that isn\'t happening today', async () => {
  const { env } = makeKvStore();
  const events = [
    makeEvent('far-out', { outlier: 40, hoursOut: 24 * 140, sport: 'americanfootball_nfl', sportTitle: 'NFL' }),
    makeEvent('today', { outlier: 20 }),
  ];
  const result = await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.count, 1, 'only the same-day game should be tracked');

  const picks = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  assert.ok(picks.every((p) => p.pickId.startsWith('today:')));
});

test('runFullSlateBatch honors MMA\'s today-or-early-tomorrow eligibility window, same as Pixel\'s Picks', async () => {
  const { env } = makeKvStore();
  const events = [
    // ~30h out, well past tomorrow's early-morning cutoff — not eligible.
    makeEvent('late-mma', { outlier: 30, hoursOut: 30, sport: 'mma_mixed_martial_arts', sportTitle: 'MMA' }),
    makeEvent('today-mlb', { outlier: 20 }),
  ];
  const result = await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.count, 1, 'only the same-day MLB game should be tracked, never the far-out MMA card');
});

test('runFullSlateBatch tennis next-day carve-out: just-past-midnight eligible, ordinary tomorrow start not', async () => {
  // Positive: 11pm ET with a 1am-ET-tomorrow match — a night session
  // rolling past midnight, inside the midnight-2am ET carve-out, its own
  // 2.5h lock window open. Stored under TODAY's date.
  {
    const { env } = makeKvStore();
    const lateNow = Date.parse('2026-08-06T03:00:00Z'); // 11pm ET Aug 5
    const events = [makeEvent('tennis-1am', {
      outlier: 30, hoursOut: 17, // NOW + 17h = 1am ET Aug 6
      sport: 'tennis_atp_canadian_open', sportTitle: 'ATP Canadian Open',
      lastUpdate: lateNow - 600000,
    })];
    const result = await runFullSlateBatch(env, ctx, lateNow, { fetchFullSlate: async () => events });
    assert.equal(result.count, 1, 'a match rolling just past midnight belongs on today\'s slate');
    const [pick] = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
    assert.equal(pick.eventId, 'tennis-1am');
  }
  // Negative: an ordinary tomorrow-afternoon match, and one two days out —
  // neither belongs on today's slate. The all-day-tomorrow window was a
  // real bug, removed per explicit product direction (midnight-2am ET only).
  {
    const { env } = makeKvStore();
    const events = [
      makeEvent('tomorrow-tennis-pm', { outlier: 30, hoursOut: 30, sport: 'tennis_atp_canadian_open', sportTitle: 'ATP Canadian Open' }),
      makeEvent('future-tennis', { outlier: 30, hoursOut: 54, sport: 'tennis_atp_canadian_open', sportTitle: 'ATP Canadian Open' }),
    ];
    const result = await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
    assert.equal(result.count, 0, 'ordinary next-day (and later) matches belong on their own day\'s slate');
  }
});

test('runFullSlateBatch stores picks with a flat unit stake', async () => {
  const { env } = makeKvStore();
  const events = [makeEvent('flat', { outlier: 35 })];
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  const picks = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  assert.equal(picks[0].suggested_stake, 20);
});

test('runFullSlateBatch is idempotent within a day — a second call adds nothing for already-tracked games', async () => {
  // The batch stopped being "once per ET day" when it became an hourly
  // self-healing top-up (see runFullSlateBatch's own comment): a repeat
  // call is expected and must simply add nothing new for games already in
  // the manifest, never a second pick.
  const { env } = makeKvStore();
  const events = [makeEvent('a', { outlier: 35 })];

  const first = await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(first.skipped, false);
  assert.equal(first.added, 1);

  const second = await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(second.added, 0, 'an already-tracked game must not be re-added');
  assert.equal(second.count, 1, 'the day still holds exactly the one original pick');

  const picks = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 1);
});

/* ---------------------------------------------------------------- */
/* runFullSlateClvSnapshot / runFullSlateGrading / history / reset   */
/* ---------------------------------------------------------------- */

test('runFullSlateClvSnapshot updates closeAmerican when the price has moved', async () => {
  const { env } = makeKvStore();
  const events = [makeEvent('clv', { outlier: 35 })]; // 2h out — lockable at NOW, still pregame at snapshot time
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });

  const movedEvents = [makeEvent('clv', { outlier: 55 })];
  const result = await runFullSlateClvSnapshot(env, ctx, NOW + 0.5 * 3.6e6, {
    fetchSportFn: async () => ({ events: movedEvents }),
  });
  assert.equal(result.updated, 1);
});

test('runFullSlateGrading grades a completed pick won/lost via the shared gradePick()', async () => {
  const { env } = makeKvStore();
  // buildCandidates() only tracks future games (commenceMs > now), so the
  // pick has to be generated against a game that hasn't started yet — grade
  // it at a later "now", after the game would be over.
  const events = [makeEvent('grade', { outlier: 35, hoursOut: 2 })];
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });

  const [pick] = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  const scoreEvents = [{
    id: 'grade',
    completed: true,
    scores: [
      { name: 'grade Home', score: pick.outcomeName === 'grade Home' ? '5' : '2' },
      { name: 'grade Away', score: pick.outcomeName === 'grade Away' ? '5' : '2' },
    ],
  }];
  const result = await runFullSlateGrading(env, ctx, NOW + 6 * 3.6e6, {
    fetchScoresFn: async () => ({ events: scoreEvents }),
  });
  assert.equal(result.graded, 1);

  const [graded] = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  assert.equal(graded.status, 'won');
  assert.ok(graded.result.payout > 0);
});

test('runFullSlateGrading still grades a pending pick after the ET date has rolled over past its own dateKey (regression: a late card used to get silently orphaned)', async () => {
  const { env } = makeKvStore();
  // Generated at 11pm ET Aug 5 against an MMA fight that doesn't commence
  // until 1am ET Aug 6 — a late card crossing the ET midnight boundary.
  // isEligibleMmaFight allows this into today's (Aug 5) tracked batch since
  // it starts before MMA_NEXT_DAY_CUTOFF_HOUR the next morning (a team-sport
  // game can't reach this same scenario — those require same-ET-day
  // commencement to be tracked at all), and the late generation "now" keeps
  // the fight inside its own 2.5h lock window. The pick is stored under
  // dateKey "2026-08-05" (today's date at generation time).
  const genNow = Date.parse('2026-08-06T03:00:00Z'); // 11pm ET Aug 5
  const events = [makeEvent('late', {
    outlier: 35, hoursOut: 17, // NOW + 17h = 1am ET Aug 6, 2h after genNow
    sport: 'mma_mixed_martial_arts', sportTitle: 'MMA',
    lastUpdate: genNow - 600000,
  })];
  await runFullSlateBatch(env, ctx, genNow, { fetchFullSlate: async () => events });

  const [pick] = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  const scoreEvents = [{
    id: 'late',
    completed: true,
    scores: [
      { name: 'late Home', score: pick.outcomeName === 'late Home' ? '5' : '2' },
      { name: 'late Away', score: pick.outcomeName === 'late Away' ? '5' : '2' },
    ],
  }];

  // Grade at 2pm ET Aug 6 — 30 hours after generation, well past the ET date
  // rollover. Without checking yesterday's dateKey too, this "now" resolves
  // to "2026-08-06" and the grading pass would never even look at the
  // manifest the pick is actually stored under. fetchMmaResultsFn is stubbed
  // to skip the real ESPN fallback fetch — the primary scoreEvent already
  // has a real result, so the fallback is never actually reached; it just
  // needs to not attempt a live network call in a unit test.
  const gradeNow = NOW + 30 * 3.6e6;
  const result = await runFullSlateGrading(env, ctx, gradeNow, {
    fetchScoresFn: async () => ({ events: scoreEvents }),
    fetchMmaResultsFn: async () => [],
  });
  assert.equal(result.graded, 1);

  const [graded] = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  assert.equal(graded.status, 'won');
  assert.ok(graded.result.payout > 0);
});

test('getAllFullSlateTracked spans multiple days, resetFullSlateTracking clears every one', async () => {
  const { env } = makeKvStore();
  const day2Now = NOW + 86400000;
  // makeEvent's times are relative to the file-level NOW constant — rebuild
  // day2's game relative to day2Now (2h out, inside its lock window, with a
  // quote fresh as of day2) rather than 22h in day2Now's past.
  const day2Event = {
    ...makeEvent('day2', { outlier: 35, hoursOut: 26, lastUpdate: day2Now - 600000 }),
  };
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => [makeEvent('day1', { outlier: 35 })] });
  await runFullSlateBatch(env, ctx, day2Now, { fetchFullSlate: async () => [day2Event] });

  const all = await getAllFullSlateTracked(env, { now: NOW + 86400000, days: 5 });
  assert.equal(all.length, 2);

  const { deleted } = await resetFullSlateTracking(env, { now: NOW + 86400000, days: 5 });
  assert.equal(deleted, 2);

  const afterReset = await getAllFullSlateTracked(env, { now: NOW + 86400000, days: 5 });
  assert.equal(afterReset.length, 0);
});

/* ---------------------------------------------------------------- */
/* diagnosePendingFullSlate                                          */
/* ---------------------------------------------------------------- */

test('diagnosePendingFullSlate surfaces a scores-fetch error instead of an empty-looking board', async () => {
  const { env } = makeKvStore();
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => [makeEvent('e1')] });

  // Exactly what fetchScores returns on an exhausted quota / bad key: an
  // error object and NO events array — which grading silently reads as [].
  const report = await diagnosePendingFullSlate(env, ctx, NOW, {
    fetchScoresFn: async () => ({ error: { status: 401, detail: 'quota exhausted' } }),
  });

  assert.equal(report.pending, 1);
  const sport = report.bySport[0];
  assert.equal(sport.scoresError.status, 401, 'the fetch failure must be reported, not swallowed');
  assert.equal(sport.scoresReturned, 0);
  assert.equal(sport.foundById, 0);
});

test('diagnosePendingFullSlate distinguishes a name mismatch from a missing event', async () => {
  const { env } = makeKvStore();
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => [makeEvent('e1')] });
  const [pick] = await getFullSlateTracked(env, { dateKey: '2026-08-05' });

  // The event IS there and IS completed — but the feed spells the players
  // differently, so gradePick can't read a score for either side. Without
  // this distinction it looks identical to "no result yet."
  const report = await diagnosePendingFullSlate(env, ctx, NOW, {
    fetchScoresFn: async () => ({
      events: [{
        id: pick.eventId,
        completed: true,
        scores: [{ name: 'Someone Else', score: '2' }, { name: 'Another Name', score: '0' }],
      }],
    }),
  });

  const sport = report.bySport[0];
  assert.equal(sport.foundById, 1, 'the event id matched');
  assert.equal(sport.completed, 1, 'and it is finished');
  assert.equal(sport.namesUsable, 0, 'but the names do not line up — the actual blocker');
  assert.deepEqual(sport.samples[0].feedNames, ['Someone Else', 'Another Name']);
});

test('diagnosePendingFullSlate reports a clean board as nothing pending', async () => {
  const { env } = makeKvStore();
  const report = await diagnosePendingFullSlate(env, ctx, NOW, {
    fetchScoresFn: async () => ({ events: [] }),
  });
  assert.equal(report.pending, 0);
  assert.deepEqual(report.bySport, []);
});

/**
 * The diagnostic runs immediately after grading, and the grader's own writes
 * are waitUntil'd into an eventually-consistent KV — so a pick that just
 * settled can still read as `pending` here. Reporting it as stuck is the one
 * thing this diagnostic exists to not do. Confirmed live on the first real
 * run: a tennis match ESPN had as STATUS_FINAL with decided sets, which
 * could not have failed to settle, came back in this report as pending.
 */
test('a pick the grading pass just settled is not reported as stuck', async () => {
  const { env } = makeKvStore();
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => [makeEvent('e1'), makeEvent('e2')] });
  const picks = await getFullSlateTracked(env, { dateKey: '2026-08-05' });
  assert.equal(picks.length, 2);

  const report = await diagnosePendingFullSlate(env, ctx, NOW, {
    fetchScoresFn: async () => ({ events: [] }),
    justSettledPickIds: [picks[0].pickId],
  });

  assert.equal(report.pending, 1, 'only the genuinely stuck pick is reported');
  assert.equal(report.bySport[0].samples[0].eventId, picks[1].eventId);
});

test('grading reports which picks it settled, not just how many', async () => {
  const { env } = makeKvStore();
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => [makeEvent('e1')] });
  const [pick] = await getFullSlateTracked(env, { dateKey: '2026-08-05' });

  const result = await runFullSlateGrading(env, ctx, NOW, {
    fetchScoresFn: async () => ({
      events: [{
        id: pick.eventId,
        completed: true,
        scores: [{ name: pick.home, score: '5' }, { name: pick.away, score: '2' }],
      }],
    }),
    fetchMmaResultsFn: async () => [],
  });

  assert.equal(result.graded, 1);
  // The ids themselves, so /admin/grade-now's diagnostics can exclude them
  // rather than re-reading a KV that hasn't caught up yet.
  assert.deepEqual(result.settledPickIds, [pick.pickId]);
});

/* ---------------------------------------------------------------- */
/* Tennis void backfill                                              */
/* ---------------------------------------------------------------- */

/** ET calendar date for an instant — mirrors the module's own etDate. */
function etDateOf(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Seeds one day's manifest + a single voided tennis total straight into KV. */
function seedVoidedTennisDay(store, dateKey, pickId) {
  store.set(`slate:${dateKey}:manifest`, JSON.stringify({ date: dateKey, pickIds: [pickId] }));
  store.set(`slate:${dateKey}:pick:${pickId}`, JSON.stringify({
    pickId,
    dateKey,
    eventId: `ev-${pickId}`,
    sportKey: 'tennis_wta_cincinnati_open',
    marketKey: 'totals',
    home: 'Iga Swiatek',
    away: 'Elena Rybakina',
    outcomeName: 'Under',
    point: 22.5,
    decimal: 1.9,
    suggested_stake: 20,
    commenceMs: Date.parse(`${dateKey}T16:00:00Z`),
    status: 'void',
    result: { payout: 0, roiPercent: 0, voidReason: UNSETTLEABLE_TENNIS_GAME_MARKET },
  }));
}

/**
 * A 90-day walk of the Full Slate reads every pick on every day across every
 * sport, which runs past the subrequest ceiling one Worker invocation has.
 * The sweep stops at its read budget and reports where to resume — dying
 * partway with no record of how far it got is the failure this prevents.
 */
test('the backfill stops at its read budget and reports where to resume', async () => {
  const { env, store } = makeKvStore();
  for (let i = 0; i < 6; i++) {
    seedVoidedTennisDay(store, etDateOf(NOW - i * 86400000), `p${i}`);
  }

  // Budget of 3 covers only the first two days (manifest + one pick each).
  const first = await regradeFullSlateTennisVoids(env, ctx, { now: NOW, days: 6, offsetDays: 0, readBudget: 3 });
  assert.equal(first.daysWalked, 2);
  assert.equal(first.nextOffsetDays, 2, 'the caller is told exactly where to pick back up');
  assert.equal(first.found, 2);

  const rest = await regradeFullSlateTennisVoids(env, ctx, { now: NOW, days: 6, offsetDays: first.nextOffsetDays, readBudget: 1000 });
  assert.equal(rest.nextOffsetDays, null, 'null is the signal that the range is fully swept');
  assert.equal(rest.found, 4);
});

test('a fully swept range re-runs as a no-op', async () => {
  const { env, store } = makeKvStore();
  seedVoidedTennisDay(store, etDateOf(NOW), 'p0');

  // No ESPN results reachable in unit tests, so nothing settles — which is
  // exactly the case that must not rewrite the record anyway.
  const first = await regradeFullSlateTennisVoids(env, ctx, { now: NOW, days: 1 });
  const second = await regradeFullSlateTennisVoids(env, ctx, { now: NOW, days: 1 });
  assert.equal(first.regraded, 0);
  assert.equal(second.regraded, 0);
  assert.equal(second.nextOffsetDays, null);
});

/* ---------------------------------------------------------------- */
/* Reconciliation lookback                                           */
/* ---------------------------------------------------------------- */

/**
 * The every-tick lookback is 2 days, which leaves a sharp edge: a pick that
 * couldn't settle within two days of its date was stranded PERMANENTLY, with
 * no code path that would ever look at it again. That's what happened to a
 * full WTA board when the odds feed turned out never to post tennis results
 * — by the time ESPN was wired in, those picks had aged out of every pass.
 *
 * The nightly reconciliation calls the same grader with a wider window.
 */
test('the default lookback leaves an older pending pick alone', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW - 5 * 86400000);
  seedPendingDay(store, dateKey, 'old-1');

  const result = await runFullSlateGrading(env, ctx, NOW, {
    fetchScoresFn: async () => ({ events: [finishedEventFor('old-1')] }),
    fetchMmaResultsFn: async () => [],
  });
  assert.equal(result.graded, 0, 'five days back is outside the every-tick window');
});

test('a widened lookback reaches back and settles it', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW - 5 * 86400000);
  seedPendingDay(store, dateKey, 'old-1');

  const result = await runFullSlateGrading(env, ctx, NOW, {
    fetchScoresFn: async () => ({ events: [finishedEventFor('old-1')] }),
    fetchMmaResultsFn: async () => [],
    lookbackDays: 14,
  });
  assert.equal(result.graded, 1, 'the nightly pass rescues what the tick window cannot see');

  const stored = JSON.parse(store.get(`slate:${dateKey}:pick:old-1`));
  assert.equal(stored.status, 'won');
});

/** A single still-pending MLB pick on one day, seeded straight into KV. */
function seedPendingDay(store, dateKey, pickId) {
  store.set(`slate:${dateKey}:manifest`, JSON.stringify({ date: dateKey, pickIds: [pickId] }));
  store.set(`slate:${dateKey}:pick:${pickId}`, JSON.stringify({
    pickId,
    dateKey,
    eventId: `ev-${pickId}`,
    sportKey: 'baseball_mlb',
    marketKey: 'h2h',
    home: 'Home Team',
    away: 'Away Team',
    outcomeName: 'Home Team',
    decimal: 1.9,
    suggested_stake: 20,
    commenceMs: Date.parse(`${dateKey}T18:00:00Z`),
    status: 'pending',
    result: null,
  }));
}

function finishedEventFor(pickId) {
  return {
    id: `ev-${pickId}`,
    completed: true,
    scores: [{ name: 'Home Team', score: '5' }, { name: 'Away Team', score: '2' }],
  };
}

/* ---------------------------------------------------------------- */
/* MMA finish-detail backfill + manual result entry                  */
/* ---------------------------------------------------------------- */

/** Seeds one day's manifest + a single already-graded MMA pick straight into KV. */
function seedGradedMmaPick(store, dateKey, pickId, { status = 'won', home = 'Fighter Home', away = 'Fighter Away', outcomeName = 'Fighter Home', detail = { winner: 'Fighter Home', method: null } } = {}) {
  store.set(`slate:${dateKey}:manifest`, JSON.stringify({ date: dateKey, pickIds: [pickId] }));
  store.set(`slate:${dateKey}:pick:${pickId}`, JSON.stringify({
    pickId,
    dateKey,
    eventId: `ev-${pickId}`,
    sportKey: 'mma_mixed_martial_arts',
    marketKey: 'h2h',
    home,
    away,
    outcomeName,
    decimal: 1.9,
    suggested_stake: 20,
    commenceMs: Date.parse(`${dateKey}T20:00:00Z`),
    status,
    result: status === 'pending' ? null : { payout: status === 'won' ? 18 : -20, roiPercent: 0, detail },
  }));
}

test('backfillMmaFinishDetail patches method onto an already-graded pick, without touching status or payout', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  seedGradedMmaPick(store, dateKey, 'p1');

  const fetchMmaResultsFn = async () => ([{
    a: 'fighter home', b: 'fighter away', aWon: true, bWon: false,
    displayA: 'Fighter Home', displayB: 'Fighter Away', method: 'Submission', round: 2,
  }]);
  const result = await backfillMmaFinishDetail(env, ctx, NOW, { days: 1, fetchMmaResultsFn });

  assert.equal(result.checked, 1);
  assert.deepEqual(result.patched.map((p) => p.pickId), ['p1']);
  assert.deepEqual(result.noMatch, []);

  const stored = JSON.parse(store.get(`slate:${dateKey}:pick:p1`));
  assert.equal(stored.status, 'won', 'status must never change');
  assert.equal(stored.result.payout, 18, 'payout must never change');
  assert.equal(stored.result.detail.method, 'Submission');
  assert.equal(stored.result.detail.winner, 'Fighter Home', 'an existing winner is kept, not overwritten');
});

test('backfillMmaFinishDetail leaves a pick with no ESPN match untouched', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  seedGradedMmaPick(store, dateKey, 'p1', { home: 'Nobody ESPN Has', away: 'Also Uncovered' });

  const result = await backfillMmaFinishDetail(env, ctx, NOW, { days: 1, fetchMmaResultsFn: async () => [] });

  assert.equal(result.checked, 1);
  assert.deepEqual(result.patched, []);
  assert.deepEqual(result.noMatch.map((p) => p.pickId), ['p1']);

  const stored = JSON.parse(store.get(`slate:${dateKey}:pick:p1`));
  assert.equal(stored.result.detail.method, null, 'left exactly as it was — no fabricated method');
});

test('backfillMmaFinishDetail ignores a pick that already has a method (idempotent)', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  seedGradedMmaPick(store, dateKey, 'p1', { detail: { winner: 'Fighter Home', method: 'Decision' } });

  let fetchCalled = false;
  const result = await backfillMmaFinishDetail(env, ctx, NOW, {
    days: 1,
    fetchMmaResultsFn: async () => { fetchCalled = true; return []; },
  });

  assert.equal(result.checked, 0, 'a pick that already has a method is never a candidate');
  assert.equal(fetchCalled, false, 're-running costs nothing once every pick is already patched');
});

test('backfillMmaFinishDetail never touches a still-pending pick', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  seedGradedMmaPick(store, dateKey, 'p1', { status: 'pending' });

  const result = await backfillMmaFinishDetail(env, ctx, NOW, { days: 1, fetchMmaResultsFn: async () => [] });
  assert.equal(result.checked, 0);
});

test('manualMmaResult settles a pending pick correctly when the picked side wins', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  seedGradedMmaPick(store, dateKey, 'p1', { status: 'pending', outcomeName: 'Fighter Home' });

  const result = await manualMmaResult(env, {
    dateKey, pickId: 'p1', winnerName: 'Fighter Home', method: 'Rear Naked Choke', round: 2,
  });

  assert.ok(!result.error, result.error);
  assert.equal(result.pick.status, 'won');
  assert.equal(result.pick.result.payout, (1.9 - 1) * 20);
  assert.equal(result.pick.result.detail.method, 'Rear Naked Choke');
  assert.equal(result.pick.result.detail.winner, 'Fighter Home');

  const stored = JSON.parse(store.get(`slate:${dateKey}:pick:p1`));
  assert.equal(stored.status, 'won');
});

test('manualMmaResult settles a pending pick correctly when the picked side loses — the exact Outlaw/Magomedov shape', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  // Mirrors the real case this was built for: the tracked pick is on the
  // HOME side (the algorithm's lean), but the away fighter is the one who
  // actually won.
  seedGradedMmaPick(store, dateKey, 'p1', { home: 'Sidney Outlaw', away: 'Rasul Magomedov', outcomeName: 'Sidney Outlaw', status: 'pending' });

  const result = await manualMmaResult(env, {
    dateKey, pickId: 'p1', winnerName: 'Rasul Magomedov', method: 'Rear Naked Choke', round: 2,
  });

  assert.ok(!result.error, result.error);
  assert.equal(result.pick.status, 'lost', 'the pick was on the fighter who lost');
  assert.equal(result.pick.result.payout, -20);
  assert.equal(result.pick.result.detail.winner, 'Rasul Magomedov');
});

test('manualMmaResult refuses a pick that already graded, rather than overwrite it', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  seedGradedMmaPick(store, dateKey, 'p1', { status: 'won' });

  const result = await manualMmaResult(env, { dateKey, pickId: 'p1', winnerName: 'Fighter Away' });
  assert.match(result.error, /already won/);

  const stored = JSON.parse(store.get(`slate:${dateKey}:pick:p1`));
  assert.equal(stored.status, 'won', 'untouched');
});

test('manualMmaResult refuses a winnerName matching neither fighter', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  seedGradedMmaPick(store, dateKey, 'p1', { status: 'pending' });

  const result = await manualMmaResult(env, { dateKey, pickId: 'p1', winnerName: 'Someone Else Entirely' });
  assert.match(result.error, /matches neither/);
});

test('manualMmaResult refuses when the pick cannot be found', async () => {
  const { env } = makeKvStore();
  const result = await manualMmaResult(env, { dateKey: etDateOf(NOW), pickId: 'does-not-exist', winnerName: 'Anyone' });
  assert.match(result.error, /not found/);
});

test('manualMmaResult can find a pick by home/away instead of pickId', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  seedGradedMmaPick(store, dateKey, 'p1', { status: 'pending', home: 'Sidney Outlaw', away: 'Rasul Magomedov', outcomeName: 'Sidney Outlaw' });

  const result = await manualMmaResult(env, {
    dateKey, home: 'Sidney Outlaw', away: 'Rasul Magomedov', winnerName: 'Rasul Magomedov', method: 'Rear Naked Choke', round: 2,
  });
  assert.ok(!result.error, result.error);
  assert.equal(result.pick.status, 'lost');
});

/* ---------------------------------------------------------------- */
/* MMA rounds-totals audit                                           */
/* ---------------------------------------------------------------- */

function seedMmaTotalsPick(store, dateKey, pickId, { status, home = 'Charles Johnson', away = 'Eduardo Henrique', outcomeName = 'Under', point = 2.5 } = {}) {
  store.set(`slate:${dateKey}:manifest`, JSON.stringify({ date: dateKey, pickIds: [pickId] }));
  store.set(`slate:${dateKey}:pick:${pickId}`, JSON.stringify({
    pickId,
    dateKey,
    eventId: `ev-${pickId}`,
    sportKey: 'mma_mixed_martial_arts',
    marketKey: 'totals',
    home,
    away,
    outcomeName,
    point,
    decimal: 1.9,
    suggested_stake: 20,
    commenceMs: Date.parse(`${dateKey}T20:00:00Z`),
    status,
    result: { payout: status === 'won' ? 18 : -20, roiPercent: 0, detail: null },
  }));
}

test('auditMmaTotalsGrading flags a pick the old bug would have graded wrong', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  // Under 2.5 stored as WON — exactly what the old bug always produced,
  // regardless of the real fight length. The real fight went to Round 3.
  seedMmaTotalsPick(store, dateKey, 'p1', { status: 'won', outcomeName: 'Under', point: 2.5 });

  const fetchMmaResultsFn = async () => ([{
    a: 'charles johnson', b: 'eduardo henrique', aWon: true, bWon: false,
    displayA: 'Charles Johnson', displayB: 'Eduardo Henrique', method: 'Submission', round: 3,
  }]);
  const result = await auditMmaTotalsGrading(env, ctx, NOW, { days: 1, fetchMmaResultsFn });

  assert.equal(result.checked, 1);
  assert.equal(result.disagreements.length, 1);
  assert.equal(result.disagreements[0].storedStatus, 'won');
  assert.equal(result.disagreements[0].recomputedStatus, 'lost');
  assert.equal(result.disagreements[0].espnRound, 3);
});

test('auditMmaTotalsGrading reports no disagreement when the stored grade is already correct', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  // Over 2.5 stored as WON — correct, since the fight actually went to Round 3.
  seedMmaTotalsPick(store, dateKey, 'p1', { status: 'won', outcomeName: 'Over', point: 2.5 });

  const fetchMmaResultsFn = async () => ([{
    a: 'charles johnson', b: 'eduardo henrique', aWon: true, bWon: false,
    displayA: 'Charles Johnson', displayB: 'Eduardo Henrique', method: 'Submission', round: 3,
  }]);
  const result = await auditMmaTotalsGrading(env, ctx, NOW, { days: 1, fetchMmaResultsFn });

  assert.equal(result.checked, 1);
  assert.deepEqual(result.disagreements, []);
});

test('auditMmaTotalsGrading reports a pick outside ESPN\'s lookback as unauditable, never silently skipped', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  seedMmaTotalsPick(store, dateKey, 'p1', { status: 'won' });

  const result = await auditMmaTotalsGrading(env, ctx, NOW, { days: 1, fetchMmaResultsFn: async () => [] });
  assert.equal(result.checked, 1);
  assert.deepEqual(result.disagreements, []);
  assert.equal(result.unauditable.length, 1);
  assert.equal(result.unauditable[0].pickId, 'p1');
});

test('auditMmaTotalsGrading never writes anything — read-only', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  seedMmaTotalsPick(store, dateKey, 'p1', { status: 'won' });
  const before = store.get(`slate:${dateKey}:pick:p1`);

  await auditMmaTotalsGrading(env, ctx, NOW, {
    days: 1,
    fetchMmaResultsFn: async () => ([{ a: 'charles johnson', b: 'eduardo henrique', aWon: true, bWon: false, round: 3 }]),
  });

  assert.equal(store.get(`slate:${dateKey}:pick:p1`), before, 'the stored pick must be byte-identical after an audit');
});

/* ---------------------------------------------------------------- */
/* MMA rounds-totals regrade (the write half of the audit)           */
/* ---------------------------------------------------------------- */

/** The real corruption shape: "Under 1.5" stored WON on a fight that reached Round 2. */
const BARBOZA_RESULTS = [{
  a: 'edson barboza', b: 'esteban ribovics', aWon: false, bWon: true,
  displayA: 'Edson Barboza', displayB: 'Esteban Ribovics', method: 'KO/TKO', round: 2,
}];

function seedBadTotalsPick(store, dateKey, pickId) {
  seedMmaTotalsPick(store, dateKey, pickId, {
    status: 'won', home: 'Edson Barboza', away: 'Esteban Ribovics', outcomeName: 'Under', point: 1.5,
  });
}

test('regradeMmaTotals defaults to a dry run and writes nothing', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  seedBadTotalsPick(store, dateKey, 'p1');
  const before = store.get(`slate:${dateKey}:pick:p1`);

  const result = await regradeMmaTotals(env, ctx, NOW, { days: 1, fetchMmaResultsFn: async () => BARBOZA_RESULTS });

  assert.equal(result.apply, false);
  assert.equal(result.corrected.length, 1, 'it still reports exactly what it would change');
  assert.equal(result.corrected[0].before.status, 'won');
  assert.equal(result.corrected[0].after.status, 'lost');
  assert.equal(store.get(`slate:${dateKey}:pick:p1`), before, 'a dry run must leave the record byte-identical');
});

test('regradeMmaTotals with apply:true corrects the outcome and records why', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  seedBadTotalsPick(store, dateKey, 'p1');

  const result = await regradeMmaTotals(env, ctx, NOW, { days: 1, apply: true, fetchMmaResultsFn: async () => BARBOZA_RESULTS });
  assert.equal(result.corrected.length, 1);

  const stored = JSON.parse(store.get(`slate:${dateKey}:pick:p1`));
  assert.equal(stored.status, 'lost', 'Under 1.5 on a Round-2 finish is a loss');
  assert.equal(stored.result.payout, -20);
  assert.equal(stored.result.regradedReason, 'mma rounds-total grading fix (see buildMmaRoundsScoreEvent)');
  assert.equal(stored.result.regradedAt, NOW, 'a changed settled record must say when it changed');
});

test('regradeMmaTotals never touches a totals pick that already graded correctly', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  // Under 2.5 on a Round-2 finish is genuinely a WIN — must be left alone.
  seedMmaTotalsPick(store, dateKey, 'good', {
    status: 'won', home: 'Edson Barboza', away: 'Esteban Ribovics', outcomeName: 'Under', point: 2.5,
  });
  const before = store.get(`slate:${dateKey}:pick:good`);

  const result = await regradeMmaTotals(env, ctx, NOW, { days: 1, apply: true, fetchMmaResultsFn: async () => BARBOZA_RESULTS });

  assert.deepEqual(result.corrected, []);
  assert.equal(store.get(`slate:${dateKey}:pick:good`), before);
});

test('regradeMmaTotals leaves a settled pick alone when ESPN has no round to judge it by', async () => {
  const { env, store } = makeKvStore();
  const dateKey = etDateOf(NOW);
  seedBadTotalsPick(store, dateKey, 'p1');
  const before = store.get(`slate:${dateKey}:pick:p1`);

  const result = await regradeMmaTotals(env, ctx, NOW, { days: 1, apply: true, fetchMmaResultsFn: async () => [] });

  assert.deepEqual(result.corrected, []);
  assert.equal(result.unauditable.length, 1, 'reported, not silently skipped');
  assert.equal(store.get(`slate:${dateKey}:pick:p1`), before, 'missing data must never flip a settled outcome');
});
