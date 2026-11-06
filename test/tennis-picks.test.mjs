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

import { formOf, styleOf, matchupProb, eloShare } from '../worker/src/tennis-form.js';
import { buildParlay, gradeParlay, unitsPosted, MAX_UNITS_DAY, PARLAY_LEG_PROB } from '../worker/src/tennis-picks.js';
import { getTennisLive, playStanding, legStanding } from '../worker/src/tennis-live.js';

const result = (id, a, b, sets, daysAgo, over = {}) => ({ id, tour: 'atp', completed: true, statusName: 'STATUS_FINAL', date: new Date(Date.now() - daysAgo * 864e5).toISOString(), a: { id: a.toLowerCase(), key: a.toLowerCase(), name: a }, b: { id: b.toLowerCase(), key: b.toLowerCase(), name: b }, sets, winner: sets.filter(([x, y]) => x > y).length > sets.filter(([x, y]) => y > x).length ? 'a' : 'b', ...over });

test('formOf reads the last six weeks: the record, the games margin, a heavy week, a marathon, a retirement and rust', () => {
  const now = Date.now();
  const hot = [result('1', 'Hot', 'X', [[6, 2], [6, 3]], 1), result('2', 'Hot', 'Y', [[6, 4], [6, 4]], 2), result('3', 'Z', 'Hot', [[3, 6], [4, 6]], 3), result('4', 'Hot', 'W', [[6, 1], [6, 2]], 5), result('5', 'Hot', 'V', [[7, 6], [6, 3]], 6)];
  const f = formOf({ id: 'hot', key: 'hot' }, hot, now);
  assert.equal(f.wins, 5); assert.equal(f.losses, 0); assert.ok(f.gamesDiff > 4, `diff ${f.gamesDiff}`); assert.equal(f.straightSetWins, 5);
  assert.equal(f.loadWeek, 5, 'five matches in seven days'); assert.equal(f.fatigue, true, 'a heavy week'); assert.equal(f.injury, false); assert.equal(f.rust, false);
  assert.ok(f.score > 0.6, `score ${f.score}`);
  const cold = [result('6', 'Cold', 'X', [[2, 6], [3, 6]], 10), result('7', 'Y', 'Cold', [[6, 1], [6, 2]], 14), result('8', 'Cold', 'Z', [[6, 4], [2, 1]], 12, { statusName: 'STATUS_RETIRED', winner: 'b', note: 'Cold retired' })];
  const g = formOf({ id: 'cold', key: 'cold' }, cold, now);
  assert.equal(g.wins, 0); assert.equal(g.injury, true, 'retired inside three weeks'); assert.equal(g.fatigue, false); assert.ok(g.score < -0.5, `score ${g.score}`);
  const marathon = [result('9', 'Long', 'X', [[7, 6], [6, 7], [7, 6]], 0.5)];
  assert.equal(formOf({ id: 'long', key: 'long' }, marathon, now).marathonYesterday, true);
  const rusty = [result('10', 'Old', 'X', [[6, 4], [6, 4]], 35)];
  const r = formOf({ id: 'old', key: 'old' }, rusty, now); assert.equal(r.rust, true); assert.ok(r.daysSince >= 34 && r.daysSince <= 35);
  assert.equal(formOf({ id: 'nobody', key: 'nobody' }, hot, now).matches, 0);
});

test('styleOf names the game from the serve and return numbers; matchupProb blends Elo and the simulation and moves for form, fatigue, injury and the surface', () => {
  assert.equal(styleOf({ serve: 0.70, ace: 0.13, return: 0.36 }, 'atp').style, 'server');
  assert.equal(styleOf({ serve: 0.63, ace: 0.05, return: 0.42 }, 'atp').style, 'returner');
  assert.equal(styleOf({ serve: 0.70, ace: 0.10, return: 0.42 }, 'atp').style, 'complete');
  assert.equal(styleOf({ serve: 0.64, ace: 0.07, return: 0.37 }, 'atp').style, 'grinder');
  assert.ok(Math.abs(eloShare(2000, 1800) - 0.76) < 0.01);
  const even = { pSim: 0.5, eloA: 1900, eloB: 1900, surface: 'hard' };
  assert.equal(matchupProb(even).p, 0.5);
  const now = Date.now();
  const formA = formOf({ id: 'a', key: 'a' }, [result('1', 'A', 'X', [[6, 2], [6, 2]], 2), result('2', 'A', 'Y', [[6, 3], [6, 4]], 4), result('3', 'A', 'Z', [[6, 1], [6, 2]], 8)], now);
  const formB = formOf({ id: 'b', key: 'b' }, [result('4', 'X', 'B', [[6, 2], [6, 2]], 2), result('5', 'Y', 'B', [[6, 3], [6, 4]], 4), result('6', 'Z', 'B', [[6, 1], [6, 2]], 8)], now);
  const form = matchupProb({ ...even, formA, formB });
  assert.ok(form.p > 0.6, `form moves the share: ${form.p}`); assert.ok(form.reasons.some((r) => /form favours A/.test(r)));
  const tiredA = { ...formA, fatigue: true, loadWeek: 4 };
  assert.ok(matchupProb({ ...even, formA: tiredA, formB: formA }).p < 0.5, 'fatigue costs');
  const hurtB = { ...formA, injury: true };
  assert.ok(matchupProb({ ...even, formA, formB: hurtB }).p > 0.58, 'an injury doubt on B helps A');
  const server = styleOf({ serve: 0.70, ace: 0.13, return: 0.36 }, 'atp'); const returner = styleOf({ serve: 0.63, ace: 0.05, return: 0.42 }, 'atp');
  assert.ok(matchupProb({ ...even, styleA: server, styleB: returner, surface: 'grass' }).p > 0.5, 'the server on grass');
  assert.ok(matchupProb({ ...even, styleA: server, styleB: returner, surface: 'clay' }).p < 0.5, 'the returner on clay');
  assert.ok(matchupProb({ pSim: 0.9, eloA: 2200, eloB: 1500, surface: 'hard', formA: tiredA, formB: formB }).p <= 0.97, 'clamped');
});

test('buildParlay takes the clearest unflagged favourites, two to four legs, at the book that prices every leg, and fills the second leg from the relaxed bar', () => {
  const now = Date.now();
  const q = (bookId, american) => ({ bookId, book: bookId, american, link: `https://${bookId}/x` });
  const cand = (matchId, prob, flags = [], quotes = [q('fanduel', -300), q('draftkings', -280)], over = {}) => ({ matchId, tour: 'atp', event: 'Paris', round: 'R16', commenceMs: now + 3 * 3600e3, a: `${matchId} fav`, b: `${matchId} dog`, side: 'a', name: `${matchId} fav`, prob, pModel: prob, pMarket: prob, flags, opponentFlags: [], quotes, why: [] });
  const p = buildParlay([cand('m1', 0.9), cand('m2', 0.85), cand('m3', 0.8), cand('m4', 0.79), cand('m5', 0.78)], now);
  assert.ok(p, 'a parlay'); assert.equal(p.market, 'ml_parlay');
  assert.ok(p.legs.length >= 2 && p.legs.length <= 4, `legs ${p.legs.length}`);
  assert.ok(p.prob >= 0.58, `prob ${p.prob}`); assert.equal(p.bookId, 'draftkings', 'the better combined price'); assert.ok(p.american > 0 || p.american <= -100);
  assert.ok(p.legs.every((l) => l.selection.endsWith('to win') && l.american === -280));
  assert.equal(buildParlay([cand('m1', 0.9, ['fatigue']), cand('m2', 0.85, ['injury']), cand('m3', 0.8)], now), null, 'flagged favourites never go in; one leg is no parlay');
  const relaxed = buildParlay([cand('m1', 0.9), cand('m2', 0.74)], now);
  assert.ok(relaxed && relaxed.legs.length === 2, 'the second leg from the relaxed bar');
  assert.equal(buildParlay([cand('m1', 0.9), cand('m2', 0.7)], now), null, 'below the relaxed bar: no second leg');
  const split = buildParlay([cand('m1', 0.9, [], [q('fanduel', -300)]), cand('m2', 0.85, [], [q('draftkings', -200)]), cand('m3', 0.8, [], [q('fanduel', -150)])], now);
  assert.equal(split.bookId, 'fanduel'); assert.equal(split.legs.length, 2, 'the legs the book carries');
  assert.equal(buildParlay([cand('m1', 0.9, [], [], { }), cand('m2', 0.85, [], [])], now), null, 'no quotes, no parlay');
  const started = buildParlay([{ ...cand('m1', 0.9), commenceMs: now - 1000 }, cand('m2', 0.85)], now);
  assert.equal(started, null, 'a match under way is not a leg');
});

test('gradeParlay loses on the first lost leg, waits on an open one, voids a walkover leg and pays the rest', () => {
  const play = { market: 'ml_parlay', units: 1, legs: [{ matchId: 'atp:1', side: 'a', selection: 'A to win', american: -300 }, { matchId: 'atp:2', side: 'b', selection: 'B to win', american: -150 }] };
  const done = (id, winner, over = {}) => [id, { completed: true, statusName: 'STATUS_FINAL', winner, sets: [[6, 4], [6, 4]], ...over }];
  assert.equal(gradeParlay(play, new Map([done('atp:1', 'a')])), null, 'one leg open');
  const won = gradeParlay(play, new Map([done('atp:1', 'a'), done('atp:2', 'b')]));
  assert.equal(won.result, 'win'); assert.equal(won.net, Math.round(((4 / 3) * (5 / 3) - 1) * 100) / 100);
  assert.equal(gradeParlay(play, new Map([done('atp:1', 'b')])).result, 'loss', 'lost at once');
  const voided = gradeParlay(play, new Map([done('atp:1', 'a'), done('atp:2', 'b', { statusName: 'STATUS_WALKOVER', sets: [] })]));
  assert.equal(voided.result, 'win'); assert.equal(voided.net, 0.33, 'the walkover leg drops, the other pays');
  const retiredLate = gradeParlay(play, new Map([done('atp:1', 'a'), done('atp:2', 'b', { statusName: 'STATUS_RETIRED', sets: [[6, 4], [2, 1]] })]));
  assert.equal(retiredLate.net, won.net, 'a retirement after a completed set stands');
  assert.equal(gradeParlay(play, new Map([done('atp:1', 'a', { statusName: 'STATUS_WALKOVER', sets: [] }), done('atp:2', 'b', { statusName: 'STATUS_WALKOVER', sets: [] })])).result, 'void');
});

test('runTennisTick never puts a flagged player on a play, posts the day\'s parlay once, and stops at the units cap with one unit kept for the parlay', async () => {
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  const now = Date.now();
  const names = ['Alpha One', 'Beta Two', 'Gamma Three', 'Delta Four', 'Epsilon Five', 'Zeta Six', 'Eta Seven', 'Theta Eight'];
  const slate = names.map((fav, i) => match({ id: `${100 + i}`, date: new Date(now + (3 + i) * 3600e3).toISOString(), a: { id: `f${i}`, name: fav, key: fav.toLowerCase() }, b: { id: `d${i}`, name: `Dog ${i}`, key: `dog ${i}` } }));
  const players = {};
  for (let i = 0; i < names.length; i++) { players[names[i].toLowerCase()] = { ...profile(names[i], 60, 0.72, 0.43, 0.11), overall: { ...line(60, 0.72, 0.43, 0.11), elo: 2100 } }; players[`dog ${i}`] = { ...profile(`Dog ${i}`, 45, 0.64, 0.37, 0.07), overall: { ...line(45, 0.64, 0.37, 0.07), elo: 1750 } }; }
  // Favourite 0 retired last week: flagged, never a side.
  const results = [{ id: '900', tour: 'atp', completed: true, statusName: 'STATUS_RETIRED', note: 'Alpha One retired', date: new Date(now - 5 * 864e5).toISOString(), a: { id: 'x', key: 'x', name: 'X' }, b: { id: 'f0', key: 'alpha one', name: 'Alpha One' }, sets: [[6, 2], [2, 0]], winner: 'a' }];
  const boardFor = (s) => ({ id: `ev${s.id}`, sport_key: 'tennis_atp_paris', home_team: s.a.name, away_team: s.b.name, commence_time: s.date, bookmakers: [
    book('fanduel', { h2h: [{ name: s.a.name, price: -400 }, { name: s.b.name, price: 300 }], spreads: [{ name: s.a.name, point: -4.5, price: -115 }, { name: s.b.name, point: 4.5, price: -105 }], totals: [{ name: 'Over', point: 21.5, price: -110 }, { name: 'Under', point: 21.5, price: -110 }] }),
    book('draftkings', { h2h: [{ name: s.a.name, price: -380 }, { name: s.b.name, price: 290 }], spreads: [{ name: s.a.name, point: -4.5, price: -110 }, { name: s.b.name, point: 4.5, price: -110 }] }),
  ] });
  const deps = { card: async () => ({ at: 1, slate, results }), profiles: async () => ({ players }), sportKeys: async () => ({ atp: [{ key: 'tennis_atp_paris', title: 'Paris' }], wta: [] }), board: async () => slate.map(boardFor), eventMarkets: async () => deepEvent(), aceLog: async () => ({}) };
  const r = await runTennisTick(env, null, now, { deps });
  assert.equal(r.skipped, false); assert.equal(r.candidates, 8);
  const picks = await getTennisPicks(env, now);
  const plays = picks.current.plays;
  const parlay = plays.find((p) => p.market === 'ml_parlay');
  assert.ok(parlay, 'the day\'s parlay posted'); assert.ok(parlay.legs.length >= 2 && parlay.legs.length <= 4); assert.ok(parlay.prob >= 0.58);
  assert.ok(parlay.legs.every((l) => l.a !== 'Alpha One'), 'the flagged favourite is not a leg');
  assert.ok(parlay.legs.every((l) => l.prob >= PARLAY_LEG_PROB - 0.07), `legs ${parlay.legs.map((l) => l.prob)}`);
  assert.ok(plays.every((p) => !p.side || !(p.flags?.[p.side] ?? []).length), 'no play sits on a flagged side');
  assert.ok(unitsPosted(plays) <= MAX_UNITS_DAY, `units ${unitsPosted(plays)}`);
  assert.equal(picks.unitsToday, unitsPosted(plays)); assert.equal(picks.bar.maxUnits, MAX_UNITS_DAY);
  const read0 = picks.current.reads['atp:100'];
  assert.ok(read0.flags.a.includes('injury'), `flags ${JSON.stringify(read0.flags)}`); assert.ok(/Alpha One/.test(read0.form.a)); assert.ok(read0.pModel != null && read0.pFinal != null);
  const again = await runTennisTick(env, null, now, { deps });
  assert.equal(again.posted, 0, 'posted once: the parlay and the plays stand'); assert.equal(again.parlay, 0);
  // Every leg's favourite wins: the parlay grades a win.
  const doneSlate = slate.map((s) => match({ ...s, state: 'post', completed: true, statusName: 'STATUS_FINAL', sets: [[6, 3], [6, 4]], winner: 'a' }));
  deps.card = async () => ({ at: 1, slate: doneSlate, results });
  const g = await runTennisTick(env, null, now, { deps });
  assert.ok(g.graded >= 1);
  const after = await getTennisPicks(env, now);
  const gradedParlay = after.current.plays.find((p) => p.market === 'ml_parlay');
  assert.equal(gradedParlay.result, 'win'); assert.ok(gradedParlay.net > 0);
  assert.ok(after.byMarket.ml_parlay.wins === 1);
});

test('the live tennis read lists the day\'s singles from ESPN with each play\'s standing, cached two minutes', async () => {
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  const now = Date.parse('2026-11-06T18:00:00Z');
  const comp = (id, a, b, state, linescores = [[], []], over = {}) => ({ id, date: '2026-11-06T17:00Z', round: { displayName: 'Quarterfinal' }, status: { type: { state, completed: state === 'post', name: state === 'post' ? 'STATUS_FINAL' : state === 'in' ? 'STATUS_IN_PROGRESS' : 'STATUS_SCHEDULED', detail: state === 'in' ? '2nd Set' : '' } }, competitors: [{ id: `${id}a`, athlete: { displayName: a }, linescores: linescores[0].map((v) => ({ value: v })), winner: over.winner === 'a' }, { id: `${id}b`, athlete: { displayName: b }, linescores: linescores[1].map((v) => ({ value: v })), winner: over.winner === 'b' }] });
  const scoreboard = { atp: { events: [{ id: '13', name: 'Rolex Paris Masters', groupings: [{ grouping: { slug: 'mens-singles' }, competitions: [comp('1', 'Jannik Sinner', 'Ben Shelton', 'in', [[6, 3], [4, 5]]), comp('2', 'Carlos Alcaraz', 'Taylor Fritz', 'pre'), comp('3', 'Alex Zverev', 'Casper Ruud', 'post', [[6, 4], [6, 2]], { winner: 'a' }), { ...comp('9', 'Old Match', 'From Monday', 'post', [[6, 4], [6, 2]], { winner: 'a' }), date: '2026-11-02T12:00Z' }] }, { grouping: { slug: 'mens-doubles' }, competitions: [comp('4', 'A / B', 'C / D', 'in')] }] }] }, wta: { events: [] } };
  let calls = 0;
  const fetchJson = async (url) => { calls++; return /atp/.test(url) ? scoreboard.atp : scoreboard.wta; };
  const record = { date: '2026-11-06', plays: [
    { id: 'atp:1:games_spread', matchId: 'atp:1', market: 'games_spread', side: 'b', a: 'Jannik Sinner', b: 'Ben Shelton', point: 4.5, american: -110, status: 'pending', selection: 'Ben Shelton +4.5 games' },
    { id: 'atp:3:games_total', matchId: 'atp:3', market: 'games_total', point: 21.5, american: -110, units: 1, status: 'pending', selection: 'Over 21.5 games', a: 'Alex Zverev', b: 'Casper Ruud' },
    { id: 'parlay:2026-11-06', market: 'ml_parlay', status: 'pending', selection: '2-leg', american: 120, legs: [{ matchId: 'atp:1', side: 'a', selection: 'Jannik Sinner to win', american: -300 }, { matchId: 'atp:2', side: 'a', selection: 'Carlos Alcaraz to win', american: -250 }] },
  ] };
  m.set('tennis:picks:2026-11-06', JSON.stringify(record));
  const live = await getTennisLive(env, now, { fetchJson });
  assert.equal(calls, 2, 'one scoreboard a tour'); assert.equal(live.matches.length, 3, 'singles only, today only: the draw\'s earlier rounds stay out'); assert.equal(live.inPlay, 1);
  assert.equal(live.matches[0].id, 'atp:1', 'in play first'); assert.equal(live.matches[0].plays[0].standing.state, 'on', '6-3 4-5: Shelton inside 4.5');
  const final = live.matches.find((x) => x.id === 'atp:3'); assert.equal(final.plays[0].standing.state, 'lost', '18 games: the over lost');
  assert.equal(live.parlays.length, 1); assert.equal(live.parlays[0].legs[0].standing.state, 'on'); assert.equal(live.parlays[0].legs[1].standing.state, 'wait');
  const again = await getTennisLive(env, now + 60e3, { fetchJson });
  assert.equal(calls, 2, 'cached'); assert.equal(again.matches.length, 3);
  assert.equal(playStanding({ market: 'set_spread', side: 'b', a: 'A', b: 'B', point: 1.5, status: 'pending' }, { state: 'in', sets: [[6, 4]], completed: false }).state, 'on');
  assert.equal(playStanding({ market: 'set_spread', side: 'b', a: 'A', b: 'B', point: 1.5, status: 'pending' }, { state: 'in', sets: [[4, 6]], completed: false }).state, 'won');
  assert.equal(legStanding({ side: 'b' }, { state: 'in', sets: [[6, 4], [3, 6], [2, 1]] }).text, '6-4 3-6 2-1: 1-1 in sets');
  // ESPN refuses both hosts: the runner's card stands in, and the record says so.
  m.delete('tennis:live');
  m.set('tennis:card', JSON.stringify({ at: now - 600e3, slate: [{ id: '7', tour: 'wta', eventName: 'WTA Finals', tier: '1000', round: 'Semifinal', qualifying: false, date: '2026-11-06T17:30Z', state: 'in', completed: false, detail: '1st Set', a: { id: 'x', name: 'Iga Swiatek' }, b: { id: 'y', name: 'Coco Gauff' }, sets: [[3, 2]], winner: null }] }));
  let refused = 0;
  const fallback = await getTennisLive(env, now, { fetchJson: async (url, note) => { refused++; note('HTTP 403'); return null; } });
  assert.equal(refused, 4, 'both hosts, both tours'); assert.equal(fallback.matches.length, 1); assert.equal(fallback.matches[0].a, 'Iga Swiatek'); assert.match(fallback.sources.card, /runner's card/); assert.match(fallback.sources['atp:20261106'], /403/);
});

import { buildTennisTrends, acesProp, poissonAtLeast, linesFor, playerMatches, ensureTennisTrends, getTennisTrends } from '../worker/src/tennis-trends.js';

test('tennis trends: a line per prop at the number the player clears most often, aces modeled from the rate, today\'s lines from the board', async () => {
  const now = Date.now();
  // Rybakina: ten matches, 9-1, big games-won numbers; her serve profile says 0.65 aces a service game.
  const results = [];
  const scores = [[[6, 3], [6, 4]], [[6, 2], [6, 2]], [[7, 6], [6, 4]], [[6, 4], [3, 6], [6, 3]], [[6, 1], [6, 3]], [[6, 4], [6, 4]], [[4, 6], [6, 3], [7, 5]], [[6, 3], [6, 2]], [[6, 4], [7, 6]], [[3, 6], [4, 6]]];
  scores.forEach((sets, i) => results.push({ id: `r${i}`, tour: 'wta', completed: true, statusName: 'STATUS_FINAL', date: new Date(now - (i + 1) * 2 * 864e5).toISOString(), eventName: 'Some Open', a: { id: 'ryb', key: 'elena rybakina', name: 'Elena Rybakina' }, b: { id: `o${i}`, key: `opp ${i}`, name: `Opp ${i}` }, sets, winner: sets.filter(([x, y]) => x > y).length >= 2 ? 'a' : 'b' }));
  const profiles = { wta: { players: { 'elena rybakina': { name: 'Elena Rybakina', key: 'elena rybakina', matches: 86, overall: { matches: 86, serve: 0.65, acesPerGame: 0.649, ace: 0.1014, points: 6054 }, bySurface: {} } } }, atp: { players: {} } };
  const card = { at: now, results, slate: [{ id: 's1', tour: 'wta', eventName: 'WTA Finals', tier: '1000', round: 'Semifinal', qualifying: false, completed: false, state: 'pre', date: new Date(now + 5 * 3600e3).toISOString(), a: { id: 'ryb', key: 'elena rybakina', name: 'Elena Rybakina' }, b: { id: 'x', key: 'jessica pegula', name: 'Jessica Pegula' }, sets: [] }] };
  const boards = { wta: [{ id: 'ev', home_team: 'Elena Rybakina', away_team: 'Jessica Pegula', bookmakers: [{ key: 'fanduel', title: 'FanDuel', markets: [{ key: 'h2h', outcomes: [{ name: 'Elena Rybakina', price: -150 }, { name: 'Jessica Pegula', price: 125 }] }, { key: 'spreads', outcomes: [{ name: 'Elena Rybakina', point: -2.5, price: -110 }, { name: 'Jessica Pegula', point: 2.5, price: -110 }] }, { key: 'totals', outcomes: [{ name: 'Over', point: 21.5, price: -115 }, { name: 'Under', point: 21.5, price: -105 }] }] }] }], atp: [] };
  const t = buildTennisTrends({ card, profiles, boards, now });
  const ryb = t.players.find((p) => p.key === 'elena rybakina');
  assert.ok(ryb, 'Rybakina is listed'); assert.equal(ryb.matches, 10); assert.equal(ryb.record, '9-1'); assert.equal(ryb.form.length, 10);
  const aces = ryb.props.find((p) => p.market === 'aces');
  assert.ok(aces.modeled); assert.ok(aces.mean > 5 && aces.mean < 9, `mean ${aces.mean}`); assert.ok(aces.line >= 2.5 && aces.line <= 5.5, `aces line ${aces.line}`); assert.ok(aces.ladder.find((l) => l.line === 2.5).rate > 0.9, 'three aces is near certain for her');
  const gw = ryb.props.find((p) => p.market === 'games_won');
  assert.ok(gw.line >= 9.5, `games won line ${gw.line}`); assert.ok(gw.rate >= 0.8); assert.equal(gw.values.length, 10); assert.ok(gw.ladder.length > 3);
  const total = ryb.props.find((p) => p.market === 'games_total'); assert.ok(total.line >= 15.5);
  const set1 = ryb.props.find((p) => p.market === 'set1_total'); assert.ok(set1);
  const spread = ryb.props.find((p) => p.market === 'games_spread'); assert.ok(spread.plus); assert.ok(spread.line != null);
  const sets = ryb.props.find((p) => p.market === 'set_spread'); assert.ok(sets.rate >= 0.9, 'a set in all but the straight-sets loss');
  assert.ok(ryb.today && ryb.today.opponent === 'Jessica Pegula' && ryb.today.lines.h2h.american === -150 && ryb.today.lines.spread.point === -2.5 && ryb.today.lines.total.point === 21.5);
  assert.equal(t.players[0].key, 'elena rybakina', 'playing today first');
  assert.ok(!t.players.some((p) => p.key === 'opp 0'), 'one match is too few for a line');
  assert.ok(Math.abs(poissonAtLeast(7, 3) - 0.97) < 0.01);
  assert.equal(acesProp({ overall: { matches: 5, acesPerGame: 0.6 } }, []), null, 'too few matches on file');
  assert.equal(playerMatches({ id: 'ryb', key: 'elena rybakina' }, results, now)[0].gamesWon, 12);
  // Stored once an hour; the read gives it back.
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  const first = await ensureTennisTrends(env, { card, profiles, now, boards }); assert.equal(first.built, true);
  const second = await ensureTennisTrends(env, { card, profiles, now: now + 60e3, boards }); assert.equal(second.built, false);
  const read = await getTennisTrends(env); assert.equal(read.players.length, t.players.length); assert.equal(read.counts.today, 1);
  assert.equal(linesFor(boards.wta[0], 'E. Rybakina').h2h.american, -150, 'an initial fits the surname');
});

import { builderLegs, legScoreOf, consistencyFrom, getTennisParlay, BUILDER_MARKETS } from '../worker/src/tennis-picks.js';

test('builderLegs prices every number on the board for the Parlay Builder, scored by the model with the consistency at the line, and the tick stores them', async () => {
  const ratesA = { serve: 0.72, firstIn: 0.62, return: 0.43, ace: 0.11, acesPerGame: 0.7, points: 4800, matches: 60, aceMatches: 60 };
  const ratesB = { serve: 0.66, firstIn: 0.6, return: 0.36, ace: 0.12, acesPerGame: 0.78, points: 3600, matches: 45, aceMatches: 45 };
  const { pA, pB } = matchServeProbs(ratesA, ratesB, 'atp');
  const fit = fitToTarget(pA, pB, 0.78, { n: 800, seed: 7 });
  const dist = distributions(simulate(fit.pA, fit.pB, { n: 1500, seed: 11 }));
  const trends = { players: [{ tour: 'atp', key: 'ben shelton', props: [{ market: 'games_spread', modeled: false, n: 10, ladder: [{ line: 4.5, rate: 0.8, hits: 8, n: 10 }, { line: 6.5, rate: 0.9, hits: 9, n: 10 }] }, { market: 'aces', modeled: true, ladder: [] }] }] };
  const cons = consistencyFrom(trends);
  const legs = builderLegs(match(), { dist, board: boardEvent(), deep: deepEvent(), pFinal: 0.8, flags: { a: [], b: ['fatigue'] }, context: ['Form: ...'], consistency: (player, market, line) => cons(player, market, line, 'atp') });
  const markets = new Set(legs.map((l) => l.market));
  assert.ok(['ml', 'games_spread', 'games_total', 'set_spread', 'set1_total'].every((k) => markets.has(k)), `markets ${[...markets]}`);
  const mlA = legs.find((l) => l.market === 'ml' && l.side === 'a'); const mlB = legs.find((l) => l.market === 'ml' && l.side === 'b');
  assert.equal(mlA.prob, 0.8); assert.equal(mlB.prob, 0.2); assert.equal(mlA.quotes.length, 2, 'both books'); assert.ok(mlA.score >= 4 && mlB.score <= 1.5, `scores ${mlA.score} ${mlB.score}`);
  assert.ok(mlB.flags.includes('fatigue') && mlA.opponentFlags.includes('fatigue'));
  const sp = legs.find((l) => l.market === 'games_spread' && l.side === 'b' && l.point === 6.5);
  assert.ok(sp, 'the alternate +6.5'); assert.equal(sp.consistency.rate, 0.9, 'the Trends rung at 6.5'); assert.ok(sp.prob > 0.7); assert.ok(sp.why.length >= 2);
  const under = legs.find((l) => l.market === 'games_total' && l.sideWord === 'under');
  assert.ok(under && under.prob + legs.find((l) => l.market === 'games_total' && l.sideWord === 'over' && l.point === under.point).prob <= 1.001);
  assert.ok(legs.find((l) => l.market === 'set_spread' && l.side === 'a' && l.point === -1.5), 'the favourite -1.5 sets');
  assert.ok(legs.every((l) => l.id && l.selection && l.label === BUILDER_MARKETS[l.market] && Number.isFinite(l.implied) && l.quotes.every((q) => q.bookId && Number.isFinite(q.decimal))));
  assert.equal(legScoreOf(0.9, 0.1), 5); assert.equal(legScoreOf(0.5, 0), 1); assert.equal(legScoreOf(0.7, 0.06, true), 2.5);
  assert.equal(cons({ name: 'Ben Shelton' }, 'games_spread', 5.5, 'atp').line, 4.5, 'the rung below the line');
  assert.equal(cons({ name: 'Ben Shelton' }, 'aces', 3.5, 'atp'), null, 'a modeled prop is no consistency');
  // The tick writes the legs for a posted match too (the cached deeper markets only).
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  const card = { at: 1, slate: [match({ date: new Date(Date.now() + 6 * 3600e3).toISOString() })], results: [] };
  const profiles = { players: { 'jannik sinner': profile('Jannik Sinner', 60, 0.72, 0.43, 0.11), 'ben shelton': profile('Ben Shelton', 45, 0.66, 0.36, 0.12) } };
  let deepCalls = [];
  const deps = { card: async () => card, profiles: async () => profiles, sportKeys: async () => ({ atp: [{ key: 'tennis_atp_finals', title: 'ATP Finals' }], wta: [] }), board: async () => [boardEvent()], eventMarkets: async (k, id, opts) => { deepCalls.push(opts); return deepEvent(); }, aceLog: async () => ({}), trends: false };
  const r = await runTennisTick(env, null, Date.now(), { deps });
  assert.ok(r.builderLegs >= 6, `legs ${r.builderLegs}`);
  const stored = await getTennisParlay(env);
  assert.equal(stored.legs.length, r.builderLegs); assert.equal(stored.matches.length, 1); assert.ok(stored.matches[0].pFinal > 0.5);
  const again = await runTennisTick(env, null, Date.now(), { deps });
  assert.ok(again.builderLegs >= 6, 'the posted match keeps its legs'); assert.equal(deepCalls.length, 2, 'the deeper markets are read each tick (the KV cache answers for three hours in the worker)');
});
