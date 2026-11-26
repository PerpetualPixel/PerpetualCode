/**
 * The results card (worker/src/results-card.js): what a day's and a week's
 * card say, for tennis and the NBA, and the picture — every line in the
 * font the renderer loads, inside the card, and clear of every other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultsCardModel, weeklyCardModel, resultsCardSvg, resultsCardHeight, ballSvg, SPORTS, RESULTS_CARD_W, recordWords, unitsWords } from '../worker/src/results-card.js';
import { textWidth } from '../worker/src/card-svg.js';

const NOW = Date.parse('2026-11-26T11:07:00Z'); // 6:07am ET
const tennis = (over = {}) => ({ id: `t${Math.random()}`, market: 'live_ml', units: 1, american: -150, status: 'graded', result: 'win', profit: 0.67, gradedAt: NOW - 3600e3, ...over });
const nba = (legs, over = {}) => ({ id: `n${Math.random()}`, legs, units: 1, american: 150, status: 'graded', result: 'win', profit: 1.5, gradedAt: NOW - 3600e3, ...over });
const leg = (hit) => ({ player: 'Someone', stat: 'points', point: 10.5, hit });

test('a tennis day: the record with its hit rate, the units with the ROI, the leans off the record; a line a market with the total lit; a dot a play in order', () => {
  const plays = [
    tennis({ profit: 0.67 }), tennis({ result: 'loss', profit: -1 }),
    tennis({ market: 'live_set', profit: 0.5 }), tennis({ market: 'live_set', status: 'void', result: null, profit: 0 }),
    tennis({ market: 'live_set_total', result: 'loss', profit: -1 }),
    tennis({ lean: true, units: 0.5, result: 'loss', profit: -0.5 }), tennis({ lean: true, units: 0.5 }),
  ];
  const m = resultsCardModel('tennis', '2026-11-25', plays, { drawnAt: NOW });
  assert.deepEqual([m.kind, m.sport, m.title, m.when, m.state, m.plays], ['daily', 'tennis', 'DAILY RESULTS', 'WEDNESDAY • NOVEMBER 25', 'final', 5]);
  assert.deepEqual(m.tiles.map((t) => [t.label, t.value, t.sub, t.tone, t.note]), [
    ['RECORD', '2-2-1', '50%', 'flat', '1 void'],
    ['UNITS', '-0.83u', 'ROI -20.7%', 'down', ''],
    ['LEANS', '1-1', '50%', 'flat', 'off record'],
  ]);
  assert.deepEqual(m.sections[0].title, 'BY MARKET');
  assert.deepEqual(m.sections[0].rows.map((r) => [r.label, r.record, r.value, r.tone, r.highlight]), [
    ['Match Winner', '1-1', '-0.33u', 'down', false],
    ['Set Winner', '1-0-1', '+0.50u', 'up', false],
    ['Set Total Games', '0-1', '-1.00u', 'down', false],
    ['All tennis', '2-2-1', '-0.83u', 'down', true],
  ]);
  assert.deepEqual(m.dots, ['win', 'loss', 'win', 'void', 'loss']);
  assert.equal(m.bars, null);
  assert.equal(m.foot, 'Posted Nov 26 • 6:07 AM ET');
  // A day still running says so.
  const live = resultsCardModel('tennis', '2026-11-26', plays.slice(0, 1), { soFar: true, drawnAt: NOW });
  assert.deepEqual([live.state, live.foot, live.sections[0].rows.length], ['live', 'So far Nov 26 • 6:07 AM ET', 2]);
  // Nothing settled: zeros, no rows but the total, no dots.
  const none = resultsCardModel('tennis', '2026-11-25', [], { drawnAt: NOW });
  assert.deepEqual([none.tiles[0].value, none.tiles[1].value, none.tiles[2].sub, none.sections[0].rows.length, none.dots.length], ['0-0', '+0.00u', 'none', 1, 0]);
});

test('an NBA day: the legs that hit as the third tile, a line a slip size, the total lit', () => {
  const plays = [
    nba([leg(true), leg(true)]), nba([leg(true), leg(false), leg(true)], { result: 'loss', profit: -1 }),
    nba([leg(true), leg(true), leg(true), leg(true)], { profit: 3 }), nba([leg(null)], { status: 'void', result: null, profit: 0 }),
  ];
  const m = resultsCardModel('nba', '2026-11-25', plays, { drawnAt: NOW });
  assert.deepEqual([m.sport, m.plays, m.sections[0].title], ['nba', 4, 'BY SLIP']);
  assert.deepEqual(m.tiles.map((t) => [t.label, t.value, t.sub, t.tone]), [
    ['RECORD', '2-1-1', '67%', 'up'],
    ['UNITS', '+3.50u', 'ROI +116.7%', 'up'],
    ['LEGS HIT', '89%', '8 of 9', 'up'],
  ]);
  assert.deepEqual(m.sections[0].rows.map((r) => [r.label, r.record, r.value]), [
    ['Singles', '0-0-1', '+0.00u'],
    ['2-leg slips', '1-0', '+1.50u'],
    ['3-leg slips', '0-1', '-1.00u'],
    ['4+ leg slips', '1-0', '+3.00u'],
    ['All NBA', '2-1-1', '+3.50u'],
  ]);
  assert.equal(recordWords({ wins: 3, losses: 2, voids: 0 }), '3-2');
  assert.equal(unitsWords(-0.005), '-0.01u');
});

test('a week: the totals in the tiles, a line a day with its record (a blank for a day without), the week lit, a bar a day', () => {
  const t = (w, l, u) => ({ wins: w, losses: l, voids: 0, pending: 0, staked: w + l, units: u, roi: u / (w + l) });
  const days = [['2026-11-16', 3, t(2, 1, 1.2)], ['2026-11-17', 0, null], ['2026-11-18', 2, t(0, 2, -2)], ['2026-11-19', 0, null], ['2026-11-20', 0, null], ['2026-11-21', 0, null], ['2026-11-22', 1, t(1, 0, 0.9)]].map(([dateKey, count, tally]) => ({ dateKey, count, tally, leans: null }));
  const m = weeklyCardModel('nba', '2026-11-16', days, { drawnAt: NOW });
  assert.deepEqual([m.kind, m.title, m.when, m.state, m.plays, m.dots], ['weekly', 'WEEKLY RESULTS', 'NOV 16 - NOV 22', 'final', 6, null]);
  assert.deepEqual(m.tiles.map((t) => [t.label, t.value, t.sub, t.note]), [['RECORD', '3-3', '50%', ''], ['UNITS', '+0.10u', 'ROI +1.7%', ''], ['PLAYS', '6', 'best Mon +1.20u', '3 days']]);
  assert.deepEqual(m.sections[0].rows.map((r) => [r.label, r.record, r.value, r.highlight]), [
    ['Mon Nov 16', '2-1', '+1.20u', false], ['Tue Nov 17', '-', '', false], ['Wed Nov 18', '0-2', '-2.00u', false],
    ['Thu Nov 19', '-', '', false], ['Fri Nov 20', '-', '', false], ['Sat Nov 21', '-', '', false], ['Sun Nov 22', '1-0', '+0.90u', false],
    ['All week', '3-3', '+0.10u', true],
  ]);
  assert.deepEqual(m.bars.map((b) => [b.day, b.units, b.played]), [['M', 1.2, true], ['T', 0, false], ['W', -2, true], ['T', 0, false], ['F', 0, false], ['S', 0, false], ['S', 0.9, true]]);
  // A tennis week keeps the leans as its third tile.
  const tw = weeklyCardModel('tennis', '2026-11-16', days.map((d) => ({ ...d, leans: d.tally ? t(1, 0, 0) : null })), { drawnAt: NOW });
  assert.deepEqual([tw.tiles[2].label, tw.tiles[2].value, tw.tiles[2].note], ['LEANS', '3-0', 'off record']);
});

/** Every line of text on the card as a box, measured with the font's own widths (test/discord-cards.test.mjs's). */
function boxes(svg) {
  return [...svg.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)" font-family="([^"]+)" font-size="([\d.]+)" font-weight="(\d+)"[^>]*?>([^]*?)<\/text>/g)].map((m) => {
    const [whole, x, y, family, size, weight, body] = m;
    const words = body.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    const spacing = Number(whole.match(/letter-spacing="([\d.]+)"/)?.[1] ?? 0);
    assert.equal(family, 'Roboto Condensed', 'every line is in the font the card can measure');
    const width = textWidth(words, Number(size), { weight: Number(weight), spacing });
    const left = /text-anchor="middle"/.test(whole) ? Number(x) - width / 2 : /text-anchor="end"/.test(whole) ? Number(x) - width : Number(x);
    return { words, left, right: left + width, top: Number(y) - Number(size) * 0.76, bottom: Number(y) + Number(size) * (/[gjpqy,]/.test(words) ? 0.22 : 0.02), size: Number(size) };
  });
}

test('the picture: the sport named with its ball, every line inside the card and clear of every other, whatever the numbers; the height follows the rows', () => {
  const big = Array.from({ length: 140 }, (_, i) => tennis({ market: ['live_ml', 'live_set', 'live_set_total', 'other'][i % 4], result: i % 3 ? 'win' : 'loss', profit: i % 3 ? 12.34 : -10, units: 10, ...(i % 11 === 0 ? { status: 'void', result: null, profit: 0 } : {}) }));
  const cases = {
    'a tennis day': resultsCardModel('tennis', '2026-11-25', [tennis(), tennis({ result: 'loss', profit: -1 })], { drawnAt: NOW }),
    'a huge tennis day': resultsCardModel('tennis', '2026-09-30', big, { drawnAt: NOW }),
    'an NBA day still running': resultsCardModel('nba', '2026-11-26', [nba([leg(true), leg(true)]), nba([leg(false)], { result: 'loss', profit: -1 }), nba(Array(6).fill(leg(true)), { profit: 123.45, american: 12345 })], { soFar: true, drawnAt: NOW }),
    'an empty day': resultsCardModel('nba', '2026-11-25', [], { drawnAt: NOW }),
    'a week': weeklyCardModel('nba', '2026-11-16', ['16', '17', '18', '19', '20', '21', '22'].map((d, i) => ({ dateKey: `2026-11-${d}`, count: i === 2 ? 0 : 30, tally: i === 2 ? null : { wins: 20, losses: 10, voids: 0, pending: 0, staked: 300, units: i % 2 ? -123.45 : 234.5, roi: 0.5 }, leans: null })), { drawnAt: NOW }),
    'an NFL week': weeklyCardModel('nfl', '2026-11-16', ['16', '17', '18', '19', '20', '21', '22'].map((d) => ({ dateKey: `2026-11-${d}`, count: 0, tally: null, leans: null })), { drawnAt: NOW }),
  };
  for (const [name, model] of Object.entries(cases)) {
    const svg = resultsCardSvg(model, { logo: 'data:image/png;base64,AAAA' });
    const H = resultsCardHeight(model);
    assert.match(svg, new RegExp(`<svg [^>]*width="${RESULTS_CARD_W}" height="${H}"`));
    assert.ok(svg.includes(`>${SPORTS[model.sport].name}</text>`), `${name}: the sport is named`);
    assert.ok(svg.includes(ballSvg(SPORTS[model.sport].ball, 654, 70, 30, SPORTS[model.sport].ink)), `${name}: its ball is drawn`);
    assert.ok(svg.includes('xlink:href="data:image/png;base64,AAAA"'), `${name}: the logo`);
    const all = boxes(svg);
    assert.ok(all.length >= 12, `${name}: the card has its lines`);
    for (const box of all) {
      assert.ok(box.left >= 20 && box.right <= RESULTS_CARD_W - 20, `${name}: "${box.words}" stays inside the card (${Math.round(box.left)} to ${Math.round(box.right)})`);
      assert.ok(box.top >= 20 && box.bottom <= H - 10, `${name}: "${box.words}" stays inside the card, top to bottom (${Math.round(box.top)} to ${Math.round(box.bottom)} of ${H})`);
    }
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const x = all[i]; const y = all[j];
      const across = Math.min(x.right, y.right) - Math.max(x.left, y.left);
      const down = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
      assert.ok(across <= 0 || down <= 0, `${name}: "${x.words}" and "${y.words}" do not overlap`);
    }
    // The dots never run past the card: four rows at most, the rest counted.
    if (model.dots?.length) assert.equal((svg.match(/<rect [^>]*rx="4" fill="#(34D399|F87171|B9B6CF)"/g) ?? []).length, Math.min(model.dots.length, 128));
  }
  assert.ok(resultsCardSvg(cases['a huge tennis day']).includes('12 more'), 'the dots past the fourth row are counted');
  assert.ok(!resultsCardSvg(cases['a tennis day']).includes('<image'), 'without a logo the title stands alone');
  // The three balls are each drawn in their own way.
  assert.ok(ballSvg('tennis', 50, 50, 30, '#fff').includes('Q') && !ballSvg('tennis', 50, 50, 30, '#fff').includes(' H '));
  assert.ok(ballSvg('basketball', 50, 50, 30, '#fff').includes(' H ') && ballSvg('basketball', 50, 50, 30, '#fff').includes(' V '));
  assert.ok(ballSvg('football', 50, 50, 30, '#fff').includes('<ellipse'));
});
