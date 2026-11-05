import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBfoHome, parseBfoEvent, bookIdOf } from '../scripts/ufc-prop-odds.mjs';
import { matchupFor, boardLabelsFor, priceLegsFromBoard, BOARD_NOTE } from '../worker/src/ufc-prop-odds.js';
import { ufcPropLegs, ufcCardProps } from '../worker/src/ufc-props.js';

// The board's markup as BestFightOdds serves it (2026-11-05 read): a header of books, then per matchup the two fighter
// rows and the prop rows, each cell a price keyed by the book's id in data-li.
const th = (id, name) => `<th scope="col" data-b="${id}"><a href="https://link.bestfightodds.com/x">${name}</a><br>&nbsp;</th>`;
const cell = (book, side, mu, price, best = false) => `<td class="but-sgp" data-li="[${book},${side},${mu},174,1]"><span id="oID1" ${best ? 'class="bestbet"' : ''}>${price}</span></td>`;
const mlCell = (book, side, mu, price) => `<td class="but-sg" data-li="[${book},${side},${mu}]"><span id="oID2">${price}</span></td>`;
const fighter = (mu, name, slug, cells) => `<tr ><th scope="row" data-admin-matchup="${mu}"><a href="/fighters/${slug}"><span class="t-b-fcc">${name}</span></a></th>${cells}<td class="button-cell but-al" data-li="[${mu},2]"><svg></svg></td><td class="prop-cell prop-cell-exp" data-mu="${mu}"> 59<span class="exp-ard"></span></td></tr>`;
const prop = (label, cells) => `<tr class="pr"><th scope="row">${label}</th><td></td>${cells}<td class="button-cell but-sip" data-li="[1,1,32,0]"><svg></svg></td><td class="prop-cell"></td></tr>`;
const page = `<html><body><table class="odds-table odds-table-responsive-header"><thead><tr><th scope="col"></th></tr></thead><tbody><tr id="mu-45556"><th scope="row"><a href="/fighters/jonny-parsons-1"><span class="t-b-fcc">Jonny Parsons</span></a></th></tr></tbody></table>
<div class="table-scroller"><table class="odds-table"><thead><tr><th scope="col"></th>${th(28, 'Polymarket')}${th(21, 'FanDuel')}${th(24, 'Caesars')}${th(25, 'BetRivers')}${th(22, 'DraftKings')}<th scope="col" colspan="3" class="table-prop-header">Props</th></tr></thead><tbody>
${fighter(45556, 'Jonny Parsons', 'jonny-parsons-1', mlCell(21, 1, 45556, '+190') + mlCell(22, 1, 45556, '+195'))}
${fighter(45556, 'Jose Henrique', 'jose-henrique-2', mlCell(21, 2, 45556, '-240') + mlCell(22, 2, 45556, '-245'))}
${prop('Over 1&amp;#189; rounds', cell(21, 1, 45556, '-116') + cell(25, 1, 45556, '-115'))}
${prop('Under 1&amp;#189; rounds', cell(21, 2, 45556, '-110'))}
${prop('Fight goes to decision', cell(21, 1, 45556, '+135'))}
${prop('Fight doesn&#039;t go to decision', cell(21, 2, 45556, '-170'))}
${prop('Fight starts round 2', cell(21, 1, 45556, '-290'))}
${prop('Fight won&#039;t start round 2', cell(21, 2, 45556, '+210'))}
${prop('Parsons wins by TKO/KO', cell(21, 1, 45556, '+450'))}
${prop('Any other result', cell(21, 2, 45556, '-650'))}
${prop('Henrique wins by submission', cell(21, 1, 45556, '+320') + cell(22, 1, 45556, '+330', true))}
${prop('Any other result', cell(21, 2, 45556, '-420'))}
${prop('Parsons wins inside distance', cell(21, 1, 45556, '+380'))}
${prop('Not Parsons inside distance', cell(21, 2, 45556, '-520'))}
${prop('Parsons wins by TKO/KO in round 1', cell(21, 1, 45556, '+1100') + cell(25, 1, 45556, '+1200', true))}
${prop('Any other result', cell(21, 2, 45556, '-2500'))}
${prop('Henrique wins in round 2', cell(21, 1, 45556, '+1000'))}
${prop('Fight ends in round 1', cell(21, 1, 45556, '+230'))}
${prop('Either fighter wins by TKO/KO', cell(21, 1, 45556, '-130'))}
${prop('Either fighter wins by submission', cell(21, 1, 45556, '+750'))}
${fighter(45560, 'Tatiana Suarez', 'tatiana-suarez-3', mlCell(21, 1, 45560, '-350'))}
${fighter(45560, 'Virna Jandiroba', 'virna-jandiroba-4', mlCell(21, 2, 45560, '+270'))}
${prop('Suarez wins by decision', cell(21, 1, 45560, '-120'))}
</tbody></table></div></body></html>`;

test('parseBfoHome lists the UFC events in page order, by slug and title', () => {
  const home = `<div class="table-div event-collapsed" id="event4442"><div class="table-header"><a href="/events/efc-139-4442"><h1>EFC 139 Odds</h1></a></div></div>
  <div class="table-div" id="event4439"><div class="table-header"><a href="/events/ufc-vegas-124-4439"><h1>UFC Vegas 124 Odds</h1></a><span class="table-header-date">November 7th</span></div></div>
  <div class="table-div" id="event4440"><div class="table-header"><a href="/events/ufc-334-4440"><h1>UFC 334: Gane vs. Hokit Odds</h1></a></div></div>`;
  assert.deepEqual(parseBfoHome(home), [
    { id: '4439', slug: 'ufc-vegas-124-4439', title: 'UFC Vegas 124', url: 'https://www.bestfightodds.com/events/ufc-vegas-124-4439' },
    { id: '4440', slug: 'ufc-334-4440', title: 'UFC 334: Gane vs. Hokit', url: 'https://www.bestfightodds.com/events/ufc-334-4440' },
  ]);
  assert.deepEqual([bookIdOf('FanDuel'), bookIdOf('Hard Rock'), bookIdOf('ESPN BET'), bookIdOf('BetWay')], ['fanduel', 'hardrock', 'espnbet', 'betway']);
});

test('parseBfoEvent reads the books, the matchups, their moneylines and every prop row with a price per book', () => {
  const board = parseBfoEvent(page, { url: 'https://www.bestfightodds.com/events/ufc-vegas-124-4439' });
  assert.deepEqual(board.books, { polymarket: 'Polymarket', fanduel: 'FanDuel', caesars: 'Caesars', betrivers: 'BetRivers', draftkings: 'DraftKings' });
  assert.equal(board.matchups.length, 2);
  const m = board.matchups[0];
  assert.deepEqual(m.fighters, ['Jonny Parsons', 'Jose Henrique']); assert.equal(m.mu, '45556');
  assert.deepEqual(m.moneyline[0], [{ bookId: 'fanduel', book: 'FanDuel', american: 190 }, { bookId: 'draftkings', book: 'DraftKings', american: 195 }]);
  assert.deepEqual(m.props.find((p) => p.label === 'Over 1.5 rounds').quotes, [{ bookId: 'fanduel', book: 'FanDuel', american: -116 }, { bookId: 'betrivers', book: 'BetRivers', american: -115 }]);
  assert.deepEqual(m.props.find((p) => p.label === "Fight doesn't go to decision").quotes, [{ bookId: 'fanduel', book: 'FanDuel', american: -170 }]);
  assert.deepEqual(m.props.find((p) => p.label === 'Parsons wins by TKO/KO in round 1').quotes.map((q) => q.american), [1100, 1200]);
  assert.equal(board.matchups[1].fighters[0], 'Tatiana Suarez');
});

const f = (id, name) => ({ id, name });
const bout = (id, a, b) => ({ id, a, b, rounds: 3, weightClass: 'Welterweight', date: 1 });
const fighterRec = (wins, { ko = 0, sub = 0, dec = 0, history = [] } = {}) => ({ methods: { wins: { ko, sub, dec, other: 0 }, losses: { ko: 0, sub: 0, dec: 0, other: 0 } }, lastFive: [], history });
const board = { at: 5, source: 'bestfightodds', events: [{ title: 'UFC Vegas 124', url: 'https://www.bestfightodds.com/events/ufc-vegas-124-4439', ...parseBfoEvent(page, { url: 'https://www.bestfightodds.com/events/ufc-vegas-124-4439' }) }] };

test('matchupFor pairs a bout with the board across a different surname spelling (José Souza is "Jose Henrique" on the board)', () => {
  const hit = matchupFor(bout('14', f('a', 'Jonny Parsons'), f('b', 'José Souza')), board);
  assert.ok(hit); assert.equal(hit.matchup.mu, '45556'); assert.equal(hit.aIndex, 0);
  const flipped = matchupFor(bout('14', f('a', 'Jose Henrique Souza'), f('b', 'Jonny Parsons')), board);
  assert.equal(flipped.aIndex, 1, 'the board lists Parsons first; our side a is the second fighter there');
  assert.equal(matchupFor(bout('2', f('a', 'Davey Grant'), f('b', 'Elijah Smith')), board), null, 'a bout the board does not list');
});

test('boardLabelsFor writes each leg in the board\'s wording', () => {
  const names = { aName: 'Jonny Parsons', bName: 'Jose Henrique' };
  assert.deepEqual(boardLabelsFor({ prop: 'rounds', point: 1.5, sideWord: 'over' }, names), ['Over 1.5 rounds']);
  assert.deepEqual(boardLabelsFor({ prop: 'round_start', round: 2, answer: 'no' }, names), ["Fight won't start round 2"]);
  assert.deepEqual(boardLabelsFor({ prop: 'method', side: 'b', method: 'sub' }, names), ['Henrique wins by submission']);
  assert.deepEqual(boardLabelsFor({ prop: 'method_round', side: 'a', method: 'ko', round: 1 }, names), ['Parsons wins by TKO/KO in round 1']);
  assert.deepEqual(boardLabelsFor({ prop: 'double', side: 'a', methods: ['ko', 'sub'] }, names), ['Parsons wins inside distance']);
  assert.deepEqual(boardLabelsFor({ prop: 'end_method', selection: 'How fight will end: Points' }, names), ['Fight goes to decision']);
  assert.equal(boardLabelsFor({ prop: 'special', side: 'a' }, names), null);
});

test('priceLegsFromBoard prices the legs the board lists, best book first, linking to the board; the rest carry the board note', () => {
  const b = bout('14', f('a', 'Jonny Parsons'), f('b', 'José Souza'));
  const profiles = { a: fighterRec(8, { ko: 6, sub: 1, dec: 1, history: [...Array.from({ length: 5 }, () => ({ result: 'win', method: 'KO/TKO', round: 1, time: '2:00' })), { result: 'win', method: 'KO/TKO', round: 2, time: '1:00' }, { result: 'win', method: 'Submission', round: 2, time: '3:00' }, { result: 'win', method: 'Decision', round: 3, time: '5:00' }] }), b: fighterRec(10, { sub: 4, dec: 6, history: [...Array.from({ length: 4 }, () => ({ result: 'win', method: 'Submission', round: 2, time: '2:30' })), ...Array.from({ length: 6 }, () => ({ result: 'win', method: 'Decision', round: 3, time: '5:00' }))] }) };
  const legs = ufcPropLegs(b, { odds: null, breakdown: { lean: 'b', confidence: 3 }, profiles });
  const { legs: priced, matched, priced: n } = priceLegsFromBoard(legs, b, board);
  assert.ok(matched && n >= 6, `priced ${n}`);
  const by = (sel) => priced.find((l) => l.selection === sel);
  const r1 = by('Jonny Parsons KO/TKO & Round 1');
  assert.ok(r1.priced); assert.deepEqual(r1.quotes.map((q) => [q.bookId, q.american, q.source]), [['betrivers', 1200, 'bestfightodds'], ['fanduel', 1100, 'bestfightodds']]);
  assert.equal(r1.quotes[0].link, 'https://www.bestfightodds.com/events/ufc-vegas-124-4439'); assert.equal(r1.note, null);
  assert.ok(by('Jonny Parsons to win').priced && by('Jonny Parsons to win').quotes[0].american === 195, 'the moneyline comes off the fighter row when the feed has none');
  assert.ok(by('José Souza by Submission').priced && by('José Souza by Submission').quotes[0].american === 330);
  assert.ok(by('Over 1.5 rounds').priced);
  assert.ok(by('Fight goes the distance').priced && by('Fight goes the distance').quotes[0].american === 135);
  assert.ok(by('Round 2 to start').priced && by('Fight to start Round 2: No').priced);
  assert.equal(by('How fight will end: KO/TKO').quotes[0].american, -130);
  const special = priced.find((l) => l.prop === 'special');
  assert.ok(special && !special.priced && special.note === BOARD_NOTE, 'a prop the board does not list keeps the note that it is not posted');
  const card = ufcCardProps([b], () => ({ odds: null, breakdown: { lean: 'b', confidence: 3 }, profiles }), { now: 9, board });
  assert.deepEqual([card.board.bouts, card.board.source, card.board.events[0].title], [1, 'bestfightodds', 'UFC Vegas 124']);
  assert.ok(card.board.priced >= 6);
});
