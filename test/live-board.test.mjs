import test from 'node:test';
import assert from 'node:assert/strict';
import { elapsedFraction, isHalftime, liveCandidates, buildLivePlay, getLiveRecap, blowoutRisk, ensureLivePlays, livePlayKey } from '../worker/src/live-board.js';

const tick = (over = {}) => ({ at: 1, state: 'in', detail: 'Halftime', period: 2, clock: '0:00', score: { PHI: 24, WSH: 3 }, box: [
  { id: '1', name: 'Saquon Barkley', team: 'PHI', stats: { rushingAttempts: '14', rushingYards: '68', receptions: '2', receivingYards: '11' } },
  { id: '2', name: 'Jalen Hurts', team: 'PHI', stats: { 'completions/passingAttempts': '12/16', passingYards: '150' } },
  { id: '3', name: 'Terry McLaurin', team: 'WSH', stats: { receptions: '4', receivingYards: '58' } },
  { id: '4', name: 'Jacory Croskey-Merritt', team: 'WSH', stats: { rushingAttempts: '10', rushingYards: '40' } },
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

// The same ladders with a third book priced well short of DraftKings on three players: since 2026-11-26 an NFL slip takes a leg
// only at a book priced out of line with the others, so this is the board an NFL slip builds from.
const marketPayload = { bookmakers: [...payload.bookmakers, { key: 'betrivers', markets: [
  { key: 'player_rush_yds_alternate', outcomes: [...ladder('Saquon Barkley', [89.5], [-240]), ...ladder('Jacory Croskey-Merritt', [49.5], [-260])] },
  { key: 'player_pass_yds_alternate', outcomes: ladder('Jalen Hurts', [199.5], [-340]) },
] }] };

test('the clock reads as a fraction of the game, and the half is the half', () => {
  assert.equal(elapsedFraction({ state: 'pre' }), 0);
  assert.equal(elapsedFraction({ state: 'in', period: 1, clock: '7:30' }), 0.125);
  assert.equal(elapsedFraction({ state: 'in', period: 3, clock: '15:00' }), 0.5);
  // A clock under a minute shows seconds with tenths; the end of a period has no clock worth reading.
  assert.ok(Math.abs(elapsedFraction({ state: 'in', period: 1, clock: '31.1', detail: '31.1 - 1st Quarter' }, 'nba') - (12 - 31.1 / 60) / 48) < 1e-9);
  assert.ok(Math.abs(elapsedFraction({ state: 'in', period: 1, clock: ':31', detail: ':31 - 1st' }, 'nfl') - (15 - 31 / 60) / 60) < 1e-9);
  assert.equal(elapsedFraction({ state: 'in', period: 1, clock: '0.0', detail: 'End of 1st Quarter' }, 'nba'), 0.25);
  assert.equal(elapsedFraction({ state: 'in', period: 2, clock: '', detail: 'End of 2nd Period' }, 'nhl'), 2 / 3);
  assert.equal(elapsedFraction({ state: 'in', period: 2, clock: 'garbage' }, 'nba'), 0.25);
  assert.equal(elapsedFraction(tick()), 0.5);
  assert.equal(isHalftime(tick()), true);
  assert.equal(isHalftime({ state: 'in', period: 3, clock: '14:50', detail: '14:50 - 3rd' }), false);
  assert.equal(elapsedFraction({ state: 'in', period: 2, clock: '6:00' }, 'nba'), 0.375);
});

test('candidates are the Overs the pace clears with margin, in range, with the game script applied: the side up big leans on the run', () => {
  const c = liveCandidates(payload, tick());
  const sel = (p) => c.filter((x) => x.player === p).map((x) => [x.bookId, x.point, x.price]);
  assert.deepEqual(sel('Saquon Barkley'), [['fanduel', 79.5, -230], ['draftkings', 79.5, -250], ['draftkings', 89.5, -140]], '68 on fourteen carries at the half: the eleven and the twenty-one yards still needed are likelier than their prices say; -500 is too short for a leg, and the two priced longer than -130 (FanDuel 89.5 at -125, DraftKings 99.5 at +110) are left out since the 2026-11-18 review');
  assert.deepEqual(sel('Jalen Hurts'), [], 'the side up 21 sits its passing game');
  assert.deepEqual(sel('Jacory Croskey-Merritt'), [], 'the side down 21 throws: its rushing lines are passed over');
  assert.deepEqual(sel('Terry McLaurin'), [['draftkings', 69.5, -280], ['draftkings', 79.5, -150]], '58 on four catches, the side down big throwing: both are a little likelier than their prices say; 99.5 at +130 is not a leg');
  // What is expected of him by the end: 68, and fourteen carries' worth of the half to come at 0.6 of his rate, lifted a sixth for the run game: about 47 more.
  assert.equal(c[0].current, 68); assert.equal(c[0].pace, 115);
  assert.ok(c.every((x) => x.chance > 0 && x.edge > 0 && Number.isFinite(x.cushion)), 'every NFL leg carries its chance and how far that sits over its price');
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
  assert.deepEqual([saquon.current, saquon.projected, saquon.line.bookId, saquon.line.point], [68, 136, 'draftkings', 89.5]);
  assert.deepEqual(saquon.lines.map((l) => [l.bookId, l.point]), [['draftkings', 89.5], ['fanduel', 79.5]], 'the best clearing line at each book, for a user who plays at one (among the numbers priced -130 or shorter)');
  const slips = buildLiveSlips(c);
  assert.deepEqual(slips.map((s) => s.bookId), ['draftkings'], 'FanDuel prices only one player: no slip there');
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  assert.equal(await ensureLivePlays(env, { id: 'g', name: 'A at B' }, marketPayload, { ...t, detail: '14:50 - 1st Quarter', period: 1, clock: '14:50' }), null, 'the first seconds: nothing to build on yet');
  assert.ok((await ensureLivePlays(env, { id: 'g', name: 'A at B' }, marketPayload, { ...t, detail: '10:00 - 1st Quarter', period: 1, clock: '10:00' }))?.slips, 'five minutes in: a slip builds (2026-11-05: not by the quarter)');
  m.clear();
  const q2 = await ensureLivePlays(env, { id: 'g', name: 'A at B' }, marketPayload, { ...t, detail: '7:00 - 2nd Quarter', period: 2, clock: '7:00' }, { now: 8 });
  assert.equal(q2.slips.length, 1); assert.deepEqual([q2.builtAt, q2.firstBuiltAt, q2.builds, q2.period, q2.clock], [8, 8, 1, 2, '7:00'], 'built in the second quarter, not only at the half');
  assert.deepEqual([q2.slips[0].bookId, q2.slips[0].legs.length], ['draftkings', 2], 'an NFL slip is two legs, at the book priced out of line with the others');
  assert.ok(q2.slips[0].legs.every((l) => l.marketEdge >= 0.04 && l.stat !== 'receptions'));
  const built = await ensureLivePlays(env, { id: 'g', name: 'A at B' }, marketPayload, t, { now: 9 });
  assert.deepEqual([built.builtAt, built.firstBuiltAt, built.builds, built.detail], [9, 8, 2, 'Halftime'], 'rebuilt at the half from the ladders now');
  const again = await ensureLivePlays(env, { id: 'g', name: 'A at B' }, { bookmakers: [] }, t, { now: 10 });
  assert.equal(again.builtAt, 9, 'no ladders this tick: the last build stands');
  const late = await ensureLivePlays(env, { id: 'g', name: 'A at B' }, marketPayload, { ...t, detail: '2:00 - 4th Quarter', period: 4, clock: '2:00' }, { now: 11 });
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
  const box = [...t.box, { id: '5', name: 'Deebo Samuel', team: 'WSH', stats: { receptions: '3', receivingYards: '48' } }, { id: '6', name: 'Zach Ertz', team: 'WSH', stats: { receptions: '9', receivingYards: '26' } }, { id: '7', name: 'Dallas Goedert', team: 'PHI', stats: { receptions: '8', receivingYards: '31' } }];
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
  assert.deepEqual([board.day, board.leagues], ['2026-11-02', ['nba', 'nfl']]);
});

test('the board is today only, Eastern, and only what is still to play: a game that has ended comes off, a late game in play past midnight stays, the rest of the week goes, and a league not on is left off', async () => {
  const { getLiveBoard } = await import('../worker/src/live-board.js');
  const now = Date.UTC(2026, 10, 6, 5, 30); // Fri 00:30 ET: still Thursday night's late game
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  m.set('live:watch:index:nba', JSON.stringify({ games: [
    { id: 'late', name: 'Miami Heat at Golden State Warriors', date: '2026-11-06T03:00Z', league: 'nba' },
    { id: 'early', name: 'Orlando Magic at Phoenix Suns', date: '2026-11-06T02:00Z', league: 'nba' },
    { id: 'tomorrow', name: 'Boston Celtics at New York Knicks', date: '2026-11-07T00:30Z', league: 'nba' },
  ] }));
  m.set('live:watch:index:nfl', JSON.stringify({ games: [
    { id: 'tnf', name: 'Jacksonville Jaguars at Baltimore Ravens', date: '2026-11-06T01:15Z', league: 'nfl' },
    { id: 'sunday', name: 'Green Bay Packers at New England Patriots', date: '2026-11-08T21:25Z', league: 'nfl' },
  ] }));
  m.set('live:watch:index:nhl', JSON.stringify({ games: [{ id: 'puck', name: 'Boston Bruins at Pittsburgh Penguins', date: '2026-11-06T00:00Z', league: 'nhl' }] }));
  const tick = (state, score) => JSON.stringify({ ticks: [{ at: now - 60e3, state, detail: state === 'post' ? 'Final' : 'Q4', period: 4, clock: '2:00', score, box: [] }] });
  m.set('live:watch:late', tick('in', { GS: 100, MIA: 98 }));
  m.set('live:watch:early', tick('post', { PHX: 110, ORL: 101 }));
  m.set('live:watch:tnf', tick('post', { BAL: 24, JAX: 17 }));
  m.set('live:watch:puck', tick('in', { PIT: 2, BOS: 2 }));
  m.set('live:watch:beat:nba', JSON.stringify({ at: now - 30e3, league: 'nba', inPlay: 1, left: 1, next: null }));
  const board = await getLiveBoard(env, now);
  assert.equal(board.day, '2026-11-06', 'half past midnight Eastern is the next day');
  assert.deepEqual(board.games.map((g) => g.espnEventId).sort(), ['late', 'tomorrow'], 'past midnight: the game still in play crosses with the new day\'s slate; the finals of the day before and the rest of the week are off');
  assert.equal(board.watcher.nba.inPlay, 1);
  const evening = await getLiveBoard(env, Date.UTC(2026, 10, 6, 4, 0)); // Thu 11 PM ET
  // 2026-11-23: "when the games are over, remove the game cards from the live section".
  assert.deepEqual(evening.games.map((g) => g.espnEventId).sort(), ['late'], 'Thursday evening: the game in play is listed; the two finals of the day are off it; Sunday and Friday are not listed; the NHL game is off');
  // The same evening before the Suns game ended: it is on the board until its final whistle.
  m.set('live:watch:early', tick('in', { PHX: 104, ORL: 99 }));
  assert.deepEqual((await getLiveBoard(env, Date.UTC(2026, 10, 6, 4, 0))).games.map((g) => g.espnEventId).sort(), ['early', 'late']);
});

test('the board carries every line one book has up when asked: any price, the slips\' own legs marked, nothing for a game still to start, and nothing unasked', async () => {
  const { getLiveBoard, bookLegs } = await import('../worker/src/live-board.js');
  const now = Date.UTC(2026, 10, 3, 2, 45);
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  m.set('live:watch:index', JSON.stringify({ games: [{ id: 'mnf', name: 'Philadelphia Eagles at Washington Commanders', date: '2026-11-03T01:15Z', league: 'nfl' }, { id: 'later', name: 'Chicago Bears at Seattle Seahawks', date: '2026-11-03T04:15Z', league: 'nfl' }] }));
  m.set('live:watch:mnf', JSON.stringify({ ticks: [tick({ at: now - 60e3, score: { PHI: 14, WSH: 10 } })] }));
  m.set('live:probe:for:mnf', 'ev1');
  m.set('live:probe:ev1:latest', JSON.stringify(payload));
  const plain = await getLiveBoard(env, now);
  assert.equal('legs' in plain.games[0], false, 'unasked: no legs on the board');
  assert.equal('legsBook' in plain, false);
  const board = await getLiveBoard(env, now, { legsBook: 'draftkings' });
  assert.equal(board.legsBook, 'draftkings');
  const mnf = board.games.find((g) => g.espnEventId === 'mnf');
  const at = (player, point) => mnf.legs.find((l) => l.player === player && l.point === point);
  // 2026-11-26, the owner: "show all legs. Not just good pacing legs". Every DraftKings line a player has not cleared is there:
  // the short one, the plus-money ones, the far rung.
  assert.deepEqual(mnf.legs.filter((l) => l.player === 'Saquon Barkley').map((l) => [l.point, l.price]).sort((a, b) => a[0] - b[0]), [[69.5, -500], [79.5, -250], [89.5, -140], [99.5, 110], [119.5, 220]]);
  assert.deepEqual(mnf.legs.filter((l) => l.player === 'Terry McLaurin').map((l) => l.point).sort((a, b) => a - b), [69.5, 79.5, 99.5]);
  assert.equal(mnf.legs.length, 12, 'every line on the DraftKings ladders');
  assert.ok(mnf.legs.every((l) => l.bookId === 'draftkings' && l.current < l.point));
  assert.equal(new Set(mnf.legs.map((l) => `${l.player}|${l.stat}|${l.point}`)).size, mnf.legs.length, 'one row a player, stat and number');
  assert.deepEqual(Object.keys(mnf.legs[0]).sort(), ['book', 'bookId', 'current', 'label', 'link', 'pick', 'player', 'point', 'price', 'stat', 'team']);
  // The ones the slips' own bar clears are marked, and come first; a plus-money rung is not one.
  assert.equal(at('Saquon Barkley', 79.5).pick, true);
  assert.equal(at('Saquon Barkley', 119.5).pick, false);
  assert.equal(at('Saquon Barkley', 69.5).pick, false, '-500 is too short to be a leg of ours');
  const firstOther = mnf.legs.findIndex((l) => !l.pick);
  assert.ok(firstOther > 0 && mnf.legs.slice(firstOther).every((l) => !l.pick));
  assert.deepEqual(board.games.find((g) => g.espnEventId === 'later').legs, [], 'not in play: no legs');
  const fd = await getLiveBoard(env, now, { legsBook: 'fanduel' });
  assert.deepEqual(fd.games.find((g) => g.espnEventId === 'mnf').legs.map((l) => [l.player, l.point, l.price, l.pick]), [['Saquon Barkley', 79.5, -230, true], ['Saquon Barkley', 89.5, -125, false]]);
  // A blowout: the slips are withheld, so no line is marked as theirs, but the lines are still listed.
  m.set('live:watch:mnf', JSON.stringify({ ticks: [tick({ at: now - 60e3, detail: '5:00 - 4th', period: 4, clock: '5:00', score: { PHI: 34, WSH: 3 } })] }));
  const blown = (await getLiveBoard(env, now, { legsBook: 'draftkings' })).games.find((g) => g.espnEventId === 'mnf');
  assert.equal(blown.blowout.blowout, true);
  assert.ok(blown.legs.length === 12 && blown.legs.every((l) => l.pick === false));
  // A line already cleared is not a leg; a stat a player has nothing in yet stands at zero; a player not in the box is not listed;
  // a number at the same book twice keeps its best price.
  const t = tick({ score: { PHI: 14, WSH: 10 } });
  const over = (player, point, price) => ({ name: 'Over', description: player, point, price });
  const legs = bookLegs({ bookmakers: [{ key: 'fanduel', markets: [
    { key: 'player_rush_yds', outcomes: [over('Saquon Barkley', 59.5, -900), over('Saquon Barkley', 79.5, -230), over('Not Playing', 9.5, -110)] },
    { key: 'player_rush_yds_alternate', outcomes: [over('Saquon Barkley', 79.5, -210)] },
    { key: 'player_reception_yds_alternate', outcomes: [over('Jacory Croskey-Merritt', 4.5, 120)] },
    { key: 'player_receptions_alternate', outcomes: [over('Terry McLaurin', 4.5, -160), { name: 'Under', description: 'Terry McLaurin', point: 4.5, price: 120 }] },
  ] }, { key: 'draftkings', markets: [{ key: 'player_rush_yds', outcomes: [over('Saquon Barkley', 89.5, -140)] }] }] }, t, 'nfl', 'fanduel', []);
  assert.deepEqual(legs.map((l) => [l.player, l.stat, l.point, l.price, l.current]).sort(), [['Jacory Croskey-Merritt', 'receivingYards', 4.5, 120, 0], ['Saquon Barkley', 'rushingYards', 79.5, -210, 68], ['Terry McLaurin', 'receptions', 4.5, -160, 4]].sort());
  assert.deepEqual(bookLegs(null, t, 'nfl', 'fanduel'), []);
  assert.deepEqual(bookLegs(payload, t, 'nfl', null), []);
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

test('playSummary: the best slip cushion against the best game-line edge, as a score and stars; nothing playable is zero', async () => {
  const { playSummary } = await import('../worker/src/live-board.js');
  const slips = [{ legs: [{ cushion: 0.6 }, { cushion: 0.4 }] }, { legs: [{ cushion: 0.1 }] }];
  const reads = [{ best: { edge: 0.1 } }];
  assert.deepEqual(playSummary(slips, reads), { playable: true, score: 0.5, stars: 5, slips: 2, reads: 1 });
  assert.deepEqual(playSummary([], reads), { playable: true, score: 0.25, stars: 3, slips: 0, reads: 1 }, 'a 10% edge reads as a quarter');
  assert.deepEqual(playSummary([], []), { playable: false, score: 0, stars: 0, slips: 0, reads: 0 });
});

test('projectStat: early in the game the pace is blended with the book number, so a hot first minute does not read as a hundred-point night; by a quarter in it is the pace alone', async () => {
  const { projectStat, BUILD_FROM, EARLY_BLEND } = await import('../worker/src/live-board.js');
  assert.ok(BUILD_FROM <= 0.05, 'slips build from the first minutes');
  assert.equal(projectStat(4, 0.05, 'points', { league: 'nba', prior: 20 }), 32, '80 on pace, 20 on the number, a fifth of the way to the blend: 0.2*80 + 0.8*20');
  assert.equal(projectStat(4, 0.05, 'points', { league: 'nba' }), 80, 'no prior: the raw pace');
  assert.equal(projectStat(10, EARLY_BLEND, 'points', { league: 'nba', prior: 20 }), 40, 'a quarter in: the pace alone');
});

test('getLiveRecap grades each stored slip against the final box at one unit', async () => {
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  m.set('live:watch:index:nba', JSON.stringify({ games: [{ id: '9', name: 'Bulls at Knicks', league: 'nba', date: '2026-11-05T00:30:00Z' }, { id: '10', name: 'Heat at Clippers', league: 'nba', date: '2026-11-05T03:30:00Z' }] }));
  m.set('live:watch:9', JSON.stringify({ ticks: [{ state: 'in', box: [] }, { state: 'post', score: { NY: 110, CHI: 100 }, detail: 'Final', box: [
    { name: 'Landry Shamet', team: 'NY', stats: { points: '12' } }, { name: 'Josh Giddey', team: 'CHI', stats: { points: '8' } }, { name: 'OG Anunoby', team: 'NY', stats: { points: '20' } },
  ] }] }));
  m.set('live:play:9', JSON.stringify({ builtAt: 5, firstBuiltAt: 1, builds: 3, period: 3, clock: '4:00', elapsed: 0.6, score: { NY: 80, CHI: 70 }, slips: [
    { bookId: 'fanduel', book: 'FanDuel', american: 152, decimal: 2.52, legs: [{ player: 'Landry Shamet', stat: 'points', point: 9.5, price: -270, current: 8, pace: 13, cushion: 0.37 }, { player: 'OG Anunoby', stat: 'points', point: 14.5, price: -280 }] },
    { bookId: 'draftkings', book: 'DraftKings', american: 142, decimal: 2.42, legs: [{ player: 'Josh Giddey', stat: 'points', point: 9.5, price: -280 }, { player: 'OG Anunoby', stat: 'points', point: 14.5, price: -280 }] },
    { bookId: 'caesars', book: 'Caesars', american: 150, legs: [{ player: 'Nobody Here', stat: 'points', point: 9.5, price: -280 }] },
  ] }));
  const r = await getLiveRecap(env, 99);
  assert.equal(r.games.length, 2);
  const g = r.games.find((x) => x.id === '9'); const none = r.games.find((x) => x.id === '10');
  assert.equal(r.games[0].id, '10'); // newest first, as the index reads
  assert.equal(g.state, 'post'); assert.deepEqual(g.score, { NY: 110, CHI: 100 }); assert.equal(g.built.builds, 3);
  assert.deepEqual(g.slips.map((s) => [s.result, s.units]), [['win', 1.52], ['loss', -1], ['open', 0]]);
  assert.deepEqual(g.slips[1].legs.map((l) => [l.final, l.hit]), [[8, false], [20, true]]);
  assert.equal(g.slips[2].legs[0].hit, null);
  // What the leg was built on stays with its result; a leg stored before that was kept reads null.
  assert.deepEqual(g.slips[0].legs.map((l) => [l.current, l.pace, l.cushion]), [[8, 13, 0.37], [null, null, null]]);
  assert.equal(none.built, null); assert.deepEqual(none.slips, []); assert.equal(none.state, null);
  assert.deepEqual(r.totals, { slips: 2, wins: 1, units: 0.52 });
});

test('blowoutRisk: the lead against the time left; a blowout withholds live bets', () => {
  // Bulls at Knicks, 43-21 at the end of the first: the starters sat, every slip died.
  const q1 = blowoutRisk({ state: 'in', period: 1, clock: '0.0', detail: 'End of 1st Quarter', score: { NY: 43, CHI: 21 } }, 'nba');
  assert.equal(q1.blowout, true); assert.equal(q1.leader, 'NY'); assert.equal(q1.margin, 22); assert.equal(q1.minutesLeft, 36);
  assert.equal(blowoutRisk({ state: 'in', period: 2, clock: '0:00', detail: 'Halftime', score: { BOS: 60, MIL: 50 } }, 'nba').blowout, false, 'ten up at the half is a game');
  assert.equal(blowoutRisk({ state: 'in', period: 4, clock: '6:00', detail: '6:00 - 4th Quarter', score: { DEN: 110, TOR: 95 } }, 'nba').blowout, true, 'fifteen up with six left');
  assert.equal(blowoutRisk({ state: 'in', period: 2, clock: '0:00', detail: 'Halftime', score: { PHI: 24, WSH: 3 } }, 'nfl').blowout, false, 'three scores at the half is not yet a blowout in football');
  assert.equal(blowoutRisk({ state: 'in', period: 4, clock: '10:00', score: { PHI: 31, WSH: 10 } }, 'nfl').blowout, true);
  assert.equal(blowoutRisk({ state: 'in', period: 3, clock: '5:00', detail: '5:00 - 3rd Period', score: { FLA: 3, CHI: 0 } }, 'nhl').blowout, true);
  assert.equal(blowoutRisk({ state: 'in', period: 2, clock: '20:00', detail: '20:00 - 2nd Period', score: { FLA: 2, CHI: 0 } }, 'nhl').blowout, false);
  assert.equal(blowoutRisk({ state: 'pre', score: { NY: 0, CHI: 0 } }, 'nba'), null);
  assert.equal(blowoutRisk({ state: 'in', period: 1, clock: '5:00', score: { NY: 10, CHI: 10 } }, 'nba'), null, 'level pegging is no risk');
});

test('ensureLivePlays: a blowout builds no slip', async () => {
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  const game = { id: '77', name: 'Washington Commanders at Philadelphia Eagles' };
  const rout = tick({ state: 'in', period: 4, clock: '10:00', detail: '10:00 - 4th Quarter', score: { PHI: 31, WSH: 10 } });
  assert.equal(await ensureLivePlays(env, game, marketPayload, rout, { league: 'nfl', now: 5 }), null);
  assert.equal(m.has(livePlayKey('77')), false, 'nothing stored');
  const close = tick({ state: 'in', period: 3, clock: '10:00', detail: '10:00 - 3rd Quarter', score: { PHI: 17, WSH: 14 } });
  const built = await ensureLivePlays(env, game, marketPayload, close, { league: 'nfl', now: 6 });
  assert.ok(built && built.slips.length, 'a close game builds');
});

import { foulTrouble, carrySlips, FOUL_LIMIT } from '../worker/src/live-board.js';

test('foulTrouble: two in the first, three by the half, four in the third, five in the fourth; three or more and one away is close enough', () => {
  const p = (fouls) => ({ stats: { fouls: String(fouls) } });
  const at = (period, extra = {}) => ({ state: 'in', period, clock: '6:00', detail: `6:00 - ${period}`, ...extra });
  assert.deepEqual(FOUL_LIMIT, [2, 3, 4, 5]);
  assert.equal(foulTrouble(p(1), at(1)), null);
  assert.deepEqual(foulTrouble(p(2), at(1)), { fouls: 2, level: 'trouble', text: '2 fouls in the first quarter: in foul trouble' });
  assert.equal(foulTrouble(p(2), at(2)), null, 'two in the second is playable');
  assert.equal(foulTrouble(p(3), at(2)).level, 'trouble');
  assert.deepEqual(foulTrouble(p(3), at(3)), { fouls: 3, level: 'watch', text: '3 fouls: one from foul trouble' });
  assert.equal(foulTrouble(p(4), at(3)).level, 'trouble');
  assert.equal(foulTrouble(p(3), at(4)), null, 'three in the fourth has room');
  assert.equal(foulTrouble(p(4), at(4)).level, 'watch');
  assert.equal(foulTrouble(p(5), at(4)).level, 'trouble');
  assert.equal(foulTrouble(p(5), at(5)).level, 'trouble', 'overtime reads as the fourth');
  // At the half the third quarter's limit is the one ahead: three fouls is one away.
  assert.equal(foulTrouble(p(3), at(2, { detail: 'Halftime', clock: '0:00' })).level, 'watch');
  assert.equal(foulTrouble(p(2), at(2, { detail: 'Halftime', clock: '0:00' })), null);
  assert.equal(foulTrouble({ stats: { points: '10' } }, at(3)), null, 'no foul count in the box');
  assert.equal(foulTrouble(p(5), at(4), 'nfl'), null, 'the NBA only');
});

const nbaTick = (box, over = {}) => ({ at: 1, state: 'in', detail: '6:00 - 2nd', period: 2, clock: '6:00', score: { NY: 48, BOS: 45 }, box, ...over });
const nbaPayload = (players) => ({ bookmakers: [{ key: 'draftkings', markets: [{ key: 'player_points_alternate', outcomes: players.flatMap(([name, pts, prices]) => ladder(name, pts, prices)) }] }] });

test('live candidates leave out an NBA player in or near foul trouble', () => {
  const box = [
    { id: '1', name: 'Jalen Brunson', team: 'NY', stats: { points: '16', fouls: '1' } },
    { id: '2', name: 'Jayson Tatum', team: 'BOS', stats: { points: '15', fouls: '3' } },
  ];
  const pay = nbaPayload([['Jalen Brunson', [19.5, 24.5], [-250, -120]], ['Jayson Tatum', [19.5, 24.5], [-240, -115]]]);
  const players = (t) => [...new Set(liveCandidates(pay, t, 'nba').map((c) => c.player))];
  assert.deepEqual(players(nbaTick(box)), ['Jalen Brunson'], 'three fouls in the second quarter: left out');
  const clean = box.map((p) => ({ ...p, stats: { ...p.stats, fouls: '1' } }));
  assert.deepEqual(players(nbaTick(clean)).sort(), ['Jalen Brunson', 'Jayson Tatum']);
});

test('carrySlips keeps a standing play with the time it was posted and each leg\'s number then, and replaces one that no longer stands', () => {
  const T0 = 1_000_000; const T1 = T0 + 5 * 60e3; const T2 = T1 + 4 * 60e3;
  const leg = (player, point, current, price = -150) => ({ bookId: 'draftkings', book: 'DraftKings', market: 'player_points_alternate', stat: 'points', label: 'Pts', player, team: 'NY', point, price, decimal: 1 + 100 / -price, current, pace: point * 1.4, cushion: 0.4, link: null });
  const slip = (legs) => ({ bookId: 'draftkings', book: 'DraftKings', legs, decimal: legs.reduce((d, l) => d * l.decimal, 1), american: 120, score: 1 });
  const box = (pts, fouls = {}) => ['Jalen Brunson', 'Mikal Bridges', 'Josh Hart', 'OG Anunoby'].map((name, i) => ({ id: String(i), name, team: 'NY', stats: { points: String(pts[i]), fouls: String(fouls[name] ?? 0) } }));
  // Posted at T0: Brunson 25+ with 8 on the board.
  const first = carrySlips(null, [slip([leg('Jalen Brunson', 24.5, 8), leg('Mikal Bridges', 14.5, 6), leg('Josh Hart', 9.5, 4)])], [], nbaTick(box([8, 6, 4, 5])), { now: T0, league: 'nba' });
  assert.deepEqual([first[0].postedAt, first[0].postedAmerican], [T0, 120]);
  assert.deepEqual(first[0].legs.map((l) => [l.postedAt, l.postedCurrent, l.postedPrice]), [[T0, 8, -150], [T0, 6, -150], [T0, 4, -150]]);
  // Five minutes on the board still carries all three lines (repriced), and the builder now likes a different slip: the posted one stands.
  const cands = [leg('Jalen Brunson', 24.5, 10, -175), leg('Mikal Bridges', 14.5, 9, -200), leg('Josh Hart', 9.5, 4, -140), leg('OG Anunoby', 12.5, 7, -130)];
  const other = slip([leg('OG Anunoby', 12.5, 7, -130), leg('Mikal Bridges', 14.5, 9, -200), leg('Josh Hart', 9.5, 4, -140)]);
  const second = carrySlips(first, [other], cands, nbaTick(box([10, 9, 4, 7])), { now: T1, league: 'nba' });
  assert.equal(second.length, 1);
  assert.equal(second[0].postedAt, T0, 'still the play posted five minutes ago');
  assert.deepEqual(second[0].legs.map((l) => l.player), ['Jalen Brunson', 'Mikal Bridges', 'Josh Hart']);
  const brunson = second[0].legs[0];
  assert.deepEqual([brunson.postedCurrent, brunson.current, brunson.postedPrice, brunson.price], [8, 10, -150, -175], '8 when posted, 10 now; the price follows the board');
  assert.equal(second[0].postedAmerican, 120);
  assert.notEqual(second[0].american, 120, 'the slip\'s price is recomputed from the legs as they are priced now');
  // A cleared leg needs no line on the board to stand.
  const third = carrySlips(second, [other], cands.filter((c) => c.player !== 'Mikal Bridges'), nbaTick(box([12, 15, 5, 7])), { now: T1 + 60e3, league: 'nba' });
  assert.equal(third[0].postedAt, T0);
  // Hart picks up his third foul in the second quarter: the play no longer stands, and the new build is posted now.
  const fouled = nbaTick(box([14, 15, 5, 8], { 'Josh Hart': 3 }));
  const withoutHart = slip([leg('Jalen Brunson', 24.5, 14, -200), leg('OG Anunoby', 12.5, 8, -130)]);
  const fourth = carrySlips(third, [withoutHart], cands.filter((c) => c.player !== 'Josh Hart'), fouled, { now: T2, league: 'nba' });
  assert.deepEqual([fourth[0].postedAt, fourth[0].replaced], [T2, true]);
  assert.deepEqual(fourth[0].legs.map((l) => [l.player, l.postedAt, l.postedCurrent]), [['Jalen Brunson', T0, 8], ['OG Anunoby', T2, 8]], 'a leg the two plays share keeps its own first stamp');
  // A book with no new build keeps the play it has while that play stands; one that does not stand goes.
  assert.equal(carrySlips(first, [], cands, nbaTick(box([10, 9, 4, 7])), { now: T1, league: 'nba' })[0].postedAt, T0);
  assert.deepEqual(carrySlips(first, [], [], nbaTick(box([10, 9, 4, 7])), { now: T1, league: 'nba' }), []);
  // A play stored before the stamps existed gets them on its first carry.
  const old = [slip([leg('Jalen Brunson', 24.5, 8)])];
  const stamped = carrySlips(old, [], cands, nbaTick(box([10, 9, 4, 7])), { now: T1, league: 'nba' });
  assert.deepEqual([stamped[0].postedAt, stamped[0].legs[0].postedAt, stamped[0].legs[0].postedCurrent], [T1, T1, 8]);
});

test('ensureLivePlays stores the posting stamps, and the board reports a posted leg\'s fouls', async () => {
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  const game = { id: 'g-nba', name: 'Boston Celtics at New York Knicks', date: new Date().toISOString() };
  const box = (pts) => [['Jalen Brunson', 'NY'], ['Mikal Bridges', 'NY'], ['Josh Hart', 'NY'], ['Jayson Tatum', 'BOS']].map(([name, team], i) => ({ id: String(i), name, team, stats: { points: String(pts[i]), fouls: '0' } }));
  const pay = nbaPayload([['Jalen Brunson', [19.5, 24.5], [-250, -120]], ['Mikal Bridges', [12.5, 14.5], [-230, -125]], ['Josh Hart', [8.5, 9.5], [-220, -130]], ['Jayson Tatum', [19.5, 22.5], [-240, -130]]]);
  const a = await ensureLivePlays(env, game, pay, nbaTick(box([16, 11, 7, 15])), { league: 'nba', now: 1000 });
  assert.ok(a.slips.length >= 1);
  assert.equal(a.slips[0].postedAt, 1000);
  assert.ok(a.slips[0].legs.every((l) => l.postedAt === 1000 && Number.isFinite(l.postedCurrent)));
  const b = await ensureLivePlays(env, game, pay, nbaTick(box([18, 12, 7, 17])), { league: 'nba', now: 1000 + 5 * 60e3 });
  assert.equal(b.slips[0].postedAt, 1000, 'the same play, five minutes on');
  const moved = b.slips[0].legs.find((l) => l.current !== l.postedCurrent);
  assert.ok(moved, 'at least one leg has moved since it was posted');
  assert.ok(moved.current > moved.postedCurrent);
});

test('NBA rebound and assist legs need more cushion than points, more again above 5.5; NBA and NFL legs are priced -130 or shorter', async () => {
  const { marginFor, legPriceFor, LEG_PRICE, LEG_PRICE_TIGHT, COUNT_MARGIN, COUNT_MARGIN_HIGH } = await import('../worker/src/live-board.js');
  // The review of 2026-11-18: points 79% against a 70% price; rebounds 61% and assists 65% against 69%; above 5.5, 52% against 70%.
  assert.equal(marginFor('points', 24.5, 'nba'), 1.25);
  assert.equal(marginFor('rebounds', 4.5, 'nba'), COUNT_MARGIN);
  assert.equal(marginFor('assists', 5.5, 'nba'), COUNT_MARGIN);
  assert.equal(marginFor('rebounds', 6.5, 'nba'), COUNT_MARGIN_HIGH);
  assert.equal(marginFor('assists', 8.5, 'nba'), COUNT_MARGIN_HIGH);
  assert.equal(marginFor('assists', 8.5, 'nhl'), 1.25, 'a hockey assist is not an NBA assist');
  assert.equal(marginFor('receptions', 4.5, 'nfl'), 1.25);
  assert.deepEqual([legPriceFor('nba'), legPriceFor('nfl'), legPriceFor('nhl'), legPriceFor('epl')], [LEG_PRICE_TIGHT, LEG_PRICE_TIGHT, LEG_PRICE, LEG_PRICE]);

  // Third quarter, 6:00 left: 62.5% of the game in. Each player's pace is his number over 0.625.
  const t = { at: 1, state: 'in', detail: '6:00 - 3rd Quarter', period: 3, clock: '6:00', score: { AAA: 70, BBB: 68 }, box: [
    { id: '1', name: 'P Scorer', team: 'AAA', stats: { points: '15', rebounds: '3', assists: '2', fouls: '1' } },      // pace 24 points
    { id: '2', name: 'R Boarder', team: 'AAA', stats: { points: '8', rebounds: '5', assists: '1', fouls: '1' } },      // pace 8 rebounds
    { id: '3', name: 'A Passer', team: 'BBB', stats: { points: '9', rebounds: '2', assists: '6', fouls: '2' } },       // pace 9.6 assists -> 10
  ] };
  const book = (markets) => ({ bookmakers: [{ key: 'draftkings', markets }] });
  const over = (player, point, price) => ({ name: 'Over', description: player, point, price });
  const c = liveCandidates(book([
    { key: 'player_points_alternate', outcomes: [over('P Scorer', 18.5, -220), over('P Scorer', 19.5, -150), over('P Scorer', 17.5, -120)] },
    { key: 'player_rebounds_alternate', outcomes: [over('R Boarder', 5.5, -230), over('R Boarder', 6.5, -160)] },
    { key: 'player_assists_alternate', outcomes: [over('A Passer', 6.5, -260), over('A Passer', 7.5, -170)] },
  ]), t, 'nba');
  const got = c.map((x) => [x.player, x.point, x.price]);
  // Points: 24 on pace clears 18.5 by 30%: in at 1.25. 19.5 is cleared by 23%: out. 17.5 clears but is priced -120: out on price.
  assert.deepEqual(got.filter((x) => x[0] === 'P Scorer'), [['P Scorer', 18.5, -220]]);
  // Rebounds: 8 on pace clears 5.5 by 45%: in, just. It clears 6.5 by 23%: a points leg with that cushion would be out too, and a rebound leg above 5.5 needs 60%.
  assert.deepEqual(got.filter((x) => x[0] === 'R Boarder'), [['R Boarder', 5.5, -230]]);
  // Assists: 10 on pace clears 6.5 by 54%, short of the 60% a line above 5.5 needs: out, though it would have been a leg before (25%).
  assert.deepEqual(got.filter((x) => x[0] === 'A Passer'), []);
  // The same numbers as a hockey stat line keep the old bar and the wide price range.
  const nhl = liveCandidates(book([{ key: 'player_shots_on_goal_alternate', outcomes: [over('P Scorer', 2.5, -115)] }]), { ...t, detail: '10:00 - 2nd', period: 2, clock: '10:00', box: [{ id: '1', name: 'P Scorer', team: 'AAA', stats: { shotsTotal: '2' } }] }, 'nhl');
  assert.deepEqual(nhl.map((x) => [x.point, x.price]), [[2.5, -115]]);
});

test('a catch comes whole (the 2026-11-23 bars, kept with their review); since 2026-11-26 no reception leg is taken and a yardage leg is judged on what is left against its price', async () => {
  const { catchChance, RECEPTION_MIN_CHANCE, YARDS_MIN_CATCH_CHANCE } = await import('../worker/src/live-board.js');
  assert.deepEqual([RECEPTION_MIN_CHANCE, YARDS_MIN_CATCH_CHANCE], [0.85, 0.8]);
  // One catch after 64% of the game, needing a second: about 43%, whatever the pace says. (2026-11-22: seven such legs, one hit.)
  assert.ok(Math.abs(catchChance(1, 1.5, 0.64) - (1 - Math.exp(-0.5625))) < 1e-9);
  assert.ok(catchChance(1, 1.5, 0.64) < 0.45);
  // Seven catches after 68%, needing an eighth: about 96%. Four after 69%, needing a fifth: about 83%.
  assert.ok(catchChance(7, 7.5, 0.68) > 0.95 && catchChance(4, 4.5, 0.69) > 0.8 && catchChance(4, 4.5, 0.69) < RECEPTION_MIN_CHANCE);
  // Two more needed is harder than one; nothing is left at the whistle or before the kick.
  assert.ok(catchChance(4, 5.5, 0.5) < catchChance(4, 4.5, 0.5));
  assert.deepEqual([catchChance(3, 3.5, 1), catchChance(3, 3.5, 0), catchChance(0, 0.5, 0.5)], [0, 0, 0]);

  // Third quarter, 6:00 left: 60% of the game in. Full-game pace clears every line below by a quarter and more, which is what took them all before.
  const t = { at: 1, state: 'in', detail: '6:00 - 3rd Quarter', period: 3, clock: '6:00', score: { PHI: 17, WSH: 17 }, box: [
    { id: '1', name: 'One Catch', team: 'PHI', stats: { receptions: '1', receivingYards: '9' } },
    { id: '2', name: 'Busy Hands', team: 'PHI', stats: { receptions: '7', receivingYards: '79' } },
    { id: '3', name: 'Two Deep', team: 'WSH', stats: { receptions: '2', receivingYards: '58' } },
    { id: '4', name: 'Ground Game', team: 'WSH', stats: { rushingAttempts: '14', rushingYards: '58', receptions: '1', receivingYards: '4' } },
    { id: '5', name: 'No Carries', team: 'WSH', stats: { rushingYards: '58' } },
  ] };
  const over = (player, point, price) => ({ name: 'Over', description: player, point, price });
  const board = { bookmakers: [{ key: 'draftkings', markets: [
    { key: 'player_receptions_alternate', outcomes: [over('One Catch', 1.5, -200), over('Busy Hands', 7.5, -180)] },
    { key: 'player_reception_yds_alternate', outcomes: [over('One Catch', 9.5, -210), over('Busy Hands', 89.5, -160), over('Two Deep', 69.5, -150)] },
    { key: 'player_rush_yds_alternate', outcomes: [over('Ground Game', 69.5, -170), over('No Carries', 69.5, -170)] },
  ] }] };
  const c = liveCandidates(board, t, 'nfl');
  const got = c.map((x) => `${x.player} ${x.stat} ${x.point}`).sort();
  // No reception count at all, Busy Hands's eighth catch included. One catch all day and half a yard to go: one more catch is about
  // one in five, far short of -210. Two catches for 58: the eleven yards hang on a third catch, under an even chance. Seven catches
  // for 79 and fourteen carries for 58 have the touches coming to make their yards more often than their prices say. And a back with
  // no carries in the box cannot be judged, so is not a leg.
  assert.deepEqual(got, ['Busy Hands receivingYards 89.5', 'Ground Game rushingYards 69.5']);
  const busy = c.find((x) => x.player === 'Busy Hands');
  assert.ok(busy.chance > 0.615 && busy.chance < 0.85 && Math.abs(busy.edge - (busy.chance - 160 / 260)) < 2e-3, `${busy.chance} against -160`);
  assert.deepEqual([busy.marketEdge, busy.marketBooks], [null, 0], 'one book alone on the number: no market to hold its price against');
  // The same board in the NBA's way of reading it does not exist: the rule is the NFL's.
  assert.equal(liveCandidates(board, t, 'nba').length, 0);
});

test('what is left, as a chance: more touches to come and fewer yards to go are likelier, and nothing is read from no touches', async () => {
  const { yardsChance, NFL_LATE, nflTouches } = await import('../worker/src/live-board.js');
  assert.equal(NFL_LATE, 0.6);
  // Five catches for 58, a yard and a half to go, 79% of the game gone (Carnell Tate, 2026-11-22, at -300; he did not catch another):
  // 0.8 more catches expected, so a little under an even chance, where pace had him 41% over the line.
  const tate = yardsChance(5, 58, 1.5, 0.79);
  assert.ok(tate > 0.4 && tate < 0.55, String(tate));
  assert.ok(tate < 300 / 400, 'short of what -300 implies');
  // The same need earlier in the game, or with more catches behind him, is likelier; a longer way to go is less likely.
  assert.ok(yardsChance(5, 58, 1.5, 0.5) > tate && yardsChance(9, 58, 1.5, 0.79) > tate && yardsChance(5, 58, 21.5, 0.79) < tate);
  // The game script and the weather turn the rate.
  assert.ok(yardsChance(5, 58, 11.5, 0.6, { factor: 0.8 }) < yardsChance(5, 58, 11.5, 0.6) && yardsChance(5, 58, 11.5, 0.6, { factor: 1.15 }) > yardsChance(5, 58, 11.5, 0.6));
  // A quarterback with thirty completions to come is summed all the way out.
  assert.ok(yardsChance(12, 150, 40, 0.1) > 0.99);
  // Already there, or nothing to read from, or no game left.
  assert.deepEqual([yardsChance(5, 58, 0, 0.5), yardsChance(0, 0, 9.5, 0.5), yardsChance(3, 0, 9.5, 0.5), yardsChance(5, 58, 1.5, 1), yardsChance(5, 58, 1.5, 0)], [1, 0, 0, 0, 0]);
  // Touches by stat, from the box.
  const p = { stats: { receptions: '4', rushingAttempts: '11', 'completions/passingAttempts': '18/27' } };
  assert.deepEqual([nflTouches(p, 'receivingYards'), nflTouches(p, 'rushingYards'), nflTouches(p, 'passingYards'), nflTouches(p, 'receptions'), nflTouches({ stats: {} }, 'rushingYards')], [4, 11, 18, null, null]);
});

test('an NFL slip takes a leg only at a book priced out of line with the others, is two legs, and stands while its legs are reachable', async () => {
  const { slipCandidates, buildLiveSlips, NFL_MARKET_EDGE, NFL_SLIP_LEGS } = await import('../worker/src/live-board.js');
  assert.deepEqual([NFL_MARKET_EDGE, NFL_SLIP_LEGS], [0.04, [2]]);
  const t = tick({ score: { PHI: 14, WSH: 10 } });
  const all = liveCandidates(marketPayload, t, 'nfl');
  const at = (book, player, point) => all.find((x) => x.bookId === book && x.player === player && x.point === point);
  // Barkley 89.5: DraftKings -140 (58%) against FanDuel -125 (56%) and BetRivers -240 (71%): the middle of the others is 63%, five points over.
  assert.deepEqual([at('draftkings', 'Saquon Barkley', 89.5).marketEdge, at('draftkings', 'Saquon Barkley', 89.5).marketBooks], [0.047, 2]);
  // The same number at BetRivers is the dear one, and a leg there is not for a slip. (FanDuel's -125 counts in the market though it is too long to be a leg.)
  assert.ok(at('betrivers', 'Saquon Barkley', 89.5).marketEdge < 0);
  // 79.5 at FanDuel is better than DraftKings by under two points: not out of line.
  assert.equal(at('fanduel', 'Saquon Barkley', 79.5).marketEdge, 0.017);
  // McLaurin is at one book only: nothing to hold the price against.
  const picks = slipCandidates(all, 'nfl');
  assert.deepEqual(picks.map((x) => `${x.bookId} ${x.player} ${x.point}`).sort(), ['draftkings Jacory Croskey-Merritt 49.5', 'draftkings Jalen Hurts 199.5', 'draftkings Saquon Barkley 89.5']);
  assert.equal(slipCandidates(all, 'nba').length, all.length, 'every other league builds from all of its legs');
  const slips = buildLiveSlips(picks, { league: 'nfl' });
  assert.deepEqual([slips.length, slips[0].bookId, slips[0].legs.length], [1, 'draftkings', 2]);
  assert.ok(slips[0].american >= -160 && slips[0].american <= 300);
  // The plain board, where no book is out of line: every leg is still a leg (the custom parlay lists them), and there is no slip.
  const plain = liveCandidates(payload, t, 'nfl');
  assert.ok(plain.length >= 5);
  assert.deepEqual(buildLiveSlips(slipCandidates(plain, 'nfl'), { league: 'nfl' }), []);
  // Posted, then the other books come into line: the slip stands on its legs still being reachable, at the price now.
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  const game = { id: 'mk', name: 'Washington Commanders at Philadelphia Eagles' };
  const first = await ensureLivePlays(env, game, marketPayload, t, { league: 'nfl', now: 100 });
  assert.equal(first.slips.length, 1);
  const names = first.slips[0].legs.map((l) => l.player).sort();
  const second = await ensureLivePlays(env, game, payload, t, { league: 'nfl', now: 200 });
  assert.deepEqual([second.slips.length, second.slips[0].postedAt, second.slips[0].legs.map((l) => l.player).sort()], [1, 100, names], 'the same slip, posted when it was');
});

test('archiveLiveResults keeps each finished game\'s slips for good, once, and getLiveResults reads them back', async () => {
  const { archiveLiveResults, getLiveResults, liveResultsKey, LIVE_RESULTS_INDEX } = await import('../worker/src/live-board.js');
  const m = new Map(); let reads = 0; const env = { POTD_KV: { get: async (k) => { reads++; return m.get(k) ?? null; }, put: async (k, v) => { m.set(k, v); } } };
  const now = Date.parse('2026-11-05T12:00:00Z');
  m.set('live:watch:index:nba', JSON.stringify({ games: [
    { id: '9', name: 'Bulls at Knicks', league: 'nba', date: '2026-11-05T00:30:00Z' },
    { id: '10', name: 'Heat at Clippers', league: 'nba', date: '2026-11-05T03:30:00Z' },
    { id: '11', name: 'Suns at Lakers', league: 'nba', date: '2026-11-05T11:30:00Z' },
  ] }));
  m.set('live:watch:9', JSON.stringify({ ticks: [{ state: 'post', score: { NY: 110, CHI: 100 }, detail: 'Final', box: [{ name: 'Landry Shamet', team: 'NY', stats: { points: '12' } }, { name: 'OG Anunoby', team: 'NY', stats: { points: '20' } }, { name: 'Josh Giddey', team: 'CHI', stats: { points: '8' } }] }] }));
  m.set('live:play:9', JSON.stringify({ builtAt: 5, slips: [
    { bookId: 'fanduel', book: 'FanDuel', american: 152, decimal: 2.52, legs: [{ player: 'Landry Shamet', stat: 'points', label: 'Pts', point: 9.5, price: -270 }, { player: 'OG Anunoby', stat: 'points', label: 'Pts', point: 14.5, price: -280 }] },
    { bookId: 'draftkings', book: 'DraftKings', american: 142, decimal: 2.42, legs: [{ player: 'Josh Giddey', stat: 'points', label: 'Pts', point: 9.5, price: -280 }] },
  ] }));
  // Game 10 started over two hours ago and is still being played: left for a later run. Game 11 has only just started.
  m.set('live:watch:10', JSON.stringify({ ticks: [{ state: 'in', box: [] }] }));
  assert.equal(await archiveLiveResults(env, now), 1);
  const nov = JSON.parse(m.get(liveResultsKey('2026-11')));
  assert.deepEqual(nov.games.map((g) => g.id), ['9']);
  assert.deepEqual(nov.games[0].slips.map((s) => [s.bookId, s.american, s.result, s.units, s.legs.length]), [['fanduel', 152, 'win', 1.52, 2], ['draftkings', 142, 'loss', -1, 1]]);
  assert.deepEqual(nov.games[0].slips[0].legs[0], { player: 'Landry Shamet', label: 'Pts', point: 9.5, hit: true });
  assert.deepEqual(JSON.parse(m.get(LIVE_RESULTS_INDEX)).months, ['2026-11']);
  // The slips themselves are only stored for three days: once they are gone the ledger still has the game.
  m.delete('live:play:9');
  reads = 0;
  assert.equal(await archiveLiveResults(env, now + 3600e3), 0, 'nothing new: nothing written');
  assert.ok(reads <= 16, `a quiet run is a handful of reads: the watch indexes, the month, the one game still in play (${reads})`);
  // Game 10 goes final with no slip: kept bare so it is not read again, and left out of what the tab is given.
  m.set('live:watch:10', JSON.stringify({ ticks: [{ state: 'post', box: [] }] }));
  assert.equal(await archiveLiveResults(env, now + 2 * 3600e3), 1);
  const out = await getLiveResults(env, now + 2 * 3600e3);
  assert.deepEqual(out.games.map((g) => [g.id, g.league, g.slips.length]), [['9', 'nba', 2]]);
  assert.equal(JSON.parse(m.get(liveResultsKey('2026-11'))).games.length, 2);
  // A slip kept while a leg's player was missing from the box is looked at again, and replaced once the box has him.
  m.set('live:watch:index:nba', JSON.stringify({ games: [{ id: '12', name: 'Nets at Hawks', league: 'nba', date: '2026-11-05T00:30:00Z' }] }));
  m.set('live:watch:12', JSON.stringify({ ticks: [{ state: 'post', detail: 'Final', box: [] }] }));
  m.set('live:play:12', JSON.stringify({ builtAt: 5, slips: [{ bookId: 'fanduel', book: 'FanDuel', american: -110, decimal: 1.91, legs: [{ player: 'Trae Young', stat: 'points', label: 'Pts', point: 19.5, price: -110 }] }] }));
  assert.equal(await archiveLiveResults(env, now + 3 * 3600e3), 1);
  const held = () => JSON.parse(m.get(liveResultsKey('2026-11'))).games.filter((g) => g.id === '12');
  assert.deepEqual(held().map((g) => g.slips[0].result), ['open']);
  assert.equal(await archiveLiveResults(env, now + 4 * 3600e3), 0, 'still open: nothing rewritten');
  m.set('live:watch:12', JSON.stringify({ ticks: [{ state: 'post', detail: 'Final', box: [{ name: 'Trae Young', team: 'ATL', stats: { points: '31' } }] }] }));
  assert.equal(await archiveLiveResults(env, now + 5 * 3600e3), 1);
  assert.deepEqual(held().map((g) => g.slips[0].result), ['win'], 'settled in place, the game kept once');
  assert.equal(await archiveLiveResults(env, now + 6 * 3600e3), 0, 'settled: not looked at again');
  // A late game on the last night of a month belongs to that month (Eastern time, near enough).
  m.set('live:watch:index:nba', JSON.stringify({ games: [{ id: '20', name: 'Late game', league: 'nba', date: '2026-12-01T03:30:00Z' }] }));
  m.set('live:watch:20', JSON.stringify({ ticks: [{ state: 'post', box: [] }] }));
  await archiveLiveResults(env, Date.parse('2026-12-01T12:00:00Z'));
  assert.ok(JSON.parse(m.get(liveResultsKey('2026-11'))).games.some((g) => g.id === '20'));
});

test('a player is taken once on a stat in a game: a replaced slip is not rebuilt on the same player at the next number', async () => {
  const { takenLegs, takenKey } = await import('../worker/src/live-board.js');
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  const game = { id: 'tk', name: 'Washington Commanders at Philadelphia Eagles' };
  const t = tick({ score: { PHI: 14, WSH: 10 } });
  const first = await ensureLivePlays(env, game, marketPayload, t, { league: 'nfl', now: 100 });
  const names = first.slips[0].legs.map((l) => l.player).sort();
  assert.deepEqual(names, ['Jacory Croskey-Merritt', 'Jalen Hurts']);
  assert.deepEqual(first.taken.map((x) => [x.player, x.stat, x.point, x.at]).sort(), [['Jacory Croskey-Merritt', 'rushingYards', 49.5, 100], ['Jalen Hurts', 'passingYards', 199.5, 100]]);
  // The books move both players up a number (still priced out of line at DraftKings), and Barkley is out of line as before.
  // Before the rule this was a new slip on the same two players for more. Now only Barkley is open, one leg is no slip, and the first stays.
  const up = { bookmakers: [
    { key: 'draftkings', markets: [
      { key: 'player_rush_yds_alternate', outcomes: [...ladder('Saquon Barkley', [89.5], [-140]), ...ladder('Jacory Croskey-Merritt', [54.5], [-150])] },
      { key: 'player_pass_yds_alternate', outcomes: ladder('Jalen Hurts', [209.5], [-150]) },
    ] },
    { key: 'betrivers', markets: [
      { key: 'player_rush_yds_alternate', outcomes: [...ladder('Saquon Barkley', [89.5], [-240]), ...ladder('Jacory Croskey-Merritt', [54.5], [-220])] },
      { key: 'player_pass_yds_alternate', outcomes: ladder('Jalen Hurts', [209.5], [-230]) },
    ] },
  ] };
  const { slipCandidates } = await import('../worker/src/live-board.js');
  assert.deepEqual(slipCandidates(liveCandidates(up, t, 'nfl'), 'nfl').map((c) => c.player).sort(), ['Jacory Croskey-Merritt', 'Jalen Hurts', 'Saquon Barkley'], 'all three would make a slip, were two of them not taken');
  const second = await ensureLivePlays(env, game, up, t, { league: 'nfl', now: 200 });
  assert.deepEqual([second.builtAt, second.slips.length, second.slips[0].legs.map((l) => `${l.player} ${l.point}`).sort()], [100, 1, ['Jacory Croskey-Merritt 49.5', 'Jalen Hurts 199.5']], 'no new slip: the first stands as it was posted');
  // A second open player at the book: a new slip, on the two not taken.
  const wider = { bookmakers: [
    { ...up.bookmakers[0], markets: [...up.bookmakers[0].markets, { key: 'player_reception_yds_alternate', outcomes: ladder('Terry McLaurin', [69.5], [-180]) }] },
    { ...up.bookmakers[1], markets: [...up.bookmakers[1].markets, { key: 'player_reception_yds_alternate', outcomes: ladder('Terry McLaurin', [69.5], [-260]) }] },
  ] };
  const box = t.box.map((p) => (p.name === 'Terry McLaurin' ? { ...p, stats: { receptions: '7', receivingYards: '58' } } : p));
  const third = await ensureLivePlays(env, game, wider, { ...t, box }, { league: 'nfl', now: 300 });
  assert.deepEqual(third.slips.map((s) => s.legs.map((l) => l.player).sort()), [['Saquon Barkley', 'Terry McLaurin']]);
  assert.equal(third.slips[0].postedAt, 300);
  assert.deepEqual(third.taken.map((x) => x.player).sort(), ['Jacory Croskey-Merritt', 'Jalen Hurts', 'Saquon Barkley', 'Terry McLaurin'], 'the replaced slip\'s players stay taken');
  // The same player on another stat is another bet.
  assert.notEqual(takenKey({ player: 'Saquon Barkley', stat: 'rushingYards' }), takenKey({ player: 'saquon barkley', stat: 'receivingYards' }));
  assert.equal(takenKey({ player: 'Saquon Barkley', stat: 'rushingYards' }), takenKey({ player: 'saquon barkley', stat: 'rushingYards' }));
  // A record from before the rule: what its slips hold is what is taken, at the lowest number.
  const old = takenLegs({ slips: [{ postedAt: 5, legs: [{ player: 'A', stat: 'points', point: 19.5 }] }, { postedAt: 9, legs: [{ player: 'a', stat: 'points', point: 17.5 }, { player: 'B', stat: 'rebounds', point: 7.5, postedAt: 7 }] }] });
  assert.deepEqual([...old.values()], [{ player: 'A', stat: 'points', point: 17.5, at: 5 }, { player: 'B', stat: 'rebounds', point: 7.5, at: 7 }]);
  assert.equal(takenLegs(null).size, 0);
});
