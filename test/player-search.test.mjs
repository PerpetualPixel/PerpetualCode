/**
 * The Players tab's worker side (worker/src/player-search.js): the stat
 * list per league, the runner's player index, and one player's game log
 * at a stat from the ESPN bundle, with the season type on every row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playerStats, getPlayerIndex, getPlayerLog } from '../worker/src/player-search.js';
import { bundleKey, playersIndexKey } from '../worker/src/espn-bundle.js';
import { nflWeek, nflWeekDates } from '../docs/trends.js';

const log = {
  names: ['minutes', 'points', 'totalRebounds'], labels: ['MIN', 'PTS', 'REB'], displayNames: ['Minutes', 'Points', 'Rebounds'],
  seasonTypes: [
    { displayName: '2026-27 Regular Season', categories: [{ events: [{ eventId: 'e1', stats: ['34', '22', '5'] }, { eventId: 'e2', stats: ['30', '18', '7'] }] }] },
    { displayName: '2025-26 Postseason', categories: [{ events: [{ eventId: 'e3', stats: ['38', '31', '9'] }] }] },
  ],
  events: { e1: { gameDate: '2026-10-25T00:00Z', opponent: { abbreviation: 'LAL' }, atVs: 'vs', gameResult: 'W', score: '110-100' }, e2: { gameDate: '2026-10-23T00:00Z', opponent: { abbreviation: 'DEN' }, atVs: '@', gameResult: 'L', score: '99-104' }, e3: { gameDate: '2026-05-01T00:00Z', opponent: { abbreviation: 'LAL' }, atVs: '@', gameResult: 'W', score: '120-110' } },
};
const store = new Map([
  [bundleKey('basketball_nba', 'POR'), JSON.stringify({ sportKey: 'basketball_nba', team: 'POR', builtAt: 1, players: [{ id: '3995', name: 'Jrue Holiday', position: 'G', injuries: [{ status: 'Day-To-Day', detail: 'Knee' }], log }] })],
  [playersIndexKey('basketball_nba'), JSON.stringify({ sportKey: 'basketball_nba', builtAt: 1, players: [{ id: '3995', name: 'Jrue Holiday', team: 'POR', position: 'G', headshot: 'x' }] })],
]);
const env = { POTD_KV: { async get(k) { return store.get(k) ?? null; } } };

test('each league lists its stats once, by the plain market name', () => {
  const nba = playerStats('basketball_nba');
  assert.deepEqual(nba.find((s) => s.key === 'points'), { key: 'points', label: 'Points', short: 'Pts' });
  assert.equal(nba.filter((s) => s.key === 'points').length, 1, 'the alternate market does not repeat the stat');
  assert.ok(playerStats('americanfootball_nfl').some((s) => s.key === 'recYds' && s.label === 'Receiving Yards'));
  assert.deepEqual(playerStats('icehockey_nhl'), []);
});

test('the index is the runner\'s, and a player\'s log at a stat carries every season with its type, most recent first', async () => {
  assert.equal((await getPlayerIndex(env, 'basketball_nba')).players[0].name, 'Jrue Holiday');
  assert.deepEqual((await getPlayerIndex(env, 'americanfootball_nfl')).players, []);
  const out = await getPlayerLog(env, 'basketball_nba', 'por', '3995', 'points');
  assert.deepEqual(out.player, { id: '3995', name: 'Jrue Holiday', team: 'POR', position: 'G', injuries: [{ status: 'Day-To-Day', detail: 'Knee' }] });
  assert.deepEqual(out.rows.map((r) => [r.value, r.season, r.seasonType, r.opponent, r.atVs]), [[22, 2026, '2026-27 Regular Season', 'LAL', 'vs'], [18, 2026, '2026-27 Regular Season', 'DEN', '@'], [31, 2025, '2025-26 Postseason', 'LAL', '@']]);
  assert.equal(await getPlayerLog(env, 'basketball_nba', 'POR', '1', 'points'), null);
});

test('the NFL week runs Tuesday to Monday and is numbered from the Tuesday after Labor Day', () => {
  assert.deepEqual(nflWeekDates(Date.parse('2026-10-28T12:00:00Z')), ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.equal(nflWeekDates(Date.parse('2026-10-27T14:00:00Z')).length, 7, 'a Tuesday starts a fresh week');
  assert.deepEqual(nflWeekDates(Date.parse('2026-11-02T20:00:00Z')), ['2026-11-02'], 'Monday night is the week\'s last game');
  assert.equal(nflWeek(Date.parse('2026-10-28T12:00:00Z')), 8);
  assert.equal(nflWeek(Date.parse('2026-09-10T23:00:00Z')), 1);
  assert.equal(nflWeek(Date.parse('2025-10-30T23:00:00Z')), 9);
});
