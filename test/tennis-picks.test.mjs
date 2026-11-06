import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedEventFor, quotesOf, marketWinShare, ratesFor, readMatch, clearsBar, gradePlay, gradeAces, surfaceOf, runTennisTick, getTennisPicks, MIN_PROB, MIN_EDGE } from '../worker/src/tennis-picks.js';
import { parseProfiles, tableJson } from '../scripts/tennis-data.mjs';
import { matchServeProbs, simulate, distributions, aceCounts, fitToTarget } from '../worker/src/tennis-model.js';

const line = (matches, serve, ret, ace, firstIn = 0.62) => ({ matches, serve, firstIn, firstWon: 0.74, secondWon: 0.52, return: ret, acesPerGame: ace * 6.4, ace, points: matches * 80 });
const profile = (name, matches, serve, ret, ace, surfaces = {}) => ({ name, key: name.toLowerCase(), matches, overall: line(matches, serve, ret, ace), bySurface: surfaces });
const match = (over = {}) => ({ id: '187200', tour: 'atp', eventId: '13-2026', eventName: 'Nitto ATP Finals', tier: '1000', round: 'Round Robin', qualifying: false, date: '2026-11-09T13:00Z', state: 'pre', completed: false, statusName: 'STATUS_SCHEDULED', bestOf: 3, a: { id: '1', name: 'Jannik Sinner', key: 'jannik sinner' }, b: { id: '2', name: 'Ben Shelton', key: 'ben shelton' }, sets: [], tiebreaks: [], winner: null, ...over });
const book = (key, markets, extra = {}) => ({ key, title: key, ...extra, markets: Object.entries(markets).map(([k, outcomes]) => ({ key: k, outcomes })) });
const boardEvent = () => ({ id: 'ev1', sport_key: 'tennis_atp_finals', home_team: 'Jannik Sinner', away_team: 'Ben Shelton', commence_time: '2026-11-09T13:00:00Z', bookmakers: [
  book('fanduel', { h2h: [{ name: 'Jannik Sinner', price: -400 }, { name: 'Ben Shelton', price: 300 }], spreads: [{ name: 'Jannik Sinner', point: -4.5, price: -115 }, { name: 'Ben Shelton', point: 4.5, price: -105, link: 'https://fd/x' }], totals: [{ name: 'Over', point: 21.5, price: -110 }, { name: 'Under', point: 21.5, price: -110 }] }),
  book('draftkings', { h2h: [{ name: 'Jannik Sinner', price: -380 }, { name: 'Ben Shelton', price: 290 }], spreads: [{ name: 'Jannik Sinner', point: -4.5, price: -110 }, { name: 'Ben Shelton', point: 4.5, price: -110 }] }),
] });
const deepEvent = () => ({ id: 'ev1', bookmakers: [
  book('fanduel', { alternate_spreads: [{ name: 'Ben Shelton', point: 6.5, price: -200 }, { name: 'Ben Shelton', point: 2.5, price: 150 }], alternate_set_spreads: [{ name: 'Ben Shelton', point: 1.5, price: 140 }, { name: 'Jannik Sinner', point: -1.5, price: -170 }], totals_s1: [{ name: 'Over', point: 9.5, price: -115 }, { name: 'Under', point: 9.5, price: -105 }], alternate_totals_s2: [{ name: 'Over', point: 8.5, price: -170 }, { name: 'Over', point: 9.5, price: -110 }] }),
] });

test('feedEventFor pairs a card match with a board event either way round; quotesOf keeps the site\'s books; marketWinShare de-vigs the median h2h', () => {
  const ev = boardEvent();
  assert.equal(feedEventFor(match(), [ev])?.aIsHome, true);
  assert.equal(feedEventFor(match({ a: { name: 'Ben Shelton' }, b: { name: 'J. Sinner' } }), [ev])?.aIsHome, false, 'flipped, and an initial fits the surname');
  assert.equal(feedEventFor(match({ a: { name: 'Carlos Alcaraz' } }), [ev]), null);
  const q = quotesOf(ev, 'spreads');
  assert.equal(q.length, 4); assert.equal(q[1].link, 'https://fd/x'); assert.equal(q[0].bookId, 'fanduel');
  const share = marketWinShare(ev, 'Jannik Sinner');
  assert.ok(share > 0.76 && share < 0.81, `share ${share}`);
});

test('ratesFor reads the surface line when it is deep enough, the overall line otherwise, and refuses a thin player', () => {
  const p = profile('Jannik Sinner', 60, 0.70, 0.42, 0.09, { hard: line(40, 0.72, 0.43, 0.10), clay: line(4, 0.66, 0.40, 0.06) });
  assert.equal(ratesFor(p, 'hard').serve, 0.72); assert.equal(ratesFor(p, 'hard').surfaceUsed, true);
  assert.equal(ratesFor(p, 'clay').serve, 0.70, 'four clay matches are too few: the overall line');
  assert.equal(ratesFor(profile('Thin', 6, 0.6, 0.4, 0.05), 'hard'), null);
  assert.equal(surfaceOf('Nitto ATP Finals'), 'hard'); assert.equal(surfaceOf('Roland Garros'), 'clay'); assert.equal(surfaceOf('Wimbledon'), 'grass');
});

test('readMatch prices the legs the model has a case on from the board and the deeper markets, and clearsBar keeps only the convincing ones', () => {
  const ratesA = { serve: 0.72, firstIn: 0.62, return: 0.43, ace: 0.11, acesPerGame: 0.7, points: 4800, matches: 60, aceMatches: 60 };
  const ratesB = { serve: 0.66, firstIn: 0.6, return: 0.36, ace: 0.12, acesPerGame: 0.78, points: 3600, matches: 45, aceMatches: 45 };
  const { pA, pB } = matchServeProbs(ratesA, ratesB, 'atp');
  const fit = fitToTarget(pA, pB, 0.78, { n: 800, seed: 7 });
  const sims = simulate(fit.pA, fit.pB, { n: 1500, seed: 11 });
  const dist = distributions(sims);
  const aceA = aceCounts(dist.svptA, ratesA.ace, { seed: 13, samplePoints: 4800 });
  const aceB = aceCounts(dist.svptB, ratesB.ace, { seed: 17, samplePoints: 3600 });
  const legs = readMatch(match(), { dist, aceA, aceB, board: boardEvent(), deep: deepEvent(), ratesA, ratesB, pMarket: 0.78 });
  assert.ok(legs.length >= 2, `legs ${legs.length}`);
  for (const l of legs) { assert.ok(l.prob >= MIN_PROB || l.market === 'aces'); assert.ok(l.selection && l.why.length >= 2); }
  const spread = legs.find((l) => l.market === 'games_spread' && l.point === 6.5);
  assert.ok(spread, 'the dog +6.5 games is on the ladder'); assert.equal(spread.bookId, 'fanduel'); assert.equal(spread.american, -200);
  const aces = legs.filter((l) => l.market === 'aces');
  assert.ok(aces.length >= 1 && aces.every((l) => l.american == null && l.point >= 4.5 && l.prob >= 0.8), 'aces legs carry no price and clear 80%');
  const cleared = legs.filter(clearsBar);
  for (const l of cleared) if (l.market !== 'aces') { assert.ok(l.edge >= MIN_EDGE); assert.ok(l.american >= -250 && l.american <= 250); }
  assert.ok(!clearsBar({ market: 'games_spread', prob: 0.9, edge: 0.3, american: -300 }), 'a price outside the band never posts');
  assert.ok(!clearsBar({ market: 'games_total', prob: 0.76, edge: 0.05, american: -110 }), 'five points of edge is a close call');
});

test('gradePlay settles each market from the set scores, voids what a retirement leaves unsettled, and leaves a live match alone', () => {
  const play = (market, over = {}) => ({ market, side: 'b', a: 'Jannik Sinner', b: 'Ben Shelton', point: 4.5, american: -110, units: 1, ...over });
  const done = { completed: true, statusName: 'STATUS_FINAL', sets: [[6, 4], [7, 6]] };
  assert.equal(gradePlay(play('games_spread'), done).result, 'win', '13-10: Shelton within 4.5');
  assert.equal(gradePlay(play('games_spread', { point: 2.5 }), done).result, 'loss');
  assert.equal(gradePlay(play('games_spread', { point: 3 }), done).result, 'push');
  assert.equal(gradePlay(play('games_total', { point: 21.5 }), done).result, 'win', '23 games');
  assert.equal(gradePlay(play('set_spread', { point: 1.5 }), done).result, 'loss', 'straight sets');
  assert.equal(gradePlay(play('set_spread', { point: 1.5 }), { ...done, sets: [[4, 6], [6, 3], [6, 2]] }).result, 'win');
  assert.equal(gradePlay(play('set1_total', { point: 9.5 }), done).result, 'win', '10 games in the first');
  assert.equal(gradePlay(play('set2_total', { point: 12.5 }), done).result, 'win', '13 in a tiebreak set');
  const retired = { completed: true, statusName: 'STATUS_RETIRED', sets: [[6, 4], [3, 1]] };
  assert.equal(gradePlay(play('games_total', { point: 21.5 }), retired).result, 'void');
  assert.equal(gradePlay(play('set1_total', { point: 9.5 }), retired).result, 'win', 'the first set was complete');
  assert.equal(gradePlay(play('set2_total', { point: 8.5 }), retired).result, 'void');
  assert.equal(gradePlay(play('set_spread', { point: 1.5 }), { ...retired, sets: [[4, 6], [3, 1]] }).result, 'win', 'the dog had a set before the retirement');
  assert.equal(gradePlay(play('games_total', { point: 21.5 }), { completed: false, sets: [[6, 4]] }), null);
  const won = gradePlay(play('games_total', { point: 21.5, american: 120 }), done);
  assert.equal(won.net, 1.2);
});

test('gradeAces reads the ace log by date and names, either side, and voids after 45 days without stats', () => {
  const p = { market: 'aces', side: 'a', a: 'Ben Shelton', b: 'Jannik Sinner', point: 9.5, american: null, units: 1, commenceMs: Date.parse('2026-11-09T13:00Z') };
  const log = { '2026-11-09|jannik sinner|ben shelton': { wAces: 6, lAces: 12 } };
  const g = gradeAces(p, log, Date.parse('2026-11-10T00:00Z'));
  assert.equal(g.result, 'win'); assert.equal(g.net, null, 'no price: the units are not counted'); assert.match(g.actual, /12 aces/);
  assert.equal(gradeAces(p, {}, Date.parse('2026-11-10T00:00Z')), null);
  assert.equal(gradeAces(p, {}, Date.parse('2027-01-10T00:00Z')).result, 'void');
});

test('runTennisTick posts the best leg per match under the caps, grades from the card, and getTennisPicks sums the record', async () => {
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  const card = { at: 1, slate: [match({ date: new Date(Date.now() + 6 * 3600e3).toISOString() })], results: [] };
  const profiles = { players: { 'jannik sinner': profile('Jannik Sinner', 60, 0.72, 0.43, 0.11), 'ben shelton': profile('Ben Shelton', 45, 0.66, 0.36, 0.12) } };
  const deps = { card: async () => card, profiles: async () => profiles, sportKeys: async () => ({ atp: [{ key: 'tennis_atp_finals', title: 'ATP Finals' }], wta: [] }), board: async () => [boardEvent()], eventMarkets: async () => deepEvent(), aceLog: async () => ({}) };
  const r = await runTennisTick(env, null, Date.now(), { deps });
  assert.equal(r.skipped, false); assert.equal(r.considered, 1);
  assert.ok(r.posted >= 1 && r.posted <= 2, `posted ${r.posted}`);
  const again = await runTennisTick(env, null, Date.now(), { deps });
  assert.equal(again.posted, 0, 'posted once; the price stands as drawn');
  const picks = await getTennisPicks(env);
  assert.equal(picks.current.plays.length, r.posted);
  assert.ok(Object.keys(picks.current.reads).length === 1);
  // The match finishes 6-4 7-6: the priced leg grades.
  card.slate[0] = match({ date: card.slate[0].date, state: 'post', completed: true, statusName: 'STATUS_FINAL', sets: [[6, 4], [7, 6]], winner: 'a' });
  const graded = await runTennisTick(env, null, Date.now(), { deps });
  assert.ok(graded.graded >= 1, `graded ${graded.graded}`);
  const after = await getTennisPicks(env);
  const priced = after.current.plays.find((p) => p.market !== 'aces');
  assert.ok(['win', 'loss', 'push'].includes(priced.result), `result ${priced.result}`);
  assert.equal(after.record.wins + after.record.losses + after.record.pushes, after.current.plays.filter((p) => p.status === 'graded').length);
});

test('the data runner parses the stats table: a row per player and surface, with the serve share, the ace rate and the match count', () => {
  const page = `<html><div class="reactable" id="player-stats-table"></div><script type="application/json" data-for="player-stats-table">${JSON.stringify({ x: { tag: { attribs: { data: { Player: ['Jannik Sinner', 'Jannik Sinner', 'Ben Shelton'], Matches: [60, 42, 50], FirstServePercentage: [0.62, 0.63, 0.6], FirstServeWonPercentage: [0.78, 0.79, 0.76], SecondServeWonPercentage: [0.58, 0.59, 0.52], ReturnPointsWonPercentage: [0.43, 0.44, 0.36], Aces: [420, 300, 600], AcePercentage: [9.1, 9.6, 12.4], AcesPerServiceGame: [0.6, 0.63, 0.8] }, columns: [{ id: 'Player', name: 'Player', cell: ['<a>Jannik Sinner</a>', '<img src="images/tennis/Tennis_ball_hard_100.png"/><a>Jannik Sinner</a>', '<a>Ben Shelton</a>'] }, { id: 'Matches', name: 'Matches' }, { id: 'FirstServePercentage', name: '1st Serve %' }, { id: 'FirstServeWonPercentage', name: '1st Serve Won %' }, { id: 'SecondServeWonPercentage', name: '2nd Serve Won %' }, { id: 'ReturnPointsWonPercentage', name: 'Return Points Won %' }, { id: 'Aces', name: 'Aces' }, { id: 'AcePercentage', name: 'Ace %' }, { id: 'AcesPerServiceGame', name: 'Aces / Service Gm' }] } } } })}</script></html>`;
  const t = tableJson(page);
  const players = parseProfiles(t);
  const s = players['jannik sinner'];
  assert.equal(s.matches, 60); assert.equal(s.overall.serve, Math.round((0.62 * 0.78 + 0.38 * 0.58) * 10000) / 10000); assert.equal(s.overall.ace, 0.091); assert.equal(s.overall.return, 0.43);
  assert.equal(s.bySurface.hard.matches, 42); assert.equal(s.bySurface.hard.ace, 0.096);
  assert.equal(players['ben shelton'].overall.ace, 0.124);
  assert.ok(ratesFor(s, 'hard').surfaceUsed);
});
