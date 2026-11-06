import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, todaySlate, slateLeft, pickGames } from '../scripts/live-watch.mjs';

const ev = (id, name, date, state) => ({ id, name, date, competitions: [{ status: { type: { state } }, competitors: [{ team: { abbreviation: name.slice(0, 3).toUpperCase() } }] }] });
// The NFL scoreboard on a Thursday afternoon: the whole week, Thursday night's game among them (2026-11-05, 22:12Z).
const week = { events: [
  ev('tnf', 'Jacksonville Jaguars at Baltimore Ravens', '2026-11-06T01:15Z', 'pre'),
  ev('sun1', 'Green Bay Packers at New England Patriots', '2026-11-08T21:25Z', 'pre'),
  ev('snf', 'Tampa Bay Buccaneers at Chicago Bears', '2026-11-09T01:20Z', 'pre'),
  ev('mnf', 'Buffalo Bills at Minnesota Vikings', '2026-11-10T01:15Z', 'pre'),
] };

test('dayKey is the Eastern calendar day: a 9 PM ET tip on the 5th is the 5th though it is the 6th in UTC', () => {
  assert.equal(dayKey(Date.parse('2026-11-06T02:00Z')), '2026-11-05');
  assert.equal(dayKey(Date.parse('2026-11-06T05:30Z')), '2026-11-06');
  assert.equal(dayKey(Date.parse('2026-07-04T03:30Z')), '2026-07-03', 'daylight time too');
});

test('todaySlate keeps only the current Eastern day from a week-long scoreboard, and a game in play from the night before', () => {
  const thu = Date.parse('2026-11-05T22:12Z');
  assert.deepEqual(todaySlate(week, thu).map((e) => e.id), ['tnf']);
  assert.equal(slateLeft(week, thu), 1);
  const sun = Date.parse('2026-11-08T18:00Z');
  assert.deepEqual(todaySlate(week, sun).map((e) => e.id), ['sun1', 'snf'], 'Sunday night football is still Sunday in the East');
  const late = { events: [ev('late', 'Miami Heat at Golden State Warriors', '2026-11-06T03:00Z', 'in'), ev('tmrw', 'Boston Celtics at New York Knicks', '2026-11-07T00:30Z', 'pre')] };
  assert.deepEqual(todaySlate(late, Date.parse('2026-11-06T05:30Z')).map((e) => e.id), ['late', 'tmrw'], 'past midnight: the game still in play, and the new day');
  assert.equal(slateLeft({ events: [ev('done', 'A at B', '2026-11-06T00:00Z', 'post')] }, Date.parse('2026-11-06T04:00Z')), 0, 'a final is not left');
});

test('pickGames --all takes today\'s games in play or inside the lead, never Sunday\'s on a Thursday', () => {
  const t = Date.parse('2026-11-06T00:40Z'); // 35 minutes before kick-off
  assert.deepEqual(pickGames(week, { all: true, now: t, leadMs: 45 * 60e3 }).map((e) => e.id), ['tnf']);
  assert.deepEqual(pickGames(week, { all: true, now: Date.parse('2026-11-05T22:12Z'), leadMs: 45 * 60e3 }), [], 'three hours out: nothing yet, the run waits');
  const inPlay = { events: [ev('g', 'Miami Heat at Golden State Warriors', '2026-11-06T03:00Z', 'in'), ev('tnf', 'Jacksonville Jaguars at Baltimore Ravens', '2026-11-06T01:15Z', 'post'), ...week.events.slice(1)] };
  assert.deepEqual(pickGames(inPlay, { all: true, now: Date.parse('2026-11-06T04:00Z'), leadMs: 45 * 60e3 }).map((e) => e.id), ['g']);
  assert.deepEqual(pickGames(week, { team: 'JAC', now: t }).map((e) => e.id), ['tnf'], 'a team watch is by abbreviation, any day');
});
