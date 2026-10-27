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
  qualifyingRows, researchPick, runTrendPicksDaily, runTrendPicksGrading, getTrendPicks, settle, settleBet, parseVerdict, buildBets, pickQuotes,
  PICK_MIN_GAMES, PICK_MAX_BETS, PICK_BOOKS, UNIT_DOLLARS,
} from '../worker/src/trend-picks.js';

const NOW = Date.parse('2026-10-27T15:00:00Z'); // 11am ET Oct 27
const ctx = { waitUntil: (p) => p };
function makeKvStore() {
  const store = new Map();
  return { store, env: { POTD_KV: { async get(k) { return store.get(k) ?? null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } } } };
}
const period = (rate, games) => ({ rate, hits: Math.round(rate * games), games, avg: 12, median: 12 });
const dec = (american) => (american < 0 ? 1 + 100 / -american : 1 + american / 100);
function row(id, { rate = 1, games = 20, h2h = period(1, 3), american = -140, player = 'Collin Sexton', commenceMs = NOW + 8 * 3.6e6, point = 9.5, side = 'over', statKey = 'points', books = { draftkings: american }, eventId = `e-${id}`, team = 'CHA' } = {}) {
  const quotes = Object.entries(books).map(([bookKey, price]) => ({ bookKey, book: bookKey, american: price, decimal: dec(price), link: `https://${bookKey}.example/${id}` })).sort((a, b) => b.american - a.american);
  return {
    id, eventId, sportKey: 'basketball_nba', sportTitle: 'NBA', commenceMs, home: 'Charlotte Hornets', away: 'Orlando Magic',
    playerName: player, team, opponent: 'ORL', athleteId: '4', headshot: null, statKey, statLabel: 'Pts', marketLabel: 'Points', point, side,
    selection: `${player} ${side === 'over' ? 'Over' : 'Under'} ${point} Pts`, american, decimal: dec(american), book: 'DraftKings', quotes,
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
  rows.push(row('i', { player: 'Grant Williams', books: { betrivers: -105, bovada: -102 } }));
  const q = qualifyingRows(rows, '2026-10-27', NOW);
  assert.deepEqual(q.map((g) => g.best.id).sort(), ['b', 'f'], 'the 9.5 (better price) leads its group; no head to head at all is fine; a line only BetRivers and Bovada price is not a pick');
  const sexton = q.find((g) => g.playerName === 'Collin Sexton');
  assert.deepEqual(sexton.lines.map((l) => l.id), ['b', 'a'], 'the group keeps every qualifying number, best paying first');
  assert.ok(PICK_BOOKS.includes('draftkings') && !PICK_BOOKS.includes('betrivers'));
  assert.deepEqual(pickQuotes({ quotes: [{ bookKey: 'betrivers', american: 100 }, { bookKey: 'williamhill_us', american: -120 }, { bookKey: 'prizepicks', american: -119 }, { bookKey: 'fanduel', american: -110 }] }).map((x) => x.bookId), ['fanduel', 'prizepicks', 'caesars'], 'Caesars by its feed key, PrizePicks by its own');
});

test('the bet builder: a same-book two-leg parlay nearest +100 first, three legs when that is what fits, straights between -200 and +150 otherwise, two bets at most', () => {
  const q = (rows) => qualifyingRows(rows, '2026-10-27', NOW);
  // Two heavy favourites on DraftKings make a +101 ticket; the third line rides as a straight.
  let bets = buildBets(q([
    row('a', { american: -250, player: 'Collin Sexton', books: { draftkings: -250, fanduel: -240 } }),
    row('b', { american: -230, player: 'LaMelo Ball', books: { draftkings: -230 }, eventId: 'e-2' }),
    row('c', { american: -120, player: 'Miles Bridges', books: { fanduel: -120 } }),
  ]));
  assert.equal(bets.length, 2);
  assert.equal(bets[0].type, 'parlay');
  assert.deepEqual(bets[0].legs.map((l) => `${l.group.playerName}@${l.bookId}`), ['LaMelo Ball@draftkings', 'Collin Sexton@draftkings'], 'legs in rank order: the better price ranks first among equal samples');
  assert.equal(bets[0].american, 101);
  assert.equal(bets[1].type, 'straight');
  assert.equal(bets[1].legs[0].group.playerName, 'Miles Bridges');
  assert.equal(bets[1].american, -120);
  // The parlay picks the number that makes the price: with Ball at -200, the 9.5 at -140 pairs to +157 (out), the 8.5 at -200 to +125, the 7.5 at -300 to +100.
  bets = buildBets(q([
    row('a1', { american: -140, point: 9.5 }), row('a2', { american: -200, point: 8.5 }), row('a3', { american: -300, point: 7.5 }),
    row('b', { american: -200, player: 'LaMelo Ball', eventId: 'e-2' }),
  ]));
  assert.equal(bets.length, 1);
  assert.equal(bets[0].american, 100);
  assert.equal(bets[0].legs.find((l) => l.group.playerName === 'Collin Sexton').line.point, 7.5);
  // Three -300 legs: no pair lands in range (-129), the three together do (+137).
  bets = buildBets(q([
    row('a', { american: -300 }), row('b', { american: -300, player: 'LaMelo Ball', eventId: 'e-2' }), row('c', { american: -300, player: 'Miles Bridges', eventId: 'e-3' }),
  ]));
  assert.equal(bets.length, 1);
  assert.equal(bets[0].legs.length, 3);
  assert.equal(bets[0].american, 137);
  // Legs on different books never share a ticket, a -250 or a +160 is no straight, and a day can come up empty.
  bets = buildBets(q([
    row('a', { american: -250, books: { draftkings: -250 } }), row('b', { american: -230, player: 'LaMelo Ball', books: { fanduel: -230 }, eventId: 'e-2' }), row('c', { american: 160, player: 'Miles Bridges' }),
  ]));
  assert.deepEqual(bets, []);
  bets = buildBets(q([row('a', { american: -180, books: { draftkings: -180 } }), row('b', { american: -230, player: 'LaMelo Ball', books: { fanduel: -230 }, eventId: 'e-2' })]));
  assert.deepEqual(bets.map((b) => [b.type, b.legs[0].group.playerName, b.american]), [['straight', 'Collin Sexton', -180]]);
  assert.equal(PICK_MAX_BETS, 2);
});

test('PrizePicks: never a single pick; two projections from two teams are a 2-pick Power Play at 3x, three make a 3-pick Flex Play at 2.25x', () => {
  const q = (rows) => qualifyingRows(rows, '2026-10-27', NOW);
  // Two Trail Blazers priced only at PrizePicks: no single picks, and one team is not a lineup.
  let bets = buildBets(q([
    row('a', { american: -137, player: 'Jrue Holiday', books: { prizepicks: -137 }, team: 'POR' }),
    row('b', { american: -137, player: 'Robert Williams', books: { prizepicks: -137 }, team: 'POR', eventId: 'e-1' }),
  ]));
  assert.deepEqual(bets, []);
  // Two teams: a 2-pick Power Play, +200 because that is what it pays, the cap notwithstanding.
  bets = buildBets(q([
    row('a', { american: -137, player: 'Jrue Holiday', books: { prizepicks: -137 }, team: 'POR' }),
    row('c', { american: -137, player: 'Derrick White', books: { prizepicks: -137 }, team: 'BOS', eventId: 'e-2' }),
  ]));
  assert.deepEqual(bets.map((b) => [b.type, b.shape, b.american, b.decimal]), [['parlay', 'power2', 200, 3]]);
  // A third projection makes the Flex Play, nearer +100 than the Power Play; the feed's -137 per leg is not the price, the table is.
  bets = buildBets(q([
    row('a', { american: -137, player: 'Jrue Holiday', books: { prizepicks: -137 }, team: 'POR' }),
    row('b', { american: -137, player: 'Robert Williams', books: { prizepicks: -137 }, team: 'POR', eventId: 'e-1' }),
    row('c', { american: -137, player: 'Derrick White', books: { prizepicks: -137 }, team: 'BOS', eventId: 'e-2' }),
  ]));
  assert.equal(bets.length, 1);
  assert.equal(bets[0].shape, 'flex3');
  assert.equal(bets[0].american, 125);
  assert.equal(bets[0].decimal, 2.25);
  assert.deepEqual(bets[0].legs.map((l) => l.group.playerName).sort(), ['Derrick White', 'Jrue Holiday', 'Robert Williams']);
  // A sportsbook parlay nearer +100 beats the lineup; a -1100 line at PrizePicks still counts as a projection.
  bets = buildBets(q([
    row('a', { american: -250, player: 'Jrue Holiday', books: { draftkings: -250, prizepicks: -137 }, team: 'POR' }),
    row('b', { american: -230, player: 'Derrick White', books: { draftkings: -230, prizepicks: -137 }, team: 'BOS', eventId: 'e-2' }),
    row('c', { american: -1100, player: 'Luka Doncic', books: { prizepicks: -1100 }, team: 'LAL', eventId: 'e-3' }),
  ]));
  assert.deepEqual(bets.map((b) => [b.type, b.shape, b.american]), [['parlay', null, 101]]);
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
  // The teammate-out note reads the player's own side: an away player's team is the away side, not the home team's.
  const awayPlayer = row('z', { player: 'Paolo Banchero', team: 'ORL' });
  const awayCtx = async () => ({ home: { name: 'Charlotte Hornets', injuries: [{ name: 'Mark Williams', status: 'Out' }] }, away: { name: 'Orlando Magic', injuries: [{ name: 'Jalen Suggs', status: 'Out' }] }, projection: null });
  const away = await researchPick(awayPlayer, env, ctx, { now: NOW, deps: { minutes: async () => steady, context: awayCtx, model: async () => null } });
  assert.match(away.note, /Jalen Suggs is out/);
  assert.doesNotMatch(away.note, /Mark Williams/);
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

test('the day researches the ranked groups, builds the tickets from the ones that pass, says what passed and why, and is final once anything posts', async () => {
  const { env, store } = makeKvStore();
  const rows = [row('a'), row('b', { player: 'LaMelo Ball', american: -110, h2h: period(null, 0), eventId: 'e-2' }), row('c', { player: 'Miles Bridges', american: -105 }), row('d', { player: 'Brandon Miller', american: -102, eventId: 'e-3' }), row('h', { player: 'Luka Doncic', american: -1100, games: 20, eventId: 'e-4' })];
  const researched = [];
  const deps = {
    rowsFor: async () => rows,
    minutes: async (r) => { researched.push(r.playerName); return r.playerName === 'Miles Bridges' ? [10, 12, 11, ...Array(17).fill(30)] : Array(20).fill(32); },
    context: async () => null,
    model: async () => '{"verdict":"post","reason":"ok","note":"none"}',
  };
  const r = await runTrendPicksDaily(env, ctx, NOW, { deps, enabled: ['basketball_nba'] });
  assert.equal(r.posted, 2);
  assert.equal(r.considered, 5);
  const rec = JSON.parse(store.get('trendpicks:2026-10-27'));
  assert.equal(rec.version, 4);
  assert.equal(rec.usable, 4, 'a line priced -1100 everywhere can sit on no ticket');
  assert.ok(!researched.includes('Luka Doncic'), 'and is not worth a research call');
  // Every pair prices past +150, so the top two ride straight: Miller then Ball; Bridges passes on minutes; Sexton is left over.
  assert.deepEqual(rec.bets.map((b) => [b.type, b.legs[0].playerName, b.american, b.book, b.units, b.stake]), [['straight', 'Brandon Miller', -102, 'DraftKings', 1, UNIT_DOLLARS], ['straight', 'LaMelo Ball', -110, 'DraftKings', 1, UNIT_DOLLARS]]);
  assert.equal(rec.bets[0].link, 'https://draftkings.example/d', 'a straight carries the line\'s deep link');
  assert.deepEqual(rec.passed.map((p) => p.selection), ['Miles Bridges Over 9.5 Pts']);
  assert.match(rec.passed[0].reasons[0], /minutes are down/);
  assert.deepEqual(rec.unused, [{ selection: 'Collin Sexton Over 9.5 Pts', reason: 'two bets a day' }], 'a line that passed but did not fit is listed, not lost');
  assert.equal(rec.final, true);
  assert.equal(rec.bets[0].status, 'pending');
  assert.equal((await runTrendPicksDaily(env, ctx, NOW + 60e3, { deps, enabled: ['basketball_nba'] })).reason, 'posted');

  // A parlay day: two -250s on DraftKings make one ticket at -104, the third line rides straight.
  const parlayDay = makeKvStore();
  const prows = [row('a', { american: -250, books: { draftkings: -250 } }), row('b', { american: -250, player: 'LaMelo Ball', books: { draftkings: -250 }, eventId: 'e-2' }), row('c', { american: -150, player: 'Brandon Miller', books: { fanduel: -150 }, eventId: 'e-3' })];
  await runTrendPicksDaily(parlayDay.env, ctx, NOW, { deps: { ...deps, rowsFor: async () => prows }, enabled: ['basketball_nba'] });
  const prec = JSON.parse(parlayDay.store.get('trendpicks:2026-10-27'));
  assert.deepEqual(prec.bets.map((b) => [b.type, b.legs.map((l) => l.playerName), b.american, b.book]), [['parlay', ['Collin Sexton', 'LaMelo Ball'], -104, 'DraftKings'], ['straight', ['Brandon Miller'], -150, 'FanDuel']]);
  assert.equal(prec.bets[0].link, null, 'a parlay has no single deep link');
  assert.equal(prec.bets[0].bookUrl, 'https://sportsbook.draftkings.com/');

  // A day stored by the older build is drawn again, whatever it said.
  const old = makeKvStore();
  old.store.set('trendpicks:2026-10-27', JSON.stringify({ version: 2, date: '2026-10-27', final: true, checkedAt: NOW, bets: [] }));
  assert.equal((await runTrendPicksDaily(old.env, ctx, NOW + 60e3, { deps, enabled: ['basketball_nba'] })).posted, 2);

  // A day with nothing qualifying is checked again in an hour, not every tick.
  const empty = makeKvStore();
  const none = { ...deps, rowsFor: async () => [row('x', { rate: 0.9 })] };
  assert.equal((await runTrendPicksDaily(empty.env, ctx, NOW, { deps: none, enabled: ['basketball_nba'] })).posted, 0);
  assert.equal((await runTrendPicksDaily(empty.env, ctx, NOW + 10 * 60e3, { deps: none, enabled: ['basketball_nba'] })).reason, 'checked recently');
  assert.equal((await runTrendPicksDaily(empty.env, ctx, NOW + 61 * 60e3, { deps: none, enabled: ['basketball_nba'] })).skipped, false);
});

test('a ticket settles like the book settles it: a lost leg loses it, a pushed or voided leg drops out and it pays at the legs left, nothing left is a push', () => {
  const leg = (result, american) => ({ result, american, decimal: dec(american) });
  assert.equal(settleBet({ units: 1, legs: [leg(null, -250), leg('win', -250)] }), null, 'not until every leg is settled');
  assert.deepEqual(settleBet({ units: 1, legs: [leg('win', -250), leg('win', -250)] }), { result: 'win', net: 0.96 });
  assert.deepEqual(settleBet({ units: 1, legs: [leg('win', -250), leg('loss', -250)] }), { result: 'loss', net: -1 });
  assert.deepEqual(settleBet({ units: 1, legs: [leg('win', -250), leg('push', -250)] }), { result: 'win', net: 0.4 }, 'the push drops out and the ticket pays as a straight');
  assert.deepEqual(settleBet({ units: 1, legs: [leg('void', -250), leg('push', -250)] }), { result: 'push', net: 0 });
  assert.deepEqual(settleBet({ units: 1, legs: [leg('void', -250)] }), { result: 'void', net: 0 });
  assert.deepEqual(settleBet({ units: 1, legs: [leg('loss', -250), leg('void', -250)] }), { result: 'loss', net: -1 });
  assert.deepEqual(settleBet({ units: 1, legs: [leg('win', 100)] }), { result: 'win', net: 1 });
  // PrizePicks 3-pick Flex: 2.25x with three in, 1.25x with two, a loss under that; a DNP drops it to a 2-pick Power Play at 3x.
  const flex = (...results) => ({ units: 1, shape: 'flex3', legs: results.map((r) => leg(r, -137)) });
  assert.deepEqual(settleBet(flex('win', 'win', 'win')), { result: 'win', net: 1.25 });
  assert.deepEqual(settleBet(flex('win', 'win', 'loss')), { result: 'win', net: 0.25 });
  assert.deepEqual(settleBet(flex('win', 'loss', 'loss')), { result: 'loss', net: -1 });
  assert.deepEqual(settleBet(flex('win', 'win', 'void')), { result: 'win', net: 2 });
  assert.deepEqual(settleBet(flex('win', 'loss', 'push')), { result: 'loss', net: -1 });
  assert.deepEqual(settleBet(flex('win', 'void', 'push')), { result: 'push', net: 0 });
  assert.deepEqual(settleBet(flex('void', 'void', 'void')), { result: 'void', net: 0 });
  assert.equal(settleBet(flex('win', null, 'win')), null);
  const power = (...results) => ({ units: 1, shape: 'power2', legs: results.map((r) => leg(r, -137)) });
  assert.deepEqual(settleBet(power('win', 'win')), { result: 'win', net: 2 });
  assert.deepEqual(settleBet(power('win', 'loss')), { result: 'loss', net: -1 });
  assert.deepEqual(settleBet(power('win', 'void')), { result: 'push', net: 0 }, 'a DNP in a 2-pick is a refund');
});

test('bets are graded leg by leg off the game log once the games are over, a no-show voids its leg a day and a half on, and the history carries the record overall and per league', async () => {
  const { env } = makeKvStore();
  const rows = [row('a', { american: -250, books: { draftkings: -250 } }), row('b', { player: 'LaMelo Ball', american: -250, point: 5, side: 'under', statKey: 'assists', books: { draftkings: -250 }, eventId: 'e-2' })];
  const deps = { rowsFor: async () => rows, minutes: async () => Array(20).fill(32), context: async () => null, model: async () => '{"verdict":"post","reason":"ok","note":"none"}' };
  await runTrendPicksDaily(env, ctx, NOW, { deps, enabled: ['basketball_nba'] });
  assert.equal(settle({ point: 9.5, side: 'over' }, 10), 'win');
  assert.equal(settle({ point: 9.5, side: 'over' }, 9), 'loss');
  assert.equal(settle({ point: 5, side: 'under' }, 5), 'push');
  assert.equal(settle({ point: 5, side: 'under' }, 4), 'win');
  const early = await runTrendPicksGrading(env, ctx, NOW + 9 * 3.6e6, { deps: { actual: async () => 12 } });
  assert.equal(early.graded, 0, 'not until three hours after tip-off');
  const later = await runTrendPicksGrading(env, ctx, NOW + 12 * 3.6e6, { deps: { actual: async (p) => (p.playerName === 'Collin Sexton' ? 12 : null) } });
  assert.equal(later.graded, 0, 'one leg in, one still unknown: the ticket waits');
  const voided = await runTrendPicksGrading(env, ctx, NOW + 46 * 3.6e6, { deps: { actual: async () => null } });
  assert.equal(voided.graded, 1, 'the no-show voids his leg and the ticket pays as a straight');
  const all = await getTrendPicks(env, NOW + 46 * 3.6e6);
  assert.equal(all.history.length, 1);
  const bet = all.history[0].bets[0];
  assert.equal(bet.type, 'parlay');
  assert.deepEqual(bet.legs.map((l) => [l.playerName, l.result, l.actual]), [['Collin Sexton', 'win', 12], ['LaMelo Ball', 'void', null]]);
  assert.equal(bet.result, 'win');
  assert.equal(bet.net, 0.4);
  assert.deepEqual(all.record, { wins: 1, losses: 0, pushes: 0, voids: 0, units: 0.4, dollars: 2 });
  assert.deepEqual(all.bySport.basketball_nba, all.record);
  assert.deepEqual(all.bySport.americanfootball_nfl, { wins: 0, losses: 0, pushes: 0, voids: 0, units: 0, dollars: 0 });
  assert.equal(all.unitDollars, UNIT_DOLLARS);
});
