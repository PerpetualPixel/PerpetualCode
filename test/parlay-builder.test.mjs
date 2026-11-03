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
  assert.equal(env.POTD_KV.map.size, 2, 'the cached read and the day\'s read count');
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

test('legBreakdown: the day has a model budget, site-wide and per person; past it the leg answers from the record, briefly cached, and the reads resume next day', async () => {
  const { legBreakdown, modelReadsToday } = await import('../worker/src/parlay-builder.js');
  const store = new Map();
  const env = { POTD_KV: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } } };
  const row = (id) => ({ id, selection: `Player ${id} Over 9.5 Pts`, american: -120, book: 'DraftKings', home: 'A', away: 'B', opponent: 'B', periods: { l5: { rate: 1, hits: 5, games: 5 }, l10: { rate: 0.9, hits: 9, games: 10 }, l20: { rate: 0.85, hits: 17, games: 20, avg: 12, median: 12 } }, series: [], rates: { l5: 1, l10: 0.9, l20: 0.85 }, seasons: [] });
  let calls = 0;
  const model = async () => { calls++; return '{"verdict":"good","summary":"Fine.","reasons":["a"]}'; };
  const NOW = Date.parse('2026-11-03T20:00:00Z');
  const opts = (id, who) => ({ now: NOW, deps: { row: row(id), model, context: async () => null }, who, caps: { site: 3, person: 2 } });
  const a = await legBreakdown(env, 'basketball_nba', 'r1', {}, opts('r1', 'ip-1'));
  assert.equal(a.model, true); assert.equal(a.capped, false); assert.equal(calls, 1);
  assert.deepEqual(await modelReadsToday(env, NOW, 'ip-1').then((u) => [u.site, u.person]), [1, 1]);
  await legBreakdown(env, 'basketball_nba', 'r1', {}, opts('r1', 'ip-1'));
  assert.equal(calls, 1, 'the same line again is the cached read, not a second spend');
  await legBreakdown(env, 'basketball_nba', 'r2', {}, opts('r2', 'ip-1'));
  const third = await legBreakdown(env, 'basketball_nba', 'r3', {}, opts('r3', 'ip-1'));
  assert.equal(calls, 2); assert.equal(third.capped, true); assert.equal(third.model, false, 'the third line for one person is past their two');
  assert.equal(third.summary, 'The record says the number is safe.');
  assert.equal(third.verdict, 'good', 'the record still gives a verdict');
  const other = await legBreakdown(env, 'basketball_nba', 'r3', {}, opts('r3', 'ip-2'));
  assert.equal(other.capped, true, 'a capped answer is cached briefly, so the next visitor sees it too');
  const fourth = await legBreakdown(env, 'basketball_nba', 'r4', {}, opts('r4', 'ip-2'));
  assert.equal(fourth.model, true); assert.equal(calls, 3, 'another person has their own budget while the site has room');
  const fifth = await legBreakdown(env, 'basketball_nba', 'r5', {}, opts('r5', 'ip-3'));
  assert.equal(fifth.capped, true, 'the site cap of three holds for everyone');
  assert.equal(calls, 3);
  const tomorrow = await legBreakdown(env, 'basketball_nba', 'r6', {}, { ...opts('r6', 'ip-3'), now: NOW + 86400e3 });
  assert.equal(tomorrow.model, true, 'the day turns and the reads resume');
});
