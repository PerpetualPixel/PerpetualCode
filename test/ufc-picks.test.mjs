/**
 * Pixel's Picks for the UFC (worker/src/ufc-picks.js): the odds cadence,
 * matching the feed to a bout, the breakdown parser, the straight's quote,
 * the pick draw with its cap and lock, voids on card changes, and the
 * grading of moneylines and rounds totals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oddsTtlMs, boutOdds, matchSide, parseUfcBreakdown, straightQuote, settleUfcPick, settleUfcTicket, buildUfcParlays, runUfcTick, getUfcPicks, UFC_MAX_PICKS } from '../worker/src/ufc-picks.js';

const NOW = Date.UTC(2026, 9, 30, 18);
const ctx = { waitUntil: (p) => p };
const kv = () => { const m = new Map(); return { env: { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }, ANTHROPIC_API_KEY: null }, store: m }; };
const f = (id, name) => ({ id, name, record: '10-2-0', headshot: null, flag: null, country: 'USA', winner: false });
const bout = (id, a, b, over = {}) => ({ id, order: 1, segment: 'main', weightClass: 'Lightweight', title: false, rounds: 3, date: NOW + 30 * 3600e3, status: 'scheduled', a, b, result: null, ...over });
const feed = (home, away, { h2h = [-150, 130], total = { point: 2.5, over: -110, under: -110 }, book = 'draftkings' } = {}) => ({ id: `f-${home}`, commence: '2026-11-01T00:00:00Z', home, away, bookmakers: [{ key: book, link: null, markets: [
  { key: 'h2h', link: null, outcomes: [{ name: home, price: h2h[0], link: `https://dk/${home}` }, { name: away, price: h2h[1], link: `https://dk/${away}` }] },
  ...(total ? [{ key: 'totals', link: null, outcomes: [{ name: 'Over', point: total.point, price: total.over }, { name: 'Under', point: total.point, price: total.under }] }] : []),
] }] });
const fighter = (id, name, extra = {}) => ({ id, name, record: { wins: 10, losses: 2, draws: 0, nc: 0 }, bio: { age: 29 }, lastFive: ['win', 'win', 'win', 'loss', 'win'], methods: { wins: { ko: 5, sub: 3, dec: 2, other: 0 }, losses: { ko: 1, sub: 0, dec: 1, other: 0 } }, history: [{ date: NOW - 100 * 864e5, opponent: { name: 'Someone' }, result: 'win', method: 'KO/TKO', round: 1 }], ...extra });

test('oddsTtlMs: six hours in the run-up, an hour on fight day, a quarter hour inside two hours of the lock', () => {
  assert.equal(oddsTtlMs(NOW + 5 * 864e5, NOW), 6 * 3600e3);
  assert.equal(oddsTtlMs(NOW + 10 * 3600e3, NOW), 3600e3);
  assert.equal(oddsTtlMs(NOW + 90 * 60e3, NOW), 15 * 60e3);
});

test('boutOdds: the feed event is matched either way round, moneylines by fighter best first, totals by number, only listed books', () => {
  const b = bout('1', f('a1', 'Renato Moicano'), f('b1', 'Tom Nolan'));
  const events = [feed('Tom Nolan', 'Renato Moicano', { h2h: [140, -165] }), { ...feed('Tom Nolan', 'Renato Moicano', { h2h: [150, -170], total: null, book: 'bovada' }), id: 'x' }];
  const o = boutOdds(b, events);
  assert.equal(o.a[0].american, -165, 'Moicano is the away side of the feed event');
  assert.equal(o.b[0].american, 140);
  assert.equal(o.a[0].bookId, 'draftkings');
  assert.deepEqual(o.totals.map((t) => [t.point, t.over[0].american]), [[2.5, -110]]);
  assert.equal(boutOdds(bout('2', f('x', 'Nobody Here'), f('y', 'Else Where')), events), null);
});

test('parseUfcBreakdown: the lean, the confidence and the straight, with a and b either case; prose is null', () => {
  const b = bout('1', f('a1', 'A One'), f('b1', 'B Two'));
  const o = parseUfcBreakdown('{"lean":"b","confidence":4,"straight":{"market":"h2h","fighter":"b"},"parlayPiece":true,"summary":" B is live. ","reasons":["x"]}', b);
  assert.equal(o.lean, 'b'); assert.equal(o.leanName, 'B Two'); assert.equal(o.confidence, 4); assert.deepEqual(o.straight, { market: 'h2h', fighter: 'b' }); assert.equal(o.parlayPiece, true); assert.equal(o.summary, 'B is live.');
  const t = parseUfcBreakdown('{"lean": "A", "confidence": 7, "straight": {"market": "totals", "side": "Under", "point": "2.5"}}', b);
  assert.equal(t.lean, 'a', 'upper case with spaces, as the model writes it');
  assert.equal(parseUfcBreakdown('{"lean": "B", "confidence": 4, "straight": {"market": "h2h", "fighter": "B"}}', b).straight.fighter, 'b');
  assert.equal(t.confidence, 5); assert.deepEqual(t.straight, { market: 'totals', side: 'under', point: 2.5 });
  assert.equal(parseUfcBreakdown('no idea', b), null);
  assert.equal(parseUfcBreakdown('{"lean":"c","confidence":3}', b), null);
});

test('straightQuote: the moneyline on the chosen side, or the total at the posted number', () => {
  const b = bout('1', f('a1', 'A One'), f('b1', 'B Two'));
  const o = boutOdds(b, [feed('A One', 'B Two', { h2h: [-180, 150] })]);
  assert.deepEqual([straightQuote(b, { straight: { market: 'h2h', fighter: 'a' } }, o).american, straightQuote(b, { straight: { market: 'h2h', fighter: 'a' } }, o).selection], [-180, 'A One to win']);
  const u = straightQuote(b, { straight: { market: 'totals', side: 'under', point: 2.5 } }, o);
  assert.equal(u.selection, 'Under 2.5 rounds'); assert.equal(u.point, 2.5);
  assert.equal(straightQuote(b, { straight: { market: 'totals', side: 'over', point: 1.5 } }, o).point, 2.5, 'a number the books do not post falls to the posted one');
});

test('settleUfcPick: the moneyline on the winner, void on a draw or a scrapped bout; the total on the finish time, a decision being the distance', () => {
  const a = f('a1', 'A One'); const b = f('b1', 'B Two');
  const ml = { decimal: 1.5, units: 1, legs: [{ market: 'h2h', fighterId: 'a1', rounds: 3 }] };
  assert.deepEqual(settleUfcPick(ml, bout('1', a, b, { status: 'final', result: { winnerId: 'a1', method: 'KO/TKO', round: 2, time: '1:10' } })), { result: 'win', net: 0.5, actual: 'A One by KO/TKO R2' });
  assert.equal(settleUfcPick(ml, bout('1', a, b, { status: 'final', result: { winnerId: 'b1', method: 'Decision', round: 3, time: '5:00' } })).result, 'loss');
  assert.equal(settleUfcPick(ml, bout('1', a, b, { status: 'final', result: { winnerId: null, draw: true, method: 'Draw' } })).result, 'void');
  assert.equal(settleUfcPick(ml, bout('1', a, b, { status: 'cancelled' })).result, 'void');
  assert.equal(settleUfcPick(ml, bout('1', a, b)), null, 'not in yet');
  const over = { decimal: 1.91, units: 1, legs: [{ market: 'totals', side: 'over', point: 2.5, rounds: 3 }] };
  assert.equal(settleUfcPick(over, bout('1', a, b, { status: 'final', result: { winnerId: 'a1', method: 'Submission', round: 3, time: '2:31' } })).result, 'win', '2:31 of round 3 is past 2.5');
  assert.equal(settleUfcPick(over, bout('1', a, b, { status: 'final', result: { winnerId: 'a1', method: 'KO/TKO', round: 3, time: '2:29' } })).result, 'loss');
  assert.equal(settleUfcPick(over, bout('1', a, b, { status: 'final', result: { winnerId: 'a1', method: 'KO/TKO', round: 3, time: '2:30' } })).result, 'push');
  assert.equal(settleUfcPick(over, bout('1', a, b, { status: 'final', result: { winnerId: 'b1', method: 'Decision (unanimous)', round: 3, time: '5:00' } })).result, 'win', 'the distance');
  assert.equal(settleUfcPick({ ...over, legs: [{ ...over.legs[0], side: 'under' }] }, bout('1', a, b, { status: 'final', result: { winnerId: 'a1', method: 'KO/TKO', round: 1, time: '0:45' } })).result, 'win');
});

test('runUfcTick: picks post at confidence 4 or better inside the price range, at most six, one per bout, follow the price, void on a replacement, grade on the result, and lock at the first bout', async () => {
  const { env, store } = kv();
  const fighters = { a1: fighter('a1', 'A One'), b1: fighter('b1', 'B Two'), a2: fighter('a2', 'C Three'), b2: fighter('b2', 'D Four'), a3: fighter('a3', 'E Five'), b3: fighter('b3', 'F Six') };
  const event = { id: 'ev', name: 'UFC Test', date: NOW + 30 * 3600e3, status: 'upcoming', changes: [], bouts: [
    bout('1', f('a1', 'A One'), f('b1', 'B Two')),
    bout('2', f('a2', 'C Three'), f('b2', 'D Four')),
    bout('3', f('a3', 'E Five'), f('b3', 'F Six')),
  ] };
  const odds = [feed('A One', 'B Two', { h2h: [-150, 130] }), feed('C Three', 'D Four', { h2h: [-400, 300] }), feed('E Five', 'F Six', { h2h: [-120, 100] })];
  const reads = { 1: '{"lean":"a","confidence":5,"straight":{"market":"h2h","fighter":"a"},"parlayPiece":true,"summary":"A.","reasons":[]}', 2: '{"lean":"a","confidence":5,"straight":{"market":"h2h","fighter":"a"},"parlayPiece":true,"summary":"C.","reasons":[]}', 3: '{"lean":"b","confidence":3,"straight":{"market":"totals","side":"over","point":2.5},"parlayPiece":false,"summary":"E.","reasons":[]}' };
  let which = 0;
  const deps = { events: async () => ({ events: [{ id: 'ev', date: event.date, status: event.status }] }), event: async () => event, odds: async () => odds, fighter: async (id) => fighters[id], model: async (prompt) => reads[/UFC Test: Lightweight/.test(prompt) ? (++which) : 1] };
  const r = await runUfcTick(env, ctx, NOW, { deps });
  assert.equal(r.posted, 1, 'A One at -150 posts; C Three at -400 is outside the range; E Five reads 3');
  let rec = JSON.parse(store.get('ufc:picks:ev'));
  assert.deepEqual(rec.bets.map((b) => [b.boutId, b.legs[0].selection, b.american, b.book]), [['1', 'A One to win', -150, 'DraftKings']]);
  assert.deepEqual(rec.passed.map((p) => [p.boutId, p.reason]), [['2', 'no usable price at your books'], ['3', 'confidence 3 of 5']]);
  assert.equal(Object.keys(rec.breakdowns).length, 3);
  assert.equal(JSON.parse(store.get('ufc:picks:index')).cards[0].id, 'ev');
  // The price moves and the same selection posts: the pick follows.
  odds[0] = feed('A One', 'B Two', { h2h: [-160, 135] });
  store.delete('ufc:odds');
  await runUfcTick(env, ctx, NOW + 60e3, { deps });
  rec = JSON.parse(store.get('ufc:picks:ev'));
  assert.equal(rec.bets[0].american, -160);
  // B Two is replaced: the pick voids and the bout reads again.
  event.bouts[0] = bout('1', f('a1', 'A One'), f('b9', 'Z Nine'));
  fighters.b9 = fighter('b9', 'Z Nine');
  odds[0] = feed('A One', 'Z Nine', { h2h: [-130, 110] });
  reads[1] = '{"lean":"a","confidence":4,"straight":{"market":"h2h","fighter":"a"},"parlayPiece":false,"summary":"A again.","reasons":[]}';
  which = 0;
  store.delete('ufc:odds');
  const r2 = await runUfcTick(env, ctx, NOW + 120e3, { deps });
  rec = JSON.parse(store.get('ufc:picks:ev'));
  assert.equal(rec.bets[0].status, 'void'); assert.equal(rec.bets[0].voidReason, 'a fighter was replaced');
  assert.equal(r2.voided.length, 1, 'the tick names the voided pick for the change email');
  assert.equal(r2.posted, 1, 'the new pairing posts on its fresh read');
  assert.equal(rec.bets[1].american, -130);
  // After the lock nothing new posts; a finished bout grades.
  event.bouts[0] = { ...event.bouts[0], status: 'final', result: { winnerId: 'a1', method: 'KO/TKO', round: 1, time: '2:00' } };
  const r3 = await runUfcTick(env, ctx, event.date + 3600e3, { deps });
  assert.equal(r3.locked, true); assert.equal(r3.posted, 0); assert.equal(r3.graded, 1);
  rec = JSON.parse(store.get('ufc:picks:ev'));
  assert.equal(rec.bets[1].result, 'win');
  const all = await getUfcPicks(env, event.date + 3600e3);
  assert.equal(all.record.wins, 1); assert.equal(all.record.voids, 1); assert.equal(all.history.length, 1);
  assert.ok(UFC_MAX_PICKS === 6);
});

test('a rounds-total pick stays on its number: the price follows at the same number, a moved number only warns, and the warning clears when the number is back', async () => {
  const { env, store } = kv();
  const fighters = { a1: fighter('a1', 'A One'), b1: fighter('b1', 'B Two') };
  const event = { id: 'ev2', name: 'UFC Totals', date: NOW + 30 * 3600e3, status: 'upcoming', changes: [], bouts: [bout('1', f('a1', 'A One'), f('b1', 'B Two'))] };
  const odds = [feed('A One', 'B Two', { h2h: [-150, 130], total: { point: 2.5, over: -120, under: 100 } })];
  const deps = { events: async () => ({ events: [{ id: 'ev2', date: event.date, status: 'upcoming' }] }), event: async () => event, odds: async () => odds, fighter: async (id) => fighters[id], model: async () => '{"lean":"a","confidence":4,"straight":{"market":"totals","side":"under","point":2.5},"parlayPiece":false,"summary":"Short night.","reasons":[]}' };
  await runUfcTick(env, ctx, NOW, { deps });
  let rec = JSON.parse(store.get('ufc:picks:ev2'));
  assert.deepEqual([rec.bets[0].legs[0].selection, rec.bets[0].american], ['Under 2.5 rounds', 100]);
  odds[0] = feed('A One', 'B Two', { total: { point: 2.5, over: -130, under: 110 } }); store.delete('ufc:odds');
  await runUfcTick(env, ctx, NOW + 60e3, { deps });
  rec = JSON.parse(store.get('ufc:picks:ev2'));
  assert.equal(rec.bets[0].american, 110, 'same number: the price follows');
  odds[0] = feed('A One', 'B Two', { total: { point: 1.5, over: -110, under: -110 } }); store.delete('ufc:odds');
  await runUfcTick(env, ctx, NOW + 120e3, { deps });
  rec = JSON.parse(store.get('ufc:picks:ev2'));
  assert.equal(rec.bets[0].american, 110, 'a moved number never moves the pick');
  assert.equal(rec.bets[0].legs[0].point, 2.5);
  assert.match(rec.bets[0].warning, /now posts 1\.5 rounds; the pick stays on the 2\.5/);
  odds[0] = feed('A One', 'B Two', { total: { point: 2.5, over: -120, under: 100 } }); store.delete('ufc:odds');
  await runUfcTick(env, ctx, NOW + 180e3, { deps });
  rec = JSON.parse(store.get('ufc:picks:ev2'));
  assert.equal(rec.bets[0].warning, null);
  assert.equal(rec.bets[0].american, 100);
});

test('settleUfcTicket: a lost leg loses, a voided leg drops out and the ticket pays at the legs left, all void is void', () => {
  const leg = (result, american) => ({ result, american, decimal: american > 0 ? 1 + american / 100 : 1 + 100 / -american });
  assert.deepEqual(settleUfcTicket({ units: 1, legs: [leg('win', -300), leg('win', -250)] }), { result: 'win', net: 0.87 });
  assert.deepEqual(settleUfcTicket({ units: 1, legs: [leg('win', -300), leg('loss', -250)] }), { result: 'loss', net: -1 });
  assert.deepEqual(settleUfcTicket({ units: 1, legs: [leg('win', -300), leg('void', -250)] }), { result: 'win', net: 0.33 });
  assert.deepEqual(settleUfcTicket({ units: 1, legs: [leg('void', -300), leg('void', -250)] }), { result: 'void', net: 0 });
  assert.equal(settleUfcTicket({ units: 1, legs: [leg('win', -300), leg(null, -250)] }), null);
});

test('buildUfcParlays: the pieces pair up at one book nearest +100, two or three legs, no bout on two tickets, under the cap', () => {
  const piece = (id, name, other, prices) => ({ bout: bout(id, f(`${id}a`, name), f(`${id}b`, other)), breakdown: { lean: 'a', confidence: 5, parlayPiece: true, summary: 's' }, odds: boutOdds(bout(id, f(`${id}a`, name), f(`${id}b`, other)), [feed(name, other, { h2h: prices, total: null }), { ...feed(name, other, { h2h: [prices[0] - 10, prices[1]], total: null, book: 'fanduel' }), id: 'fd' }]) });
  const pieces = [piece('1', 'Heavy One', 'Dog One', [-300, 240]), piece('2', 'Heavy Two', 'Dog Two', [-250, 200]), piece('3', 'Heavy Three', 'Dog Three', [-280, 220]), piece('4', 'Heavy Four', 'Dog Four', [-110, -110])];
  const out = buildUfcParlays(pieces, { open: 6 });
  assert.ok(out.length >= 1);
  const first = out[0];
  assert.ok(first.american >= -150 && first.american <= 150, String(first.american));
  const bouts = out.flatMap((c) => c.legs.map((l) => l.bout.id));
  assert.equal(new Set(bouts).size, bouts.length, 'no bout twice');
  assert.ok(out.every((c) => c.legs.every((l) => l.bookId === c.bookId)), 'one book per ticket');
  assert.deepEqual(buildUfcParlays(pieces.slice(0, 1)), [], 'one piece makes no parlay');
  assert.equal(buildUfcParlays(pieces, { open: 1 }).length, 1);
});

test('runUfcTick: two heavy favourites the straights cannot take ride as one parlay under the cap, and a replaced leg drops out of it', async () => {
  const { env, store } = kv();
  const fighters = { a1: fighter('a1', 'Heavy One'), b1: fighter('b1', 'Dog One'), a2: fighter('a2', 'Heavy Two'), b2: fighter('b2', 'Dog Two') };
  const event = { id: 'ev3', name: 'UFC Parlay', date: NOW + 30 * 3600e3, status: 'upcoming', changes: [], bouts: [bout('1', f('a1', 'Heavy One'), f('b1', 'Dog One')), bout('2', f('a2', 'Heavy Two'), f('b2', 'Dog Two'))] };
  const odds = [feed('Heavy One', 'Dog One', { h2h: [-300, 240], total: null }), feed('Heavy Two', 'Dog Two', { h2h: [-250, 200], total: null })];
  const deps = { events: async () => ({ events: [{ id: 'ev3', date: event.date, status: 'upcoming' }] }), event: async () => event, odds: async () => odds, fighter: async (id) => fighters[id], model: async () => '{"lean":"a","confidence":5,"straight":{"market":"h2h","fighter":"a"},"parlayPiece":true,"summary":"Heavy.","reasons":[]}' };
  const r = await runUfcTick(env, ctx, NOW, { deps });
  assert.equal(r.posted, 1);
  let rec = JSON.parse(store.get('ufc:picks:ev3'));
  assert.equal(rec.bets[0].type, 'parlay');
  assert.deepEqual(rec.bets[0].legs.map((l) => l.selection), ['Heavy One to win', 'Heavy Two to win']);
  assert.equal(rec.bets[0].american, -115, '1.333 x 1.4 = 1.867, which is -115');
  // Dog Two is replaced: that leg drops out and the ticket rides on Heavy One alone at -300.
  event.bouts[1] = bout('2', f('a2', 'Heavy Two'), f('b9', 'New Dog'));
  fighters.b9 = fighter('b9', 'New Dog');
  odds[1] = feed('Heavy Two', 'New Dog', { h2h: [-200, 170], total: null });
  store.delete('ufc:odds');
  const r2 = await runUfcTick(env, ctx, NOW + 60e3, { deps });
  rec = JSON.parse(store.get('ufc:picks:ev3'));
  assert.equal(rec.bets[0].status, 'pending');
  assert.equal(rec.bets[0].legs[1].result, 'void');
  assert.equal(rec.bets[0].american, -300);
  assert.equal(r2.voided.length, 1, 'the change email names the dropped leg');
  // Both in: the surviving leg wins, the ticket pays at -300.
  event.bouts[0] = { ...event.bouts[0], status: 'final', result: { winnerId: 'a1', method: 'Decision', round: 3, time: '5:00' } };
  event.bouts[1] = { ...event.bouts[1], status: 'final', result: { winnerId: 'b9', method: 'KO/TKO', round: 1, time: '1:00' } };
  await runUfcTick(env, ctx, event.date + 3600e3, { deps });
  rec = JSON.parse(store.get('ufc:picks:ev3'));
  assert.deepEqual([rec.bets[0].result, rec.bets[0].net], ['win', 0.33]);
});

test('matchSide: two fighters sharing a surname each get their own outcome; a name fitting both sides equally is left out', () => {
  assert.equal(matchSide('yana santos', 'yana santos', 'luana santos'), 'a');
  assert.equal(matchSide('luana santos', 'yana santos', 'luana santos'), 'b');
  assert.equal(matchSide('l santos', 'yana santos', 'luana santos'), null);
  assert.equal(matchSide('tom nolan', 'renato moicano', 'tom nolan'), 'b');
  assert.equal(matchSide('josh silveira', 'joshua silveira', 'mick jones'), 'a');
  const o = boutOdds(bout('s', f('a', 'Yana Santos'), f('b', 'Luana Santos')), [feed('Yana Santos', 'Luana Santos', { h2h: [260, -320], total: null })]);
  assert.deepEqual([o.a[0].american, o.b[0].american], [260, -320]);
});
