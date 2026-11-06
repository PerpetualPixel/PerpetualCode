import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLeg, parseSlipText, parseAmerican, ratesAt, scoreLeg, scoreSlip, suggestions, matchLeg, checkSlip, betterLines, sameName } from '../docs/slip-check.js';

const log = (values, opponent = null) => values.map((v, i) => ({ value: v, opponent: i % 3 === 0 ? 'BOS' : opponent ?? 'NYK', date: `2026-11-${String(20 - i).padStart(2, '0')}` }));

test('parseLeg reads the ways a slip writes a leg: over/under, N+, PrizePicks more/less, team lines, totals, prices', () => {
  const t = parseLeg('Jayson Tatum Over 27.5 Points -115');
  assert.equal(t.kind, 'prop'); assert.equal(t.player, 'jayson tatum'); assert.equal(t.stat.key, 'points'); assert.equal(t.side, 'over'); assert.equal(t.point, 27.5); assert.equal(t.american, -115);
  const plus = parseLeg('Jayson Tatum 25+ Points'); assert.equal(plus.side, 'over'); assert.equal(plus.point, 24.5);
  const more = parseLeg('More 27.5 Points Jayson Tatum'); assert.equal(more.side, 'over'); assert.equal(more.player, 'jayson tatum');
  const under = parseLeg('Shai Gilgeous-Alexander Under 30.5 Points'); assert.equal(under.player, 'shai gilgeous alexander'); assert.equal(under.side, 'under');
  const yards = parseLeg('Josh Allen 250+ Passing Yards'); assert.equal(yards.stat.key, 'passYds'); assert.equal(yards.point, 249.5); assert.deepEqual(yards.stat.leagues, ['americanfootball_nfl']);
  const sog = parseLeg('Connor McDavid 3+ Shots on Goal'); assert.equal(sog.stat.key, 'shots'); assert.equal(sog.point, 2.5);
  const threes = parseLeg('Stephen Curry 4+ 3-Pointers Made'); assert.equal(threes.stat.key, 'threes'); assert.equal(threes.point, 3.5);
  const pra = parseLeg('Nikola Jokic Over 45.5 Pts + Reb + Ast'); assert.equal(pra.stat.key, 'pra');
  const ml = parseLeg('Lakers ML -150'); assert.equal(ml.kind, 'team'); assert.equal(ml.team, 'lakers'); assert.equal(ml.point, null); assert.equal(ml.american, -150);
  const spread = parseLeg('Celtics +6.5 (-110)'); assert.equal(spread.kind, 'team'); assert.equal(spread.point, 6.5); assert.equal(spread.american, -110);
  const total = parseLeg('Lakers/Celtics Over 224.5 -108'); assert.equal(total.kind, 'total'); assert.equal(total.side, 'over'); assert.equal(total.point, 224.5);
  const aces = parseLeg('Elena Rybakina Over 3.5 Aces'); assert.equal(aces.stat.key, 'aces'); assert.ok(aces.stat.leagues.includes('tennis'));
  assert.equal(parseLeg('Parlay'), null); assert.equal(parseLeg('+450'), null); assert.equal(parseLeg('Wager $10'), null); assert.equal(parseLeg('To win $55.00'), null);
  assert.equal(parseAmerican('Tatum Over 27.5 Points (−115)'), -115); assert.equal(parseAmerican('Over 27.5'), null);
  const legs = parseSlipText('3 leg parlay\nJayson Tatum Over 27.5 Points -115\nLakers -3.5\n+450\nWager $10');
  assert.equal(legs.length, 2);
  // The reader's structured fields win over the text.
  const s = parseLeg('J. Tatum O 27.5 PTS', { player: 'Jayson Tatum', stat: 'Points', side: 'OVER', line: 27.5, american: -118 });
  assert.equal(s.player, 'jayson tatum'); assert.equal(s.american, -118); assert.equal(s.structured, true);
  assert.ok(sameName('Tatum', 'Jayson Tatum')); assert.ok(sameName('J. Tatum', 'Jayson Tatum')); assert.ok(!sameName('Jaylen Brown', 'Jayson Tatum'));
});

test('ratesAt reads the hit rates at the slip\'s own number, pushes left out, head-to-head by the opponent', () => {
  const rows = log([30, 25, 28, 27, 31, 22, 29, 33, 26, 28, 24, 30, 27, 27, 35, 20, 28, 29, 31, 26, 30, 32]);
  const r = ratesAt(rows, 27.5, 'over', { opponent: 'BOS' });
  assert.equal(r.l5.games, 5); assert.equal(r.l5.hits, 3); assert.equal(r.l10.rate, 0.6); assert.equal(r.l20.games, 20); assert.ok(r.h2h.games >= 6, `h2h ${r.h2h.games}`);
  const push = ratesAt(log([27, 27, 30]), 27, 'over'); assert.equal(push.l5.games, 1, 'two pushes at an integer line are not counted');
  const under = ratesAt(rows, 27.5, 'under'); assert.equal(under.l20.hits + r.l20.hits, 20);
});

test('scoreLeg: the last 20 weighs most, a thin log and an injury cut the number, a price is a quarter of it; team lines and tennis read their own way', () => {
  const rows = log([30, 31, 29, 33, 30, 28, 32, 30, 31, 29, 30, 28, 33, 31, 30, 29, 32, 30, 31, 30]);
  const leg = { kind: 'prop', player: 'x', stat: { key: 'points' }, side: 'over', point: 27.5, american: -115, selection: 'X Over 27.5 Points' };
  const match = { source: 'trends', name: 'X', rows, rates: ratesAt(rows, 27.5, 'over', { opponent: 'BOS' }), opponent: 'BOS', injury: null, avg: 30.5 };
  const s = scoreLeg(leg, match);
  assert.ok(s.confidence >= 85, `confidence ${s.confidence}`); assert.equal(s.source, 'trends'); assert.ok(s.notes.some((n) => /L20 100%/.test(n)));
  const out = scoreLeg(leg, { ...match, injury: { level: 'out', status: 'Out', detail: 'knee' } });
  assert.ok(out.confidence <= 30 && out.warnings.some((w) => /OUT/.test(w)), `out ${out.confidence}`);
  const q = scoreLeg(leg, { ...match, injury: { level: 'questionable', status: 'Questionable' } }); assert.ok(q.confidence < s.confidence);
  const thin = scoreLeg(leg, { ...match, rows: rows.slice(0, 3), rates: ratesAt(rows.slice(0, 3), 27.5, 'over') }); assert.ok(thin.confidence < s.confidence && thin.warnings.length);
  const team = scoreLeg({ kind: 'team', team: 'lakers', american: -150, selection: 'Lakers ML' }, { source: 'market', prob: 0.58, note: 'priced' });
  assert.equal(team.confidence, 58); assert.equal(team.source, 'market');
  const unmatched = scoreLeg({ kind: 'prop', american: -110, selection: 'Nobody Over 1.5' }, { source: 'none' }); assert.equal(unmatched.confidence, 50); assert.ok(unmatched.warnings.length);
  const nothing = scoreLeg({ kind: 'prop', american: null, selection: 'Nobody Over 1.5' }, { source: 'none' }); assert.equal(nothing.confidence, null);
  const tennis = scoreLeg({ kind: 'prop', american: null, selection: 'Rybakina over 3.5 aces' }, { source: 'tennis', prob: 0.91, consistency: null, flags: ['injury'], why: ['modeled'] }); assert.equal(tennis.confidence, 91); assert.ok(tennis.warnings[0].includes('injury'));
});

test('scoreSlip grades the ticket, names a lotto by the odds or the leg count, and the suggestions drop, move, flip and warn', () => {
  const strong = log([30, 31, 29, 33, 30, 28, 32, 30, 31, 29, 30, 28, 33, 31, 30, 29, 32, 30, 31, 30]);
  const weak = log([24, 31, 23, 25, 30, 22, 24, 30, 23, 25, 30, 22, 24, 25, 30, 23, 24, 30, 25, 24]);
  const legA = { kind: 'prop', player: 'a', stat: { key: 'points' }, side: 'over', point: 27.5, american: -120, selection: 'A Over 27.5 Points' };
  const legB = { kind: 'prop', player: 'b', stat: { key: 'points' }, side: 'over', point: 27.5, american: -110, selection: 'B Over 27.5 Points' };
  const mA = { source: 'trends', name: 'A', rows: strong, rates: ratesAt(strong, 27.5, 'over'), gameId: 'g1' };
  const mB = { source: 'trends', name: 'B', rows: weak, rates: ratesAt(weak, 27.5, 'over'), gameId: 'g1' };
  const scored = [{ leg: legA, match: mA, score: scoreLeg(legA, mA) }, { leg: legB, match: mB, score: scoreLeg(legB, mB) }];
  const slip = scoreSlip(scored);
  assert.equal(slip.legs, 2); assert.equal(slip.known, 2); assert.ok(slip.lands > 0 && slip.lands < 1); assert.equal(slip.category, 'parlay'); assert.ok(slip.combined > 0, 'the legs multiply to plus money'); assert.ok(['C', 'D', 'F'].includes(slip.grade), `grade ${slip.grade}`);
  assert.equal(slip.weakest, 1);
  const sug = suggestions(scored, slip);
  const types = sug.map((x) => x.type);
  assert.ok(types.includes('drop'), `drop: ${types}`); assert.ok(types.includes('move'), 'a lower line B clears'); assert.ok(types.includes('flip'), 'the under lands for B'); assert.ok(types.includes('same-game'));
  const move = sug.find((x) => x.type === 'move'); assert.ok(/over 2[0-6]\.5/.test(move.text), move.text);
  assert.ok(betterLines(weak, 27.5, 'over').length === 1 && betterLines(weak, 27.5, 'over')[0].rate >= 0.8);
  // Six legs read as a lotto; a +2000 price too.
  const six = Array.from({ length: 6 }, (_, i) => ({ leg: { ...legA, selection: `L${i}`, american: 150 }, match: mA, score: scoreLeg({ ...legA, american: 150 }, mA) }));
  assert.equal(scoreSlip(six).category, 'lotto'); assert.ok(suggestions(six, scoreSlip(six)).some((x) => x.type === 'lotto'));
  assert.equal(scoreSlip([scored[0], { ...scored[1], leg: { ...legB, american: null } }], { combinedAmerican: 2200 }).category, 'lotto');
  assert.equal(scoreSlip([scored[0]]).category, 'straight');
  const a = scoreSlip([scored[0]]); assert.equal(a.grade, 'A');
});

test('matchLeg finds the player on the board, in a Players-tab log, in the tennis legs, or prices a team line off the slate; checkSlip runs the whole read', () => {
  const rows = log([30, 31, 29, 33, 30, 28, 32, 30, 31, 29, 30, 28]);
  const trendsRows = { basketball_nba: [{ playerName: 'Jayson Tatum', statKey: 'points', point: 26.5, side: 'over', opponent: 'NYK', eventId: 'ev1', team: 'BOS', injury: null, series: rows.map((r) => ({ ...r, hit: 1 })) }] };
  const playerLogs = { 'basketball_nba:rebounds:jaylen brown': { rows: log([6, 7, 5, 8, 6, 7, 9, 6, 5, 7, 6]), player: { name: 'Jaylen Brown', team: 'BOS', injury: null } } };
  const tennisLegs = [{ name: 'Elena Rybakina', market: 'aces', point: 3.5, prob: 0.91, consistency: null, flags: [], why: ['modeled'], matchId: 'wta:1' }, { name: 'Taylor Fritz', market: 'ml', point: null, prob: 0.22, flags: ['fatigue'], why: [], matchId: 'atp:1' }];
  const slateGames = [{ eventId: 'g9', sportKey: 'basketball_nba', away: 'Los Angeles Lakers', home: 'Boston Celtics', h2h: { away: { selection: 'Los Angeles Lakers', american: -150 }, home: { selection: 'Boston Celtics', american: 130 } }, spreads: { away: { selection: 'Los Angeles Lakers', point: -3.5, american: -110 }, home: { selection: 'Boston Celtics', point: 3.5, american: -110 } }, totals: { away: { selection: 'Over', point: 224.5, american: -108 }, home: { selection: 'Under', point: 224.5, american: -112 } } }];
  const data = { trendsRows, playerLogs, tennisLegs, slateGames };
  const onBoard = matchLeg(parseLeg('Tatum Over 27.5 Points'), data); assert.equal(onBoard.source, 'trends'); assert.equal(onBoard.opponent, 'NYK'); assert.equal(onBoard.rates.l10.games, 10);
  const offBoard = matchLeg(parseLeg('Jaylen Brown 6+ Rebounds'), data); assert.equal(offBoard.source, 'player'); assert.equal(offBoard.name, 'Jaylen Brown');
  const tennis = matchLeg(parseLeg('Elena Rybakina Over 3.5 Aces'), data); assert.equal(tennis.source, 'tennis'); assert.equal(tennis.prob, 0.91);
  const fritz = matchLeg(parseLeg('Taylor Fritz ML +240'), data); assert.equal(fritz.source, 'tennis'); assert.equal(fritz.prob, 0.22);
  const ml = matchLeg(parseLeg('Lakers ML -150'), data); assert.equal(ml.source, 'market'); assert.ok(Math.abs(ml.prob - 0.58) < 0.03, `ml ${ml.prob}`);
  const spread = matchLeg(parseLeg('Celtics +3.5'), data); assert.equal(spread.source, 'market'); assert.ok(spread.prob > 0.45 && spread.prob < 0.55);
  const total = matchLeg(parseLeg('Lakers/Celtics Over 224.5'), data); assert.equal(total.source, 'market'); assert.ok(total.note.includes('Over'));
  assert.equal(matchLeg(parseLeg('Nobody Special Over 10.5 Points'), data).source, 'none');
  const res = checkSlip(parseSlipText('Tatum Over 27.5 Points -115\nJaylen Brown 6+ Rebounds -120\nLakers ML -150\nElena Rybakina Over 3.5 Aces'), data);
  assert.equal(res.scored.length, 4); assert.equal(res.slip.known, 4); assert.ok(res.slip.lands > 0); assert.ok(res.suggestions.length);
});
