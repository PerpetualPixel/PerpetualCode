/**
 * The winners' collage (worker/src/wins-collage.js): which wins the model keeps and in what order, the two-across
 * layout, each card set inside the picture with ids of its own, and the SVG's bounds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winsCollageModel, winsLayout, winsCollageHeight, winsCollageSvg, nestCard, cardHeightOf, isWin, WINS_MAX, WINS_COLLAGE_W, COLS } from '../worker/src/wins-collage.js';
import { CARD_H, slipCardHeight } from '../worker/src/card-svg.js';

const NOW = Date.parse('2026-11-28T11:07:00Z');
const tennis = (over = {}) => ({ id: `atp:${Math.random()}`, matchId: 'atp:1', tour: 'atp', event: 'Nitto ATP Finals', a: 'Jannik Sinner', b: 'Carlos Alcaraz', market: 'live_ml', side: 'a', american: -175, bookId: 'fanduel', book: 'FanDuel', units: 1, selection: 'Jannik Sinner to win the match (live)', postedAt: NOW - 8 * 3600e3, status: 'graded', result: 'win', actual: '6-4 6-4', profit: 0.57, gradedAt: NOW - 7 * 3600e3, ...over });
const slip = (legs, over = {}) => ({ id: `g1:fanduel:${Math.random()}`, gameId: 'g1', game: 'New York Knicks at Boston Celtics', league: 'nba', bookId: 'fanduel', book: 'FanDuel', american: 105, decimal: 2.05, units: 1, postedAt: NOW - 9 * 3600e3,
  legs: Array.from({ length: legs }, (_, i) => ({ player: `Player ${i + 1}`, stat: 'points', label: 'Pts', point: 19.5, final: 27, hit: true })),
  status: 'graded', result: 'win', profit: 1.05, finalScore: { NY: 110, BOS: 104 }, gradedAt: NOW - 6 * 3600e3, ...over });

test('the model keeps the wins alone, the biggest first, counts them by sport and sums their units; the cards drawn are capped', () => {
  const entries = [
    { sport: 'tennis', play: tennis({ id: 't-small', profit: 0.4, gradedAt: NOW - 5 * 3600e3 }) },
    { sport: 'tennis', play: tennis({ id: 't-lost', result: 'loss', profit: -1 }) },
    { sport: 'tennis', play: tennis({ id: 't-void', status: 'void', result: 'void', profit: 0 }) },
    { sport: 'tennis', play: tennis({ id: 't-open', status: 'pending', result: null }) },
    { sport: 'nba', play: slip(3, { id: 'n-big', profit: 2.4 }) },
    { sport: 'nfl', play: slip(2, { id: 'f-mid', league: 'nfl', profit: 1.1 }) },
    { sport: 'tennis', play: tennis({ id: 't-same', profit: 0.4, gradedAt: NOW - 7 * 3600e3 }) },
    { sport: 'mma', play: tennis({ id: 'x', profit: 9 }) },
  ];
  const m = winsCollageModel('2026-11-27', entries, { drawnAt: NOW });
  assert.deepEqual([m.kind, m.title, m.when, m.count, m.units, m.more], ['wins', 'WINNERS', 'FRIDAY • NOVEMBER 27', 4, 3.3, 0]);
  assert.deepEqual(m.shown.map((e) => e.play.id), ['n-big', 'f-mid', 't-same', 't-small'], 'units made, then the earlier settled');
  assert.deepEqual(m.bySport, { tennis: 2, nba: 1, nfl: 1 });
  assert.equal(m.foot, 'Posted Nov 28 • 6:07 AM ET');
  assert.equal(m.net, 3.3, 'the net counts the loss; the void adds nothing');
  assert.deepEqual([isWin(tennis()), isWin(tennis({ result: 'loss' })), isWin(tennis({ status: 'pending', result: 'win' }))], [true, false, false]);

  const many = winsCollageModel('2026-11-27', Array.from({ length: 20 }, (_, i) => ({ sport: 'nba', play: slip(2, { id: `n${i}`, profit: 1 + i / 100 }) })), { drawnAt: NOW });
  assert.deepEqual([many.count, many.shown.length, many.more], [20, WINS_MAX, 20 - WINS_MAX]);
  assert.equal(many.shown[0].play.id, 'n19');
  const none = winsCollageModel('2026-11-27', [{ sport: 'tennis', play: tennis({ result: 'loss', profit: -1 }) }], { drawnAt: NOW });
  assert.deepEqual([none.count, none.shown.length, none.units, none.net], [0, 0, null, -1], 'a day that is down shows no units');
  const flat = winsCollageModel('2026-11-27', [{ sport: 'tennis', play: tennis({ profit: 1 }) }, { sport: 'tennis', play: tennis({ result: 'loss', profit: -1 }) }], { drawnAt: NOW });
  assert.deepEqual([flat.count, flat.units, flat.net], [1, null, 0], 'nor does a day that is level');
});

test('the layout sets the cards two across, a row as tall as its taller card, and the height follows', () => {
  const m = winsCollageModel('2026-11-27', [
    { sport: 'tennis', play: tennis({ id: 'a', profit: 3 }) }, { sport: 'nba', play: slip(4, { id: 'b', profit: 2 }) }, { sport: 'nba', play: slip(2, { id: 'c', profit: 1 }) },
  ], { drawnAt: NOW });
  const { cells, height } = winsLayout(m);
  assert.equal(cells.length, 3);
  assert.deepEqual(cells.map((c) => c.entry.play.id), ['a', 'b', 'c']);
  assert.equal(cells[0].y, cells[1].y, 'the first two share a row');
  assert.notEqual(cells[0].x, cells[1].x);
  assert.equal(cells[2].x, cells[0].x, 'the third starts the next row at the left');
  assert.equal(cells[2].y, cells[0].y + slipCardHeight(4) + 24, 'the row is as tall as the four-leg slip');
  assert.deepEqual([cardHeightOf(cells[0].entry), cardHeightOf(cells[1].entry)], [CARD_H, slipCardHeight(4)]);
  assert.equal(height, winsCollageHeight(m));
  assert.equal(height, cells[2].y + slipCardHeight(2) + 24 + 64);
  assert.equal(COLS, 2);
  assert.ok(winsCollageHeight(winsCollageModel('2026-11-27', [], { drawnAt: NOW })) > 0, 'an empty day still has a height');
});

test('a card is nested as a group with its ids made its own, so two cards never share a gradient', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="424" viewBox="0 0 720 424"><defs><linearGradient id="card"/><clipPath id="edge"/></defs><rect fill="url(#card)" clip-path="url(#edge)"/><use href="#card"/></svg>';
  const g = nestCard(svg, 3, 100, 200);
  assert.ok(g.startsWith('<g transform="translate(100 200)">') && g.endsWith('</g>'));
  assert.doesNotMatch(g, /<svg|<\/svg>/);
  assert.match(g, /id="w3-card"/);
  assert.match(g, /url\(#w3-card\)/);
  assert.match(g, /url\(#w3-edge\)/);
  assert.match(g, /href="#w3-card"/);
  assert.doesNotMatch(g, /id="card"|url\(#card\)/);
});

test('the SVG: one group a card, every id unique, every reference answered, and the picture the size the model says', () => {
  const entries = [
    { sport: 'tennis', play: tennis({ id: 'a', profit: 0.57 }) },
    { sport: 'tennis', play: tennis({ id: 'lean', lean: true, american: undefined, playable: -186, units: 0.5, selection: 'Carlos Alcaraz to win set 2', market: 'live_set', set: 2, profit: 0.27 }) },
    { sport: 'nba', play: slip(3, { id: 'b', profit: 2.1 }) },
    { sport: 'nfl', play: slip(2, { id: 'c', league: 'nfl', game: 'Dallas Cowboys at Philadelphia Eagles', profit: 1.1 }) },
    { sport: 'nba', play: slip(9, { id: 'd', profit: 5 }) },
  ];
  const m = winsCollageModel('2026-11-27', entries, { drawnAt: NOW });
  const svg = winsCollageSvg(m, { logo: 'data:image/png;base64,AAAA' });
  assert.match(svg, new RegExp(`^<svg [^>]*width="${WINS_COLLAGE_W}" height="${winsCollageHeight(m)}"`));
  assert.equal((svg.match(/<g transform="translate\(/g) ?? []).length, 5, 'a group a card');
  const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]);
  assert.equal(new Set(ids).size, ids.length, 'no id twice');
  for (const [, ref] of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(ref), `url(#${ref}) is defined`);
  for (const [, ref] of svg.matchAll(/\bhref="#([^"]+)"/g)) assert.ok(ids.includes(ref), `href="#${ref}" is defined`);
  assert.match(svg, />5 WINS</);
  assert.match(svg, /font-size="30" font-weight="700" fill="#10B981" text-anchor="end">\+9\.04u</, 'the net, when the day is up');
  const down = winsCollageModel('2026-11-27', [...entries, { sport: 'nba', play: slip(2, { id: 'bust', result: 'loss', profit: -20 }) }], { drawnAt: NOW });
  assert.deepEqual([down.count, down.units, down.net], [5, null, -10.96]);
  assert.doesNotMatch(winsCollageSvg(down), /font-size="30" font-weight="700" fill="#10B981"/, 'a day that is down shows the winners and no units');
  assert.match(svg, />TENNIS 2</); assert.match(svg, />NBA 2</); assert.match(svg, />NFL 1</);
  assert.match(svg, />FRIDAY • NOVEMBER 27</);
  assert.match(svg, />perpetualpicks\.com</);
  assert.equal((svg.match(/<image /g) ?? []).length, 1 + 5, 'the logo in the head and on each card');
  // Every card sits inside the picture.
  for (const c of winsLayout(m).cells) assert.ok(c.x >= 0 && c.x + c.w <= WINS_COLLAGE_W && c.y + c.h <= winsCollageHeight(m));
  // More wins than are drawn: said in the foot.
  const many = winsCollageModel('2026-11-27', Array.from({ length: 14 }, (_, i) => ({ sport: 'nba', play: slip(2, { id: `n${i}` }) })), { drawnAt: NOW });
  assert.match(winsCollageSvg(many), /\+2 more wins not shown/);
  assert.equal((winsCollageSvg(many).match(/<g transform="translate\(/g) ?? []).length, WINS_MAX);
  // Nothing won: the picture says so rather than standing empty.
  assert.match(winsCollageSvg(winsCollageModel('2026-11-27', [], { drawnAt: NOW })), /No winners today\./);
  assert.match(winsCollageSvg(winsCollageModel('2026-11-27', entries.slice(0, 1), { drawnAt: NOW })), />1 WIN</);
});
