import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';

/**
 * The Trends and Players routes answer for the Soccer tab (2026-11-03:
 * "just put soccer and have it all in there"): the five leagues' rows
 * side by side, each tagged with its own league's injury report, and a
 * player index that says which league each player's log lives under.
 */
const ORIGIN = 'https://miguelsgarcia4.github.io';
const ctx = { waitUntil() {}, passThroughOnException() {} };
const makeEnv = (store) => ({
  ALLOWED_ORIGINS: ORIGIN,
  POTD_KV: { get: async (k) => (store.has(k) ? store.get(k) : null), put: async (k, v) => void store.set(k, v) },
});
const call = (path) => new Request(`https://worker.dev${path}`, { headers: { Origin: ORIGIN } });
const row = (sportKey, id, l20) => ({ id, sportKey, sportTitle: sportKey, playerName: id, athleteId: id, statKey: 'shots', point: 1.5, side: 'over', rates: { l20 }, periods: { l20: { rate: l20, hits: Math.round(l20 * 20), games: 20 } }, logKey: `${id}:shots` });

test('/trends?sport=soccer merges the leagues, each row with its own injury report, and the tabs show one Soccer chip', async () => {
  const store = new Map();
  store.set('trends:soccer_epl', JSON.stringify({ sportKey: 'soccer_epl', title: 'Premier League', builtAt: 10, rows: [row('soccer_epl', 'saka', 0.8)], logs: { 'saka:shots': [{ value: 3, date: 1 }] }, stamps: {} }));
  store.set('trends:soccer_italy_serie_a', JSON.stringify({ sportKey: 'soccer_italy_serie_a', title: 'Serie A', builtAt: 20, rows: [row('soccer_italy_serie_a', 'lautaro', 0.9)], logs: { 'lautaro:shots': [{ value: 2, date: 1 }] }, stamps: {} }));
  store.set('espn:soccer_italy_serie_a:injuries', JSON.stringify({ builtAt: 30, players: { lautaro: { status: 'Out', detail: 'Hamstring' } } }));
  store.set('espn:soccer_epl:injuries', JSON.stringify({ builtAt: 25, players: { saka: { status: 'Questionable', detail: 'Knock' } } }));
  const res = await worker.fetch(call('/trends?sport=soccer'), makeEnv(store), ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.trends.sportKey, 'soccer'); assert.equal(body.trends.title, 'Soccer');
  assert.deepEqual(body.trends.rows.map((r) => [r.id, r.sportKey, r.injury?.level]), [['lautaro', 'soccer_italy_serie_a', 'out'], ['saka', 'soccer_epl', 'questionable']]);
  assert.equal(body.trends.injuriesAt, 30);
  assert.ok(body.trends.logs['saka:shots'] && body.trends.logs['lautaro:shots']);
  assert.deepEqual(body.leagues, ['basketball_nba', 'americanfootball_nfl', 'icehockey_nhl', 'soccer']);
  assert.deepEqual(body.available.find((a) => a.sportKey === 'soccer'), { sportKey: 'soccer', title: 'Soccer', rows: 2, builtAt: 20 });
  assert.ok(!body.available.some((a) => a.sportKey.startsWith('soccer_')), 'no per-league chips');
  // A league on its own still answers, for the parlay legs and the game logs.
  const one = await (await worker.fetch(call('/trends?sport=soccer_epl'), makeEnv(store), ctx)).json();
  assert.deepEqual(one.trends.rows.map((r) => r.id), ['saka']);
});

test('/players?sport=soccer is every league index side by side, each player carrying his league', async () => {
  const store = new Map();
  store.set('espn:soccer_epl:players', JSON.stringify({ sportKey: 'soccer_epl', builtAt: 5, players: [{ id: '1', name: 'Bukayo Saka', team: 'ARS' }] }));
  store.set('espn:soccer_germany_bundesliga:players', JSON.stringify({ sportKey: 'soccer_germany_bundesliga', builtAt: 9, players: [{ id: '2', name: 'Harry Kane', team: 'BAY' }] }));
  const body = await (await worker.fetch(call('/players?sport=soccer'), makeEnv(store), ctx)).json();
  assert.equal(body.sportKey, 'soccer'); assert.equal(body.builtAt, 9);
  assert.deepEqual(body.players.map((p) => [p.name, p.sportKey]), [['Bukayo Saka', 'soccer_epl'], ['Harry Kane', 'soccer_germany_bundesliga']]);
  assert.ok(body.stats.some((s) => s.key === 'shots'));
  const bad = await worker.fetch(call('/players?sport=soccer_mls'), makeEnv(store), ctx);
  assert.equal(bad.status, 400);
});
