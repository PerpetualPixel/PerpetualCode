import test from 'node:test';
import assert from 'node:assert/strict';
import { checkable, nextFlagBatch, pickLegs, pickTicket, leftOutText, flaggedText, FLAG_BATCH, FLAG_TEAMS } from '../docs/parlay-flags.js';

const c = (id, over = {}) => ({ key: over.key ?? `player ${id}`, row: { id, sportKey: 'americanfootball_nfl', team: over.team ?? `T${id}`, ...over.row }, score: 5 });
const flagsFrom = (map) => (x) => map[x.row.id];

test('which lines are checked: player props in the board\'s leagues, never a fight or a tennis match', () => {
  const sports = ['basketball_nba', 'americanfootball_nfl'];
  assert.equal(checkable({ id: 'a', sportKey: 'basketball_nba' }, sports), true);
  assert.equal(checkable({ id: 'a', sportKey: 'mma_mixed_martial_arts', ufc: {} }, sports), false);
  assert.equal(checkable({ id: 'a', sportKey: 'tennis', tennis: {} }, sports), false);
  assert.equal(checkable({ id: 'a', sportKey: 'icehockey_nhl' }, sports), false);
  assert.equal(checkable({ sportKey: 'basketball_nba' }, sports), false);
  assert.equal(checkable(null, sports), false);
});

test('the next list to ask for: the first unanswered lines in order, one league, within the line and team limits', () => {
  const rows = [c('a').row, { id: 'n1', sportKey: 'basketball_nba', team: 'BOS' }, c('b').row, c('c').row, c('a').row];
  const known = (r) => r.id === 'b';
  assert.deepEqual(nextFlagBatch(rows, known), { sportKey: 'americanfootball_nfl', ids: ['a', 'c'] });
  assert.deepEqual(nextFlagBatch(rows, (r) => r.sportKey === 'americanfootball_nfl'), { sportKey: 'basketball_nba', ids: ['n1'] });
  assert.equal(nextFlagBatch(rows, () => true), null);
  assert.equal(nextFlagBatch([], () => false), null);
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `r${i}`, sportKey: 'basketball_nba', team: `T${i % 4}` }));
  assert.equal(nextFlagBatch(many, () => false).ids.length, FLAG_BATCH);
  // A team past the limit waits for the next request; a team already in it keeps adding lines.
  const spread = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, sportKey: 'basketball_nba', team: `T${i % 20}` }));
  const got = nextFlagBatch(spread, () => false);
  assert.equal(new Set(got.ids.map((id) => spread.find((r) => r.id === id).team)).size, FLAG_TEAMS);
  assert.deepEqual(got.ids.slice(0, 3), ['s0', 's1', 's2']);
  assert.ok(got.ids.includes('s20') && !got.ids.includes('s12'));
});

test('flags off: the legs are taken as they come, flagged or not', () => {
  const order = [c('a'), c('b'), c('c')];
  const out = pickLegs(order, 2, { flagsOf: flagsFrom({ a: [{ key: 'back' }] }) });
  assert.deepEqual([out.chosen.map((x) => x.row.id), out.leftOut, out.pending], [['a', 'b'], [], null]);
});

test('flags on: a flagged player is passed over and counted, and the next clean one takes the slot', () => {
  const order = [c('a'), c('b'), c('c'), c('d'), c('e')];
  const flags = { a: [{ key: 'back' }], b: [], c: [{ key: 'minutes' }], d: [], e: [] };
  const out = pickLegs(order, 2, { flagsOf: flagsFrom(flags), noRed: true });
  assert.deepEqual(out.chosen.map((x) => x.row.id), ['b', 'd']);
  assert.deepEqual(out.leftOut.map((x) => x.row.id), ['a', 'c']);
  assert.equal(out.pending, null);
  // The walk stops at the last slot: a flagged player further down was never in the running, so is not counted.
  const more = pickLegs([...order, c('f')], 2, { flagsOf: flagsFrom({ ...flags, f: [{ key: 'back' }] }), noRed: true });
  assert.equal(more.leftOut.length, 2);
  // Not enough clean players: what there is, with every flagged one counted.
  const thin = pickLegs(order, 5, { flagsOf: flagsFrom(flags), noRed: true });
  assert.deepEqual([thin.chosen.map((x) => x.row.id), thin.leftOut.length], [['b', 'd', 'e'], 2]);
});

test('flags on: a line with no answer yet stops the walk, or is passed over uncounted once the asking is done', () => {
  const order = [c('a'), c('b'), c('c')];
  const flags = { a: [] };
  const waiting = pickLegs(order, 2, { flagsOf: flagsFrom(flags), noRed: true });
  assert.deepEqual([waiting.chosen.map((x) => x.row.id), waiting.pending.row.id], [['a'], 'b']);
  const done = pickLegs(order, 2, { flagsOf: flagsFrom(flags), noRed: true, skipUnknown: true });
  assert.deepEqual([done.chosen.map((x) => x.row.id), done.leftOut, done.pending], [['a'], [], null]);
});

test('one leg a player, the ticket\'s own rule, and the legs an earlier pass took', () => {
  const order = [c('a'), c('a2', { key: 'player a' }), c('b', { team: 'X' }), c('d', { team: 'Y' })];
  assert.deepEqual(pickLegs(order, 3).chosen.map((x) => x.row.id), ['a', 'b', 'd']);
  const twoTeams = (x, picked) => !(picked.length === 1 && picked[0].row.team === x.row.team);
  assert.deepEqual(pickLegs([c('a', { team: 'X' }), c('b', { team: 'X' }), c('d', { team: 'Y' })], 2, { fits: twoTeams }).chosen.map((x) => x.row.id), ['a', 'd']);
  assert.deepEqual(pickLegs(order, 2, { chosen: [c('z')] }).chosen.map((x) => x.row.id), ['z', 'a']);
});

test('the whole pick rotates: lines not shown before first, then the pool again, a flagged player counted once', () => {
  const pool = [c('a'), c('b'), c('c'), c('d')];
  const flags = { a: [{ key: 'back' }], b: [], c: [], d: [] };
  const opts = { flagsOf: flagsFrom(flags), noRed: true };
  const first = pickTicket(pool, 2, new Set(), opts);
  assert.deepEqual([first.chosen.map((x) => x.row.id), first.leftOut.map((x) => x.row.id), first.rotated], [['b', 'c'], ['a'], false]);
  // The next build has seen b and c: d is new, and the pool comes round again for the second slot.
  const again = pickTicket(pool, 2, new Set(['b', 'c']), opts);
  assert.deepEqual([again.chosen.map((x) => x.row.id), again.leftOut.map((x) => x.row.id), again.rotated], [['d', 'b'], ['a'], true]);
  // An answer still out stops it before the second pass.
  const waiting = pickTicket(pool, 2, new Set(), { flagsOf: flagsFrom({ a: [] }), noRed: true });
  assert.deepEqual([waiting.pending.row.id, waiting.rotated], ['b', false]);
  assert.deepEqual(pickTicket(null, 2, null).chosen, []);
});

test('the words', () => {
  assert.equal(leftOutText(7), '7 players left out due to red flag indicators.');
  assert.equal(leftOutText(1), '1 player left out due to red flag indicators.');
  assert.equal(flaggedText(2, 10), '2 out of 10 results have red flag indicators.');
  assert.equal(flaggedText(1, 4), '1 out of 4 results has red flag indicators.');
});

// --- The wiring (docs/app.js, docs/app.html, worker/src/index.js) ---
import fs from 'node:fs';
const app = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../docs/app.html', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');

test('the toggle is off by default, asks the worker a list at a time, and a newer build wins', () => {
  assert.match(page, /<button type="button" id="parlayNoRed" class="rate-chip parlay-season-chip" data-parlay-nored aria-pressed="false">Leave out red flags<\/button>/);
  assert.match(app, /noRed: false, flagInfo: null,/);
  assert.match(app, /const url = new URL\('\/trends\/flags', CONFIG\.WORKER_URL\); url\.searchParams\.set\('sport', sportKey\);/);
  assert.match(app, /if \(seq !== parlayBuildSeq\) return; \/\/ a newer build is under way/);
  // The check out of reach never empties a ticket: it is built as with the toggle off, and says so.
  assert.match(app, /if \(!reached\) \{ unchecked = true; result = pick\(\); break; \}/);
  assert.match(app, /Red flags could not be checked right now/);
  assert.match(worker, /pathname === '\/trends\/flags' && request\.method === 'GET'/);
  assert.match(worker, /ids\.length > RED_CHECK_LINES/);
});
