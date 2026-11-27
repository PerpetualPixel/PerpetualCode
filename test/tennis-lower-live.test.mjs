import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSets, parseLiveEvents, lowerLiveBudget, lowerInPlay, runLowerLiveTick, getLowerLive, eventFor, matchWinner, settleLean, advanceLower, lowerLiveView, lowerSourceTier, nearPlayer, samePair, etHour, LOWER_LIVE_KEY, LOWER_LIVE_DAILY } from '../worker/src/tennis-lower-live.js';
import { TENNIS_LOWER_KEY } from '../worker/src/tennis-lower.js';

// 11 AM Eastern: inside the free plan's reading hours.
const NOW = Date.parse('2026-11-27T16:00:00Z');
const kv = (init = {}) => { const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)])); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const log = (startMs, extra = {}) => ({ matches: { 1: { id: '1', comp: 'Monastir Challenger 2026', tour: 'atp', tier: 'challenger', a: 'Kimmer Coppejans', b: 'Dali Blanch', start: startMs, ml: { a: -188, b: 140 }, ...extra } } });
const row = (score, extra = {}) => ({ id: '9', a: 'Kimmer Coppejans', b: 'Dali Blanch', tour: 'atp', status: 'InPlay', sets: parseSets(score), points: '30-15', server: 'a', tournament: null, ...extra });
const body = { success: true, count: 2, results: [
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
  assert.equal(parseLiveEvents({ data: body.results }).length, 1);
  assert.equal(parseLiveEvents(body.results).length, 1);
});

test('the budget is the free plan\'s unless the worker says otherwise', () => {
  assert.deepEqual(lowerLiveBudget({}), { daily: LOWER_LIVE_DAILY, everyMs: 60 * 60e3, fromHour: 10 });
  assert.deepEqual(lowerLiveBudget({ TENNIS_LOWER_LIVE_DAILY: '1400', TENNIS_LOWER_LIVE_EVERY_MIN: '1' }), { daily: 1400, everyMs: 60e3, fromHour: 10 });
  assert.equal(lowerLiveBudget({ TENNIS_LOWER_LIVE_FROM_HOUR: '8' }).fromHour, 8);
  assert.equal(lowerLiveBudget({ TENNIS_LOWER_LIVE_FROM_HOUR: '0' }).fromHour, 0);
  assert.equal(lowerLiveBudget({ TENNIS_LOWER_LIVE_FROM_HOUR: 'noon' }).fromHour, 10);
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
  r = await runLowerLiveTick(env, NOW + 61 * 60e3, { deps });
  assert.equal(r.calls, 2);
  const seen = await getLowerLive(env, NOW + 61 * 60e3, { debug: true });
  assert.equal(seen.matches[0].a, 'Kimmer Coppejans');
  assert.deepEqual(seen.matches[0].sets, [[6, 4], [3, 2]]);
  assert.equal(seen.shape.rows, 2);
  assert.equal(seen.readsLeft, LOWER_LIVE_DAILY - 2);
  assert.equal((await getLowerLive(env, NOW + 61 * 60e3)).shape, undefined);
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
  const r = await runLowerLiveTick({ POTD_KV }, NOW + 61 * 60e3, { deps });
  assert.equal(r.reason, 'nothing in play');
  assert.equal(asked, 1);
});

test('a failed read keeps the last scores and still counts against the day', async () => {
  const POTD_KV = kv({ [TENNIS_LOWER_KEY]: log(NOW - 3600e3) });
  await runLowerLiveTick({ POTD_KV }, NOW, { deps: { noRest: true, fetchLive: async () => body } });
  const r = await runLowerLiveTick({ POTD_KV }, NOW + 61 * 60e3, { deps: { noRest: true, fetchLive: async () => { throw new Error('down'); } } });
  assert.equal(r.error, 'down');
  assert.equal(r.calls, 2);
  const seen = await getLowerLive({ POTD_KV }, NOW + 61 * 60e3);
  assert.equal(seen.matches.length, 1);
  assert.equal(seen.at, NOW);
  assert.equal(seen.error, 'down');
});

test('the source\'s row is turned to the board\'s own order of players', () => {
  const m = { a: 'Dali Blanch', b: 'Kimmer Coppejans' };
  const e = eventFor(m, [row('6-4,3-2')]);
  assert.deepEqual(e.sets, [[4, 6], [2, 3]]);
  assert.equal(e.points, '15-30');
  assert.equal(e.server, 'b');
  assert.equal(eventFor({ a: 'Someone Else', b: 'Kimmer Coppejans' }, [row('6-4')]), null);
  assert.equal(eventFor({ a: 'Kimmer Coppejans', b: 'Dali Blanch' }, [row('1-0')]).server, 'a');
});

test('a match is won with two sets, and a lean settles with its set or the match', () => {
  assert.equal(matchWinner([[6, 4], [3, 2]]), null);
  assert.equal(matchWinner([[6, 4], [7, 6]]), 'a');
  assert.equal(matchWinner([[6, 4], [3, 6], [5, 7]]), 'b');
  const set = { market: 'live_set', side: 'a', set: 2 };
  assert.equal(settleLean(set, [[6, 4], [3, 2]]), null);
  assert.equal(settleLean(set, [[6, 4], [6, 3]]), 'win');
  assert.equal(settleLean(set, [[6, 4], [4, 6], [1, 0]]), 'loss');
  assert.equal(settleLean(set, [[6, 4], [3, 2]], { ended: true }), 'void');
  const ml = { market: 'live_ml', side: 'b' };
  assert.equal(settleLean(ml, [[6, 4], [3, 2]]), null);
  assert.equal(settleLean(ml, [[6, 4], [6, 2]]), 'loss');
  assert.equal(settleLean(ml, [[6, 4], [3, 2]], { drawWinner: 'b' }), 'win');
  assert.equal(settleLean(ml, [[6, 4], [3, 2]], { ended: true }), 'void');
});

test('a match in play gets a call, a lean opens once, and it is graded when its set ends', () => {
  const lg = log(NOW - 3600e3);
  // A set and a break up: the favourite is the set lean or the match is too short to call, never a watch this deep.
  let st = advanceLower(null, null, lg, [row('6-4,3-1')], NOW);
  const m = st.matches['1'];
  assert.equal(m.live, true);
  assert.equal(m.priced, true);
  assert.ok(['lean', 'pass'].includes(m.call.kind));
  assert.ok(m.read.prob > 0.8);
  // Level in the first set, six games in: whatever the call, a lean that opens is kept as it was when it opened.
  st = advanceLower(null, null, lg, [row('4-2')], NOW);
  const lean = st.matches['1'].lean;
  assert.ok(lean, JSON.stringify(st.matches['1'].call));
  assert.equal(lean.side, 'a');
  assert.equal(lean.score, '4-2');
  assert.ok(Number.isFinite(lean.playable));
  // The next read: still open, the same lean.
  let nxt = advanceLower(st.matches, st.tally, lg, [row('5-3')], NOW + 20 * 60e3);
  assert.equal(nxt.matches['1'].lean.at, NOW);
  assert.equal(nxt.matches['1'].lean.result, undefined);
  // Its set (or the match) goes the lean's way.
  nxt = advanceLower(nxt.matches, nxt.tally, lg, [row(lean.market === 'live_set' ? '6-3,1-0' : '6-3,6-2', lean.market === 'live_set' ? {} : { status: 'Ended' })], NOW + 40 * 60e3);
  assert.equal(nxt.tally.wins, 1);
  assert.ok(nxt.tally.units > 0);
  // Read again with nothing new: not counted twice.
  const again = advanceLower(nxt.matches, nxt.tally, lg, [row(lean.market === 'live_set' ? '6-3,1-0' : '6-3,6-2', lean.market === 'live_set' ? {} : { status: 'Ended' })], NOW + 41 * 60e3);
  assert.equal(again.tally.wins + again.tally.losses, 1);
});

test('a match that leaves the source with a set lean open voids it, and a match lean waits for the draw', () => {
  const lg = log(NOW - 3600e3);
  const open = (lean) => ({ 1: { id: '1', a: 'Kimmer Coppejans', b: 'Dali Blanch', start: NOW - 3600e3, sets: [[6, 4], [3, 2]], live: true, seenAt: NOW, timeline: { sets: [[6, 4], [3, 2]], games: [] }, serve: { pA: 0.64, pB: 0.6 }, lean } });
  let st = advanceLower(open({ market: 'live_set', side: 'a', set: 2, playable: -150, at: NOW }), null, lg, [], NOW + 20 * 60e3);
  assert.equal(st.matches['1'].lean.result, 'void');
  assert.equal(st.matches['1'].live, false);
  assert.equal(st.tally.voids, 1);
  st = advanceLower(open({ market: 'live_ml', side: 'b', playable: 120, at: NOW }), null, lg, [], NOW + 20 * 60e3);
  assert.equal(st.matches['1'].lean.result, undefined);
  // The draw then shows who went through.
  st = advanceLower(st.matches, st.tally, log(NOW - 3600e3, { result: 'b' }), [], NOW + 5 * 3600e3);
  assert.equal(st.matches['1'].lean.result, 'win');
  assert.equal(st.tally.units, 0.6);
});

test('the view lists the matches in play at the last read, with the tally and how often the source is read', () => {
  const st = advanceLower(null, null, log(NOW - 3600e3), [row('4-2')], NOW);
  const v = lowerLiveView({ ...st, eventsAt: NOW, day: 'x', calls: 3 }, {}, NOW + 5 * 60e3);
  assert.equal(v.matches.length, 1);
  assert.equal(v.matches[0].timeline, undefined);
  assert.equal(v.everyMin, 60);
  assert.equal(v.fromHour, 10);
  assert.equal(v.stale, false);
  assert.deepEqual(v.tally, { wins: 0, losses: 0, voids: 0, units: 0 });
  // A later read without the match: it is off the list.
  const later = advanceLower(st.matches, st.tally, log(NOW - 3600e3), [], NOW + 20 * 60e3);
  assert.equal(lowerLiveView({ ...later, eventsAt: NOW + 20 * 60e3 }, {}, NOW + 61 * 60e3).matches.length, 0);
  assert.equal(lowerLiveView(null, {}), null);
});

test('the source\'s rows as they really come (2026-11-27) are read whole', () => {
  const real = { success: true, count: 1, results: [{ id: 5223343, name: 'Joel Schwaerzler vs Daniel Merida Aguilar', participant1: 'Joel Schwaerzler', participant2: 'Daniel Merida Aguilar', league: 'Playford Challenger', score: '4-6,2-1', status: 'InPlay', points: '15-0', indicator: '0,1', player1: { name: 'Joel Schwaerzler' }, player2: { name: 'Daniel Merida Aguilar' }, tournament: { name: 'Playford Challenger' }, tourType: 'atp', startTimestamp: 1795709700 }] };
  assert.deepEqual(parseLiveEvents(real), [{ id: '5223343', a: 'Joel Schwaerzler', b: 'Daniel Merida Aguilar', tour: 'atp', status: 'InPlay', sets: [[4, 6], [2, 1]], points: '15-0', server: 'b', tournament: 'Playford Challenger' }]);
});

test('a tournament below the tours is told by the source\'s name for it', () => {
  assert.equal(lowerSourceTier('Playford Challenger'), 'challenger');
  assert.equal(lowerSourceTier('M15 Orlando'), 'itf');
  assert.equal(lowerSourceTier('W75 Playford'), 'itf');
  assert.equal(lowerSourceTier('Davis Cup, World Group, QF, AUT-ESP'), null);
  assert.equal(lowerSourceTier('Nitto ATP Finals'), null);
});

test('a Challenger or ITF match the board never listed is followed from the source alone, a tour match is not', () => {
  const events = [row('4-2', { id: '77', a: 'Alex Bolt', b: 'Li Tu', tournament: 'Playford Challenger' }), row('4-2', { id: '78', a: 'Top Seed', b: 'Other Seed', tournament: 'Nitto ATP Finals' }), row('3-3')];
  let st = advanceLower(null, null, log(NOW - 3600e3), events, NOW);
  assert.deepEqual(Object.keys(st.matches).sort(), ['1', 'src:77']);
  const m = st.matches['src:77'];
  assert.equal(m.comp, 'Playford Challenger');
  assert.equal(m.priced, false);
  assert.equal(m.source, true);
  assert.equal(m.live, true);
  assert.equal(m.lean?.basis, 'score');
  // The board match is not doubled by the source's own row for it.
  assert.equal(Object.values(st.matches).filter((x) => x.a === 'Kimmer Coppejans').length, 1);
  // Carried to the next read, same start, and settled by the score.
  const at = st.matches['src:77'].start;
  st = advanceLower(st.matches, st.tally, log(NOW - 3600e3), [row('6-2,6-1', { id: '77', a: 'Alex Bolt', b: 'Li Tu', tournament: 'Playford Challenger' })], NOW + 60 * 60e3);
  assert.equal(st.matches['src:77'].start, at);
  assert.equal(st.matches['src:77'].live, false);
  assert.equal(st.matches['src:77'].lean.result, 'win');
  // Gone from the source: kept on file, off the list.
  st = advanceLower(st.matches, st.tally, log(NOW - 3600e3), [], NOW + 80 * 60e3);
  assert.equal(st.matches['src:77'].live, false);
  assert.equal(st.tally.wins, 1);
});

test('a plan with calls to spare reads with no board match in play', async () => {
  const POTD_KV = kv({ [TENNIS_LOWER_KEY]: log(NOW + 5 * 3600e3) });
  let asked = 0;
  const deps = { noRest: true, fetchLive: async () => { asked += 1; return body; } };
  const env = { POTD_KV, TENNIS_LOWER_LIVE_DAILY: '1400', TENNIS_LOWER_LIVE_EVERY_MIN: '1' };
  await runLowerLiveTick(env, NOW, { deps });
  const r = await runLowerLiveTick(env, NOW + 2 * 60e3, { deps });
  assert.equal(r.skipped, false);
  assert.equal(asked, 2);
});

test('a near spelling of one player pairs a match when the other player fits, and not otherwise', () => {
  assert.equal(nearPlayer('Adelina Lachinova', 'Adelina Lacinova'), true);
  assert.equal(nearPlayer('Adelina Lachinova', 'Bella Lacinova'), false);
  assert.equal(nearPlayer('Anna Kubareva', 'Anna Snigireva'), false);
  assert.equal(nearPlayer('Li Tu', 'Li Zu'), false);
  const board = { a: 'Adelina Lacinova', b: 'Ani Amiraghyan' };
  assert.equal(samePair(board, { a: 'Adelina Lachinova', b: 'Ani Amiraghyan' }), 1);
  assert.equal(samePair(board, { a: 'Ani Amiraghyan', b: 'Adelina Lachinova' }), 2);
  // A near spelling with a different opponent is another match.
  assert.equal(samePair(board, { a: 'Adelina Lachinova', b: 'Someone Else' }), 0);
  // As it came on 2026-11-27: the board match takes the source's row, and no second card is made for it.
  const lg = { matches: { 7: { id: '7', comp: 'ITF W15 Antalya TUR', tour: 'wta', tier: 'itf', a: 'Adelina Lacinova', b: 'Ani Amiraghyan', start: NOW - 3600e3, ml: { a: 100, b: -132 } } } };
  const st = advanceLower(null, null, lg, [row('2-5', { id: '5223415', a: 'Adelina Lachinova', b: 'Ani Amiraghyan', tournament: 'W15 Antalya' })], NOW);
  assert.deepEqual(Object.keys(st.matches), ['7']);
  assert.equal(st.matches['7'].priced, true);
  assert.deepEqual(st.matches['7'].sets, [[2, 5]]);
  // A match followed from the source alone before the pairing was made gives way to the board's.
  const before = { 'src:5223415': { id: 'src:5223415', source: true, comp: 'W15 Antalya', tour: 'wta', tier: 'itf', a: 'Adelina Lachinova', b: 'Ani Amiraghyan', start: NOW - 1800e3, sets: [[1, 2]], live: true, seenAt: NOW - 1800e3, timeline: { sets: [[1, 2]], games: [] }, serve: { pA: 0.56, pB: 0.56 }, lean: { market: 'live_ml', side: 'b', set: null, selection: 'Ani Amiraghyan to win the match', prob: 0.7, playable: -200, basis: 'score', score: '1-2', at: NOW - 1800e3 } } };
  const next = advanceLower(before, null, lg, [row('2-5', { id: '5223415', a: 'Adelina Lachinova', b: 'Ani Amiraghyan', tournament: 'W15 Antalya' })], NOW);
  assert.deepEqual(Object.keys(next.matches), ['7']);
  // The lean opened while it was followed from the source alone goes with it.
  assert.equal(next.matches['7'].lean.selection, 'Ani Amiraghyan to win the match');
  assert.equal(next.matches['7'].lean.at, NOW - 1800e3);
});

test('on the free plan nothing is read before 10 AM Eastern, so the day\'s reads are not spent overnight', async () => {
  assert.equal(etHour(Date.parse('2026-11-27T14:59:00Z')), 9);
  assert.equal(etHour(Date.parse('2026-11-27T15:00:00Z')), 10);
  assert.equal(etHour(Date.parse('2026-11-27T05:00:00Z')), 0);
  const early = Date.parse('2026-11-27T09:00:00Z'); // 4 AM Eastern, Europe's matches in play
  const POTD_KV = kv({ [TENNIS_LOWER_KEY]: log(early - 3600e3) });
  let asked = 0;
  const deps = { noRest: true, fetchLive: async () => { asked += 1; return body; } };
  let r = await runLowerLiveTick({ POTD_KV }, early, { deps });
  assert.equal(r.reason, 'before the day\'s first read');
  assert.equal(asked, 0);
  // The hour can be moved, and a plan with calls to spare reads the clock round.
  r = await runLowerLiveTick({ POTD_KV, TENNIS_LOWER_LIVE_FROM_HOUR: '4' }, early, { deps });
  assert.equal(r.skipped, false);
  const paid = kv({ [TENNIS_LOWER_KEY]: log(early - 3600e3) });
  r = await runLowerLiveTick({ POTD_KV: paid, TENNIS_LOWER_LIVE_DAILY: '1400', TENNIS_LOWER_LIVE_EVERY_MIN: '1' }, early, { deps });
  assert.equal(r.skipped, false);
});

test('scores past their read are not shown as in play, and the view says so', () => {
  const st = advanceLower(null, null, log(NOW - 3600e3), [row('4-2')], NOW);
  const state = { ...st, eventsAt: NOW, day: '2026-11-27', calls: 10 };
  // Inside the hour and a little: shown.
  assert.equal(lowerLiveView(state, {}, NOW + 65 * 60e3).matches.length, 1);
  // Seven hours on, the day's reads spent (2026-11-27: scores read at 5:30 AM shown as in play at noon).
  const late = lowerLiveView(state, {}, NOW + 7 * 3600e3);
  assert.equal(late.stale, true);
  assert.equal(late.matches.length, 0);
  assert.equal(late.readsLeft, 0);
  assert.deepEqual(late.tally, { wins: 0, losses: 0, voids: 0, units: 0 });
  // A plan that reads every minute goes stale in minutes, not hours.
  assert.equal(lowerLiveView(state, { TENNIS_LOWER_LIVE_DAILY: '1400', TENNIS_LOWER_LIVE_EVERY_MIN: '1' }, NOW + 12 * 60e3).stale, true);
  assert.equal(lowerLiveView(state, { TENNIS_LOWER_LIVE_DAILY: '1400', TENNIS_LOWER_LIVE_EVERY_MIN: '1' }, NOW + 5 * 60e3).fromHour, null);
});
