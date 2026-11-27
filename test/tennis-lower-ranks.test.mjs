import test from 'node:test';
import assert from 'node:assert/strict';
import { rankingWeek, parseRanks, rankOf, runLowerRanksTick, getLowerRanks, lowerRanksStatus, RANKS_DAILY, LOWER_RANKS_WORK_KEY } from '../worker/src/tennis-lower-ranks.js';

const kv = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const FRI = Date.parse('2026-11-27T09:00:00Z');
const page = (tour, n, size = 2, more = false) => ({ hasNextPage: more, data: Array.from({ length: size }, (_, i) => ({ position: (n - 1) * 500 + i + 1, point: 1000 - i, player: { name: `${tour} Player${n}${i}` } })) });

test('the ranking week starts on Monday noon UTC', () => {
  assert.equal(new Date(rankingWeek(FRI)).toISOString(), '2026-11-23T12:00:00.000Z');
  assert.equal(new Date(rankingWeek(Date.parse('2026-11-23T11:00:00Z'))).toISOString(), '2026-11-16T12:00:00.000Z');
  assert.equal(new Date(rankingWeek(Date.parse('2026-11-23T12:00:00Z'))).toISOString(), '2026-11-23T12:00:00.000Z');
});

test('a page of the list reads under several field names, and says whether more follows', () => {
  assert.deepEqual(parseRanks({ hasNextPage: true, data: [{ position: 3, point: 250, player: { name: 'Kimmer Coppejans' } }] }), { rows: [{ name: 'Kimmer Coppejans', rank: 3, points: 250 }], more: true, raw: 1 });
  assert.deepEqual(parseRanks([{ rank: '7', points: '90', name: 'Dali Blanch' }], 1).rows, [{ name: 'Dali Blanch', rank: 7, points: 90 }]);
  assert.equal(parseRanks([{ rank: 7, name: 'A B' }], 1).more, true);
  assert.equal(parseRanks({ data: [{ name: 'No Rank' }] }).rows.length, 0);
  assert.deepEqual(parseRanks(null), { rows: [], more: false, raw: 0 });
});

test('a player is found by name, or by surname and initial when only one fits', () => {
  const list = { 'kimmer coppejans': [210, 280], 'gilles arnaud bailly': [300, 190], 'anna kubareva': [500, 60], 'anastasia kubareva': [640, 40] };
  assert.deepEqual(rankOf(list, 'Kimmer Coppejans'), { rank: 210, points: 280 });
  assert.deepEqual(rankOf(list, 'Gilles Bailly'), { rank: 300, points: 190 });
  assert.equal(rankOf(list, 'A. Kubareva'), null);
  assert.equal(rankOf(list, 'Nobody Here'), null);
  assert.equal(rankOf(null, 'Kimmer Coppejans'), null);
});

test('the list is read a page a tick, both tours, then put into use and left for the week', async () => {
  const POTD_KV = kv(); const env = { POTD_KV };
  const asked = [];
  const deps = { noRest: true, fetchPage: async (tour, n) => { asked.push(`${tour}${n}`); return page(tour, n, 2, tour === 'atp' && n === 1); } };
  let r = await runLowerRanksTick(env, FRI, { deps });
  assert.equal(r.done, false);
  assert.equal(await getLowerRanks(env), null);
  r = await runLowerRanksTick(env, FRI + 60e3, { deps });
  r = await runLowerRanksTick(env, FRI + 120e3, { deps });
  assert.equal(r.done, true);
  assert.deepEqual(asked, ['atp1', 'atp2', 'wta1']);
  const ranks = await getLowerRanks(env);
  assert.equal(Object.keys(ranks.atp).length, 4);
  assert.deepEqual(ranks.wta['wta player10'], [1, 1000]);
  // Later the same week: nothing is asked.
  r = await runLowerRanksTick(env, FRI + 3 * 3600e3, { deps });
  assert.equal(r.reason, 'this week\'s list is on file');
  assert.equal(asked.length, 3);
  // The next Monday's list is read afresh; the old one stays in use meanwhile.
  r = await runLowerRanksTick(env, FRI + 4 * 864e5, { deps });
  assert.equal(r.skipped, false);
  assert.equal(Object.keys((await getLowerRanks(env)).atp).length, 4);
  const status = await lowerRanksStatus(env);
  assert.equal(status.inUse.atp, 4);
  assert.equal(status.shape.atp.parsed, 2);
});

test('an empty list is not put into use, and a failed read counts against the day', async () => {
  const POTD_KV = kv(); const env = { POTD_KV };
  const empty = { noRest: true, fetchPage: async () => ({ data: [] }) };
  await runLowerRanksTick(env, FRI, { deps: empty });
  let r = await runLowerRanksTick(env, FRI + 60e3, { deps: empty });
  assert.equal(r.done, false);
  assert.equal(await getLowerRanks(env), null);
  r = await runLowerRanksTick(env, FRI + 120e3, { deps: empty });
  assert.equal(r.reason, 'the last list came back empty');
  // Half a day on it starts again.
  r = await runLowerRanksTick(env, FRI + 13 * 3600e3, { deps: empty });
  assert.equal(r.skipped, false);
  const failing = kv();
  const down = { noRest: true, fetchPage: async () => { throw new Error('down'); } };
  for (let i = 0; i < RANKS_DAILY + 2; i++) await runLowerRanksTick({ POTD_KV: failing }, FRI + i * 60e3, { deps: down });
  assert.equal(JSON.parse(failing.m.get(LOWER_RANKS_WORK_KEY)).calls, RANKS_DAILY);
});
