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
  assert.ok(play.american >= -160 && play.american <= 300);
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
  assert.deepEqual(saquon.lines.map((l) => [l.bookId, l.point]), [['draftkings', 99.5], ['fanduel', 89.5]], 'the best clearing line at each book, for a user who plays at one');
  const slips = buildLiveSlips(c);
  assert.deepEqual(slips.map((s) => s.bookId), ['draftkings'], 'FanDuel prices only one player: no slip there');
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  assert.equal(await ensureLivePlays(env, { id: 'g', name: 'A at B' }, payload, { ...t, detail: '10:00 - 1st Quarter', period: 1, clock: '10:00' }), null, 'five minutes in: too little pace to build on');
  const q2 = await ensureLivePlays(env, { id: 'g', name: 'A at B' }, payload, { ...t, detail: '7:00 - 2nd Quarter', period: 2, clock: '7:00' }, { now: 8 });
  assert.equal(q2.slips.length, 1); assert.deepEqual([q2.builtAt, q2.firstBuiltAt, q2.builds, q2.period, q2.clock], [8, 8, 1, 2, '7:00'], 'built in the second quarter, not only at the half');
  const built = await ensureLivePlays(env, { id: 'g', name: 'A at B' }, payload, t, { now: 9 });
  assert.deepEqual([built.builtAt, built.firstBuiltAt, built.builds, built.detail], [9, 8, 2, 'Halftime'], 'rebuilt at the half from the ladders now');
  const again = await ensureLivePlays(env, { id: 'g', name: 'A at B' }, { bookmakers: [] }, t, { now: 10 });
  assert.equal(again.builtAt, 9, 'no ladders this tick: the last build stands');
  const late = await ensureLivePlays(env, { id: 'g', name: 'A at B' }, payload, { ...t, detail: '2:00 - 4th Quarter', period: 4, clock: '2:00' }, { now: 11 });
  assert.equal(late.builtAt, 9, 'two minutes left: no new build, the last stands');
});

test('later slips are built without the best slip\'s players when the ladders allow, and a player on more than one slip is counted on his legs', async () => {
  const { buildLiveSlips } = await import('../worker/src/live-board.js');
  const t = tick({ score: { PHI: 14, WSH: 10 } });
  // FanDuel prices the same three players as DraftKings plus two of its own: its slip should leave the shared ones alone.
  const fd = (player, pts, prices) => ladder(player, pts, prices);
  const extra = [...fd('Deebo Samuel', [49.5, 59.5], [-220, -130]), ...fd('Zach Ertz', [34.5, 44.5], [-260, -120]), ...fd('Dallas Goedert', [39.5, 49.5], [-270, -125])];
  const dk = payload.bookmakers.find((b) => b.key === 'draftkings');
  const wide = { bookmakers: [{ ...dk, markets: dk.markets.map((m) => (m.key === 'player_reception_yds_alternate' ? { ...m, outcomes: [...m.outcomes, ...extra] } : m)) }, { key: 'fanduel', markets: [
    { key: 'player_rush_yds_alternate', outcomes: [...fd('Saquon Barkley', [79.5, 89.5], [-230, -125]), ...fd('Jacory Croskey-Merritt', [49.5, 59.5], [-200, -110])] },
    { key: 'player_reception_yds_alternate', outcomes: [...fd('Terry McLaurin', [69.5, 79.5], [-280, -150]), ...extra] },
    { key: 'player_pass_yds_alternate', outcomes: fd('Jalen Hurts', [199.5, 224.5], [-250, -130]) },
  ] }] };
  const box = [...t.box, { id: '5', name: 'Deebo Samuel', team: 'WSH', stats: { receptions: '3', receivingYards: '48' } }, { id: '6', name: 'Zach Ertz', team: 'WSH', stats: { receptions: '3', receivingYards: '26' } }, { id: '7', name: 'Dallas Goedert', team: 'PHI', stats: { receptions: '4', receivingYards: '31' } }];
  const c = liveCandidates(wide, { ...t, box });
  const slips = buildLiveSlips(c);
  assert.equal(slips.length, 2);
  const core = new Set(slips[0].legs.map((l) => l.player));
  const second = slips[1];
  assert.equal(second.legs.some((l) => core.has(l.player)), false, 'no player on both slips, rebuilt away from the first when they clashed');
  assert.ok(slips.every((s) => s.legs.every((l) => l.onSlips === 1)) && slips.every((s) => s.shared.length === 0));
  // With no other players to turn to, the second slip keeps its legs and the shared players are counted.
  const narrow = buildLiveSlips(liveCandidates(payload, t));
  assert.equal(narrow.length, 1, 'FanDuel prices one player here: no slip');
  const dup = buildLiveSlips([...liveCandidates(payload, t), ...liveCandidates(payload, t).filter((x) => x.bookId === 'draftkings').map((x) => ({ ...x, bookId: 'betmgm', book: 'BetMGM' }))]);
  assert.equal(dup.length, 2);
  assert.ok(dup[1].legs.some((l) => l.onSlips === 2) && dup[1].shared.length > 0, 'the same ladders at two books: the players are shared and say so');
});

test('the board drops a game once it is final, and a stale watch six hours past kick-off with no tick; what is on or about to be stays', async () => {
  const { getLiveBoard, liveGameOver } = await import('../worker/src/live-board.js');
  const kick = Date.UTC(2026, 10, 3, 1, 15);
  assert.equal(liveGameOver({ date: '2026-11-03T01:15Z' }, { state: 'post' }, kick + 3 * 3600e3), true, 'final: gone');
  assert.equal(liveGameOver({ date: '2026-11-03T01:15Z' }, { state: 'in' }, kick + 3 * 3600e3), false);
  assert.equal(liveGameOver({ date: '2026-11-03T01:15Z' }, null, kick - 30 * 60e3), false, 'before kick-off with no tick yet: shown');
  assert.equal(liveGameOver({ date: '2026-11-03T01:15Z' }, null, kick + 7 * 3600e3), true, 'no tick and long over: gone');
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  m.set('live:watch:index', JSON.stringify({ games: [{ id: 'tonight', name: 'Chicago Bears at Seattle Seahawks', date: '2026-11-03T01:15Z', league: 'nfl' }, { id: 'last', name: 'Philadelphia Eagles at Washington Commanders', date: '2026-11-02T01:20Z', league: 'nfl' }] }));
  m.set('live:watch:last', JSON.stringify({ ticks: [{ at: 1, state: 'post', detail: 'Final', score: { WSH: 27, PHI: 10 }, box: [] }] }));
  const board = await getLiveBoard(env, kick - 30 * 60e3);
  assert.deepEqual(board.games.map((g) => g.espnEventId), ['tonight']);
});

test('a deep ladder is read from its cheap end too: the three-leg at +100 comes from the low rungs, not the plus-money ones alone', async () => {
  const { buildLivePlay, liveCandidates } = await import('../worker/src/live-board.js');
  const t = tick({ detail: '7:00 - 2nd Quarter', period: 2, clock: '7:00', score: { PHI: 14, WSH: 10 } }); // close: no script rules anyone out
  // Every rung clears the pace with margin; the plus-money rungs alone multiply past +200, the cheap ones make +100.
  const deep = { bookmakers: [{ key: 'draftkings', markets: [
    { key: 'player_rush_yds_alternate', outcomes: [...ladder('Saquon Barkley', [69.5, 74.5, 79.5, 84.5, 89.5, 94.5, 99.5], [-280, -240, -200, -165, -140, -115, 105]), ...ladder('Jacory Croskey-Merritt', [39.5, 44.5, 49.5, 54.5, 59.5], [-270, -220, -175, -140, -110])] },
    { key: 'player_reception_yds_alternate', outcomes: ladder('Terry McLaurin', [59.5, 64.5, 69.5, 74.5, 79.5, 89.5], [-260, -210, -170, -140, -115, 120]) },
    { key: 'player_pass_yds_alternate', outcomes: ladder('Jalen Hurts', [224.5, 249.5, 274.5], [-250, -180, -120]) },
  ] }] };
  const { buildLivePlay: build } = await import('../worker/src/live-board.js');
  const play = build(liveCandidates(deep, t));
  assert.ok(play, 'a play is built');
  assert.ok(play.american >= -160 && play.american <= 300, `in range: ${play.american}`);
  assert.ok(play.legs.every((l) => l.price <= -110), 'built from the cheap rungs');
});

test('a book priced near even still gets a slip: three legs at FanDuel land past +200 and stay in range', async () => {
  const { buildLivePlay, liveCandidates, PLAY_PRICE } = await import('../worker/src/live-board.js');
  assert.equal(PLAY_PRICE[1], 300);
  const t = tick({ detail: '1:08 - 2nd Quarter', period: 2, clock: '1:08', score: { PHI: 13, WSH: 3 } });
  const fd = (player, pts, prices) => pts.map((point, i) => ({ name: 'Over', description: player, point, price: prices[i] }));
  const tight = { bookmakers: [{ key: 'fanduel', markets: [
    { key: 'player_rush_yds_alternate', outcomes: [...fd('Saquon Barkley', [79.5, 89.5], [-198, -125]), ...fd('Jacory Croskey-Merritt', [49.5], [-162])] },
    { key: 'player_reception_yds_alternate', outcomes: fd('Terry McLaurin', [69.5, 79.5], [-215, -114]) },
  ] }] };
  const play = buildLivePlay(liveCandidates(tight, t));
  assert.ok(play, 'built');
  assert.ok(play.american > 200 && play.american <= 300, `past +200, in range: ${play.american}`);
});

test('hockey: the clock runs three periods, points are goals + assists, shots and saves make candidates, and the two-goal script moves the pace', async () => {
  const { elapsedFraction, liveCandidates, whoToWatch, playerLines, gameScript, intermissionOf, boxValue } = await import('../worker/src/live-board.js');
  assert.equal(elapsedFraction({ state: 'in', period: 2, clock: '10:00' }, 'nhl'), 0.5, 'halfway through the second');
  assert.equal(elapsedFraction({ state: 'in', period: 1, clock: '0:00', detail: 'End of 1st Period' }, 'nhl'), 1 / 3);
  assert.equal(intermissionOf({ state: 'in', detail: 'End of 2nd Period' }, 'nhl'), 2);
  assert.equal(intermissionOf({ state: 'in', detail: '5:00 - 2nd Period' }, 'nhl'), null);
  const t = { at: 1, state: 'in', detail: '10:00 - 2nd Period', period: 2, clock: '10:00', score: { SEA: 3, CHI: 1 }, home: 'SEA', away: 'CHI', box: [
    { id: '1', name: 'Jaden Schwartz', team: 'SEA', stats: { goals: '1', assists: '1', shotsTotal: '3', shootoutGoals: '0' } },
    { id: '2', name: 'Connor Bedard', team: 'CHI', stats: { goals: '0', assists: '0', shotsTotal: '2', shootoutGoals: '0' } },
    { id: '3', name: 'Joey Daccord', team: 'SEA', stats: { saves: '14', goalsAgainst: '1' } },
  ] };
  assert.equal(boxValue(t.box[0], 'points'), 2, 'points from goals + assists');
  assert.deepEqual(gameScript(t, 'nhl'), { leader: 'SEA', trailer: 'CHI', margin: 2 }, 'a two-goal lead is the hockey script');
  const payload = { bookmakers: [{ key: 'draftkings', markets: [
    { key: 'player_shots_on_goal_alternate', outcomes: [{ name: 'Over', description: 'Connor Bedard', point: 2.5, price: -150 }, { name: 'Over', description: 'Jaden Schwartz', point: 4.5, price: -120 }] },
    { key: 'player_total_saves', outcomes: [{ name: 'Over', description: 'Joey Daccord', point: 24.5, price: -115 }] },
    { key: 'player_points', outcomes: [{ name: 'Over', description: 'Jaden Schwartz', point: 2.5, price: 160 }] },
  ] }] };
  const c = liveCandidates(payload, t, 'nhl');
  const bedard = c.find((x) => x.player === 'Connor Bedard');
  assert.ok(bedard && bedard.pace === 4 && bedard.point === 2.5, 'behind by two he shoots more: 2 at the half projects to 4 (4.4 rounded), clearing 2.5 with margin');
  const daccord = c.find((x) => x.player === 'Joey Daccord');
  assert.ok(daccord && daccord.pace === 31, 'the goalie ahead sees more: 14 saves at the half project to 31');
  assert.ok(!c.some((x) => x.player === 'Jaden Schwartz' && x.stat === 'shotsTotal'), 'ahead by two he shoots less: 3 projects to 5, short of 4.5 with margin');
  const lines = playerLines(t, 'nhl');
  assert.equal(lines[0].name, 'Jaden Schwartz'); assert.equal(lines[0].points, 2); assert.equal(lines.find((l) => l.name === 'Joey Daccord').saves, 14);
  const w = whoToWatch(t, c, 'nhl');
  assert.ok(w.some((r) => r.player === 'Joey Daccord' && r.stat === 'saves' && /up two/.test(r.why)));
});

test('soccer: the clock counts up to ninety with stoppage capped, half-time reads the half, and shots make candidates off the roster box', async () => {
  const { elapsedFraction, isHalftime, liveCandidates, playerLines, isSoccer } = await import('../worker/src/live-board.js');
  assert.ok(isSoccer('ucl') && isSoccer('epl') && !isSoccer('nhl'));
  assert.ok(Math.abs(elapsedFraction({ state: 'in', period: 2, clock: "67'" }, 'epl') - 67 / 90) < 1e-9);
  assert.equal(elapsedFraction({ state: 'in', period: 1, clock: "45'+3'" }, 'epl'), 0.5, 'first-half stoppage caps at the half');
  assert.equal(elapsedFraction({ state: 'in', period: 1, clock: '', detail: 'HT' }, 'ucl'), 0.5);
  assert.equal(isHalftime({ state: 'in', detail: 'HT' }, 'ucl'), true);
  const t = { at: 1, state: 'in', detail: "60'", period: 2, clock: "60'", score: { ARS: 1, SLP: 0 }, home: 'SLP', away: 'ARS', box: [
    { id: '1', name: 'Bukayo Saka', team: 'ARS', stats: { totalShots: '3', shotsOnTarget: '2', totalGoals: '1', goalAssists: '0' } },
  ] };
  const payload = { bookmakers: [{ key: 'draftkings', markets: [{ key: 'player_shots_on_target', outcomes: [{ name: 'Over', description: 'Bukayo Saka', point: 2.5, price: -130 }] }, { key: 'player_shots', outcomes: [{ name: 'Over', description: 'Bukayo Saka', point: 3.5, price: -110 }] }] }] };
  const c = liveCandidates(payload, t, 'ucl');
  assert.ok(c.some((x) => x.stat === 'totalShots' && x.pace === 5 && x.point === 3.5), 'three shots at the hour project to five (4.5 rounded), clearing 3.5 with margin');
  assert.ok(!c.some((x) => x.stat === 'shotsOnTarget'), 'two on target project to three, short of 2.5 with margin');
  assert.equal(playerLines(t, 'ucl')[0].totalGoals, 1);
});
