/**
 * Pixel's Picks from the Trends rows (worker/src/trend-picks.js): the
 * qualifying rule is fixed — 100% over the last 20 with ten or more
 * games, 100% head to head when there is any — and the research pass
 * passes a line on minutes, health, a blowout, or the matchup read, and
 * notes what is worth knowing otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  qualifyingRows, researchPick, runTrendPicksDaily, runTrendPicksGrading, getTrendPicks, settle, parseVerdict,
  PICK_MIN_GAMES, PICK_MAX_POSTED,
} from '../worker/src/trend-picks.js';

const NOW = Date.parse('2026-10-27T15:00:00Z'); // 11am ET Oct 27
const ctx = { waitUntil: (p) => p };
function makeKvStore() {
  const store = new Map();
  return { store, env: { POTD_KV: { async get(k) { return store.get(k) ?? null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } } } };
}
const period = (rate, games) => ({ rate, hits: Math.round(rate * games), games, avg: 12, median: 12 });
function row(id, { rate = 1, games = 20, h2h = period(1, 3), american = -140, player = 'Collin Sexton', commenceMs = NOW + 8 * 3.6e6, point = 9.5, side = 'over', statKey = 'points' } = {}) {
  return {
    id, eventId: `e-${id}`, sportKey: 'basketball_nba', sportTitle: 'NBA', commenceMs, home: 'Charlotte Hornets', away: 'Orlando Magic',
    playerName: player, team: 'CHA', opponent: 'ORL', athleteId: '4', headshot: null, statKey, statLabel: 'Pts', marketLabel: 'Points', point, side,
    selection: `${player} ${side === 'over' ? 'Over' : 'Under'} ${point} Pts`, american, decimal: american < 0 ? 1 + 100 / -american : 1 + american / 100, book: 'DraftKings', quotes: [],
    seasons: [2026, 2025], rates: { l20: rate, h2h: h2h.rate, s2026: 1 }, periods: { l5: period(1, 5), l10: period(1, 10), l20: period(rate, games), h2h, s2026: period(1, 5) }, series: [],
  };
}

test('a line qualifies at 100% over at least ten of the last 20 and 100% head to head; the best-paying 100% line per player and stat is kept, today only, not started', () => {
  const rows = [
    row('a', { american: -300, point: 7.5 }),
    row('b', { american: -140, point: 9.5 }),
    row('c', { rate: 0.95 }),
    row('d', { games: PICK_MIN_GAMES - 1 }),
    row('e', { h2h: period(0.5, 2) }),
    row('f', { h2h: period(null, 0), player: 'LaMelo Ball', american: -120 }),
    row('g', { commenceMs: NOW - 60e3, player: 'Miles Bridges' }),
    row('h', { commenceMs: NOW + 30 * 3.6e6, player: 'Brandon Miller' }),
  ];
  const q = qualifyingRows(rows, '2026-10-27', NOW);
  assert.deepEqual(q.map((r) => r.id).sort(), ['b', 'f'], 'the 9.5 (better price) over the 7.5; no head to head at all is fine');
});

test('the research pass: minutes down, listed out or questionable, or a projected blowout pass the line; a bench role, day to day, a teammate out or a lopsided projection become notes', async () => {
  const env = {};
  const base = row('a');
  const steady = Array(20).fill(32);
  const ok = await researchPick(base, env, ctx, { now: NOW, deps: { minutes: async () => steady, context: async () => null, model: async () => '{"verdict":"post","reason":"nothing in the matchup hinders it","note":"none"}' } });
  assert.equal(ok.verdict, 'post');
  assert.equal(ok.note, null);

  const down = await researchPick(base, env, ctx, { now: NOW, deps: { minutes: async () => [18, 20, 19, ...Array(17).fill(32)], context: async () => null, model: async () => null } });
  assert.equal(down.verdict, 'pass');
  assert.match(down.flags[0], /minutes are down/);

  const context = (status, teammateStatus = null, projection = null) => async () => ({
    home: { name: 'Charlotte Hornets', shortName: 'Hornets', overallRecord: '2-1', lastFive: '3-2', injuries: [{ name: 'Collin Sexton', status }, ...(teammateStatus ? [{ name: 'Mark Williams', status: teammateStatus }] : [])] },
    away: { name: 'Orlando Magic', shortName: 'Magic', overallRecord: '1-2', lastFive: '2-3', injuries: [] },
    projection,
  });
  const out = await researchPick(base, env, ctx, { now: NOW, deps: { minutes: async () => steady, context: context('Out'), model: async () => null } });
  assert.equal(out.verdict, 'pass');
  const q = await researchPick(base, env, ctx, { now: NOW, deps: { minutes: async () => steady, context: context('Questionable'), model: async () => null } });
  assert.equal(q.verdict, 'pass');
  const dtd = await researchPick(base, env, ctx, { now: NOW, deps: { minutes: async () => steady, context: context('Day-To-Day', 'Out', { home: 72, away: 28 }), model: async () => '{"verdict":"post","reason":"ok","note":"none"}' } });
  assert.equal(dtd.verdict, 'post');
  assert.match(dtd.note, /day-to-day/i);
  assert.match(dtd.note, /Mark Williams is out/);
  assert.match(dtd.note, /72% favourite/);
  const blowout = await researchPick(base, env, ctx, { now: NOW, deps: { minutes: async () => steady, context: context('Active', null, { home: 85, away: 15 }), model: async () => null } });
  assert.equal(blowout.verdict, 'pass');
  const bench = await researchPick(base, env, ctx, { now: NOW, deps: { minutes: async () => Array(20).fill(19), context: async () => null, model: async () => '{"verdict":"post","reason":"ok","note":"The Magic switch everything, so his catch-and-shoot looks shrink."}' } });
  assert.equal(bench.verdict, 'post');
  assert.match(bench.note, /bench role/);
  assert.match(bench.note, /Magic switch everything/);
  const vetoed = await researchPick(base, env, ctx, { now: NOW, deps: { minutes: async () => steady, context: async () => null, model: async () => '{"verdict":"pass","reason":"he has shot under 9 points in both games on the second night of a back-to-back","note":"none"}' } });
  assert.equal(vetoed.verdict, 'pass');
  assert.match(vetoed.flags.at(-1), /back-to-back/);
  // Without a model reply the facts decide, and the card says the read was unavailable.
  const noModel = await researchPick(base, env, ctx, { now: NOW, deps: { minutes: async () => steady, context: async () => null, model: async () => null } });
  assert.equal(noModel.verdict, 'post');
  assert.ok(noModel.flags.includes('matchup read unavailable'));
  assert.deepEqual(parseVerdict('Sure! {"verdict":"post","reason":"fine","note":"none"} hope that helps'), { verdict: 'post', reason: 'fine', note: 'none' }, 'the JSON is read out of a chatty reply');
  assert.deepEqual(parseVerdict('{"verdict":"pass","reason":"r","note":"n"}'), { verdict: 'pass', reason: 'r', note: 'n' });
});

test('the day posts up to two picks that pass, one per player, says what passed and why, and is final once anything posts', async () => {
  const { env, store } = makeKvStore();
  const rows = [row('a'), row('b', { player: 'LaMelo Ball', american: -110, h2h: period(null, 0) }), row('c', { player: 'Miles Bridges', american: -105 }), row('d', { player: 'Brandon Miller', american: -102 })];
  const deps = {
    rowsFor: async () => rows,
    minutes: async (r) => (r.playerName === 'Miles Bridges' ? [10, 12, 11, ...Array(17).fill(30)] : Array(20).fill(32)),
    context: async () => null,
    model: async () => '{"verdict":"post","reason":"ok","note":"none"}',
  };
  const r = await runTrendPicksDaily(env, ctx, NOW, { deps, enabled: ['basketball_nba'] });
  assert.equal(r.posted, PICK_MAX_POSTED);
  assert.equal(r.considered, 4);
  const rec = JSON.parse(store.get('trendpicks:2026-10-27'));
  assert.deepEqual(rec.picks.map((p) => p.playerName).sort(), ['Brandon Miller', 'LaMelo Ball'], 'ranked by price among equal samples: Miller posts, Bridges passes on minutes, Ball posts, Sexton is never reached');
  assert.deepEqual(rec.passed.map((p) => p.selection), ['Miles Bridges Over 9.5 Pts']);
  assert.match(rec.passed[0].reasons[0], /minutes are down/);
  assert.equal(rec.final, true);
  assert.equal(rec.picks[0].status, 'pending');
  assert.equal((await runTrendPicksDaily(env, ctx, NOW + 60e3, { deps, enabled: ['basketball_nba'] })).reason, 'posted');

  // A day with nothing qualifying is checked again in an hour, not every tick.
  const empty = makeKvStore();
  const none = { ...deps, rowsFor: async () => [row('x', { rate: 0.9 })] };
  assert.equal((await runTrendPicksDaily(empty.env, ctx, NOW, { deps: none, enabled: ['basketball_nba'] })).posted, 0);
  assert.equal((await runTrendPicksDaily(empty.env, ctx, NOW + 10 * 60e3, { deps: none, enabled: ['basketball_nba'] })).reason, 'checked recently');
  assert.equal((await runTrendPicksDaily(empty.env, ctx, NOW + 61 * 60e3, { deps: none, enabled: ['basketball_nba'] })).skipped, false);
});

test('picks are graded off the game log once the game is over, a no-show voids a day and a half on, and the history carries the running record', async () => {
  const { env } = makeKvStore();
  const rows = [row('a'), row('b', { player: 'LaMelo Ball', american: 100, point: 5, side: 'under', statKey: 'assists' })];
  const deps = { rowsFor: async () => rows, minutes: async () => Array(20).fill(32), context: async () => null, model: async () => '{"verdict":"post","reason":"ok","note":"none"}' };
  await runTrendPicksDaily(env, ctx, NOW, { deps, enabled: ['basketball_nba'] });
  assert.equal(settle({ point: 9.5, side: 'over' }, 10), 'win');
  assert.equal(settle({ point: 9.5, side: 'over' }, 9), 'loss');
  assert.equal(settle({ point: 5, side: 'under' }, 5), 'push');
  assert.equal(settle({ point: 5, side: 'under' }, 4), 'win');
  const early = await runTrendPicksGrading(env, ctx, NOW + 9 * 3.6e6, { deps: { actual: async () => 12 } });
  assert.equal(early.graded, 0, 'not until three hours after tip-off');
  const later = await runTrendPicksGrading(env, ctx, NOW + 12 * 3.6e6, { deps: { actual: async (p) => (p.playerName === 'Collin Sexton' ? 12 : null) } });
  assert.equal(later.graded, 1);
  const voided = await runTrendPicksGrading(env, ctx, NOW + 46 * 3.6e6, { deps: { actual: async () => null } });
  assert.equal(voided.graded, 1, 'the no-show voids');
  const all = await getTrendPicks(env, NOW + 46 * 3.6e6);
  assert.equal(all.history.length, 1);
  const sexton = all.history[0].picks.find((p) => p.playerName === 'Collin Sexton');
  const ball = all.history[0].picks.find((p) => p.playerName === 'LaMelo Ball');
  assert.equal(sexton.result, 'win');
  assert.equal(sexton.actual, 12);
  assert.equal(ball.result, 'void');
  assert.deepEqual(all.record, { wins: 1, losses: 0, pushes: 0, units: 0.71 });
});
