import test from 'node:test';
import assert from 'node:assert/strict';
import { viabilityOf, suggestedPlay, blowoutSplit, marginOf } from '../docs/slip-viability.js';
import { checkSlip, parseLeg } from '../docs/slip-check.js';
import { linesFromScoreboard, depthFromChart, outByTeam } from '../worker/src/espn-bundle.js';
import { minutesUsage } from '../worker/src/trends.js';

const NOW = Date.parse('2026-11-12T17:00:00Z');
const TIP = NOW + 6 * 3600e3;
const DAY = 864e5;
const NBA = 'basketball_nba';
const NFL = 'americanfootball_nfl';
/** A log, newest first: `values` two days apart ending `lastAgo` days before tip, each with a score. */
const log = (values, { lastAgo = 2, scores = [] } = {}) => values.map((value, i) => ({ value, date: TIP - (lastAgo + i * 2) * DAY, opponent: 'ORL', score: scores[i] ?? '110-104' }));
const leg = (side = 'over', point = 20.5, stat = { key: 'points', label: 'Points' }) => ({ kind: 'prop', side, point, stat, player: 'Test Player', selection: `Test Player ${side} ${point}` });
const match = (extra = {}) => ({ source: 'trends', name: 'Test Player', sportKey: NBA, rows: log([24, 22, 25, 21, 23, 26, 24, 22, 25, 23]), commenceMs: TIP, ...extra });
const levels = (v) => Object.fromEntries(v.checks.map((c) => [c.key, c.level]));

test('viabilityOf reads nothing for a team line or an unmatched leg, and a clean prop is viable', () => {
  assert.equal(viabilityOf(leg(), { source: 'market' }, { now: NOW }), null);
  assert.equal(viabilityOf(leg(), { source: 'none' }, { now: NOW }), null);
  const v = viabilityOf(leg(), match({ role: { starter: true, today: true, source: 'lineup', date: '2026-11-12T23:00Z' }, mins: { l3: 34, l10: 33.5, last: 35 } }), { now: NOW });
  assert.equal(v.level, 'viable');
  assert.deepEqual(levels(v), { role: 'ok', minutes: 'ok' });
  assert.deepEqual(v.penalty, { factor: 1, points: 0 });
});

test('role: out of today\'s posted lineup sinks an over and helps an under; a bench game last time out is a warning until the lineup posts', () => {
  const bench = { starter: false, today: true, source: 'lineup', date: '2026-11-12T23:00Z' };
  const over = viabilityOf(leg('over'), match({ role: bench }), { now: NOW });
  assert.equal(over.level, 'avoid');
  assert.match(over.checks[0].text, /not in today's starting lineup/);
  assert.equal(over.penalty.factor, 0.7);
  assert.equal(viabilityOf(leg('under'), match({ role: bench }), { now: NOW }).level, 'viable');
  const last = viabilityOf(leg('over'), match({ role: { starter: false, today: false, source: 'box', date: '2026-11-10T00:30Z' } }), { now: NOW });
  assert.equal(last.level, 'risky');
  assert.match(last.checks[0].text, /came off the bench in his last game \(Nov 9\)/);
});

test('depth chart: a backup quarterback is an avoid on an over, a second running back a risk, a top-three receiver fine', () => {
  const nfl = (depth, stat = { key: 'rushYds', label: 'Rushing yards' }) => viabilityOf(leg('over', 45.5, stat), match({ sportKey: NFL, depth, rows: log([50, 48, 52, 47, 51, 49, 50, 53], { lastAgo: 7 }) }), { now: NOW });
  assert.equal(nfl({ pos: 'QB', rank: 2 }, { key: 'passYds', label: 'Passing yards' }).level, 'avoid');
  const rb2 = nfl({ pos: 'RB', rank: 2 });
  assert.equal(rb2.level, 'risky');
  assert.match(rb2.checks.find((c) => c.key === 'depth').text, /Listed 2nd at running back.*not the primary player/);
  assert.equal(nfl({ pos: 'WR', rank: 3 }, { key: 'recYds', label: 'Receiving yards' }).level, 'viable');
  assert.equal(nfl({ pos: 'WR', rank: 4 }, { key: 'recYds', label: 'Receiving yards' }).level, 'risky');
});

test('a layoff, a minutes cut, a back-to-back and a limit in the injury note each warn an over; the same facts do not warn an under', () => {
  const back = viabilityOf(leg(), match({ rows: log([24, 22, 25, 21], { lastAgo: 15 }) }), { now: NOW });
  assert.equal(levels(back).layoff, 'warn');
  assert.match(back.checks.find((c) => c.key === 'layoff').text, /has not played since Oct 28 \(15 days\).*minutes limit/);
  const cut = viabilityOf(leg(), match({ mins: { l3: 24, l10: 32, last: 22 } }), { now: NOW });
  assert.equal(levels(cut).minutes, 'warn');
  assert.equal(levels(viabilityOf(leg('under'), match({ mins: { l3: 24, l10: 32, last: 22 } }), { now: NOW })).minutes, 'ok');
  assert.equal(levels(viabilityOf(leg('under'), match({ mins: { l3: 37, l10: 31, last: 38 } }), { now: NOW })).minutes, 'warn', 'rising minutes work against an under');
  const b2b = viabilityOf(leg(), match({ rows: log([24, 22, 25], { lastAgo: 1 }) }), { now: NOW });
  assert.equal(levels(b2b).rest, 'warn');
  const limit = viabilityOf(leg(), match({ injury: { level: 'questionable', status: 'Questionable', detail: 'Knee; expected to be on a minutes restriction' } }), { now: NOW });
  assert.deepEqual([levels(limit).injury, levels(limit).limit], ['warn', 'warn']);
  // Warnings other than the injury listing cost five points each, fifteen at most.
  assert.equal(limit.penalty.points, 0.05);
  const many = viabilityOf(leg(), match({ rows: log([24, 22, 25], { lastAgo: 1 }), mins: { l3: 20, l10: 32, last: 18 }, role: { starter: false, today: false, source: 'box', date: '2026-11-11T00:30Z' }, line: { spread: -11, total: 228, opp: 'WSH' } }), { now: NOW });
  assert.equal(many.penalty.points, 0.15);
});

test('blowout: a double-digit NBA spread warns an over and names how the line did in his own lopsided games; the split can clear it', () => {
  assert.equal(marginOf('127-101'), 26);
  assert.equal(marginOf('W 31-17'), null);
  const scores = ['130-100', '99-121', '118-96', '110-108', '104-101', '112-109', '101-99', '120-117'];
  const rows = log([14, 12, 15, 26, 24, 27, 25, 23], { scores });
  const split = blowoutSplit(rows, 20.5, 'over', 15);
  assert.deepEqual([split.games, split.hits, split.rest.games, split.rest.hits], [3, 0, 5, 5]);
  const v = viabilityOf(leg('over', 20.5), match({ rows, line: { spread: -12.5, total: 226, opp: 'WSH' } }), { now: NOW });
  assert.equal(levels(v).blowout, 'warn');
  assert.match(v.checks.find((c) => c.key === 'blowout').text, /12\.5-point favorite.*In his 3 games decided by 15 or more, this line landed 0 of 3, against 5 of 5 in the rest/);
  assert.equal(levels(viabilityOf(leg('over', 20.5), match({ rows, line: { spread: 15, total: 226, opp: 'BOS' } }), { now: NOW })).blowout, 'bad', 'fourteen and up with no evidence he survives it');
  assert.equal(levels(viabilityOf(leg('under', 20.5), match({ rows, line: { spread: -12.5 } }), { now: NOW })).blowout, 'ok');
  // He clears the line in blowouts too: the spread is a note, not a warning.
  const steady = log([26, 24, 27, 25, 23, 26, 24, 25], { scores });
  assert.equal(levels(viabilityOf(leg('over', 20.5), match({ rows: steady, line: { spread: -12.5 } }), { now: NOW })).blowout, 'info');
  assert.equal(levels(viabilityOf(leg('over', 20.5), match({ rows, line: { spread: -6.5 } }), { now: NOW })).blowout, undefined, 'a single-digit spread says nothing');
});

test('NFL game script: a big favorite hurts passing overs and helps rushing overs; a big underdog the reverse', () => {
  const rows = log([240, 250, 230, 260, 245, 255, 235, 250], { lastAgo: 7 });
  const nfl = (side, key, spread) => levels(viabilityOf(leg(side, 200.5, { key, label: key }), match({ sportKey: NFL, rows, line: { spread } }), { now: NOW })).blowout;
  assert.equal(nfl('over', 'passYds', -10.5), 'warn');
  assert.equal(nfl('over', 'rushYds', -10.5), 'ok');
  assert.equal(nfl('over', 'rushYds', 10.5), 'warn');
  assert.equal(nfl('over', 'recYds', 10.5), 'ok');
  assert.equal(nfl('under', 'passAttempts', 13), 'warn');
});

test('NFL workload stands in for snap counts, and a starting quarterback ruled out warns his receivers', () => {
  const down = viabilityOf(leg('over', 4.5, { key: 'receptions', label: 'Receptions' }), match({ sportKey: NFL, rows: log([2, 2, 3, 6, 7, 6, 5, 7, 6, 6], { lastAgo: 7 }) }), { now: NOW });
  assert.equal(levels(down).workload, 'warn');
  assert.match(down.checks.find((c) => c.key === 'workload').text, /2\.3 receptions a game over the last 3 against 5 over the last 10 \(snap counts are not in the feed/);
  const qbOut = viabilityOf(leg('over', 55.5, { key: 'recYds', label: 'Receiving yards' }), match({ sportKey: NFL, rows: log([60, 62, 58, 61], { lastAgo: 7 }), teammatesOut: [{ id: '1', name: 'Joe Burrow', pos: 'QB', rank: 1 }] }), { now: NOW });
  assert.equal(levels(qbOut).teammates, 'warn');
  const nba = viabilityOf(leg('under'), match({ teammatesOut: [{ id: '2', name: 'Jalen Brunson', starter: true }] }), { now: NOW });
  assert.equal(levels(nba).teammates, 'warn', 'a starter out moves usage to the rest: against an under');
});

test('a game under way is flagged', () => {
  assert.equal(levels(viabilityOf(leg(), match({ commenceMs: NOW - 60e3 }), { now: NOW })).started, 'warn');
});

const quote = (bookKey, american) => ({ bookKey, book: bookKey, american, link: `https://${bookKey}.example/${american}` });
const row = (id, athleteId, name, point, values, quotes, extra = {}) => ({ id, athleteId, eventId: 'g1', sportKey: NBA, playerName: name, team: 'NY', opponent: 'WSH', statKey: 'points', statLabel: 'Pts', side: 'over', point, selection: `${name} Over ${point} Pts`, commenceMs: TIP, home: 'New York Knicks', away: 'Washington Wizards', quotes, series: log(values), ...extra });

test('checkSlip carries viability into the score and the verdict, and suggests the play: a leg kept, a leg moved to a number that clears, a benched leg left off', () => {
  const strong = Array(20).fill(26);
  const soft = [18, 26, 19, 27, 18, 26, 19, 27, 18, 26, 19, 27, 18, 26, 19, 27, 18, 26, 19, 27];
  const trendsRows = { [NBA]: [
    row('a', '1', 'Jalen Brunson', 22.5, strong, [quote('fanduel', -150), quote('draftkings', -160)]),
    row('b', '2', 'Mikal Bridges', 22.5, soft, [quote('fanduel', -110)]),
    row('b2', '2', 'Mikal Bridges', 17.5, soft, [quote('fanduel', -320), quote('draftkings', -300)]),
    row('c', '3', 'Josh Hart', 22.5, strong, [quote('fanduel', -120)], { role: { starter: false, today: true, source: 'lineup', date: new Date(TIP).toISOString() } }),
  ] };
  const legs = ['Jalen Brunson over 22.5 points', 'Mikal Bridges over 22.5 points', 'Josh Hart over 22.5 points'].map((t) => parseLeg(t));
  const res = checkSlip(legs, { trendsRows, context: { [NBA]: { lines: { NY: { spread: -4.5, total: 224, opp: 'WSH' } }, depth: {}, out: {} } } }, { type: 'regular', books: ['fanduel'], now: NOW });
  const [brunson, bridges, hart] = res.scored;
  assert.equal(brunson.score.viability.level, 'viable');
  assert.equal(hart.score.viability.level, 'avoid');
  assert.ok(hart.score.confidence < brunson.score.confidence, 'the bench role cuts the confidence a clean log would give');
  assert.ok(hart.score.warnings.some((w) => /not in today's starting lineup/.test(w)));
  assert.equal(bridges.score.better.point, 17.5);
  assert.equal(res.slip.verdict.state, 'fix');
  const play = res.play;
  assert.deepEqual(play.legs.map((l) => [l.player, l.change, l.point, l.bookId, l.american]), [['Jalen Brunson', 'kept', 22.5, 'fanduel', -150], ['Mikal Bridges', 'moved', 17.5, 'fanduel', -320]]);
  assert.equal(play.legs[1].from, 22.5);
  assert.equal(play.bookId, 'fanduel', 'the user\'s book prices both legs');
  assert.ok(play.legs.every((l) => l.link.startsWith('https://fanduel.example/')));
  assert.equal(play.american, 119);
  assert.deepEqual(play.dropped.map((d) => d.selection), ['Josh Hart over 22.5 points']);
  assert.match(play.dropped[0].why, /not in today's starting lineup/);
});

test('suggestedPlay keeps a team line that clears the bar as a leg to add by hand, and says so when nothing survives', () => {
  const team = { leg: { selection: 'Knicks ML -180', american: -180, kind: 'team' }, match: { source: 'market' }, score: { confidence: 62, source: 'market' } };
  const play = suggestedPlay([team], { rows: {}, bar: 55, now: NOW });
  assert.equal(play.legs[0].manual, true);
  assert.equal(play.legs[0].american, -180);
  assert.equal(play.bookId, null);
  const none = suggestedPlay([{ ...team, score: { confidence: 40, source: 'market' } }], { rows: {}, bar: 55, now: NOW });
  assert.deepEqual([none.legs.length, none.dropped.length], [0, 1]);
  assert.equal(suggestedPlay([], { rows: {} }), null);
});

test('linesFromScoreboard reads each coming game\'s spread and total by team, from the point spread block, the details line or neither', () => {
  const game = (id, home, away, odds, state = 'pre') => ({ id, date: '2026-11-13T00:30Z', competitions: [{ status: { type: { state } }, competitors: [{ homeAway: 'home', team: { abbreviation: home, displayName: home } }, { homeAway: 'away', team: { abbreviation: away, displayName: away } }], odds: odds ? [odds] : [] }] });
  const lines = linesFromScoreboard({ events: [
    game('1', 'BOS', 'DAL', { pointSpread: { home: { close: { line: '-5.5' } }, away: { close: { line: '+5.5' } } }, total: { over: { close: { line: 'o227.5' } } } }),
    game('2', 'NY', 'WSH', { details: 'NY -12.5', overUnder: 221.5 }),
    game('3', 'LAL', 'GS', { details: 'GS -2', overUnder: 230 }),
    game('4', 'MIA', 'ORL', null),
    game('5', 'DEN', 'PHX', { details: 'DEN -7' }, 'in'),
    game('6', 'CHI', 'SA', { details: 'EVEN', pointSpread: { home: { close: { line: 'PK' } } } }),
  ] });
  assert.deepEqual(lines.BOS, { total: 227.5, eventId: '1', date: '2026-11-13T00:30Z', spread: -5.5, opp: 'DAL', home: true });
  assert.deepEqual([lines.DAL.spread, lines.DAL.opp, lines.DAL.home], [5.5, 'BOS', false]);
  assert.deepEqual([lines.NY.spread, lines.WSH.spread, lines.NY.total], [-12.5, 12.5, 221.5]);
  assert.deepEqual([lines.LAL.spread, lines.GS.spread], [2, -2], 'the away side favored');
  assert.equal(lines.CHI.spread, 0);
  assert.deepEqual([lines.MIA, lines.DEN], [undefined, undefined], 'no odds, or a game under way');
  const mapped = linesFromScoreboard({ events: [game('7', 'UTAH', 'NO', { details: 'UTAH -3' })] }, { abbrOf: (t) => ({ UTAH: 'UTA', NO: 'NOP' }[t.abbreviation]) });
  assert.deepEqual([mapped.UTA.spread, mapped.NOP.spread], [-3, 3], 'the rows\' letters key the lines; ESPN\'s own read its details');
});

test('depthFromChart lists the skill positions in order, and outByTeam keeps the absences that matter', () => {
  const ath = (id, displayName) => ({ id, displayName });
  const chart = { depthchart: [
    { name: 'Base 4-3 D', positions: { lde: { position: { abbreviation: 'LDE' }, athletes: [ath('90', 'Edge One')] } } },
    { name: '3WR 1TE', positions: {
      qb: { position: { abbreviation: 'QB' }, athletes: [ath('1', 'Patrick Mahomes'), ath('2', 'Backup Qb')] },
      rb: { position: { abbreviation: 'RB' }, athletes: [ath('3', 'Lead Back'), ath('4', 'Second Back')] },
      wr: { position: { abbreviation: 'WR' }, athletes: [ath('5', 'Wr One'), ath('6', 'Wr Two'), ath('7', 'Wr Three'), ath('8', 'Wr Four')] },
    } },
    { name: 'Special Teams', positions: { pk: { position: { abbreviation: 'PK' }, athletes: [ath('9', 'The Kicker')] }, pr: { position: { abbreviation: 'PR' }, athletes: [ath('8', 'Wr Four')] } } },
  ] };
  const depth = depthFromChart(chart, 'kc');
  assert.deepEqual(depth.map((p) => `${p.pos}${p.rank}:${p.id}`), ['QB1:1', 'QB2:2', 'RB1:3', 'RB2:4', 'WR1:5', 'WR2:6', 'WR3:7', 'WR4:8', 'PK1:9']);
  assert.equal(depth[0].team, 'KC');
  assert.deepEqual(depthFromChart(null, 'kc'), []);
  const byId = Object.fromEntries(depth.map((p) => [p.id, p]));
  const report = { players: { 1: { name: 'Patrick Mahomes', team: 'KC', status: 'Out' }, 4: { name: 'Second Back', team: 'KC', status: 'Out' }, 5: { name: 'Wr One', team: 'KC', status: 'Questionable' }, 20: { name: 'A Starter', team: 'NY', status: 'Out' }, 21: { name: 'A Reserve', team: 'NY', status: 'Out' } } };
  const roles = { players: { 20: { starter: true, team: 'NY' }, 21: { starter: false, team: 'NY' } } };
  const out = outByTeam(report, roles, byId);
  assert.deepEqual(out.KC.map((p) => [p.name, p.pos, p.rank]), [['Patrick Mahomes', 'QB', 1]], 'a second-string back and a questionable receiver are not listed');
  assert.deepEqual(out.NY.map((p) => [p.name, p.starter]), [['A Starter', true]]);
});

test('minutesUsage averages the last three and the last ten minutes, and needs three games', () => {
  assert.deepEqual(minutesUsage([30, 28, 26, 34, 35, 33, 36, 34, 35, 33, 40].map((value) => ({ value }))), { l3: 28, l10: 32.4, last: 30 });
  assert.equal(minutesUsage([{ value: 30 }, { value: 31 }]), null);
  assert.equal(minutesUsage(null), null);
});
