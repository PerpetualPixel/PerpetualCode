import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSets, parseLiveEvents, lowerLiveBudget, lowerInPlay, runLowerLiveTick, getLowerLive, LOWER_LIVE_KEY, LOWER_LIVE_DAILY } from '../worker/src/tennis-lower-live.js';
import { TENNIS_LOWER_KEY } from '../worker/src/tennis-lower.js';

const NOW = Date.parse('2026-11-27T09:00:00Z');
const kv = (init = {}) => { const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)])); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const log = (startMs) => ({ matches: { 1: { id: '1', a: 'Kimmer Coppejans', b: 'Dali Blanch', start: startMs } } });
const body = { data: [
  { id: 9, player1: { name: 'Kimmer Coppejans' }, player2: { name: 'Dali Blanch' }, score: '6-4,3-2', points: '30-15', indicator: '1,0', status: 'InPlay', tourType: 'atp' },
  { id: 10, player1: { name: 'A One / B Two' }, player2: { name: 'C Three / D Four' }, score: '2-1', status: 'InPlay', tourType: 'atp' },
] };

test('a score string reads as sets, a tiebreak\'s points dropped', () => {
  assert.deepEqual(parseSets('6-4,3-2'), [[6, 4], [3, 2]]);
  assert.deepEqual(parseSets('7-6(4), 1-0'), [[7, 6], [1, 0]]);
  assert.deepEqual(parseSets(''), []);
  assert.deepEqual(parseSets(null), []);
});

test('the source\'s rows are read as singles matches with the server', () => {
  const events = parseLiveEvents(body);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { id: '9', a: 'Kimmer Coppejans', b: 'Dali Blanch', tour: 'atp', status: 'InPlay', sets: [[6, 4], [3, 2]], points: '30-15', server: 'a', tournament: null });
  assert.deepEqual(parseLiveEvents(null), []);
  assert.deepEqual(parseLiveEvents({ data: 'no' }), []);
});

test('the budget is the free plan\'s unless the worker says otherwise', () => {
  assert.deepEqual(lowerLiveBudget({}), { daily: LOWER_LIVE_DAILY, everyMs: 20 * 60e3 });
  assert.deepEqual(lowerLiveBudget({ TENNIS_LOWER_LIVE_DAILY: '1400', TENNIS_LOWER_LIVE_EVERY_MIN: '1' }), { daily: 1400, everyMs: 60e3 });
});

test('a match is in play from its start for a few hours, until it has a result', () => {
  assert.equal(lowerInPlay(log(NOW - 3600e3), NOW).length, 1);
  assert.equal(lowerInPlay(log(NOW + 3600e3), NOW).length, 0);
  assert.equal(lowerInPlay(log(NOW - 5 * 3600e3), NOW).length, 0);
  assert.equal(lowerInPlay({ matches: { 1: { id: '1', start: NOW - 3600e3, result: 'a' } } }, NOW).length, 0);
});

test('the tick reads when a match is in play, then waits out the interval and the day\'s calls', async () => {
  const POTD_KV = kv({ [TENNIS_LOWER_KEY]: log(NOW - 3600e3) });
  const env = { POTD_KV };
  let asked = 0;
  const deps = { noRest: true, fetchLive: async () => { asked += 1; return body; } };
  let r = await runLowerLiveTick(env, NOW, { deps });
  assert.deepEqual({ skipped: r.skipped, events: r.events, playing: r.playing, calls: r.calls }, { skipped: false, events: 1, playing: 1, calls: 1 });
  // Five minutes on: too soon.
  r = await runLowerLiveTick(env, NOW + 5 * 60e3, { deps });
  assert.equal(r.reason, 'read not long ago');
  assert.equal(asked, 1);
  // Past the interval it reads again.
  r = await runLowerLiveTick(env, NOW + 21 * 60e3, { deps });
  assert.equal(r.calls, 2);
  const seen = await getLowerLive(env);
  assert.equal(seen.events[0].a, 'Kimmer Coppejans');
  assert.equal(seen.shape.rows, 2);
  // The day's calls spent: no read.
  const state = JSON.parse(POTD_KV.m.get(LOWER_LIVE_KEY));
  POTD_KV.m.set(LOWER_LIVE_KEY, JSON.stringify({ ...state, calls: LOWER_LIVE_DAILY, fetchedAt: NOW }));
  r = await runLowerLiveTick(env, NOW + 60 * 60e3, { deps });
  assert.equal(r.reason, 'the day\'s calls are spent');
  assert.equal(asked, 2);
});

test('with nothing in play the source is read once, for its shape, and not again', async () => {
  const POTD_KV = kv({ [TENNIS_LOWER_KEY]: log(NOW + 5 * 3600e3) });
  let asked = 0;
  const deps = { noRest: true, fetchLive: async () => { asked += 1; return body; } };
  await runLowerLiveTick({ POTD_KV }, NOW, { deps });
  const r = await runLowerLiveTick({ POTD_KV }, NOW + 30 * 60e3, { deps });
  assert.equal(r.reason, 'nothing in play');
  assert.equal(asked, 1);
});

test('a failed read keeps the last scores and still counts against the day', async () => {
  const POTD_KV = kv({ [TENNIS_LOWER_KEY]: log(NOW - 3600e3) });
  await runLowerLiveTick({ POTD_KV }, NOW, { deps: { noRest: true, fetchLive: async () => body } });
  const r = await runLowerLiveTick({ POTD_KV }, NOW + 21 * 60e3, { deps: { noRest: true, fetchLive: async () => { throw new Error('down'); } } });
  assert.equal(r.error, 'down');
  assert.equal(r.calls, 2);
  const seen = await getLowerLive({ POTD_KV });
  assert.equal(seen.events.length, 1);
  assert.equal(seen.at, NOW);
});
