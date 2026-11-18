import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendedParlays, confidenceOf, REC_BUILDER_MAX, REC_LOTTO_MIN, REC_LEG_FLOOR, REC_TYPES } from '../worker/src/ufc-recommended.js';
import { americanToDecimal, decimalToAmerican } from '../docs/engine.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const q = (bookId, american, link = null) => ({ bookId, book: { fanduel: 'FanDuel', draftkings: 'DraftKings', betrivers: 'BetRivers', kalshi: 'Kalshi', engine: 'cappers quote' }[bookId] ?? bookId, american, decimal: americanToDecimal(american), link });
const implied = (a) => 1 / americanToDecimal(a);
let n = 0;
const leg = (bout, prop, side, selection, chance, score, quotes, extra = {}) => ({ id: `${bout}:${prop}:${n++}`, boutId: bout, boutDate: NOW + 36 * 3600e3, order: Number(bout.slice(1)), fight: `${bout}A vs ${bout}B`, prop, label: prop, side, name: side ? `${bout}${side.toUpperCase()}` : null, selection, chance, score, fairAmerican: decimalToAmerican(1 / chance), why: [`${Math.round(chance * 100)}% to win on the market`, 'a reason off the record'], quotes, priced: quotes.length > 0, ...extra });

/** Six fights: a favourite and an underdog priced at two books, a finish prop, a method, and a round-and-method long shot at BetRivers. */
function card() {
  n = 0;
  const legs = []; const breakdowns = {};
  const favs = [[0.76, -320, 250], [0.72, -260, 210], [0.68, -210, 175], [0.62, -165, 140], [0.58, -140, 118], [0.54, -120, 108]];
  favs.forEach(([p, fav, dog], i) => {
    const b = `b${i + 1}`;
    legs.push(leg(b, 'ml', 'a', `${b}A to win`, p, i === 3 ? 4 : 3, [q('fanduel', fav, `https://sportsbook.fanduel.com/addToBetslip?marketId=1.${i}&selectionId=${i}`), q('draftkings', fav - 10), q('kalshi', fav + 15)]));
    legs.push(leg(b, 'ml', 'b', `${b}B to win`, 1 - p, 2, [q('fanduel', dog), q('draftkings', dog - 5)]));
    legs.push(leg(b, 'distance', null, 'Fight does not go the distance', 0.8, 5, [q('betrivers', -150 + i * 10)]));
    legs.push(leg(b, 'method', 'a', `${b}A by KO/TKO`, 0.4, 3, [q('betrivers', 240), q('engine', 150)]));
    legs.push(leg(b, 'method_round', 'a', `${b}A KO/TKO & Round 1`, 0.15, 1, [q('betrivers', 700)], { sprinkle: i < 2 }));
    breakdowns[b] = { a: `${b}A`, b: `${b}B`, boutDate: NOW + 36 * 3600e3, order: i + 1, lean: 'a', confidence: i < 2 ? 4 : 3, parlayPiece: i === 0, reasons: [`${b}A is the sharper striker and has not been finished`], sharp: { plays: [] } };
  });
  return { legs, breakdowns };
}

test('every ticket is one leg a fight, priced, typed by what it pays, with the reasons for each leg', () => {
  const { legs, breakdowns } = card();
  const r = recommendedParlays({ legs, breakdowns, now: NOW });
  assert.ok(r.tickets.length >= 12, `tickets ${r.tickets.length}`);
  assert.equal(new Set(r.tickets.map((t) => t.id)).size, r.tickets.length, 'no ticket twice');
  assert.deepEqual(r.types, REC_TYPES);
  assert.equal(r.counts.builder + r.counts.parlay + r.counts.lotto + r.counts.stat, r.tickets.length);
  assert.ok(r.counts.builder >= 2 && r.counts.parlay >= 3 && r.counts.lotto >= 3, JSON.stringify(r.counts));
  for (const t of r.tickets) {
    assert.ok(t.legs.length >= 2 && t.n === t.legs.length, t.title);
    assert.equal(new Set(t.legs.map((l) => l.boutId)).size, t.legs.length, `${t.title}: one leg a fight`);
    // The type is the payout's: a builder under +160, a lotto past +800.
    assert.equal(t.type, t.decimal < REC_BUILDER_MAX ? 'builder' : t.decimal < REC_LOTTO_MIN ? 'parlay' : 'lotto', `${t.title} ${t.decimal}`);
    // The ticket's chance is its legs' multiplied; its price is theirs multiplied, at the prices shown.
    assert.ok(Math.abs(t.chance - t.legs.reduce((p, l) => p * l.chance, 1)) < 0.002, t.title);
    assert.ok(Math.abs(t.decimal - t.legs.reduce((d, l) => d * americanToDecimal(l.american), 1)) < 0.002, t.title);
    assert.ok(Math.abs(t.american - decimalToAmerican(t.decimal)) <= 1, `${t.american} from ${t.decimal}`);
    assert.ok(Math.abs(t.edge - (t.chance - 1 / t.decimal)) < 0.002);
    assert.ok(t.confidence >= 1 && t.confidence <= 5 && Number.isInteger(t.confidence * 2));
    if (t.oneBook) { assert.ok(t.legs.every((l) => l.bookId === t.bookId), `${t.title}: every leg at the ticket's book`); assert.equal(t.books[0].bookId, t.bookId); assert.ok(t.books.every((b, i) => i === 0 || t.books[i - 1].american >= b.american)); }
    assert.ok(!['kalshi', 'engine'].includes(t.bookId), 'a ticket is never priced at a venue that takes no parlay');
    for (const l of t.legs) {
      assert.ok(Number.isFinite(l.american) && l.american >= REC_LEG_FLOOR && l.bookId !== 'engine', `${t.title}: ${l.selection}`);
      // At least the reason it was picked and the read against the price; then the card's own reasons.
      assert.ok(l.why.length >= 3 && l.why.every((w) => typeof w === 'string' && w.length > 8), JSON.stringify(l.why));
      assert.match(l.why[1], /asks for \d+%/);
      assert.ok(!l.why.some((w) => /^\d+% to win on the market$/.test(w)), 'the line that only repeats the chance is dropped');
    }
    assert.equal(t.sides, t.underdogs ? 'underdogs' : t.favorites ? 'favorites' : 'neither');
  }
});

test('the recipes: the likeliest favourites first, the leans, the live dog, the finishes, the long shots', () => {
  const { legs, breakdowns } = card();
  const r = recommendedParlays({ legs, breakdowns, now: NOW });
  const by = (title) => r.tickets.find((t) => t.title === title);
  const two = by('The two likeliest favourites');
  assert.deepEqual(two.legs.map((l) => l.selection), ['b1A to win', 'b2A to win']);
  assert.deepEqual([two.type, two.style, two.sides, two.bookId, two.oneBook], ['builder', 'ml', 'favorites', 'fanduel', true]);
  assert.deepEqual(two.books.map((b) => b.bookId), ['fanduel', 'draftkings'], 'the same ticket at every book that has both legs, best first; Kalshi takes no parlay');
  assert.equal(two.legs[0].why[0], 'The likeliest favourite on the card');
  assert.match(two.legs[0].why[1], /^76% to win, the market's price blended with Pixel's lean; FanDuel -320 asks for 76%$/);
  assert.ok(two.legs[0].why.includes('b1A is the sharper striker and has not been finished'), 'the read\'s first reason rides with a leg on the lean side');
  assert.equal(two.legs[0].link, 'https://sportsbook.fanduel.com/addToBetslip?marketId=1.0&selectionId=0');
  const leans = by("Pixel's leans");
  assert.deepEqual(leans, undefined, 'the same two legs as the favourites: one ticket, not two');
  const dog = by('Two favourites and a live dog');
  assert.deepEqual([dog.legs.map((l) => l.role), dog.sides, dog.underdogs], [['fav', 'fav', 'dog'], 'underdogs', 1]);
  assert.equal(dog.legs[2].selection, 'b6B to win', 'the underdog with the best chance');
  const fin = by('Three finishes');
  assert.deepEqual([fin.style, fin.sides, fin.bookId], ['props', 'neither', 'betrivers']);
  // A prop counts as halfway between the records and its price.
  const l0 = fin.legs[0]; assert.ok(Math.abs(l0.chance - (0.8 + implied(l0.american)) / 2) < 0.002 && l0.read === 0.8);
  assert.match(l0.why[1], /^80% by the two records; BetRivers [+-]\d+ asks for \d+%; counted here as \d+%, halfway between$/);
  assert.equal(by('Every favourite on the card').legs.length, 6);
  assert.equal(by('Every favourite on the card').type, 'lotto');
  const longs = by('Two round-and-method long shots');
  assert.deepEqual([longs.type, longs.style, longs.legs.map((l) => l.boutId).sort()], ['lotto', 'method', ['b1', 'b2']], 'the sprinkles first');
  const methods = by('Two methods of victory');
  assert.ok(methods.legs.every((l) => l.american === 240 && l.bookId === 'betrivers'), 'the cappers\' quote is a reference, never the price');
});

test('what stays off a ticket: a leg against a pick, a price past the floor, a price well short of the chance, a fight under way', () => {
  const { legs, breakdowns } = card();
  const b1 = legs.find((l) => l.selection === 'b1A to win'); b1.why.push("goes against a Pixel's Pick on the other side");
  legs.find((l) => l.selection === 'b2A to win').quotes = [q('fanduel', -700), q('draftkings', -720)];
  const b3 = legs.find((l) => l.selection === 'b3A to win'); b3.quotes = [q('fanduel', -400)]; // asks 80% of a 68% read
  for (const l of legs) if (l.boutId === 'b4') l.boutDate = NOW - 60e3;
  const r = recommendedParlays({ legs, breakdowns, now: NOW });
  const all = r.tickets.flatMap((t) => t.legs.map((l) => l.selection));
  for (const s of ['b1A to win', 'b2A to win', 'b3A to win']) assert.ok(!all.includes(s), s);
  assert.ok(!r.tickets.some((t) => t.legs.some((l) => l.boutId === 'b4')), 'a fight that has started');
  assert.ok(all.includes('b5A to win'));
  assert.deepEqual(recommendedParlays({ legs: [], breakdowns: {}, now: NOW }).tickets, []);
});

test('the favourite is the side the books price shorter, whatever the read makes of it', () => {
  const { legs, breakdowns } = card();
  // The lean lifts the +118 side of fight five over 50%: still the underdog.
  const dog = legs.find((l) => l.selection === 'b5B to win'); const fav = legs.find((l) => l.selection === 'b5A to win');
  dog.chance = 0.56; fav.chance = 0.44;
  const r = recommendedParlays({ legs, breakdowns, now: NOW });
  const seen = r.tickets.flatMap((t) => t.legs).find((l) => l.selection === 'b5B to win');
  assert.equal(seen.role, 'dog');
  assert.ok(r.tickets.filter((t) => t.sides === 'favorites').every((t) => !t.legs.some((l) => l.selection === 'b5B to win')));
});

test('the stat plays of the Sharp analysis ride as their own tickets, priced only when one book prices every leg', () => {
  const { legs, breakdowns } = card();
  breakdowns.b1.sharp.plays = [{ key: 'strikes', family: 'strikes', side: 'a', market: 'Most significant strikes', selection: 'b1A most significant strikes', strength: 88, why: ['b1A lands 6.1 a minute to 3.2'], note: 'Settles on the official count.' }, { key: 'distance_no', family: 'duration', side: null, market: 'Fight goes the distance', selection: 'Fight does not go the distance', strength: 95, why: ['x'] }];
  breakdowns.b2.sharp.plays = [{ key: 'takedowns_a', family: 'takedowns', side: 'a', market: 'Fighter takedowns', selection: 'b2A over 1.5 takedowns', strength: 76, why: ['b2A lands 4.7 takedowns per 15 minutes'] }];
  breakdowns.b3.sharp.plays = [{ key: 'strikes', family: 'strikes', side: 'b', market: 'Most significant strikes', selection: 'b3B most significant strikes', strength: 66, why: ['b3B lands more'] }];
  let r = recommendedParlays({ legs, breakdowns, now: NOW });
  const stat = r.tickets.filter((t) => t.type === 'stat');
  assert.deepEqual(stat.map((t) => t.title), ['The two strongest stat plays', 'The three strongest stat plays', 'Most significant strikes']);
  assert.deepEqual(stat[0].legs.map((l) => [l.selection, l.score, l.name]), [['b1A most significant strikes', 5, 'b1A'], ['b2A over 1.5 takedowns', 4, 'b2A']], 'the strikes, takedown and knockdown reads; the duration read has its own tickets');
  assert.deepEqual([stat[0].american, stat[0].chance, stat[0].oneBook, stat[0].confidence], [null, null, false, 4.5]);
  assert.deepEqual(stat[0].legs[0].why, ['A Sharp analysis play, strength 88 of 100', 'b1A lands 6.1 a minute to 3.2', 'Settles on the official count.']);
  assert.deepEqual(stat[2].legs.map((l) => l.boutId), ['b1', 'b3']);
  // FanDuel prices both of the first ticket's plays in fight week.
  breakdowns.b1.sharp.plays[0].quote = q('fanduel', -125, 'https://sportsbook.fanduel.com/addToBetslip?marketId=9&selectionId=1');
  breakdowns.b2.sharp.plays[0].quote = q('fanduel', 110);
  r = recommendedParlays({ legs, breakdowns, now: NOW });
  const pricedStat = r.tickets.find((t) => t.title === 'The two strongest stat plays');
  assert.deepEqual([pricedStat.oneBook, pricedStat.bookId, pricedStat.american], [true, 'fanduel', decimalToAmerican(americanToDecimal(-125) * americanToDecimal(110))]);
});

test('confidenceOf: the weakest leg and the average, evenly, less a quarter star a leg past the second', () => {
  assert.equal(confidenceOf([5, 5]), 5);
  assert.equal(confidenceOf([3, 4]), 3.5);
  assert.equal(confidenceOf([5, 5, 5, 5, 5, 5]), 4);
  assert.equal(confidenceOf([1, 1, 1, 1]), 1);
});
