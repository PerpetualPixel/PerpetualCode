import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retractedRecord, isWtaPick } from '../worker/src/retraction.js';
import {
  runFullSlateBatch,
  getFullSlateTracked,
  retractFullSlatePicks,
  resetFullSlateTracking,
} from '../worker/src/full-slate-tracking.js';
import { runTop5Batch, getTop5, retractTop5Picks } from '../worker/src/tracking.js';
import { retractPotd, getPotdHistory } from '../worker/src/potd.js';
import { summarizePicks } from '../docs/learning.js';
import { seedTennisArchiveCacheForTests } from '../worker/src/tennis-archive.js';

// Same reasoning as every other batch test file: the tennis form gate reads
// the static archive, unit tests must never hit the network, and a null
// archive is the honest degraded mode.
seedTennisArchiveCacheForTests({ atp: null, wta: null });
import { seedTeamContextCacheForTests } from '../worker/src/team-form.js';
// Same reasoning for team sports: seeding SEALS the memo, so no fixture in
// these slates reaches cdn.espn.com. An empty seed is the honest degraded
// mode — no context, so no form re-score and no underdog gate, exactly what
// an unreachable ESPN produces in production.
seedTeamContextCacheForTests({});

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
const DATE_KEY = '2026-08-05';

const BOOKS = ['DraftKings', 'FanDuel', 'BetMGM', 'Caesars', 'BetRivers', 'ESPN BET', 'Fanatics', 'Hard Rock Bet'];
const BOOK_KEYS = {
  DraftKings: 'draftkings', FanDuel: 'fanduel', BetMGM: 'betmgm', Caesars: 'williamhill_us',
  BetRivers: 'betrivers', 'ESPN BET': 'espnbet', Fanatics: 'fanatics', 'Hard Rock Bet': 'hardrockbet',
};

/**
 * A single h2h market, home side favored. `outlier` widens the first book's
 * home price so the candidate clears the score floor. Home is the market
 * favorite throughout, which matters for tennis: the form gate only blocks
 * straight-moneyline UNDERDOGS, so a favorite pick survives the null
 * archive and these fixtures produce a real tracked pick.
 */
function makeEvent(id, { hoursOut = 2, outlier = 35, sport = 'baseball_mlb', sportTitle = 'MLB' } = {}) {
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
      last_update: new Date(NOW - 600000).toISOString(),
      markets: [{
        key: 'h2h',
        last_update: new Date(NOW - 600000).toISOString(),
        outcomes: [
          { name: `${id} Home`, price: -140 + (i === 0 ? outlier : 0) },
          { name: `${id} Away`, price: 120 },
        ],
      }],
    })),
  };
}

const wtaEvent = (id, opts = {}) =>
  makeEvent(id, { sport: 'tennis_wta_canadian_open', sportTitle: 'WTA Canadian Open', ...opts });
const atpEvent = (id, opts = {}) =>
  makeEvent(id, { sport: 'tennis_atp_canadian_open', sportTitle: 'ATP Canadian Open', ...opts });

/* ---------------------------------------------------------------- */
/* retractedRecord / isWtaPick                                       */
/* ---------------------------------------------------------------- */

test('retractedRecord voids the pick with a zero payout and keeps the reason', () => {
  const pick = { pickId: 'e1:h2h|x', status: 'pending', suggested_stake: 20, result: null };
  const out = retractedRecord(pick, { reason: 'because', at: NOW });

  assert.equal(out.status, 'void');
  assert.equal(out.result.payout, 0);
  assert.equal(out.result.roiPercent, 0);
  assert.equal(out.result.voidReason, 'because');
  assert.deepEqual(out.retracted, { at: NOW, reason: 'because' });
  assert.equal(out.pickId, 'e1:h2h|x', 'identity is preserved — this is a settlement, not a new pick');
  assert.equal(pick.status, 'pending', 'the input record is not mutated');
});

test('a retracted pick counts as neither a win nor a loss, and stakes nothing', () => {
  const won = { status: 'won', suggested_stake: 20, result: { payout: 18 } };
  const lost = { status: 'lost', suggested_stake: 20, result: { payout: -20 } };
  const pulled = retractedRecord(
    { status: 'pending', suggested_stake: 20, result: null }, { reason: 'r', at: NOW },
  );

  const summary = summarizePicks([won, lost, pulled]);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
  assert.equal(summary.voided, 1);
  assert.equal(summary.graded, 2, 'the retraction is settled but never graded');
  assert.equal(summary.staked, 40, 'a retracted pick puts no money at risk');
  assert.equal(summary.pending, 0);
});

test('isWtaPick matches only the WTA tour', () => {
  assert.equal(isWtaPick({ sportKey: 'tennis_wta_canadian_open' }), true);
  assert.equal(isWtaPick({ sportKey: 'tennis_atp_canadian_open' }), false);
  assert.equal(isWtaPick({ sportKey: 'baseball_mlb' }), false);
  assert.equal(isWtaPick({}), false);
  assert.equal(isWtaPick(null), false);
});

/* ---------------------------------------------------------------- */
/* Full Slate retraction                                             */
/* ---------------------------------------------------------------- */

test('retractFullSlatePicks voids only the matching picks and leaves the rest live', async () => {
  const { env } = makeKvStore();
  const events = [wtaEvent('wta1'), atpEvent('atp1'), makeEvent('mlb1')];
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });

  const result = await retractFullSlatePicks(env, {
    now: NOW, dateKey: DATE_KEY, match: isWtaPick, reason: 'form gate',
  });
  assert.equal(result.retracted, 1);

  const picks = await getFullSlateTracked(env, { dateKey: DATE_KEY });
  assert.equal(picks.length, 3, 'the retracted pick is still on the board, not deleted');

  const byTour = Object.fromEntries(picks.map((p) => [p.sportKey, p]));
  assert.equal(byTour.tennis_wta_canadian_open.status, 'void');
  assert.equal(byTour.tennis_wta_canadian_open.result.voidReason, 'form gate');
  assert.equal(byTour.tennis_atp_canadian_open.status, 'pending', 'ATP is untouched');
  assert.equal(byTour.baseball_mlb.status, 'pending', 'non-tennis is untouched');
});

test('a retracted game is re-picked by the next batch, and the retraction survives it', async () => {
  const { env } = makeKvStore();
  const events = [wtaEvent('wta1')];
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  await retractFullSlatePicks(env, { now: NOW, dateKey: DATE_KEY, match: isWtaPick, reason: 'form gate' });

  // Same fixture, so the re-pick lands on the SAME market as the retraction
  // — the case that would silently overwrite the void if retracted records
  // stayed under the live `pick:` key.
  const result = await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => events });
  assert.equal(result.added, 1, 'the retracted game is eligible again');

  const picks = await getFullSlateTracked(env, { dateKey: DATE_KEY });
  assert.equal(picks.length, 2, 'the void and its replacement both stand');
  assert.equal(picks.filter((p) => p.status === 'void').length, 1);
  assert.equal(picks.filter((p) => p.status === 'pending').length, 1);
});

test('a batch run after a retraction does not drop the retracted ids from the manifest', async () => {
  const { env, store } = makeKvStore();
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => [wtaEvent('wta1')] });
  await retractFullSlatePicks(env, { now: NOW, dateKey: DATE_KEY, match: isWtaPick, reason: 'form gate' });

  // A tick with nothing new to add still rewrites the manifest — the exact
  // write that would orphan every retraction if it rebuilt the object from
  // scratch instead of spreading what was already there.
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => [] });

  const manifest = JSON.parse(store.get(`slate:${DATE_KEY}:manifest`));
  assert.equal(manifest.retractedPickIds.length, 1);
  assert.equal((await getFullSlateTracked(env, { dateKey: DATE_KEY })).length, 1);
});

test('retractFullSlatePicks is a no-op when nothing matches', async () => {
  const { env } = makeKvStore();
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => [makeEvent('mlb1')] });

  const result = await retractFullSlatePicks(env, {
    now: NOW, dateKey: DATE_KEY, match: isWtaPick, reason: 'form gate',
  });
  assert.equal(result.retracted, 0);
  assert.equal((await getFullSlateTracked(env, { dateKey: DATE_KEY }))[0].status, 'pending');
});

test('retractFullSlatePicks is a no-op on a day that was never picked', async () => {
  const { env } = makeKvStore();
  const result = await retractFullSlatePicks(env, {
    now: NOW, dateKey: DATE_KEY, match: isWtaPick, reason: 'form gate',
  });
  assert.deepEqual(result, { dateKey: DATE_KEY, retracted: 0, picks: [] });
});

test('resetFullSlateTracking clears retracted records too', async () => {
  const { env, store } = makeKvStore();
  await runFullSlateBatch(env, ctx, NOW, { fetchFullSlate: async () => [wtaEvent('wta1')] });
  await retractFullSlatePicks(env, { now: NOW, dateKey: DATE_KEY, match: isWtaPick, reason: 'form gate' });

  await resetFullSlateTracking(env, { now: NOW, days: 2 });
  assert.equal([...store.keys()].filter((k) => k.startsWith('slate:')).length, 0,
    'no orphaned retraction keys are left behind');
});

/* ---------------------------------------------------------------- */
/* Pixel's Picks retraction                                          */
/* ---------------------------------------------------------------- */

test('retractTop5Picks voids the WTA pick and frees its slot for the next batch', async () => {
  const { env } = makeKvStore();
  const events = [wtaEvent('wta1'), makeEvent('mlb1'), makeEvent('mlb2')];
  await runTop5Batch(env, ctx, NOW, { fetchFullSlate: async () => events });

  const before = await getTop5(env, { dateKey: DATE_KEY });
  assert.ok(before.some(isWtaPick), 'fixture sanity: the WTA game made the board');

  const result = await retractTop5Picks(env, {
    now: NOW, dateKey: DATE_KEY, match: isWtaPick, reason: 'form gate',
  });
  assert.equal(result.retracted, 1);

  const after = await getTop5(env, { dateKey: DATE_KEY });
  assert.equal(after.length, before.length, 'the void still shows on the board');
  assert.equal(after.find(isWtaPick).status, 'void');
  assert.equal(after.filter((p) => p.status === 'pending').length, before.length - 1);
});

/* ---------------------------------------------------------------- */
/* Play of the Day retraction                                        */
/* ---------------------------------------------------------------- */

test('retractPotd voids the day and clears the slot so the day can be picked again', async () => {
  const { env, store } = makeKvStore();
  store.set(`potd:${DATE_KEY}`, JSON.stringify({
    pick: {
      pickId: 'wta1:h2h|Home', dateKey: DATE_KEY, sportKey: 'tennis_wta_canadian_open',
      status: 'pending', suggested_stake: 100, result: null,
    },
    writeup: 'x',
  }));

  const result = await retractPotd(env, { now: NOW, dateKey: DATE_KEY, match: isWtaPick, reason: 'form gate' });
  assert.equal(result.retracted, 1);
  assert.equal(store.get(`potd:${DATE_KEY}`), undefined,
    'the live key is cleared — runPotdDaily skips a day whose key merely exists');

  const history = await getPotdHistory(env, { now: NOW, days: 2 });
  assert.equal(history.length, 1, 'the retracted day is still in the history');
  assert.equal(history[0].status, 'void');
  assert.equal(history[0].result.voidReason, 'form gate');
});

test('retractPotd leaves a non-matching day alone', async () => {
  const { env, store } = makeKvStore();
  store.set(`potd:${DATE_KEY}`, JSON.stringify({
    pick: {
      pickId: 'mlb1:h2h|Home', dateKey: DATE_KEY, sportKey: 'baseball_mlb',
      status: 'pending', suggested_stake: 100, result: null,
    },
  }));

  const result = await retractPotd(env, { now: NOW, dateKey: DATE_KEY, match: isWtaPick, reason: 'form gate' });
  assert.equal(result.retracted, 0);
  assert.ok(store.get(`potd:${DATE_KEY}`), 'the live pick is untouched');
});

test('a day pulled twice keeps both retractions in the history', async () => {
  const { env, store } = makeKvStore();
  const record = (pickId) => JSON.stringify({
    pick: {
      pickId, dateKey: DATE_KEY, sportKey: 'tennis_wta_canadian_open',
      status: 'pending', suggested_stake: 100, result: null,
    },
  });

  store.set(`potd:${DATE_KEY}`, record('wta1:h2h|Home'));
  await retractPotd(env, { now: NOW, dateKey: DATE_KEY, match: isWtaPick, reason: 'first' });
  store.set(`potd:${DATE_KEY}`, record('wta2:h2h|Home'));
  await retractPotd(env, { now: NOW, dateKey: DATE_KEY, match: isWtaPick, reason: 'second' });

  const history = await getPotdHistory(env, { now: NOW, days: 2 });
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((p) => p.result.voidReason).sort(), ['first', 'second']);
});
