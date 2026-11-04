import test from 'node:test';
import assert from 'node:assert/strict';
import { pickLiveEvent, summariseProps, runLiveProbe, liveProbeKey, liveGamesNow, liveGameTeams, LIVE_BOOKMAKERS } from '../worker/src/live-probe.js';
import { SPORTSBOOKS, bookIdFor } from '../docs/engine.js';

test('the probe follows the watched games inside their windows, finds each on the feed either way round, summarises what every book posts, and keeps one snapshot a tick', async () => {
  const kick = Date.UTC(2026, 10, 3, 1, 20);
  const index = { games: [{ id: '401873100', name: 'Chicago Bears at Seattle Seahawks', date: '2026-11-03T01:20Z', league: 'nfl' }, { id: 'old', name: 'Philadelphia Eagles at Washington Commanders', date: '2026-11-02T01:20Z', league: 'nfl' }] };
  assert.deepEqual(liveGameTeams('Chicago Bears at Seattle Seahawks'), ['Chicago Bears', 'Seattle Seahawks']);
  assert.deepEqual(liveGamesNow(index, kick - 30 * 60e3).map((g) => g.id), ['401873100'], 'forty minutes before kick-off the game is in its window; last night\'s is not');
  assert.deepEqual(liveGamesNow(index, kick - 2 * 3600e3), []);
  const events = [{ id: 'x1', home_team: 'Dallas Cowboys', away_team: 'New York Giants' }, { id: 'e1', home_team: 'Seattle Seahawks', away_team: 'Chicago Bears', commence_time: '2026-11-03T01:20:00Z' }];
  assert.equal(pickLiveEvent(events, ['Chicago Bears', 'Seattle Seahawks']).id, 'e1');
  assert.equal(pickLiveEvent(events, ['Chicago Bears', 'Miami Dolphins']), null);
  const payload = { bookmakers: [
    { key: 'draftkings', last_update: 't', markets: [{ key: 'player_rush_yds_alternate', last_update: 't', outcomes: [{ name: 'Over', description: 'Kenneth Walker III', point: 59.5, price: -150 }, { name: 'Over', description: 'Kenneth Walker III', point: 69.5, price: 110 }, { name: 'Over', description: "D'Andre Swift", point: 39.5, price: -120 }] }] },
    { key: 'fanduel', last_update: 't', markets: [] },
  ] };
  const snap = summariseProps(payload, 5);
  assert.equal(snap.booksPosting, 1);
  assert.deepEqual([snap.books[0].markets[0].outcomes, snap.books[0].markets[0].players, snap.books[0].markets[0].sample[0].player], [3, 2, 'Kenneth Walker III']);
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  let calls = 0;
  const deps = { index, events: async () => events, props: async () => { calls++; return payload; } };
  assert.equal((await runLiveProbe(env, {}, kick - 2 * 3600e3, { deps })).skipped, true, 'before the window');
  const r = await runLiveProbe(env, {}, kick + 60e3, { deps });
  assert.deepEqual([r.skipped, r.games[0].eventId, r.games[0].booksPosting, r.games[0].markets, r.games[0].plays], [false, 'e1', 1, 1, 0]);
  await runLiveProbe(env, {}, kick + 120e3, { deps });
  const log = JSON.parse(m.get(liveProbeKey('e1')));
  assert.equal(log.snapshots.length, 2); assert.equal(calls, 2); assert.equal(log.home, 'Seattle Seahawks'); assert.equal(log.espnEventId, '401873100');
  assert.equal(m.get('live:probe:for:401873100'), 'e1', 'the board finds the probe by the watched game');
  assert.equal((await runLiveProbe(env, {}, kick + 6 * 3600e3, { deps })).skipped, true, 'after the window');
});

test('the live call names every book the site lists that posts props, ten at most so it prices as one region', () => {
  const keys = LIVE_BOOKMAKERS.split(',');
  assert.ok(keys.length <= 10, 'more than ten names and the feed charges a second region');
  const ids = new Set(keys.map((k) => bookIdFor(k)));
  for (const id of Object.keys(SPORTSBOOKS)) if (id !== 'kalshi') assert.ok(ids.has(id), `${id} is on the site but not in the live call`);
});

test('pickLiveEvent: a club named one way by ESPN and another by the feed still matches on a shared word, never on a club word alone, the nearest kick-off breaking ties', () => {
  const events = [
    { id: 'u1', home_team: 'SK Slavia Praha', away_team: 'Arsenal FC', commence_time: '2026-11-04T20:00:00Z' },
    { id: 'u2', home_team: 'Sparta Praha', away_team: 'FC Barcelona', commence_time: '2026-11-04T20:00:00Z' },
    { id: 'u3', home_team: 'Manchester City', away_team: 'Borussia Dortmund', commence_time: '2026-11-04T20:00:00Z' },
    { id: 'u4', home_team: 'Manchester United', away_team: 'Borussia Monchengladbach', commence_time: '2026-11-05T20:00:00Z' },
  ];
  assert.equal(pickLiveEvent(events, ['Arsenal', 'Slavia Prague'])?.id, 'u1', 'Slavia is the shared word; Praha and Prague differ');
  assert.equal(pickLiveEvent(events, ['Arsenal', 'Sparta Prague']), null, 'Sparta is not Slavia; Prague alone does not carry it');
  assert.equal(pickLiveEvent(events, ['Borussia Dortmund', 'Manchester City'])?.id, 'u3', 'full containment outranks the shared Manchester and Borussia');
  assert.equal(pickLiveEvent(events, ['Dortmund', 'Man City'], { date: '2026-11-04T20:00:00Z' })?.id, 'u3');
  assert.equal(pickLiveEvent([{ id: 'x', home_team: 'FC Nowhere', away_team: 'SK Elsewhere' }], ['FC Arsenal', 'SK Slavia']), null, 'FC and SK are club words, not a match');
});
