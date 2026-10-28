/**
 * The Parlay Builder: the leg score the app ranks legs by, the ticket
 * price (a sportsbook parlay multiplies, PrizePicks pays its Power Play
 * table), and the worker's breakdown of one leg (worker/src/parlay-builder.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legScore, parlayDecimal, PICKEM_POWER } from '../docs/trends.js';
import { legBreakdown, parseBreakdown } from '../worker/src/parlay-builder.js';

const period = (hits, games, extra = {}) => ({ hits, games, rate: games ? hits / games : null, ...extra });
const row = (over = {}) => ({
  id: 'r1', sportKey: 'basketball_nba', playerName: 'Jaylen Brown', team: 'BOS', opponent: 'NYK', home: 'Boston Celtics', away: 'New York Knicks',
  selection: 'Jaylen Brown Over 14.5 Points', american: -110, book: 'DraftKings', seasons: [2026], streak: 4,
  periods: { l5: period(5, 5), l10: period(9, 10), l20: period(16, 20, { avg: 24.1, median: 23 }), s2026: period(16, 20), h2h: period(3, 3) },
  series: [{ value: 28 }, { value: 22 }, { value: 19 }, { value: 31 }, { value: 25 }, { value: 17 }],
  ...over,
});

test('legScore: a hot line with a perfect head to head and a streak scores near the top', () => {
  const s = legScore(row());
  assert.ok(s >= 4.5 && s <= 5, String(s));
});

test('legScore: an out player scores zero, a questionable one loses half a star, a thin log is discounted', () => {
  const base = legScore(row());
  assert.equal(legScore(row({ injury: { level: 'out' } })), 0);
  assert.equal(legScore(row({ injury: { level: 'questionable' } })), Math.round((base - 0.5) * 10) / 10);
  const perfect = (games) => row({ streak: 0, periods: { l5: period(5, 5), l10: period(Math.min(10, games), Math.min(10, games)), l20: period(games, games), s2026: period(games, games), h2h: period(0, 0) } });
  assert.equal(legScore(perfect(20)), 5);
  assert.equal(legScore(perfect(7)), 4.3);
  assert.equal(legScore(perfect(3)), 3);
  assert.equal(legScore({ periods: {} }), 0);
});

test('parlayDecimal: a sportsbook ticket multiplies its legs, PrizePicks pays the Power Play table', () => {
  assert.equal(parlayDecimal([]), null);
  assert.ok(Math.abs(parlayDecimal([1.91, 2.0]) - 3.82) < 1e-9);
  assert.equal(parlayDecimal([1.91, 2.0, 1.5], { pickem: true }), PICKEM_POWER[3]);
  assert.equal(parlayDecimal([1.91], { pickem: true }), null);
});

test('parseBreakdown: takes the model JSON, trims it, and refuses anything without a verdict', () => {
  const out = parseBreakdown('Sure: {"verdict":"good","summary":" He clears it nightly. ","reasons":["9 of 10",7,"Knicks allow 118"]}');
  assert.deepEqual(out, { verdict: 'good', summary: 'He clears it nightly.', reasons: ['9 of 10', 'Knicks allow 118'] });
  assert.equal(parseBreakdown('{"verdict":"maybe"}'), null);
  assert.equal(parseBreakdown('no json here'), null);
  assert.equal(parseBreakdown(''), null);
});

const kv = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, map: m }; };

test('legBreakdown: writes the facts into the prompt, keeps the model read, and caches it for the day', async () => {
  const env = { POTD_KV: kv() };
  const prompts = [];
  const model = async (p) => { prompts.push(p); return '{"verdict":"good","summary":"Fine leg.","reasons":["a","b"]}'; };
  const out = await legBreakdown(env, 'basketball_nba', 'r1', {}, { now: Date.UTC(2026, 9, 28, 18), deps: { row: row(), model, context: async () => ({ projection: { home: 61, away: 39 } }) } });
  assert.equal(out.verdict, 'good');
  assert.equal(out.summary, 'Fine leg.');
  assert.deepEqual(out.reasons, ['a', 'b']);
  assert.equal(out.model, true);
  assert.ok(out.score >= 4.5);
  assert.match(prompts[0], /Last 10: 90% \(9 of 10\)/);
  assert.match(prompts[0], /Against NYK: 100% \(3 of 3\)/);
  assert.match(prompts[0], /ESPN projects home 61%, away 39%/);
  assert.match(prompts[0], /last five values 28, 22, 19, 31, 25/);
  assert.equal(env.POTD_KV.map.size, 1);
  const again = await legBreakdown(env, 'basketball_nba', 'r1', {}, { now: Date.UTC(2026, 9, 28, 19), deps: { row: row(), model } });
  assert.equal(prompts.length, 1);
  assert.equal(again.summary, 'Fine leg.');
});

test('legBreakdown: falls back to the record when the model answers with prose, and names the injury', async () => {
  const env = { POTD_KV: kv() };
  const out = await legBreakdown(env, 'basketball_nba', 'r1', {}, { deps: { row: row({ injury: { level: 'questionable', status: 'Questionable', detail: 'Knee' }, periods: { l5: period(2, 5), l10: period(4, 10), l20: period(9, 20), s2026: period(9, 20), h2h: period(0, 0) } }), model: async (p) => { assert.match(p, /Injury report: Questionable, Knee/); return 'I cannot say.'; }, context: async () => null } });
  assert.equal(out.model, false);
  assert.equal(out.verdict, 'risky');
  assert.deepEqual(out.reasons, ['Last 10: 40% (4 of 10)', 'Last 20: 45% (9 of 20)', 'No head to head yet']);
});

test('legBreakdown: null when the row is gone', async () => {
  const env = { POTD_KV: kv() };
  assert.equal(await legBreakdown(env, 'basketball_nba', 'nope', {}, { deps: { row: null, model: async () => '' } }), null);
});
