import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  positionGroup, playerGames, teamUsage, usageLeader, defenseVsPosition, leagueTables, legsAtBook, togetherRate, landChance, estimateSameGame, mvpTicket, legFlags,
  mvpCandidates, runMvpPicksDaily, runMvpPicksGrading, getMvpPicks, MVP_MAX_TRACKED, MVP_EDGE, MVP_SHRINK_GAMES, MVP_PRIOR, MVP_INDEX_KEY,
} from '../worker/src/mvp-picks.js';

const DAY = 864e5;
const NOW = Date.parse('2026-11-24T17:00:00Z'); // noon Eastern
const TIP = Date.parse('2026-11-25T00:30:00Z'); // 7:30 PM Eastern, the same Eastern day

/** An ESPN-shaped game log: games are [{id, date, opp, min, fg: [made, att], ft: [made, att], reb, ast, to, pts}], one season. */
const logOf = (games, season = '2026-27') => ({
  names: ['minutes', 'fieldGoalsMade-fieldGoalsAttempted', 'freeThrowsMade-freeThrowsAttempted', 'totalRebounds', 'assists', 'turnovers', 'points'],
  labels: ['MIN', 'FG', 'FT', 'REB', 'AST', 'TO', 'PTS'],
  events: Object.fromEntries(games.map((g) => [g.id, { gameDate: new Date(g.date).toISOString(), opponent: { abbreviation: g.opp }, atVs: 'vs' }])),
  seasonTypes: [{ displayName: `${season} Regular Season`, categories: [{ events: games.map((g) => ({ eventId: g.id, stats: [String(g.min), `${g.fg[0]}-${g.fg[1]}`, `${g.ft[0]}-${g.ft[1]}`, String(g.reb), String(g.ast), String(g.to), String(g.pts)] })) }] }],
});
/** A team of five whose games are `n` nights against `opps` in turn; `lines` gives each player's nightly line. */
const teamOf = (abbr, players, n, opps) => ({
  sportKey: 'basketball_nba', team: abbr,
  players: players.map((p) => ({ id: p.id, name: p.name, position: p.position, log: logOf(Array.from({ length: n }, (_, i) => ({ id: `${[abbr, opps[i % opps.length]].sort().join('-')}-${Math.floor(i / opps.length)}`, date: NOW - (i + 1) * 2 * DAY, opp: opps[i % opps.length], ...p.line(i, opps[i % opps.length]) }))) })),
});
const line = (min, fga, fta, to, pts, reb, ast) => () => ({ min, fg: [Math.round(fga / 2), fga], ft: [fta, fta], to, pts, reb, ast });

test('positionGroup reads a guard, a forward and a center out of ESPN\'s positions', () => {
  assert.deepEqual(['PG', 'SG', 'G', 'G-F', 'SF', 'PF', 'F', 'F-C', 'C', 'C-F', '', null].map(positionGroup), ['G', 'G', 'G', 'G', 'F', 'F', 'F', 'F', 'C', 'C', null, null]);
});

test('usage: the possessions a player uses a minute against his team\'s own, this season, on this team', () => {
  const star = { id: '1', name: 'Star Guard', position: 'PG', line: line(36, 22, 8, 4, 30, 6, 8) };
  const second = { id: '2', name: 'Second Man', position: 'SF', line: line(34, 14, 4, 2, 18, 6, 3) };
  const role = (id, pos) => ({ id, name: `Role ${id}`, position: pos, line: line(30, 8, 2, 1, 9, 5, 2) });
  // A bench scorer who fires at a higher rate than anyone, in twelve minutes a night: no usage leader.
  const micro = { id: '6', name: 'Bench Gunner', position: 'SG', line: line(12, 9, 2, 1, 10, 1, 1) };
  const team = teamOf('AAA', [star, second, role('3', 'PF'), role('4', 'C'), role('5', 'SG'), micro], 12, ['BBB', 'CCC', 'DDD']);
  // A man traded in: his games for another team, and one against this team, are not this team's.
  team.players.push({ id: '7', name: 'Traded In', position: 'SF', log: logOf([{ id: 'old-1', date: NOW - 40 * DAY, opp: 'ZZZ', min: 30, fg: [9, 20], ft: [5, 5], reb: 4, ast: 2, to: 3, pts: 25 }, { id: 'AAA-OLD-0', date: NOW - 50 * DAY, opp: 'AAA', min: 30, fg: [9, 20], ft: [5, 5], reb: 4, ast: 2, to: 3, pts: 25 }]) });
  const table = teamUsage(team, 2026);
  assert.equal(table.some((r) => r.name === 'Traded In'), false, 'no game for this team, no place in its table');
  const by = Object.fromEntries(table.map((r) => [r.name, r]));
  // Star: 22 + 0.44 x 8 + 4 = 29.52 a game in 36 of the team's 172 minutes; the team uses 87.8 (17.76, three at 9.88 and the gunner's 10.88 beside his).
  // 100 x 29.52 x (172 / 5) / (36 x 87.8) = 32.1.
  assert.equal(by['Star Guard'].usage, 32.1); assert.equal(by['Star Guard'].games, 12); assert.equal(by['Star Guard'].mpg, 36);
  assert.ok(by['Bench Gunner'].usage > by['Star Guard'].usage, 'the gunner fires more often a minute');
  const lead = usageLeader(table);
  assert.equal(lead.name, 'Star Guard', 'but the leader is the regular');
  assert.deepEqual(lead.next, { name: 'Second Man', usage: by['Second Man'].usage });
  assert.equal(usageLeader([]), null);
  assert.equal(playerGames(team.players[0].log, 2025).length, 0, 'another season\'s games are another season\'s');
});

/** Seven teams; every guard scores his base, plus `soft[opp]` against a team soft on guards. */
function league({ soft = { BBB: 12, CCC: 6 } } = {}) {
  const abbrs = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG'];
  const teams = new Map();
  for (const abbr of abbrs) {
    const opps = abbrs.filter((a) => a !== abbr);
    const guard = { id: `${abbr}1`, name: `${abbr} Guard`, position: 'PG', line: (i, opp) => ({ min: 36, fg: [10, 22], ft: [8, 8], to: 4, pts: 26 + (soft[opp] ?? 0), reb: 5, ast: 7 }) };
    const fwd = { id: `${abbr}2`, name: `${abbr} Forward`, position: 'SF', line: line(34, 13, 4, 2, 16, 7, 3) };
    const big = { id: `${abbr}3`, name: `${abbr} Center`, position: 'C', line: line(30, 9, 3, 2, 12, 10, 2) };
    teams.set(abbr, teamOf(abbr, [guard, fwd, big], 12, opps));
  }
  return teams;
}

test('defense by position: what each team allows a game to guards, forwards and centers, the most allowed ranked first', () => {
  const dvp = defenseVsPosition(league(), 2026);
  assert.equal(Object.keys(dvp).length, 7);
  assert.deepEqual([dvp.BBB.G.rank, dvp.CCC.G.rank, dvp.BBB.G.of], [1, 2, 7], 'the team guards score most on is the worst against guards');
  assert.equal(dvp.BBB.G.pra, 26 + 12 + 5 + 7, 'one guard a night: his points, rebounds and assists');
  assert.equal(dvp.DDD.G.pra, 38);
  assert.equal(dvp.BBB.F.pra, dvp.DDD.F.pra, 'soft on guards says nothing of forwards');
  assert.equal(dvp.BBB.G.games, 12);
  const t = leagueTables(league(), NOW);
  assert.equal(t.season, 2026); assert.equal(t.leaders.AAA.name, 'AAA Guard'); assert.equal(t.dvp.BBB.G.rank, 1);
});

/** A Trends row for a player's stat at a number, with this season's and last season's games (newest first) and one book's price. */
function row(player, stat, point, now, last, quotes, over = {}) {
  const rec = (vals) => { const hits = vals.filter((v) => v > point).length; return vals.length ? { rate: Math.round((hits / vals.length) * 1000) / 1000, hits, games: vals.length, avg: 0, median: 0 } : undefined; };
  const series = [...now.map((v, i) => ({ value: v, date: NOW - (i + 1) * 2 * DAY, season: 2026, opponent: 'DDD', atVs: 'vs' })), ...last.map((v, i) => ({ value: v, date: NOW - (200 + i) * DAY, season: 2025, opponent: 'DDD', atVs: 'vs' }))];
  const label = { points: 'Pts', rebounds: 'Reb', assists: 'Ast' }[stat];
  return {
    id: `ev:${stat}:${player.name}:${point}:over`, eventId: 'ev', sportKey: 'basketball_nba', sportTitle: 'NBA', commenceMs: TIP, home: 'Home Team', away: 'Away Team',
    playerName: player.name, team: player.team, opponent: player.opponent, athleteId: player.id, headshot: null, statKey: stat, statLabel: label, marketLabel: `${stat} (alt)`,
    point, side: 'over', yesNo: false, selection: `${player.name} Over ${point} ${label}`, american: quotes[0].american, decimal: quotes[0].decimal,
    quotes, rates: {}, periods: { l5: rec(now.slice(0, 5)), l10: rec(now.slice(0, 10)), l20: rec(series.slice(0, 20).map((g) => g.value)), s2026: rec(now), s2025: rec(last) }, series, ...over,
  };
}
const q = (bookKey, american) => ({ bookKey, book: bookKey, american, decimal: american < 0 ? 1 + 100 / -american : 1 + american / 100, link: `https://sportsbook.draftkings.com/event/1?outcomes=${bookKey}${american}` });
// Fourteen games: 25+ points in 13, 4+ rebounds in 13, 3+ assists in all; the two misses on different nights, so 12 of 14 together.
const PTS = [31, 28, 24, 33, 27, 30, 26, 29, 35, 27, 32, 28, 26, 30];
const REB = [6, 5, 7, 4, 3, 8, 5, 6, 4, 7, 5, 6, 4, 5];
const AST = [8, 7, 9, 6, 5, 10, 7, 8, 6, 9, 7, 8, 5, 4];
const LAST = { pts: Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 22 : 29)), reb: Array(30).fill(5), ast: Array(30).fill(6) };
const luka = { id: 'AAA1', name: 'AAA Guard', team: 'AAA', opponent: 'BBB' };
const ladder = (p, books = ['draftkings', 'fanduel']) => [
  row(p, 'points', 19.5, PTS, LAST.pts, books.map((b) => q(b, -2500))),
  row(p, 'points', 24.5, PTS, LAST.pts, books.map((b) => q(b, b === 'draftkings' ? -650 : -700))),
  row(p, 'points', 29.5, PTS, LAST.pts, books.map((b) => q(b, 120))),
  row(p, 'rebounds', 3.5, REB, LAST.reb, books.map((b) => q(b, -900))),
  row(p, 'rebounds', 5.5, REB, LAST.reb, books.map((b) => q(b, 110))),
  row(p, 'assists', 2.5, AST, LAST.ast, books.map((b) => q(b, -3500))),
  row(p, 'assists', 3.5, AST, LAST.ast, books.map((b) => q(b, -1400))),
  row(p, 'assists', 4.5, AST, LAST.ast, books.map((b) => q(b, -800))),
  row(p, 'assists', 6.5, AST, LAST.ast, [q('fanduel', -150)]),
];

test('the ticket: the highest number still at 90% in each of points, rebounds and assists, at one book, and how often all three land together', () => {
  const rows = ladder(luka);
  const legs = legsAtBook(rows, 'draftkings', 2026);
  assert.deepEqual(legs.map((l) => [l.row.statKey, l.row.point, l.quote.american, l.record.hits, l.record.games]), [['points', 24.5, -650, 13, 14], ['rebounds', 3.5, -900, 13, 14], ['assists', 4.5, -800, 13, 14]]);
  assert.equal(legsAtBook(rows, 'betmgm', 2026), null, 'a book that prices none of it has no ticket');
  assert.equal(legsAtBook(rows.filter((r) => r.statKey !== 'rebounds'), 'draftkings', 2026), null, 'all three stats or nothing');
  const together = togetherRate(legs, 2026);
  // Points miss on night 3 (24), rebounds on night 5 (3), assists on night 14 (4): three different nights.
  assert.deepEqual(together, { hits: 11, games: 14, rate: 0.786 });
  const t = mvpTicket(rows, 2026);
  assert.equal(t.ok, true); assert.equal(t.bookId, 'draftkings', 'the book whose three legs pay most');
  assert.deepEqual(t.last, { hits: 24, games: 30, rate: 0.8 });
  // 11 of 14 mixed with last season's 80% as eight games: (11 + 6.4) / 22.
  assert.equal(t.chance, Math.round(((11 + MVP_SHRINK_GAMES * 0.8) / (14 + MVP_SHRINK_GAMES)) * 1000) / 1000);
  assert.equal(landChance({ hits: 14, games: 14 }, null), Math.round(((14 + MVP_SHRINK_GAMES * MVP_PRIOR) / (14 + MVP_SHRINK_GAMES)) * 1000) / 1000, 'with no last season, a young season leans on the prior');
  assert.ok(Math.abs(1 / t.take.decimal - (t.chance - MVP_EDGE)) < 0.001, 'the price to take it at leaves the edge under the chance');
  assert.ok(t.take.american < 0);
  // The legs' prices multiplied (no lift: they miss on different nights), less the same-game haircut.
  const implied = (1 / (1 + 100 / 650)) * (1 / (1 + 100 / 900)) * (1 / (1 + 100 / 800));
  assert.ok(Math.abs(t.est.decimal - (1 + (1 / implied - 1) * 0.9)) < 0.001);
  // Legs that only ever miss on the same night are priced as one event, never longer than the hardest leg.
  const same = [row(luka, 'points', 24.5, [30, 20, 30, 30, 30, 30, 30, 30, 30, 30, 30], [], [q('draftkings', -900)]), row(luka, 'rebounds', 3.5, [5, 2, 5, 5, 5, 5, 5, 5, 5, 5, 5], [], [q('draftkings', -900)]), row(luka, 'assists', 3.5, [6, 1, 6, 6, 6, 6, 6, 6, 6, 6, 6], [], [q('draftkings', -900)])];
  const sameLegs = legsAtBook(same, 'draftkings', 2026);
  assert.ok(estimateSameGame(sameLegs, togetherRate(sameLegs, 2026)).decimal < (1 + 100 / 900) ** 3, 'legs that move together pay less than their prices multiplied');
  // What he is short of, said.
  assert.match(mvpTicket(rows.filter((r) => r.statKey !== 'assists' || r.point > 5), 2026).reason, /no assists number at 90% this season/);
  assert.match(mvpTicket(ladder(luka, ['prizepicks']), 2026).reason, /no one sportsbook prices all three/);
  assert.match(mvpTicket([], 2026).reason, /no points, rebounds or assists lines/);
});

test('flags: each leg\'s own, one of a kind; a player on the injury report is not waved through', () => {
  const legs = legsAtBook(ladder(luka), 'draftkings', 2026).map((l) => ({ ...l, row: { ...l.row, mins: { l3: 24, l10: 35, last: 22 }, injury: { status: 'Questionable', detail: 'ankle' } } }));
  const flags = legFlags(legs);
  assert.deepEqual(flags.map((f) => [f.key, f.tone]).sort(), [['injury', 'warn'], ['minutes', 'bad']]);
  assert.equal(legFlags(legsAtBook(ladder(luka), 'draftkings', 2026)).length, 0);
});

const tables = () => leagueTables(league(), NOW);

test('who qualifies: the team\'s usage leader, a 90% number in all three, against a bottom-five defense at his position', async () => {
  const lg = tables();
  // AAA plays BBB (worst against guards); DDD plays EEE (middle of the league); CCC's guard has no assists number.
  const dGuard = { id: 'DDD1', name: 'DDD Guard', team: 'DDD', opponent: 'EEE' };
  const cGuard = { id: 'CCC1', name: 'CCC Guard', team: 'CCC', opponent: 'BBB' };
  const rows = [...ladder(luka), ...ladder(dGuard), ...ladder(cGuard).filter((r) => r.statKey !== 'assists'), ...ladder({ id: 'AAA2', name: 'AAA Forward', team: 'AAA', opponent: 'BBB' })];
  lg.dvp.EEE.G.rank = 6;
  const { picks, near } = await mvpCandidates(rows, lg, { report: { players: {} }, deps: { lineup: async () => [] } });
  assert.deepEqual(picks.map((p) => p.player), ['AAA Guard'], 'only the usage leader, never his teammate with the same lines');
  assert.deepEqual([picks[0].group, picks[0].dvp.rank, picks[0].blocked, picks[0].ticket.bookId], ['G', 1, false, 'draftkings']);
  const why = Object.fromEntries(near.map((n) => [n.player, n.why]));
  assert.match(why['DDD Guard'], /EEE is 2nd of 7 against guards, not a bottom-5 defense/);
  assert.match(why['CCC Guard'], /no assists number at 90% this season/);
  // Listed out: no ticket. A flag against him: listed, and blocked from the record.
  const out = await mvpCandidates(ladder(luka), lg, { report: { players: { AAA1: { status: 'Out', detail: 'knee' } } }, deps: { lineup: async () => [] } });
  assert.equal(out.picks.length, 0); assert.match(out.near[0].why, /listed out/);
  const flagged = await mvpCandidates(ladder(luka), lg, { report: { players: {} }, deps: { lineup: async () => [{ key: 'back:Someone', tone: 'bad', title: 'Someone is back', text: 'x' }, { key: 'blowout', tone: 'warn', title: 'Blowout risk', text: 'y' }] } });
  assert.equal(flagged.picks[0].blocked, true);
  assert.equal(flagged.picks[0].confidence, Math.round((flagged.picks[0].ticket.chance - 0.02) * 1000) / 1000, 'a thing to weigh takes two points off the confidence');
});

test('the day: everyone who qualifies listed most confident first, the best tracked at the price to take, graded off the box score', async () => {
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  const lg = tables();
  // Three leaders against the two softest guard defenses (a third made soft for the day): the steadiest first.
  lg.dvp.DDD.G.rank = 3;
  const b = { id: 'CCC1', name: 'CCC Guard', team: 'CCC', opponent: 'BBB' };
  const c = { id: 'EEE1', name: 'EEE Guard', team: 'EEE', opponent: 'DDD' };
  const steady = ladder(b).map((r) => (r.statKey === 'points' ? { ...r, ...row(b, 'points', r.point, PTS.map((v) => Math.max(v, 26)), LAST.pts, r.quotes) } : r.statKey === 'rebounds' ? { ...r, ...row(b, 'rebounds', r.point, REB.map((v) => Math.max(v, 4)), LAST.reb, r.quotes) } : r));
  const rows = [...ladder(luka), ...steady, ...ladder(c)];
  const deps = { rows: async () => rows, league: async () => lg, report: async () => ({ players: {} }), lineup: async (r) => (r.playerName === 'EEE Guard' ? [] : []) };
  const res = await runMvpPicksDaily(env, {}, NOW, { deps });
  assert.deepEqual([res.picks, res.tracked], [3, MVP_MAX_TRACKED]);
  const rec = JSON.parse(m.get('mvp:picks:2026-11-24'));
  assert.equal(rec.final, true);
  assert.deepEqual(rec.picks.map((p) => [p.rank, p.player, p.tracked]), [[1, 'CCC Guard', true], [2, 'AAA Guard', true], [3, 'EEE Guard', false]]);
  assert.match(rec.picks[2].why, /the day's 2 tracked picks rank above it/);
  assert.ok(rec.picks[0].confidence > rec.picks[1].confidence);
  const bet = rec.picks[0].bet;
  assert.deepEqual([bet.id, bet.type, bet.mvp, bet.bookId, bet.units, bet.legs.length, bet.status], ['mvp:2026-11-24:CCC1', 'parlay', true, 'draftkings', 1, 3, 'pending']);
  assert.equal(bet.american, rec.picks[0].take.american, 'the ticket is priced at the price it says to take');
  assert.ok(bet.legs.every((l) => /^https:\/\/sportsbook\.draftkings\.com\//.test(l.link) && l.gameDate === '2026-11-24'), 'each leg carries its book\'s slip link');
  assert.deepEqual(JSON.parse(m.get(MVP_INDEX_KEY)).dates, ['2026-11-24']);
  // Posted: it stands, whatever a later look would find.
  assert.equal((await runMvpPicksDaily(env, {}, NOW + 3600e3, { deps: { ...deps, rows: async () => [] } })).reason, 'posted');
  // Before the games: nothing to grade. After: CCC lands all three, AAA misses his rebounds, EEE (listed) lands.
  assert.equal((await runMvpPicksGrading(env, {}, TIP + 3600e3, { deps: { actual: () => 99 } })).graded, 0);
  const actual = (leg) => (leg.playerName === 'AAA Guard' && leg.statKey === 'rebounds' ? 2 : 40);
  assert.equal((await runMvpPicksGrading(env, {}, TIP + 5 * 3600e3, { deps: { actual } })).graded, 3);
  const done = JSON.parse(m.get('mvp:picks:2026-11-24'));
  const [p1, p2, p3] = done.picks.map((p) => p.bet);
  assert.deepEqual([p1.result, p1.net], ['win', Math.round((p1.decimal - 1) * 100) / 100], 'a win pays at the price to take, not at the legs multiplied');
  assert.ok(p1.net < p1.legs.reduce((d, l) => d * l.decimal, 1) - 1);
  assert.deepEqual([p2.result, p2.net, p3.result], ['loss', -1, 'win']);
  const view = await getMvpPicks(env, TIP + 6 * 3600e3);
  assert.deepEqual([view.record.wins, view.record.losses, view.record.risked], [1, 1, 2], 'the record counts the tracked picks and no other');
  assert.equal(view.record.units, Math.round((p1.net - 1) * 100) / 100);
  assert.equal(view.history.length, 1);
});

test('the day: nothing in the window is not looked at; a price too short or a flag is listed and not tracked; it looks again until something posts', async () => {
  const m = new Map(); const env = { POTD_KV: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
  const lg = tables();
  const base = { league: async () => lg, report: async () => ({ players: {} }), lineup: async () => [] };
  assert.equal((await runMvpPicksDaily(env, {}, NOW - 12 * 3600e3, { deps: { ...base, rows: async () => ladder(luka) } })).reason, 'no games in the window');
  // Legs priced so short the same-game price could not clear the price to take.
  const shortRows = ladder(luka).map((r) => ({ ...r, quotes: r.quotes.map((x) => ({ ...x, american: Math.min(x.american, -2800), decimal: 1 + 100 / 2800 })) }));
  const a = await runMvpPicksDaily(env, {}, NOW, { deps: { ...base, rows: async () => shortRows } });
  assert.deepEqual([a.picks, a.tracked], [1, 0]);
  let rec = JSON.parse(m.get('mvp:picks:2026-11-24'));
  assert.equal(rec.final, false); assert.match(rec.picks[0].why, /same-game price would be too short/);
  assert.equal((await runMvpPicksDaily(env, {}, NOW + 10 * 60e3, { deps: { ...base, rows: async () => ladder(luka) } })).reason, 'checked recently');
  const b = await runMvpPicksDaily(env, {}, NOW + 40 * 60e3, { deps: { ...base, rows: async () => ladder(luka), lineup: async () => [{ key: 'back:X', tone: 'bad', title: 'X is back', text: 'z' }] } });
  assert.equal(b.tracked, 0);
  rec = JSON.parse(m.get('mvp:picks:2026-11-24'));
  assert.match(rec.picks[0].why, /a flag against it/); assert.equal(rec.picks[0].flags[0].title, 'X is back');
  const c = await runMvpPicksDaily(env, {}, NOW + 80 * 60e3, { deps: { ...base, rows: async () => ladder(luka) } });
  assert.equal(c.tracked, 1);
  assert.equal((await getMvpPicks(env, NOW + 2 * 3600e3)).today.picks[0].tracked, true);
});
