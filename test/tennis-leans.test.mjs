import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fanduelPlayers, fanduelEventFor, fanduelFeedEvent, withFanduel, samePlayer, FANDUEL_MAX_AGE } from '../worker/src/tennis-fanduel.js';
import { leanFor, propFor, sortLeans, pairSuggestions, priceTogether, shortSelection, STRAIGHT_FLOOR } from '../worker/src/tennis-leans.js';
import { quotesOf, marketWinShare, gradePlay, runTennisTick, getTennisPicks, getTennisParlay, MAX_UNITS_DAY } from '../worker/src/tennis-picks.js';

let sel = 1;
const r = (runnerName, american) => ({ selectionId: sel++, runnerName, handicap: 0, american });
const mkt = (marketType, marketName, runners) => ({ marketId: `m${sel++}`, marketType, marketName, sgm: true, runners });
// FanDuel's own wording, as its page gave it on 2026-11-12 (Pegula v Noskova).
const pegula = () => ({ eventId: 36278257, name: 'Jessica Pegula v Linda Noskova', openDate: '2026-11-12T21:30:00.000Z', markets: [
  mkt('MATCH_BETTING', 'Moneyline', [r('Jessica Pegula', 100), r('Linda Noskova', -120)]),
  mkt('PLAYER_A_TO_WIN_AT_LEAST_1_SET', 'Jessica Pegula To Win At Least 1 Set', [r('Jessica Pegula Yes', -260), r('Jessica Pegula No', 188)]),
  mkt('PLAYER_B_TO_WIN_AT_LEAST_1_SET', 'Linda Noskova To Win At Least 1 Set', [r('Linda Noskova Yes', -320), r('Linda Noskova No', 220)]),
  mkt('SET_1_WINNER', 'Set 1 Winner', [r('Jessica Pegula', -106), r('Linda Noskova', -116)]),
  mkt('SET_2_WINNER', 'Set 2 Winner', [r('Jessica Pegula', -102), r('Linda Noskova', -118)]),
  mkt('SET_BETTING', 'Set Betting', [r('Jessica Pegula 2-0', 220), r('Jessica Pegula 2-1', 340), r('Linda Noskova 2-0', 185), r('Linda Noskova 2-1', 330)]),
  mkt('MAIN_MATCH_GAME_HANDICAP', 'Game Spread', [r('Linda Noskova -0.5', -130), r('Jessica Pegula +0.5', -125)]),
  mkt('MATCH_TOTAL_GAMES', 'Match Total Games', [r('Over 22.5', -110), r('Under 22.5', -122)]),
  mkt('ALTERNATIVE_MATCH_TOTAL_GAMES', 'Alternative Total Games', [r('Over 20.5', -195), r('Under 20.5', 130)]),
  mkt('MAIN_SET_TOTAL_GAMES', 'Set 1 Total Games', [r('Over 9.5', -150), r('Under 9.5', -105)]),
  mkt('MAIN_SET_TOTAL_GAMES', 'Set 2 Total Games', [r('Over 9.5', -125), r('Under 9.5', -130)]),
  mkt('MAIN_SET_TOTAL_GAMES', 'Set 3 Total Games', [r('Over 9.5', -105), r('Under 9.5', -150)]),
  mkt('EXACT_NUMBER_OF_SETS', 'Total Sets', [r('2 Sets', -185), r('3 Sets', 120)]),
  mkt('PLAYER_A_ACES', 'Jessica Pegula Aces', [r('3+', -2000), r('5+', -475), r('7+', -175), r('9+', 140)]),
  mkt('PLAYER_B_ACES', 'Linda Noskova Aces', [r('5+', -1000), r('7+', -310), r('9+', -135)]),
] });

test('fanduelFeedEvent turns a FanDuel match page into the feed\'s markets, each outcome with its slip link', () => {
  assert.deepEqual(fanduelPlayers('Jessica Pegula v Linda Noskova'), ['Jessica Pegula', 'Linda Noskova']);
  assert.equal(fanduelPlayers('Siniakova/Townsend v Bucsa/Melichar-Martinez'), null, 'doubles are not read');
  assert.equal(fanduelPlayers('Men\'s Australian Open 2027'), null, 'an outright is no match');
  const { board, deep } = fanduelFeedEvent(pegula());
  const h2h = quotesOf(board, 'h2h');
  assert.equal(h2h.length, 2); assert.equal(h2h[0].bookId, 'fanduel'); assert.equal(h2h[0].american, 100);
  assert.match(h2h[0].link, /^https:\/\/sportsbook\.fanduel\.com\/addToBetslip\?marketId=m\d+&selectionId=\d+$/);
  const spreads = quotesOf(board, 'spreads');
  assert.deepEqual(spreads.map((q) => [q.name, q.point, q.american]), [['Linda Noskova', -0.5, -130], ['Jessica Pegula', 0.5, -125]], 'the number is read off the runner\'s name');
  assert.deepEqual(quotesOf(board, 'totals').map((q) => [q.name, q.point]), [['Over', 22.5], ['Under', 22.5]]);
  assert.equal(quotesOf(deep, 'alternate_totals').length, 2);
  assert.deepEqual(quotesOf(deep, 'totals_s1').map((q) => q.american), [-150, -105], 'the first set\'s total');
  assert.deepEqual(quotesOf(deep, 'alternate_totals_s2').map((q) => q.american), [-125, -130], 'the second set\'s; the third is left out');
  assert.deepEqual(quotesOf(deep, 'h2h_s1').map((q) => q.american), [-106, -116]);
  // "To win at least one set": Yes is the player +1.5 sets, No is the other player in straight sets.
  const sets = quotesOf(deep, 'alternate_set_spreads').map((q) => `${q.name} ${q.point} ${q.american}`);
  assert.deepEqual(sets, ['Jessica Pegula 1.5 -260', 'Linda Noskova -1.5 188', 'Linda Noskova 1.5 -320', 'Jessica Pegula -1.5 220']);
  assert.deepEqual(quotesOf(deep, 'alternate_set_totals').map((q) => `${q.name} ${q.point} ${q.american}`), ['Under 2.5 -185', 'Over 2.5 120']);
  const aces = quotesOf(deep, 'player_aces');
  assert.deepEqual(aces.filter((q) => q.name === 'Jessica Pegula').map((q) => [q.point, q.american]), [[2.5, -2000], [4.5, -475], [6.5, -175], [8.5, 140]], '"7+" is over 6.5');
  assert.ok(Math.abs(marketWinShare(board, 'Jessica Pegula') - 0.478) < 0.01);
  // A best of five: winning a set is +2.5 there, so the two set markets are left out.
  const five = pegula(); five.markets.find((m) => m.marketType === 'SET_BETTING').runners.push(r('Jessica Pegula 3-0', 500));
  assert.equal(quotesOf(fanduelFeedEvent(five).deep, 'alternate_set_spreads').length, 0);
  assert.equal(quotesOf(fanduelFeedEvent(pegula(), { bestOf: 5 }).deep, 'alternate_set_totals').length, 0);
});

test('fanduelEventFor pairs a card match either way round and refuses a stale read; withFanduel lays the page over the feed\'s FanDuel prices', () => {
  const now = Date.parse('2026-11-12T14:00:00Z');
  const fd = { at: now - 60e3, events: [pegula()] };
  const match = { a: { name: 'Linda Noskova' }, b: { name: 'J. Pegula' } };
  assert.equal(fanduelEventFor(match, fd, now)?.eventId, 36278257);
  assert.equal(fanduelEventFor({ a: { name: 'Coco Gauff' }, b: { name: 'Jessica Pegula' } }, fd, now), null);
  assert.equal(fanduelEventFor(match, { ...fd, at: now - FANDUEL_MAX_AGE - 1 }, now), null, 'six hours old is no price');
  assert.equal(fanduelEventFor(match, null, now), null);
  assert.ok(samePlayer('Thiago Agustin Tirante', 'Thiago Agustin Tirante') && !samePlayer('Laura Samson', 'Liam Samson') === false);
  const feed = { id: 'ev9', sportKey: 'tennis_wta_finals', bookmakers: [
    { key: 'fanduel', title: 'FanDuel', markets: [{ key: 'h2h', outcomes: [{ name: 'Jessica Pegula', price: 105 }, { name: 'Linda Noskova', price: -125 }] }] },
    { key: 'draftkings', title: 'DraftKings', markets: [{ key: 'h2h', outcomes: [{ name: 'Jessica Pegula', price: 102 }, { name: 'Linda Noskova', price: -122 }] }] },
  ] };
  const merged = withFanduel(feed, fanduelFeedEvent(pegula()).board);
  assert.equal(merged.id, 'ev9'); assert.equal(merged.sportKey, 'tennis_wta_finals');
  const h2h = quotesOf(merged, 'h2h');
  assert.equal(h2h.length, 4, 'two books, two sides: the feed\'s own FanDuel h2h gave way');
  assert.equal(h2h.find((q) => q.bookId === 'fanduel' && q.name === 'Jessica Pegula').american, 100);
  assert.ok(h2h.find((q) => q.bookId === 'fanduel').link.includes('addToBetslip'));
  assert.equal(withFanduel(feed, null), feed); assert.equal(withFanduel(null, null), null);
});

const q = (bookId, american, link = null) => ({ bookId, book: bookId === 'fanduel' ? 'FanDuel' : 'DraftKings', american, decimal: american > 0 ? 1 + american / 100 : 1 + 100 / -american, link });
const implied = (american) => (american < 0 ? -american / (-american + 100) : 100 / (american + 100));
const leg = (matchId, market, name, prob, quotes, over = {}) => {
  const best = Math.max(...quotes.map((x) => x.american));
  return { id: `${matchId}:${market}:${name}:${over.point ?? ''}`, matchId, tour: 'atp', event: 'Bybit Stockholm Open', round: 'Quarterfinal', commenceMs: Date.now() + 3600e3, a: name, b: `Rival of ${name}`, side: 'a', name, opponent: `Rival of ${name}`, market, label: market, selection: `${name} ${market}`, point: null, sideWord: null, prob, implied: Math.round(implied(best) * 1000) / 1000, edge: Math.round((prob - implied(best)) * 1000) / 1000, score: 4, flags: [], opponentFlags: [], quotes, consistency: null, why: [`${name} line`, 'Form: ...'], ...over };
};

test('leanFor names the side and how to play it: the straight play with the most room, a parlay piece when the price is too short, nothing when no price leaves room', () => {
  // Fritz: the moneyline at -184 with five points of room, the first set with less, "to win a set" too short to take alone.
  const fritz = [leg('m1', 'ml', 'Taylor Fritz', 0.70, [q('fanduel', -184), q('draftkings', -190)]), leg('m1', 'set1_ml', 'Taylor Fritz', 0.64, [q('fanduel', -150)]), leg('m1', 'set_spread', 'Taylor Fritz', 0.89, [q('fanduel', -550)], { point: 1.5 }), leg('m1', 'games_total', null, 0.5, [q('fanduel', -110)], { side: null, name: null })];
  const lean = leanFor(fritz, { read: { pMarket: 0.62, pModel: 0.77, pFinal: 0.70 } });
  assert.equal(lean.main.market, 'ml'); assert.equal(lean.main.american, -184); assert.equal(lean.main.bookId, 'fanduel', 'the best price on the board');
  assert.equal(lean.how, 'straight'); assert.equal(lean.units, 1.5, '70% is a unit and a half'); assert.equal(lean.conviction, 'lean', 'five points of room is a lean, not a pick');
  assert.equal(lean.main.short, 'Taylor Fritz ML'); assert.match(lean.howText, /Moneyline, straight for 1\.5u/);
  assert.deepEqual(lean.alternates.map((a) => a.short), ['Taylor Fritz to win a set', 'Taylor Fritz 1st set'].filter((s) => lean.alternates.some((a) => a.short === s)));
  assert.ok(lean.alternates.some((a) => a.short === 'Taylor Fritz to win a set'), 'the other ways to play the same side ride along');
  assert.match(lean.why[0], /Taylor Fritz 70% to win by the read: the model's own 77%, the market's 62%/);
  assert.ok(!lean.why.includes('Taylor Fritz line'), 'the moneyline\'s own line would say the share twice');
  assert.ok(lean.why.some((w) => /FanDuel has it at -184, which asks for 65%; the read gives 70%, 5 points of room/.test(w)));
  // High conviction: likely, roomy, straight, on a full read. The same numbers on a thin read stay a lean.
  const strong = [leg('m2', 'ml', 'Jessica Pegula', 0.76, [q('fanduel', -120)])];
  assert.equal(leanFor(strong, { read: { pFinal: 0.76 } }).conviction, 'high');
  const thin = leanFor(strong, { read: { pFinal: 0.76, thin: true, thinNames: 'Linda Noskova' } });
  assert.equal(thin.conviction, 'lean'); assert.ok(thin.why.some((w) => /No serve numbers on file for Linda Noskova/.test(w)));
  assert.equal(thin.units, 0.5, 'a thin read is half a unit at most');
  // A thin read has a view of the winner alone (form): its spreads, sets and totals are the tour's average fitted to the price, and are never its lean.
  const shape = [leg('m8', 'games_spread', 'Irene Burillo', 0.61, [q('fanduel', -135)], { point: 4.5 }), leg('m8', 'set_spread', 'Irene Burillo', 0.73, [q('fanduel', -225)], { point: 1.5 }), leg('m8', 'games_total', null, 0.8, [q('fanduel', -230)], { side: null, name: null, sideWord: 'over', point: 18.5 })];
  assert.equal(leanFor(shape, { read: { thin: true } }), null);
  assert.ok(leanFor(shape, { read: {} }), 'the same legs on a full read are a lean');
  assert.deepEqual(sortLeans([thin, leanFor(fritz, { read: {} })]).map((l) => l.name), ['Taylor Fritz', 'Jessica Pegula'], 'the full reads first, however likely the thin one');
  // Only a short price clears: a parlay piece, no units of its own.
  const short = leanFor([leg('m3', 'ml', 'Bianca Andreescu', 0.9, [q('fanduel', -600)])], {});
  assert.equal(short.how, 'parlay'); assert.equal(short.units, null); assert.equal(short.conviction, 'lean'); assert.ok(-600 < STRAIGHT_FLOOR);
  // No room, a flagged side, a price past the floor: no lean.
  assert.equal(leanFor([leg('m4', 'ml', 'Holger Rune', 0.6, [q('fanduel', -160)])], {}), null, 'the read agrees with the price: nothing to bet');
  assert.equal(leanFor([leg('m5', 'ml', 'Holger Rune', 0.75, [q('fanduel', -160)], { flags: ['fatigue'] })], {}), null, 'never on a flagged player');
  assert.equal(leanFor([leg('m6', 'ml', 'Holger Rune', 0.95, [q('fanduel', -900)])], {}), null, 'too short to be a bet at all');
  // No side, but a total with room at the stricter bar leads the card.
  const total = leanFor([leg('m7', 'games_total', null, 0.7, [q('fanduel', -130)], { side: null, name: null, selection: 'Over 21.5 games', sideWord: 'over', point: 21.5 })], {});
  assert.equal(total.main.selection, 'Over 21.5 games'); assert.equal(total.side, null);
  assert.equal(shortSelection({ market: 'set_spread', name: 'A', point: -1.5 }), 'A in straight sets');
  assert.equal(shortSelection({ market: 'games_spread', name: 'A', point: 3.5 }), 'A +3.5 games');
});

test('propFor takes the aces line with room at a price worth taking alone', () => {
  const aces = (point, prob, american) => leg('m1', 'aces', 'Taylor Fritz', prob, [q('fanduel', american)], { point, selection: `Taylor Fritz over ${point} aces`, sideWord: 'over' });
  const prop = propFor([aces(6.5, 0.93, -350), aces(8.5, 0.78, -140), aces(10.5, 0.5, 150)]);
  assert.equal(prop.point, 8.5, 'the short rung is no straight play, the long one no better than a coin'); assert.equal(prop.units, 1.5);
  assert.equal(propFor([aces(8.5, 0.6, -140)]), null);
});

test('pairSuggestions writes the parlay the way a bettor says it, priced at one book, the most confident leans together', () => {
  const now = Date.now();
  const lean = (matchId, name, prob, quotes) => leanFor([leg(matchId, 'ml', name, prob, quotes)], { read: { pFinal: prob } });
  const leans = sortLeans([lean('m2', 'Jessica Pegula', 0.62, [q('fanduel', 100, 'https://sportsbook.fanduel.com/addToBetslip?marketId=2&selectionId=20')]), lean('m1', 'Taylor Fritz', 0.70, [q('fanduel', -184, 'https://sportsbook.fanduel.com/addToBetslip?marketId=1&selectionId=10'), q('draftkings', -180)])]);
  assert.deepEqual(leans.map((l) => l.name), ['Taylor Fritz', 'Jessica Pegula'], 'by confidence, the best on top');
  const [s] = pairSuggestions(leans, now);
  assert.equal(s.text, 'Take Taylor Fritz ML and parlay it with Jessica Pegula ML');
  assert.equal(s.bookId, 'fanduel', 'the one book that prices both'); assert.equal(s.american, 209);
  assert.equal(s.prob, 0.434); assert.ok(s.edge > 0.1); assert.equal(s.legs.length, 2); assert.ok(s.legs.every((l) => l.link));
  assert.ok(s.why.at(-1).startsWith('Together 43% to land at +209 (FanDuel)'));
  // A parlay piece is paired with the most confident other lean first.
  const withPiece = sortLeans([...leans, lean('m3', 'Bianca Andreescu', 0.9, [q('fanduel', -600)])]);
  const out = pairSuggestions(withPiece, now);
  assert.equal(out[0].text, 'Take Bianca Andreescu ML and parlay it with Taylor Fritz ML'); assert.equal(out[0].lead, 'piece');
  assert.ok(out.length <= 3 && new Set(out.map((x) => x.id)).size === out.length);
  // No common book: no ticket to suggest.
  assert.equal(priceTogether([{ quotes: [q('fanduel', -150)] }, { quotes: [q('draftkings', -150)] }]), null);
  assert.deepEqual(pairSuggestions([leans[0]], now), []);
});

test('gradePlay settles a moneyline, a first set, straight sets and the sets played', () => {
  const play = (market, over = {}) => ({ market, side: 'a', a: 'Taylor Fritz', b: 'Holger Rune', point: null, american: -184, units: 1.5, ...over });
  const done = { completed: true, statusName: 'STATUS_FINAL', sets: [[6, 4], [3, 6], [6, 3]], winner: 'a' };
  const ml = gradePlay(play('ml'), done);
  assert.equal(ml.result, 'win'); assert.equal(ml.net, Math.round((100 / 184) * 1.5 * 100) / 100, 'the units ride the price');
  assert.equal(gradePlay(play('ml', { side: 'b' }), done).result, 'loss'); assert.equal(gradePlay(play('ml', { side: 'b' }), done).net, -1.5);
  assert.equal(gradePlay(play('ml'), { completed: false, sets: [[6, 4]] }), null, 'a match in play waits');
  assert.equal(gradePlay(play('ml'), { completed: true, statusName: 'STATUS_RETIRED', sets: [[6, 4], [2, 1]], winner: 'a' }).result, 'win', 'a set was completed: the bet stands');
  assert.equal(gradePlay(play('ml'), { completed: true, statusName: 'STATUS_RETIRED', sets: [[3, 1]], winner: 'a' }).result, 'void');
  assert.equal(gradePlay(play('ml'), { completed: true, statusName: 'STATUS_WALKOVER', sets: [], winner: 'a' }).result, 'void');
  assert.equal(gradePlay(play('set1_ml'), { completed: false, sets: [[6, 4], [1, 0]] }).result, 'win', 'settled as soon as the set is in');
  assert.equal(gradePlay(play('set1_ml', { side: 'b' }), done).result, 'loss');
  assert.equal(gradePlay(play('set_spread', { point: -1.5 }), done).result, 'loss', 'a set dropped');
  assert.equal(gradePlay(play('set_spread', { point: -1.5 }), { completed: false, sets: [[6, 4], [3, 6]] }).result, 'loss', 'lost the moment the set went');
  assert.equal(gradePlay(play('set_spread', { point: -1.5 }), { ...done, sets: [[6, 4], [6, 3]] }).result, 'win');
  assert.equal(gradePlay(play('set_spread', { point: -1.5 }), { completed: false, sets: [[6, 4]] }), null);
  assert.equal(gradePlay(play('sets_total', { point: 2.5, sideWord: 'over' }), done).result, 'win');
  assert.equal(gradePlay(play('sets_total', { point: 2.5, sideWord: 'under' }), done).result, 'loss');
  assert.equal(gradePlay(play('sets_total', { point: 2.5, sideWord: 'under' }), { ...done, sets: [[6, 4], [6, 3]] }).result, 'win');
  assert.equal(gradePlay(play('games_total', { point: 22.5, sideWord: 'under' }), { ...done, sets: [[6, 4], [6, 3]] }).result, 'win', '19 games stay under');
  assert.match(gradePlay(play('games_spread', { point: -2.5 }), { ...done, sets: [[6, 4], [6, 3]] }).actual, /covered at -2\.5/);
});

const line = (matches, serve, ret, ace) => ({ matches, serve, firstIn: 0.62, firstWon: 0.74, secondWon: 0.52, return: ret, acesPerGame: ace * 6.4, ace, points: matches * 80 });
const profile = (name, matches, serve, ret, ace) => ({ name, key: name.toLowerCase(), matches, overall: line(matches, serve, ret, ace), bySurface: {} });

test('runTennisTick reads a week the feed has no board for off FanDuel: the leans by confidence, the straight ones tracked by their units, the parlay suggested', async () => {
  const now = Date.parse('2026-11-12T14:00:00Z');
  const mk = (id, tour, a, b, h, ev) => ({ id, tour, eventId: 'e', eventName: ev, tier: 'tour', round: 'Quarterfinal', qualifying: false, date: new Date(now + h * 3600e3).toISOString(), state: 'pre', completed: false, statusName: 'STATUS_SCHEDULED', bestOf: 3, a: { id: `${id}a`, name: a, key: a.toLowerCase() }, b: { id: `${id}b`, name: b, key: b.toLowerCase() }, sets: [], tiebreaks: [], winner: null });
  const fdEvent = (eventId, a, b, ml, extra = []) => ({ eventId, name: `${a} v ${b}`, openDate: new Date(now + 3600e3).toISOString(), markets: [mkt('MATCH_BETTING', 'Moneyline', [r(a, ml[0]), r(b, ml[1])]), ...extra] });
  const fd = { at: now - 60e3, events: [
    fdEvent(1, 'Taylor Fritz', 'Holger Rune', [-184, 150], [mkt('SET_1_WINNER', 'Set 1 Winner', [r('Taylor Fritz', -150), r('Holger Rune', 120)]), mkt('PLAYER_A_TO_WIN_AT_LEAST_1_SET', 'Taylor Fritz To Win At Least 1 Set', [r('Taylor Fritz Yes', -550), r('Taylor Fritz No', 380)])]),
    fdEvent(2, 'Jessica Pegula', 'Linda Noskova', [100, -120]),
    fdEvent(3, 'Laura Samson', 'Irene Burillo', [-280, 200]),
  ] };
  const card = { at: 1, slate: [mk('1', 'atp', 'Holger Rune', 'Taylor Fritz', 4, 'Bybit Stockholm Open'), mk('2', 'wta', 'Linda Noskova', 'Jessica Pegula', 6, 'WTA Finals'), mk('3', 'wta', 'Irene Burillo', 'Laura Samson', 2, 'DIRECTV Open')], results: [] };
  const res = (id, tour, w, l, daysAgo) => ({ ...mk(id, tour, w, l, -24 * daysAgo, 'Earlier'), state: 'post', completed: true, statusName: 'STATUS_FINAL', sets: [[6, 3], [6, 4]], winner: 'a' });
  for (let i = 0; i < 6; i++) {
    const d = i * 5 + 3;
    card.results.push(res(`r${i}`, 'atp', 'Taylor Fritz', `Opp ${i}`, d), i % 2 ? res(`s${i}`, 'atp', `Other ${i}`, 'Holger Rune', d) : res(`s${i}`, 'atp', 'Holger Rune', `Other ${i}`, d));
    card.results.push(res(`p${i}`, 'wta', 'Jessica Pegula', `W ${i}`, d), i % 3 ? res(`q${i}`, 'wta', 'Linda Noskova', `X ${i}`, d) : res(`q${i}`, 'wta', `X ${i}`, 'Linda Noskova', d));
  }
  const profiles = { atp: { players: { 'taylor fritz': profile('Taylor Fritz', 70, 0.70, 0.37, 0.13), 'holger rune': profile('Holger Rune', 60, 0.65, 0.39, 0.07) } }, wta: { players: { 'jessica pegula': profile('Jessica Pegula', 60, 0.60, 0.46, 0.04), 'linda noskova': profile('Linda Noskova', 50, 0.59, 0.43, 0.06) } } };
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  let billed = 0;
  const deps = { card: async () => card, profiles: async (t) => profiles[t], sportKeys: async () => ({ atp: [], wta: [] }), board: async () => [], eventMarkets: async () => { billed++; return null; }, fanduel: async () => fd, aceLog: async () => ({}), trends: false };
  const out = await runTennisTick(env, null, now, { deps });
  assert.equal(out.fanduel, 3); assert.equal(out.leans, 2); assert.equal(billed, 0, 'FanDuel\'s page gave the deeper markets: no billed call');
  const picks = await getTennisPicks(env, now);
  const leans = picks.current.leans;
  assert.deepEqual(leans.map((l) => l.main.short), ['Taylor Fritz ML', 'Jessica Pegula ML'], 'sorted by confidence');
  assert.ok(leans[0].confidence >= leans[1].confidence);
  assert.ok(leans.every((l) => l.how === 'straight' && l.posted && l.main.link.includes('addToBetslip')));
  assert.ok(leans[0].alternates.some((a) => a.short === 'Taylor Fritz 1st set'), 'the first set rides along as another way to play the side');
  const plays = picks.current.plays.filter((p) => p.market !== 'aces');
  assert.deepEqual(plays.map((p) => p.id), ['atp:1:ml', 'wta:2:ml'], 'the straight leans are tracked, the likeliest first');
  const bare = picks.current.plays.find((p) => p.market === 'aces');
  assert.ok(!bare || bare.american == null, 'no book priced the aces here: the old aces leg stands, the price left to the user\'s book');
  assert.ok(plays.every((p) => p.market === 'ml' && p.units === leans.find((l) => l.matchId === p.matchId).units && p.why.length >= 4));
  assert.equal(picks.unitsToday, picks.current.plays.reduce((n, p) => n + p.units, 0)); assert.ok(picks.unitsToday <= MAX_UNITS_DAY - 1, 'a unit is kept for the parlay');
  assert.equal(picks.current.suggestions[0].text, 'Take Taylor Fritz ML and parlay it with Jessica Pegula ML');
  assert.equal(picks.markets.ml, 'Moneyline'); assert.ok(picks.bar.leanProb > 0.5);
  // The match with no serve numbers on file is still read, off the price and form alone, and says so.
  const thin = picks.current.reads['wta:3'];
  assert.equal(thin.thin, true); assert.ok(thin.pMarket > 0.25 && thin.pMarket < 0.35); assert.match(thin.passed, /no price leaves room/);
  // A thin match whose form does move the price is a lean on the moneyline, half a unit, shown last and never on the record.
  {
    const m2 = new Map(); const env2 = { POTD_KV: { get: async (k) => m2.get(k) ?? null, put: async (k, v) => { m2.set(k, v); } } };
    const card2 = { ...card, results: [...card.results] };
    for (let i = 0; i < 6; i++) card2.results.push(res(`t${i}`, 'wta', 'Laura Samson', `Y ${i}`, i * 5 + 3), res(`u${i}`, 'wta', `Z ${i}`, 'Irene Burillo', i * 5 + 3));
    const fd2 = { ...fd, events: fd.events.map((e) => (e.eventId === 3 ? fdEvent(3, 'Laura Samson', 'Irene Burillo', [-150, 125]) : e)) };
    await runTennisTick(env2, null, now, { deps: { ...deps, card: async () => card2, fanduel: async () => fd2 } });
    const cur = (await getTennisPicks(env2, now)).current;
    const samson = cur.leans.find((l) => l.matchId === 'wta:3');
    assert.ok(samson && samson.thin && samson.main.market === 'ml' && samson.units === 0.5, 'the form gap makes the thin match a moneyline lean');
    assert.equal(cur.leans.at(-1), samson, 'listed after the full reads'); assert.equal(samson.posted, null); assert.match(samson.note, /not tracked: a price-and-form read/);
    assert.ok(!cur.plays.some((p) => p.matchId === 'wta:3'));
  }
  // The Parlay Builder gets the same legs, FanDuel's set markets among them.
  const builder = await getTennisParlay(env);
  assert.ok(builder.legs.some((l) => l.market === 'set1_ml') && builder.legs.some((l) => l.market === 'set_spread'));
  // A second tick posts nothing new and keeps the leans marked as tracked.
  const again = await runTennisTick(env, null, now + 60e3, { deps });
  assert.equal(again.posted, 0); assert.ok((await getTennisPicks(env, now)).current.leans.every((l) => l.posted));
  // Fritz wins in three: the moneyline grades at its price and units.
  card.slate[0] = { ...card.slate[0], state: 'post', completed: true, statusName: 'STATUS_FINAL', sets: [[4, 6], [6, 3], [6, 4]], winner: 'b' };
  const graded = await runTennisTick(env, null, now + 120e3, { deps });
  assert.equal(graded.graded, 1);
  const fritz = (await getTennisPicks(env, now)).current.plays.find((p) => p.id === 'atp:1:ml');
  assert.equal(fritz.result, 'win'); assert.equal(fritz.net, Math.round((100 / 184) * fritz.units * 100) / 100);
});
