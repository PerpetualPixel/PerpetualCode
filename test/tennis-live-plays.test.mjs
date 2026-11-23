import test from 'node:test';
import assert from 'node:assert/strict';
import { holdProb, pointProbFor, tiebreakProb, setOutcome, liveMatchProb, serveFromMarket, advanceTimeline, serveRead, updatedServe, momentumOf, scoreState, liveRead, livePlays, liveUnits } from '../worker/src/tennis-live-model.js';
import { runTennisLiveTick, getTennisLivePlays, gradeLivePlay, liveRecordOf, TENNIS_LIVE_STATE_KEY, tennisLivePlaysKey, TENNIS_LIVE_READS_KEY, IDLE_MS } from '../worker/src/tennis-live-plays.js';
import { tennisPicksKey } from '../worker/src/tennis-picks.js';

const near = (a, b, tol = 0.005) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('holdProb, its inverse and the tiebreak: a tour-average server holds about 81%, equal players split a tiebreak', () => {
  near(holdProb(0.64), 0.813);
  near(holdProb(0.57), 0.67);
  near(holdProb(0.5), 0.5, 1e-9);
  near(pointProbFor(holdProb(0.68)), 0.68, 1e-6);
  near(tiebreakProb(0.64, 0.64, true), 0.5, 1e-9);
  near(tiebreakProb(0.64, 0.64, false), 0.5, 1e-9);
  assert.ok(tiebreakProb(0.68, 0.62) > 0.58);
  near(tiebreakProb(0.68, 0.62, true) + tiebreakProb(0.62, 0.68, true), 1, 1e-9);
});

test('setOutcome and liveMatchProb: the score moves the chances the way a match does', () => {
  const o = setOutcome(0.64, 0.64, 0, 0, true);
  near(o.aA + o.aB + o.bA + o.bB, 1, 1e-9);
  near(o.aA + o.aB, 0.5, 1e-9);
  near(liveMatchProb({ pA: 0.64, pB: 0.64 }).match, 0.5, 1e-9);
  near(liveMatchProb({ pA: 0.64, pB: 0.64, setsA: 1 }).match, 0.75, 1e-9);
  near(liveMatchProb({ pA: 0.64, pB: 0.64, setsA: 1, bestOf: 5 }).match, 0.6875, 1e-9);
  const upBreak = liveMatchProb({ pA: 0.64, pB: 0.64, gA: 3, gB: 1, aServes: true });
  assert.ok(upBreak.set > 0.8 && upBreak.set < 0.87, String(upBreak.set));
  assert.ok(liveMatchProb({ pA: 0.64, pB: 0.64, gA: 5, gB: 4, aServes: true }).set > liveMatchProb({ pA: 0.64, pB: 0.64, gA: 5, gB: 4, aServes: false }).set, 'serving for the set beats receiving at 5-4');
  // Unknown server: the mean of the two cases.
  const both = [true, false].map((s) => liveMatchProb({ pA: 0.64, pB: 0.64, gA: 5, gB: 4, aServes: s }).set);
  near(liveMatchProb({ pA: 0.64, pB: 0.64, gA: 5, gB: 4 }).set, (both[0] + both[1]) / 2, 1e-9);
  assert.equal(liveMatchProb({ pA: 0.64, pB: 0.64, setsA: 2 }).match, 1);
  assert.ok(liveMatchProb({ pA: 0.67, pB: 0.61, bestOf: 5 }).match > liveMatchProb({ pA: 0.67, pB: 0.61 }).match, 'a longer match favors the better server');
  near(liveMatchProb({ pA: 0.67, pB: 0.61 }).nextSet, liveMatchProb({ pA: 0.67, pB: 0.61 }).set, 1e-9);
});

test('serveFromMarket solves a serve pair that reads the price from the score it was seen at', () => {
  const s = serveFromMarket(0.7);
  near(liveMatchProb(s).match, 0.7, 1e-4);
  const late = serveFromMarket(0.55, { tour: 'wta', setsB: 1, gA: 2, gB: 1 });
  near(liveMatchProb({ ...late, setsB: 1, gA: 2, gB: 1 }).match, 0.55, 1e-4);
  assert.ok(late.pA > late.pB, 'a set down and still favored: the stronger server');
});

test('advanceTimeline carries the games forward in order, marks what it cannot order, and starts over on a corrected score', () => {
  let t = null;
  for (const sets of [[[1, 0]], [[1, 1]], [[2, 1]], [[3, 1]]]) t = advanceTimeline(t, sets);
  assert.equal(t.games.map((g) => g.w).join(''), 'abaa');
  assert.ok(t.games.every((g) => !g.g));
  // Two games land between looks: counted, not ordered.
  t = advanceTimeline(t, [[4, 2]]);
  assert.deepEqual(t.games.slice(-2), [{ s: 0, w: 'a', g: 1 }, { s: 0, w: 'b', g: 1 }]);
  // A new set, and a tiebreak game.
  t = advanceTimeline(advanceTimeline(t, [[6, 2]]), [[6, 2], [0, 1]]);
  assert.deepEqual(t.games.at(-1), { s: 1, w: 'b' });
  const tb = advanceTimeline({ sets: [[6, 6]], games: Array(12).fill({ s: 0, w: 'a', g: 1 }) }, [[7, 6]]);
  assert.deepEqual(tb.games.at(-1), { s: 0, w: 'a', tb: 1 });
  // First seen under way: every game counted, none ordered.
  const mid = advanceTimeline(null, [[6, 4], [2, 1]]);
  assert.equal(mid.games.length, 13);
  assert.ok(mid.games.every((g) => g.g));
  // The score went backwards: the record starts again from the new score.
  assert.equal(advanceTimeline(t, [[5, 2]]).games.length, 7);
  assert.deepEqual(advanceTimeline(t, t.sets).games, t.games, 'no change, no games');
});

test('serveRead works out who served from the games: the order with fewer breaks, each side\'s holds, and whose serve is next', () => {
  // A serves first and holds throughout; B is broken once (game 4).
  const games = [...'abaaabababab'].map((w) => ({ s: 0, w }));
  const r = serveRead(games);
  assert.equal(r.first, 'a');
  assert.equal(r.sure, true);
  assert.deepEqual([r.a, r.b], [{ served: 6, held: 6 }, { served: 6, held: 5 }]);
  assert.deepEqual(r.breaks, [{ set: 0, by: 'a', index: 3 }]);
  assert.equal(r.aServesNext, true, 'twelve games in, the first server serves again');
  // Too little to tell: both orders have the same breaks.
  assert.equal(serveRead([]).first, null);
  assert.equal(serveRead([{ s: 0, w: 'a', g: 1 }, { s: 0, w: 'b', g: 1 }]).first, null, 'unordered games say nothing about the serve');
  // Unordered games still count for whose turn it is.
  const mixed = [{ s: 0, w: 'a', g: 1 }, { s: 0, w: 'b', g: 1 }, { s: 0, w: 'a', g: 1 }, ...[...'babab'].map((w) => ({ s: 0, w }))];
  const m = serveRead(mixed);
  assert.equal(m.first, 'a', 'the ordered games (indexes 3 to 7) fit B serving the odd ones');
  assert.deepEqual([m.a.served + m.b.served, m.breaks.length], [5, 0]);
  assert.equal(m.aServesNext, true);
});

test('updatedServe moves a serve number by today\'s holds, within its limit, and momentumOf counts the last eight and the run', () => {
  const games = [...'abaaabababab'].map((w) => ({ s: 0, w }));
  const r = serveRead(games);
  const u = updatedServe(0.64, 0.64, r);
  assert.ok(u.pA > 0.64 && u.pA <= 0.69, String(u.pA));
  assert.ok(u.pA > u.pB, 'six of six beats five of six');
  assert.deepEqual(updatedServe(0.64, 0.6, serveRead([])), { pA: 0.64, pB: 0.6 }, 'no read, no move');
  // Broken three times in five: down, but no further than the limit.
  const rough = serveRead([...'bbbbabbbab'].map((w) => ({ s: 0, w })));
  assert.ok(updatedServe(0.64, 0.64, rough).pA >= 0.59 - 1e-9);
  const mo = momentumOf([...'ababbbbb'].map((w) => ({ s: 0, w })), null);
  assert.deepEqual(mo.last, { a: 2, b: 6, of: 8 });
  assert.deepEqual(mo.streak, { side: 'b', n: 5 });
  assert.deepEqual(scoreState([[6, 3], [1, 2]]), { setsA: 1, setsB: 0, gA: 1, gB: 2, setNumber: 2, inSet: true, tiebreak: false });
  assert.equal(scoreState([[6, 6]]).tiebreak, true);
  assert.deepEqual([scoreState([[6, 3], [4, 6]]).inSet, scoreState([[6, 3], [4, 6]]).setNumber], [false, 3]);
});

const NAMES = { a: 'Jannik Sinner', b: 'Taylor Fritz' };
const games12 = [...'abaaabababab'].map((w, i) => ({ s: i < 9 ? 0 : 1, w }));

test('liveRead blends the model with the live price and says why; livePlays posts the moneyline on an edge and a set inside its band', () => {
  const read = liveRead({ sets: [[6, 3], [1, 2]], games: games12, serve: { pA: 0.66, pB: 0.62 }, market: 0.74, names: NAMES });
  assert.ok(read.model.match > 0.85, String(read.model.match));
  near(read.prob, (read.model.match + 0.74) / 2, 1e-9);
  assert.match(read.why[0], /Score 6-3 1-2: from here the model gives Jannik Sinner \d+% to win the match and \d+% to win the set in play/);
  assert.match(read.why[1], /Jannik Sinner has held 6 of 6 service games; Taylor Fritz has held 5 of 6/);
  assert.match(read.why.at(-1), /The live price gives Jannik Sinner 74%/);
  const quotes = { a: [{ bookId: 'draftkings', book: 'DraftKings', american: -290 }, { bookId: 'fanduel', book: 'FanDuel', american: -270 }], b: [{ bookId: 'draftkings', book: 'DraftKings', american: 220 }] };
  const plays = livePlays(read, { quotes, names: NAMES, gamesSeen: 12 });
  const ml = plays.find((p) => p.market === 'live_ml');
  assert.deepEqual([ml.side, ml.american, ml.bookId, ml.selection], ['a', -270, 'fanduel', 'Jannik Sinner to win the match (live)']);
  assert.ok(ml.edge >= 0.05 && ml.prob >= 0.6);
  assert.equal(ml.units, liveUnits(ml.prob));
  // The same read at a price past the band, before enough games, or in a tiebreak: no moneyline.
  assert.equal(livePlays(read, { quotes: { a: [{ bookId: 'draftkings', american: -600 }], b: [] }, names: NAMES, gamesSeen: 12 }).some((p) => p.market === 'live_ml'), false);
  assert.deepEqual(livePlays(read, { quotes, names: NAMES, gamesSeen: 3 }), []);
  assert.deepEqual(livePlays(liveRead({ sets: [[6, 6]], games: [], serve: { pA: 0.66, pB: 0.62 }, market: 0.6, names: NAMES }), { quotes, names: NAMES, gamesSeen: 12 }), []);
  // The model 25 points over the price: stale or something the score does not show, so no moneyline, and the read says so.
  const far = liveRead({ sets: [[6, 3], [1, 2]], games: games12, serve: { pA: 0.66, pB: 0.62 }, market: 0.6, names: NAMES });
  assert.equal(far.apart, true);
  assert.match(far.why.at(-1), /more than 20 points apart, so there is no moneyline play/);
  assert.equal(livePlays(far, { quotes: { a: [{ bookId: 'draftkings', american: -150 }], b: [] }, names: NAMES, gamesSeen: 12 }).some((p) => p.market === 'live_ml'), false);
  // A break up in the set: the set play, with the price to take it at or better.
  const up = liveRead({ sets: [[3, 1]], games: [...'abaa'].map((w) => ({ s: 0, w })), serve: { pA: 0.6, pB: 0.66 }, market: 0.62, names: NAMES });
  const set = livePlays(up, { quotes: { a: [], b: [] }, names: NAMES, gamesSeen: 4 }).find((p) => p.market === 'live_set');
  assert.deepEqual([set.side, set.set, set.selection], ['a', 1, 'Jannik Sinner to win set 1']);
  assert.ok(set.prob >= 0.66 && set.prob <= 0.8 && set.playable < 0, JSON.stringify(set));
  // The same break with the better server in front reads 89%: past the band, no set play (the review of 2026-11-23: at 80% and up they won 9 of 12 and lost money).
  const far2 = liveRead({ sets: [[3, 1]], games: [...'abaa'].map((w) => ({ s: 0, w })), serve: { pA: 0.64, pB: 0.64 }, market: 0.62, names: NAMES });
  assert.ok(far2.model.set > 0.8);
  assert.equal(livePlays(far2, { quotes: { a: [], b: [] }, names: NAMES, gamesSeen: 4 }).some((p) => p.market === 'live_set'), false);
  assert.deepEqual([0.85, 0.72, 0.61, 0.5].map(liveUnits), [2, 1.5, 1, 0.5]);
});

test('gradeLivePlay settles a set when it ends and the moneyline on the winner, voids a retirement, and liveRecordOf adds it up', () => {
  const ml = { market: 'live_ml', side: 'a', american: -150, units: 1.5 };
  const set = { market: 'live_set', side: 'b', set: 2, playable: -200, units: 1 };
  assert.equal(gradeLivePlay(ml, { sets: [[6, 3], [2, 2]], completed: false }), null);
  assert.deepEqual(gradeLivePlay(ml, { sets: [[6, 3], [6, 4]], completed: true, winner: 'a' }), { status: 'graded', result: 'win', actual: '6-3 6-4', profit: 1 });
  assert.equal(gradeLivePlay(ml, { sets: [[6, 3], [3, 6], [4, 6]], completed: true, winner: 'b' }).profit, -1.5);
  assert.equal(gradeLivePlay(ml, { sets: [[6, 3], [1, 0]], completed: true, winner: 'a', note: 'Sinner bt Fritz 6-3 1-0 ret.' }).status, 'void');
  assert.deepEqual(gradeLivePlay(set, { sets: [[6, 3], [4, 6]], completed: false }), { status: 'graded', result: 'win', actual: '6-3 4-6', profit: 0.5 });
  assert.equal(gradeLivePlay(set, { sets: [[6, 3], [7, 5]], completed: true, winner: 'a' }).result, 'loss');
  assert.equal(gradeLivePlay(set, { sets: [[6, 3], [1, 0]], completed: true, winner: 'a' }).status, 'void');
  assert.equal(gradeLivePlay(set, null), null);
  const rec = liveRecordOf([{ status: 'graded', result: 'win', units: 1.5, profit: 1 }, { status: 'graded', result: 'loss', units: 1, profit: -1 }, { status: 'void' }, { status: 'pending' }]);
  assert.deepEqual(rec, { wins: 1, losses: 1, voids: 1, pending: 1, staked: 2.5, units: 0, roi: 0 });
});

const match = (sets, extra = {}) => ({ id: '77', tour: 'atp', eventName: 'ATP Finals', round: 'Round Robin', date: '2026-11-12T13:00Z', state: 'in', completed: false, bestOf: 3, a: { name: 'Jannik Sinner' }, b: { name: 'Taylor Fritz' }, sets, winner: null, note: null, detail: null, ...extra });
const feed = (aPrice, bPrice) => [{ id: 'e1', home_team: 'Jannik Sinner', away_team: 'Taylor Fritz', bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets: [{ key: 'h2h', outcomes: [{ name: 'Jannik Sinner', price: aPrice, link: 'https://sportsbook.draftkings.com/x' }, { name: 'Taylor Fritz', price: bPrice }] }] }] }];

test('runTennisLiveTick follows a match game by game, posts a play once, grades it, and rests when nothing is on', async () => {
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  const T0 = Date.parse('2026-11-12T18:00:00Z');
  // The Tennis tab read this match before it started: a strong server against a weaker one.
  m.set(tennisPicksKey('2026-11-12'), JSON.stringify({ plays: [], reads: { 'atp:77': { serve: { pA: 0.66, pB: 0.62 }, bestOf: 3 } } }));
  let sets = [[1, 0]]; let done = {}; let prices = [-320, 250]; let calls = 0;
  const deps = { scoreboard: async () => ({ at: 0, matches: [match(sets, done)] }), sportKeys: async () => ({ atp: [{ key: 'tennis_atp_finals' }], wta: [] }), liveBoard: async () => { calls++; return feed(...prices); }, cachedBoard: async () => [] };
  // Game by game: A serves first, both hold, then A breaks for 3-1 and holds for 4-1.
  let now = T0; let out = null;
  for (const s of [[[1, 0]], [[1, 1]], [[2, 1]], [[3, 1]]]) { sets = s; out = await runTennisLiveTick(env, {}, now, { deps }); now += 60e3; }
  assert.equal(out.inPlay, 1);
  const state = JSON.parse(m.get(TENNIS_LIVE_STATE_KEY));
  assert.equal(state.matches['atp:77'].games.map((g) => g.w).join(''), 'abaa');
  assert.equal(state.matches['atp:77'].serve.source, 'the pre-match read');
  assert.equal(state.nextAt <= now, true, 'a match in play: the next minute');
  const reads = JSON.parse(m.get(TENNIS_LIVE_READS_KEY));
  assert.equal(reads.matches[0].serve.first, 'a');
  assert.ok(reads.matches[0].model.match > 0.8 && reads.matches[0].prob > 0.72 && reads.matches[0].prob < reads.matches[0].model.match, JSON.stringify(reads.matches[0].model));
  const day = () => JSON.parse(m.get(tennisLivePlaysKey('2026-11-12'))).plays;
  // The price (-320, about 73%) sits under the read by more than the edge and less than the gap: the moneyline posts once.
  const ml = day().find((p) => p.market === 'live_ml');
  assert.deepEqual([ml.id, ml.side, ml.american, ml.bookId, ml.status, ml.score], ['atp:77:live_ml', 'a', -320, 'draftkings', 'pending', '3-1']);
  assert.ok(ml.why.length >= 3);
  // The play keeps the moneyline at every book when it posted; the read carries both players' live prices at every book.
  assert.deepEqual(ml.quotes, [{ bookId: 'draftkings', book: 'DraftKings', american: -320 }]);
  assert.deepEqual(reads.matches[0].books, { a: [{ bookId: 'draftkings', book: 'DraftKings', american: -320 }], b: [{ bookId: 'draftkings', book: 'DraftKings', american: 250 }] });
  sets = [[4, 1]]; await runTennisLiveTick(env, {}, now, { deps }); now += 60e3;
  assert.equal(day().filter((p) => p.market === 'live_ml').length, 1, 'posted once, however long the edge lasts');
  // The match ends: the play is graded at the price it was posted at.
  sets = [[6, 1], [6, 4]]; done = { state: 'post', completed: true, winner: 'a' };
  out = await runTennisLiveTick(env, {}, now, { deps });
  assert.equal(out.inPlay, 0);
  const graded = day().find((p) => p.market === 'live_ml');
  assert.deepEqual([graded.status, graded.result, graded.actual], ['graded', 'win', '6-1 6-4']);
  near(graded.profit, graded.units * (100 / 320), 0.01);
  for (const p of day().filter((x) => x.market === 'live_set')) assert.equal(p.status, 'graded');
  // Nothing in play and nothing waiting: the tick rests, and a tick inside the rest does nothing.
  const after = JSON.parse(m.get(TENNIS_LIVE_STATE_KEY));
  assert.equal(after.nextAt, now + IDLE_MS);
  assert.deepEqual(await runTennisLiveTick(env, {}, now + 60e3, { deps }), { skipped: true });
  assert.deepEqual(JSON.parse(m.get(TENNIS_LIVE_READS_KEY)).matches, [], 'the tab empties when the last match ends');
  const view = await getTennisLivePlays(env, now + 60e3);
  assert.equal(view.record.ml.wins, 1);
  assert.equal(view.today.length, day().length);
  assert.ok(calls >= 5, 'the live board is asked each tick here; its own cache spaces the real calls');
});

test('a match with no pre-match read takes its serve numbers from the live price at first sight; with neither it reads the score and posts nothing', async () => {
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  const T0 = Date.parse('2026-11-12T18:00:00Z');
  const base = { scoreboard: async () => ({ at: 0, matches: [match([[2, 1]])] }), sportKeys: async () => ({ atp: [{ key: 'k' }], wta: [] }), cachedBoard: async () => [] };
  await runTennisLiveTick(env, {}, T0, { deps: { ...base, liveBoard: async () => feed(-250, 200) } });
  const st = JSON.parse(m.get(TENNIS_LIVE_STATE_KEY)).matches['atp:77'];
  assert.equal(st.serve.source, 'the live price when the match was first seen');
  assert.ok(st.serve.pA > st.serve.pB);
  const read = JSON.parse(m.get(TENNIS_LIVE_READS_KEY)).matches[0];
  near(read.model.match, read.market, 0.03);
  // No price at all: a read from the score, no serve source, no plays.
  const m2 = new Map(); const env2 = { POTD_KV: { get: async (k) => m2.get(k) ?? null, put: async (k, v) => { m2.set(k, v); } } };
  const out = await runTennisLiveTick(env2, {}, T0, { deps: { ...base, scoreboard: async () => ({ at: 0, matches: [match([[5, 1]])] }), liveBoard: async () => [] } });
  assert.equal(out.posted, 0);
  assert.match(JSON.parse(m2.get(TENNIS_LIVE_READS_KEY)).matches[0].serve.source, /tour average/);
});

test('a set play takes the book\'s set price when it is good enough, is passed when the books price it worse, and posts at the price named when no book has the set', async () => {
  const T0 = Date.parse('2026-11-12T18:00:00Z');
  const setFeed = (aPrice, bPrice) => ({ id: 'e1', bookmakers: [{ key: 'fanduel', title: 'FanDuel', markets: [{ key: 'h2h_s1', outcomes: [{ name: 'Jannik Sinner', price: aPrice, link: 'https://sportsbook.fanduel.com/s1' }, { name: 'Taylor Fritz', price: bPrice }] }] }] });
  const run = async (setMarket) => {
    const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
    m.set(tennisPicksKey('2026-11-12'), JSON.stringify({ plays: [], reads: { 'atp:77': { serve: { pA: 0.6, pB: 0.66 }, bestOf: 3 } } }));
    let sets = [[1, 0]];
    const deps = { scoreboard: async () => ({ at: 0, matches: [match(sets)] }), sportKeys: async () => ({ atp: [{ key: 'k' }], wta: [] }), liveBoard: async () => feed(-135, 110), cachedBoard: async () => [], setMarket };
    let now = T0;
    // A serves first; a break for 3-1.
    for (const s of [[[1, 0]], [[1, 1]], [[2, 1]], [[3, 1]]]) { sets = s; await runTennisLiveTick(env, {}, now, { deps }); now += 60e3; }
    return (JSON.parse(m.get(tennisLivePlaysKey('2026-11-12')) ?? '{"plays":[]}').plays).find((p) => p.market === 'live_set') ?? null;
  };
  const good = await run(async () => setFeed(-300, 230));
  assert.deepEqual([good.set, good.side, good.american, good.bookId, good.link], [1, 'a', -300, 'fanduel', 'https://sportsbook.fanduel.com/s1']);
  assert.ok(good.american >= good.playable, 'the book is at the price the read needs, or better');
  assert.deepEqual(good.quotes, [{ bookId: 'fanduel', book: 'FanDuel', american: -300 }], 'the set at every book when it posted');
  assert.equal(await run(async () => setFeed(-900, 550)), null, 'priced, and too short: no play');
  const none = await run(async () => ({ id: 'e1', bookmakers: [] }));
  assert.deepEqual([none.american ?? null, none.bookId ?? null, none.playable < 0], [null, null, true], 'no book on the set: the price to take it at');
  assert.equal(none.quotes, undefined, 'and no book prices to show');
});

test('a set play on the player who won the last set, with no break in this one, is held to the follow-on cap', async () => {
  const { FOLLOW_ON_CAP, LIVE_SET_MARGIN } = await import('../worker/src/tennis-live-model.js');
  // The review of 2026-11-18: Shelton and Fritz each won a first set 6-2 and lost the second from 1-1, laid at -273 and -353.
  const readAt = (sets, set) => ({ state: scoreState(sets), model: { match: 0.9, set }, prob: 0.9, market: null, apart: false, why: [] });
  const play = (sets, set) => livePlays(readAt(sets, set), { quotes: { a: [], b: [] }, names: NAMES, gamesSeen: 10, sets }).find((p) => p.market === 'live_set');
  const american = (p) => Math.round(-100 * p / (1 - p));

  const held = play([[6, 2], [1, 1]], 0.82);
  assert.deepEqual([held.side, held.set, held.prob, held.units, held.held], ['a', 2, FOLLOW_ON_CAP, 1, 0.82]);
  near(held.playable, american(FOLLOW_ON_CAP - LIVE_SET_MARGIN), 1);
  assert.match(held.note, /Jannik Sinner won the last set but has no break in this one yet, and a new set starts level: the read of 82% is held to 69%, a one-unit play\./);
  // A game up is a hold, not a break: still held.
  assert.equal(play([[6, 2], [2, 1]], 0.8).prob, FOLLOW_ON_CAP);
  // The other side of the net reads the same way.
  const b = play([[2, 6], [1, 1]], 0.2);
  assert.deepEqual([b.side, b.prob, b.units, b.held], ['b', FOLLOW_ON_CAP, 1, 0.8]);

  // Two games up is a break in hand: the read stands.
  const broke = play([[6, 2], [3, 1]], 0.78);
  assert.deepEqual([broke.prob, broke.units, broke.held, broke.note], [0.78, 1.5, undefined, undefined]);
  // Past 80% with the break in hand there is no play; held to the cap with no break, the same read still posts at one unit.
  assert.equal(play([[6, 2], [3, 1]], 0.86), undefined);
  assert.deepEqual([play([[6, 2], [1, 1]], 0.86).prob, play([[6, 2], [1, 1]], 0.86).units], [FOLLOW_ON_CAP, 1]);
  assert.equal(play([[6, 2], [1, 1]], 0.93), undefined, 'and past 90% not even held');
  // The player lost the last set: the read is not a follow-on, and stands.
  assert.deepEqual([play([[3, 6], [1, 1]], 0.74).prob, play([[3, 6], [1, 1]], 0.74).units], [0.74, 1.5]);
  // Set one has no set before it.
  assert.equal(play([[1, 1]], 0.78).prob, 0.78);
  // A read already under the cap is left alone and says nothing about being held.
  const under = play([[6, 2], [1, 1]], 0.67);
  assert.deepEqual([under.prob, under.units, under.held, under.note], [0.67, 1, undefined, undefined]);
  // Without the set scores (an older caller) nothing is held.
  assert.equal(livePlays(readAt([[6, 2], [1, 1]], 0.78), { quotes: { a: [], b: [] }, names: NAMES, gamesSeen: 10 }).find((p) => p.market === 'live_set').prob, 0.78);
});

test('setGamesDist walks the set in play to its count: no set ends on 11, 5-5 is 12 or a tiebreak, and better servers run longer', async () => {
  const { setGamesDist, setGamesRead, LIVE_SET_TOTAL_LINES } = await import('../worker/src/tennis-live-model.js');
  const d = setGamesDist(0.64, 0.64, 0, 0, true);
  near(Object.values(d).reduce((s, p) => s + p, 0), 1, 1e-9);
  assert.deepEqual(Object.keys(d).map(Number).sort((x, y) => x - y), [6, 7, 8, 9, 10, 12, 13]);
  assert.deepEqual(Object.keys(setGamesDist(0.64, 0.64, 5, 5, true)).map(Number).sort((x, y) => x - y), [12, 13]);
  // From 5-5 the set reaches a tiebreak when both hold, or when each breaks the other.
  near(setGamesDist(0.64, 0.64, 5, 5, true)[13], holdProb(0.64) ** 2 + (1 - holdProb(0.64)) ** 2, 1e-9);
  const big = setGamesRead(0.7, 0.7); const weak = setGamesRead(0.56, 0.56);
  assert.ok(big.mean > weak.mean + 1 && big.over[9.5] > weak.over[9.5] && big.over[12.5] > weak.over[12.5], `${big.mean} vs ${weak.mean}`);
  assert.deepEqual(Object.keys(big.over).map(Number), LIVE_SET_TOTAL_LINES);
  // A double break: the set is nearly over, and short.
  assert.ok(setGamesRead(0.66, 0.62, 4, 1, true).over[9.5] < 0.25);
  // The server not known: the mean of the two cases.
  near(setGamesRead(0.66, 0.6, 2, 1).over[9.5], (setGamesRead(0.66, 0.6, 2, 1, true).over[9.5] + setGamesRead(0.66, 0.6, 2, 1, false).over[9.5]) / 2, 1e-9);
});

test('livePlays posts the games in the set from the score and the holds: one line, in its band, only once the serve order is certain', async () => {
  const { LIVE_SET_TOTAL_PROB, LIVE_SET_TOTAL_MARGIN, LIVE_SET_TOTAL_UNITS } = await import('../worker/src/tennis-live-model.js');
  const NAMES2 = { a: 'Ann Lee', b: 'Bea Roy' };
  const holds = (n) => Array.from({ length: n }, (_, i) => ({ s: 0, w: i % 2 === 0 ? 'a' : 'b' }));
  // 3-3, six holds, two strong servers: the set is likely to run long.
  const read = liveRead({ sets: [[3, 3]], games: holds(6), serve: { pA: 0.68, pB: 0.67 }, market: 0.5, names: NAMES2 });
  assert.equal(read.serve.sure, true);
  assert.equal(read.model.setGames.over[8.5], 1, 'from 3-3 the set cannot end under nine games');
  assert.ok(read.why.some((w) => /Set 1 at 3-3: about \d+\.\d games expected at today's hold rates/.test(w)));
  const play = livePlays(read, { names: NAMES2, gamesSeen: 6, sets: [[3, 3]] }).find((p) => p.market === 'live_set_total');
  assert.deepEqual([play.set, play.sideWord, play.point, play.side, play.units, play.selection], [1, 'over', 10.5, null, LIVE_SET_TOTAL_UNITS, 'Set 1 over 10.5 games']);
  assert.ok(play.prob >= LIVE_SET_TOTAL_PROB[0] && play.prob <= LIVE_SET_TOTAL_PROB[1], String(play.prob));
  // Over 9.5 is likelier (90%) and past the band: too short to be a price worth taking.
  assert.ok(read.model.setGames.over[9.5] > LIVE_SET_TOTAL_PROB[1]);
  // The price to take it at leaves the margin.
  const implied = (am) => (am < 0 ? -am / (-am + 100) : 100 / (am + 100));
  near(implied(play.playable), play.prob - LIVE_SET_TOTAL_MARGIN, 0.004);
  assert.match(play.note, /Ann Lee has held 3 of 3 service games today and Bea Roy has held 3 of 3; walked from 3-3 at those rates the set runs past 10\.5 games \d+% of the time/);
  // The same score with the order of the games not known (seen first at 3-3): no read of the holds, no play.
  const blind = liveRead({ sets: [[3, 3]], games: Array.from({ length: 6 }, (_, i) => ({ s: 0, w: i % 2 === 0 ? 'a' : 'b', g: 1 })), serve: { pA: 0.68, pB: 0.67 }, market: 0.5, names: NAMES2 });
  assert.equal(livePlays(blind, { names: NAMES2, gamesSeen: 6, sets: [[3, 3]] }).some((p) => p.market === 'live_set_total'), false);
  // An under: weaker servers, one up a break at 3-1 after breaking in the second game.
  const games = ['a', 'a', 'a', 'b'].map((w) => ({ s: 0, w }));
  const short = liveRead({ sets: [[3, 1]], games, serve: { pA: 0.6, pB: 0.55 }, market: 0.8, names: NAMES2 });
  assert.equal(short.serve.sure, true);
  const under = livePlays(short, { names: NAMES2, gamesSeen: 4, sets: [[3, 1]] }).find((p) => p.market === 'live_set_total');
  assert.deepEqual([under.sideWord, under.point], ['under', 9.5]);
  assert.ok(under.prob >= LIVE_SET_TOTAL_PROB[0] && under.prob <= LIVE_SET_TOTAL_PROB[1], String(under.prob));
  assert.match(under.note, /the set stays under 9\.5 games/);
  // A game later, up a double break at 4-1: the under is past the band (85%), and nothing posts.
  const done = liveRead({ sets: [[4, 1]], games: [...games.slice(0, 3), { s: 0, w: 'b' }, { s: 0, w: 'a' }], serve: { pA: 0.6, pB: 0.55 }, market: 0.8, names: NAMES2 });
  assert.equal(livePlays(done, { names: NAMES2, gamesSeen: 5, sets: [[4, 1]] }).some((p) => p.market === 'live_set_total'), false);
  // Never in a tiebreak, never before the games are in.
  assert.equal(livePlays(read, { names: NAMES2, gamesSeen: 3, sets: [[3, 3]] }).length, 0);
});

test('gradeLivePlay settles the games in a set: an over the moment the count passes the line, an under when the set ends short, a void when it never finishes', () => {
  const over = { market: 'live_set_total', side: null, set: 1, point: 9.5, sideWord: 'over', playable: -150, units: 1 };
  const under = { ...over, sideWord: 'under' };
  assert.equal(gradeLivePlay(over, { sets: [[4, 4]], completed: false }), null);
  assert.deepEqual(gradeLivePlay(over, { sets: [[5, 5]], completed: false }), { status: 'graded', result: 'win', actual: '5-5', profit: 0.67 });
  assert.equal(gradeLivePlay(under, { sets: [[5, 5]], completed: false }).result, 'loss');
  assert.equal(gradeLivePlay(under, { sets: [[6, 3], [1, 0]], completed: false }).result, 'win');
  assert.equal(gradeLivePlay(over, { sets: [[6, 3], [1, 0]], completed: false }).result, 'loss');
  assert.equal(gradeLivePlay(over, { sets: [[4, 3]], completed: true, winner: 'a', note: 'ret.' }).status, 'void');
  // The second set's games read the second set.
  assert.equal(gradeLivePlay({ ...over, set: 2, point: 10.5 }, { sets: [[6, 0], [7, 5]], completed: true, winner: 'a' }).result, 'win');
});

test('the games in a set take the book\'s line when it is there at a price good enough, pass when the book has moved on, and post at the price named when no book has the set\'s games', async () => {
  const T0 = Date.parse('2026-11-12T18:00:00Z');
  const totals = (point, over, under) => ({ id: 'e1', bookmakers: [{ key: 'fanduel', title: 'FanDuel', markets: [{ key: 'totals_s1', outcomes: [{ name: 'Over', point, price: over, link: 'https://sportsbook.fanduel.com/t1' }, { name: 'Under', point, price: under }] }] }] });
  const run = async (setTotals) => {
    const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
    m.set(tennisPicksKey('2026-11-12'), JSON.stringify({ plays: [], reads: { 'atp:77': { serve: { pA: 0.68, pB: 0.67 }, bestOf: 3 } } }));
    let sets = [[1, 0]];
    const deps = { scoreboard: async () => ({ at: 0, matches: [match(sets)] }), sportKeys: async () => ({ atp: [{ key: 'k' }], wta: [] }), liveBoard: async () => feed(-115, -105), cachedBoard: async () => [], setMarket: async () => ({ id: 'e1', bookmakers: [] }), setTotals };
    let now = T0;
    for (const s of [[[1, 0]], [[1, 1]], [[2, 1]], [[2, 2]], [[3, 2]], [[3, 3]]]) { sets = s; await runTennisLiveTick(env, {}, now, { deps }); now += 60e3; }
    const plays = JSON.parse(m.get(tennisLivePlaysKey('2026-11-12')) ?? '{"plays":[]}').plays;
    return { play: plays.find((p) => p.market === 'live_set_total') ?? null, n: plays.filter((p) => p.market === 'live_set_total').length, env, now };
  };
  const first = await run(async () => ({ id: 'e1', bookmakers: [] }));
  assert.equal(first.n, 1, 'one a set');
  const none = first.play;
  assert.deepEqual([none.id, none.american ?? null, none.units, none.status], ['atp:77:live_set_total:1', null, 1, 'pending']);
  assert.ok(none.playable < 0 && /games/.test(none.selection));
  assert.ok(none.why.some((w) => /walked from \d-\d at those rates/.test(w)), 'the reason rides with the play');
  // The book has the play's own line at a price better than the one the read needs: taken at the book.
  const good = await run(async () => totals(none.point, none.sideWord === 'over' ? none.playable + 30 : -400, none.sideWord === 'under' ? none.playable + 30 : -400));
  assert.deepEqual([good.play.point, good.play.american, good.play.bookId], [none.point, none.playable + 30, 'fanduel']);
  assert.deepEqual(good.play.quotes, [{ bookId: 'fanduel', book: 'FanDuel', american: none.playable + 30 }]);
  // The book prices the set's games at another line only: nothing to take, no play.
  assert.equal((await run(async () => totals(none.point === 12.5 ? 9.5 : 12.5, -110, -110))).play, null);
  // The right line, too short: no play.
  assert.equal((await run(async () => totals(none.point, -900, -900))).play, null);
  // A book that keeps pricing it too short is asked for ten minutes, then the set is left alone.
  {
    const { SET_TOTAL_ASK_MS } = await import('../worker/src/tennis-live-plays.js');
    const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
    m.set(tennisPicksKey('2026-11-12'), JSON.stringify({ plays: [], reads: { 'atp:77': { serve: { pA: 0.68, pB: 0.67 }, bestOf: 3 } } }));
    let sets = [[1, 0]]; let asks = 0;
    const deps = { scoreboard: async () => ({ at: 0, matches: [match(sets)] }), sportKeys: async () => ({ atp: [{ key: 'k' }], wta: [] }), liveBoard: async () => feed(-115, -105), cachedBoard: async () => [], setMarket: async () => ({ id: 'e1', bookmakers: [] }), setTotals: async () => { asks++; return totals(none.point, -900, -900); } };
    let now = T0;
    for (const s of [[[1, 0]], [[1, 1]], [[2, 1]], [[2, 2]], [[3, 2]], [[3, 3]]]) { sets = s; await runTennisLiveTick(env, {}, now, { deps }); now += 60e3; }
    const early = asks; assert.ok(early >= 1);
    for (let i = 0; i < 30; i++) { await runTennisLiveTick(env, {}, now, { deps }); now += 60e3; }
    assert.ok(asks > early && asks - early <= SET_TOTAL_ASK_MS / 60e3 + 1, `asked ${asks - early} more times over half an hour`);
  }
  // The record keeps the set's games apart.
  const view = await getTennisLivePlays(first.env, first.now);
  assert.deepEqual([view.record.setGames.pending, view.record.sets.pending >= 0], [1, true]);
  assert.ok(view.matches[0].model.setGames.mean > 9, 'the read carries the games expected');
});
