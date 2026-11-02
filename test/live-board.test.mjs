import test from 'node:test';
import assert from 'node:assert/strict';
import { elapsedFraction, isHalftime, liveCandidates, buildLivePlay } from '../worker/src/live-board.js';

const tick = (over = {}) => ({ at: 1, state: 'in', detail: 'Halftime', period: 2, clock: '0:00', score: { PHI: 24, WSH: 3 }, box: [
  { id: '1', name: 'Saquon Barkley', team: 'PHI', stats: { rushingYards: '68', receptions: '2', receivingYards: '11' } },
  { id: '2', name: 'Jalen Hurts', team: 'PHI', stats: { 'completions/passingAttempts': '12/16', passingYards: '150' } },
  { id: '3', name: 'Terry McLaurin', team: 'WSH', stats: { receptions: '4', receivingYards: '58' } },
  { id: '4', name: 'Jacory Croskey-Merritt', team: 'WSH', stats: { rushingYards: '40' } },
], ...over });
const ladder = (player, pts, prices) => pts.map((point, i) => ({ name: 'Over', description: player, point, price: prices[i] }));
const payload = { bookmakers: [
  { key: 'draftkings', markets: [
    { key: 'player_rush_yds_alternate', outcomes: [...ladder('Saquon Barkley', [69.5, 79.5, 89.5, 99.5, 119.5], [-500, -250, -140, 110, 220]), ...ladder('Jacory Croskey-Merritt', [49.5, 59.5], [-200, -110])] },
    { key: 'player_reception_yds_alternate', outcomes: ladder('Terry McLaurin', [69.5, 79.5, 99.5], [-280, -150, 130]) },
    { key: 'player_pass_yds_alternate', outcomes: ladder('Jalen Hurts', [199.5, 224.5], [-250, -130]) },
  ] },
  { key: 'fanduel', markets: [{ key: 'player_rush_yds_alternate', outcomes: ladder('Saquon Barkley', [79.5, 89.5], [-230, -125]) }] },
] };

test('the clock reads as a fraction of the game, and the half is the half', () => {
  assert.equal(elapsedFraction({ state: 'pre' }), 0);
  assert.equal(elapsedFraction({ state: 'in', period: 1, clock: '7:30' }), 0.125);
  assert.equal(elapsedFraction({ state: 'in', period: 3, clock: '15:00' }), 0.5);
  assert.equal(elapsedFraction(tick()), 0.5);
  assert.equal(isHalftime(tick()), true);
  assert.equal(isHalftime({ state: 'in', period: 3, clock: '14:50', detail: '14:50 - 3rd' }), false);
  assert.equal(elapsedFraction({ state: 'in', period: 2, clock: '6:00' }, 'nba'), 0.375);
});

test('candidates are the Overs the pace clears with margin, in range, with the game script applied: the side up big leans on the run', () => {
  const c = liveCandidates(payload, tick());
  const sel = (p) => c.filter((x) => x.player === p).map((x) => [x.bookId, x.point, x.price]);
  assert.deepEqual(sel('Saquon Barkley'), [['fanduel', 79.5, -230], ['draftkings', 79.5, -250], ['fanduel', 89.5, -125], ['draftkings', 89.5, -140], ['draftkings', 99.5, 110]], 'on pace for 136: 79.5 to 99.5 clear by a quarter; 119.5 does not, and -500 is outside the leg price range');
  assert.deepEqual(sel('Jalen Hurts'), [], 'the side up 21 sits its passing game');
  assert.deepEqual(sel('Jacory Croskey-Merritt'), [], 'the side down 21 throws: its rushing lines are passed over');
  assert.deepEqual(sel('Terry McLaurin'), [['draftkings', 69.5, -280], ['draftkings', 79.5, -150], ['draftkings', 99.5, 130]], 'on pace for 116, lifted to 133 by the side down big throwing: 99.5 clears too');
  assert.equal(c[0].current, 68); assert.equal(c[0].pace, 156, 'up big: 136 on pace, lifted a sixth for the run game');
  const close = liveCandidates(payload, tick({ score: { PHI: 14, WSH: 10 } }));
  assert.ok(close.some((x) => x.player === 'Jalen Hurts'), 'a close game: the passing lines are in');
  assert.deepEqual(liveCandidates(payload, { state: 'pre', box: [] }), []);
});

test('the play is three to five legs at one book nearest +100, each player on his highest clearing number', () => {
  const c = liveCandidates(payload, tick({ score: { PHI: 14, WSH: 10 } }));
  const play = buildLivePlay(c);
  assert.ok(play, 'a play builds');
  assert.equal(play.bookId, 'draftkings');
  assert.ok(play.legs.length >= 3 && play.legs.length <= 5);
  assert.equal(new Set(play.legs.map((l) => l.player)).size, play.legs.length, 'one line per player');
  assert.ok(play.american >= -160 && play.american <= 200);
  assert.equal(buildLivePlay(c.filter((x) => x.player === 'Saquon Barkley')), null, 'one player cannot make three legs');
});

test('the projection follows pace, script and weather; who to watch lists the biggest projected outputs with the best clearing line; slips come one per book and keep their numbers up to date', async () => {
  const { projectStat, whoToWatch, buildLiveSlips, playerLines, ensureLivePlays, gameScript, roughWeather } = await import('../worker/src/live-board.js');
  assert.equal(projectStat(60, 0.5, 'rushingYards'), 120);
  assert.equal(projectStat(60, 0.5, 'rushingYards', { team: 'PHI', script: { leader: 'PHI', trailer: 'WSH' } }), 138, 'up big: the run game carries');
  assert.equal(projectStat(150, 0.5, 'passingYards', { team: 'PHI', script: { leader: 'PHI', trailer: 'WSH' } }), 240, 'up big: the passing game sits');
  assert.equal(projectStat(150, 0.5, 'passingYards', { team: 'WSH', script: { leader: 'PHI', trailer: 'WSH' } }), 345, 'down big: throwing to catch up');
  assert.equal(projectStat(150, 0.5, 'passingYards', { weather: { windSpeed: '20 mph', precipChance: 10 } }), 255, 'wind fades passing');
  assert.equal(roughWeather({ windSpeed: '8 mph', precipChance: 60 }), true);
  assert.deepEqual(gameScript(tick({ score: { PHI: 20, WSH: 3 } })), { leader: 'PHI', trailer: 'WSH', margin: 17 });
  const t = tick({ score: { PHI: 14, WSH: 10 } });
  const lines = playerLines(t);
  assert.equal(lines[0].name, 'Jalen Hurts'); assert.equal(lines[0].passingYards, 150); assert.equal(lines[0].passing, '12/16');
  const c = liveCandidates(payload, t);
  const w = whoToWatch(t, c);
  assert.equal(w[0].player, 'Jalen Hurts'); assert.equal(w[0].projected, 300); assert.equal(w[0].line.point, 224.5, 'his highest clearing number');
  const saquon = w.find((x) => x.player === 'Saquon Barkley' && x.stat === 'rushingYards');
  assert.deepEqual([saquon.current, saquon.projected, saquon.line.bookId, saquon.line.point], [68, 136, 'draftkings', 99.5]);
  const slips = buildLiveSlips(c);
  assert.deepEqual(slips.map((s) => s.bookId), ['draftkings'], 'FanDuel prices only one player: no slip there');
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  assert.equal(await ensureLivePlays(env, { id: 'g', name: 'A at B' }, payload, { ...t, detail: '7:00 - 2nd Quarter', period: 2, clock: '7:00' }), null, 'not at the half: nothing built');
  const built = await ensureLivePlays(env, { id: 'g', name: 'A at B' }, payload, t, { now: 9 });
  assert.equal(built.slips.length, 1); assert.equal(built.builtAt, 9);
  const again = await ensureLivePlays(env, { id: 'g', name: 'A at B' }, { bookmakers: [] }, t, { now: 10 });
  assert.equal(again.builtAt, 9, 'the first slip stands');
});
