/**
 * The lineup half of "Too good to be true?" (docs/line-check.js has the
 * half read off the line itself): what changed around the player.
 *
 *   a teammate back   the owner's own case (2026-11-24): a player 20 of
 *                     20 at -120, and "Ingram had come back to the
 *                     lineup". A teammate who puts up comparable numbers
 *                     in the same stat, who missed a run of the team's
 *                     recent games and has played again (or is off the
 *                     injury report), with how many of the player's last
 *                     ten came without him.
 *   a teammate out    the same kind of teammate on the report as out or
 *                     doubtful: the usage shifts, either way.
 *   a blowout         ESPN's win projection lopsided enough that starters
 *                     may sit late.
 *
 * Everything is read from what the site already stores (the team's
 * bundled game logs, the injury report) and ESPN's free game summary. No
 * odds call and no model call.
 */
import { loadBundleTeams, loadInjuries, injuryFor, loadRoles, roleFor } from './espn-bundle.js';
import { basketballStatRows } from './basketball-props.js';
import { nflStatRows } from './football-props.js';
import { fetchContext, hasContext } from './context.js';
import { findTrendRow } from './parlay-builder.js';
import { getTrends } from './trends.js';
import { attachSeries } from '../../docs/trends.js';
import { lineFlags, lineVerdict, looksTooGood, baseWindow } from '../../docs/line-check.js';

/** A teammate counts when he averages this share of the player's own number in the same stat. */
export const TEAMMATE_SHARE = 0.6;
/** The team's recent games looked at, and how many of them a teammate must have missed to be "back". */
export const TEAM_GAMES = 8;
export const MISSED_FOR_BACK = 3;
/** A win projection from which a blowout is worth a word. */
export const BLOWOUT_NOTE = 70;

const OUT = /\b(out|doubtful|suspended|injured reserve|ir)\b/i;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** A player's games in one stat, newest first, this season: [{date, value}], from his bundled log. */
export function statGames(sportKey, log, statKey) {
  const rows = sportKey === 'basketball_nba' ? basketballStatRows(log, statKey, { allSeasons: false }) : sportKey === 'americanfootball_nfl' ? nflStatRows(log, statKey, { allSeasons: false }) : [];
  return (rows ?? []).filter((r) => Number.isFinite(r?.date) && Number.isFinite(Number(r.value))).map((r) => ({ date: r.date, value: Number(r.value) }));
}

/**
 * The teammates whose presence changes this line: [{name, kind: 'back' |
 * 'out', missed, of, without, avg, status}]. `team` is the bundled team
 * record ({players: [{id, name, log}]}), `report` the injury report
 * ({players: {id: {name, team, status}}}).
 */
export function teammateChanges(row, team, report, { gamesOf = (p) => statGames(row.sportKey, p.log, row.statKey) } = {}) {
  const players = team?.players ?? [];
  const me = players.find((p) => String(p.id) === String(row.athleteId)) ?? players.find((p) => fold(p.name) === fold(row.playerName));
  const mine = me ? gamesOf(me) : [];
  const base = baseWindow(row);
  if (!mine.length || !base || !(base.avg > 0)) return [];
  // The team's own recent games: the days at least three of its players have a game on (a traded player's old games fall away).
  const counts = new Map();
  const games = new Map();
  for (const p of players) { const g = gamesOf(p); games.set(p, g); for (const d of new Set(g.map((x) => day(x.date)))) counts.set(d, (counts.get(d) ?? 0) + 1); }
  const teamDays = [...counts.entries()].filter(([, n]) => n >= 3).map(([d]) => d).sort().reverse().slice(0, TEAM_GAMES);
  if (teamDays.length < 4) return [];
  const myDays = mine.slice(0, 10).map((g) => day(g.date));
  const listed = new Map(Object.values(report?.players ?? {}).map((p) => [fold(p.name), String(p.status ?? '')]));
  const out = [];
  for (const p of players) {
    if (p === me) continue;
    const g = games.get(p);
    if (g.length < 3) continue;
    const avg = g.slice(0, 10).reduce((s, x) => s + x.value, 0) / Math.min(10, g.length);
    if (avg < base.avg * TEAMMATE_SHARE) continue;
    const played = new Set(g.map((x) => day(x.date)));
    const status = listed.get(fold(p.name)) ?? '';
    const isOut = OUT.test(status);
    const without = myDays.filter((d) => !played.has(d)).length;
    const one = Math.round(avg * 10) / 10;
    if (isOut) { out.push({ name: p.name, kind: 'out', status, avg: one, without, of: myDays.length }); continue; }
    const playedLast = played.has(teamDays[0]);
    const earlier = teamDays.slice(1);
    const missedEarlier = earlier.filter((d) => !played.has(d)).length;
    // Back: played the last game after missing a run before it; or missed the last few and is no longer listed as out.
    const lastRun = teamDays.findIndex((d) => played.has(d));
    if (playedLast && missedEarlier >= MISSED_FOR_BACK) out.push({ name: p.name, kind: 'back', missed: missedEarlier, of: earlier.length, avg: one, without, sample: myDays.length, status });
    else if (!playedLast && lastRun >= MISSED_FOR_BACK && lastRun > 0) out.push({ name: p.name, kind: 'due', missed: lastRun, of: teamDays.length, avg: one, without, sample: myDays.length, status });
    else if (!playedLast && lastRun === -1 && g.length >= 3) out.push({ name: p.name, kind: 'due', missed: teamDays.length, of: teamDays.length, avg: one, without, sample: myDays.length, status });
  }
  return out.sort((x, y) => y.avg - x.avg).slice(0, 4);
}

/** The teammates' flags for a row, from its team's record and the injury report: who is back, who may be, who is out. */
export function teammateFlags(row, team, report, opts = {}) {
  const flags = [];
  const over = row.side !== 'under';
  const stat = String(row.statLabel ?? row.marketLabel ?? 'this stat').toLowerCase();
  for (const t of teammateChanges(row, team, report, opts)) {
    if (t.kind === 'back') flags.push({ key: `back:${t.name}`, tone: over ? 'bad' : 'info', title: `${t.name} is back`, text: `He missed ${t.missed} of the team's ${t.of} games before the last one and averages ${t.avg} ${stat}. ${t.without} of this player's last ${t.sample} came without him, so the record ${over ? 'flatters the role he has tonight' : 'was set with more of the ball than he gets tonight'}.` });
    else if (t.kind === 'due') flags.push({ key: `due:${t.name}`, tone: over ? 'warn' : 'info', title: `${t.name} may be back`, text: `He has missed the team's last ${t.missed} game${t.missed === 1 ? '' : 's'} and is ${t.status ? `listed ${t.status.toLowerCase()}` : 'not listed as out'}. ${t.without} of this player's last ${t.sample} came without him. Check the lineup: if he plays, the role shrinks.` });
    else flags.push({ key: `out:${t.name}`, tone: 'info', title: `${t.name} is out`, text: `Listed ${t.status.toLowerCase()}, and averages ${t.avg} ${stat}. The usage shifts${t.without < t.of / 2 ? `: only ${t.without} of this player's last ${t.of} came without him` : ''}. It can lift an over as easily as it changes the role.` });
  }
  return flags;
}

/** The lineup flags for a row: teammates back, due back or out, and a likely blowout. `deps` stands in for the stored records in tests. */
export async function lineupFlags(env, row, ctx, { deps = {} } = {}) {
  const flags = [];
  const over = row.side !== 'under';
  try {
    const team = deps.team ? await deps.team(row) : (await loadBundleTeams(env, row.sportKey, [row.team])).get(String(row.team ?? '').toUpperCase());
    const report = deps.report ? await deps.report(row) : await loadInjuries(env, row.sportKey).catch(() => ({ players: {} }));
    flags.push(...teammateFlags(row, team, report, deps.gamesOf ? { gamesOf: deps.gamesOf } : {}));
  } catch (e) { console.error('Line check, teammates:', e); }
  try {
    const context = deps.context ? await deps.context(row) : (hasContext(row.sportKey) ? await fetchContext({ sportKey: row.sportKey, home: row.home, away: row.away }, ctx).catch(() => null) : null);
    const top = Math.max(Number(context?.projection?.home) || 0, Number(context?.projection?.away) || 0);
    if (top >= BLOWOUT_NOTE) flags.push({ key: 'blowout', tone: over ? 'warn' : 'info', title: 'Blowout risk', text: `ESPN projects a ${Math.round(top)}% favourite. A lopsided game sits starters late, which cuts into counting stats.` });
  } catch (e) { console.error('Line check, context:', e); }
  return flags;
}

/** The whole check for one stored line: {rowId, at, tooGood, verdict, flags}, or null when the line is off the board. */
export async function lineCheck(env, sportKey, rowId, ctx, { now = Date.now(), deps = {} } = {}) {
  const row = deps.row ?? await findTrendRow(env, sportKey, rowId);
  if (!row) return null;
  const flags = [...lineFlags(row), ...(await lineupFlags(env, row, ctx, { deps }))];
  const tooGood = looksTooGood(row);
  return { rowId, at: now, tooGood, verdict: lineVerdict(flags, { tooGood }), flags };
}

/** The most lines one red-flag request checks. */
export const RED_CHECK_LINES = 40;

/**
 * The red flags on a list of stored lines (2026-11-26, the owner, of the
 * Parlay Builder: "a toggle ... to include or exclude red flagged players
 * ... 7 players left out due to red flag indicators"): for each line, the
 * flags of the "Too good to be true?" card that are a reason to stay off
 * (`tone: 'bad'`): minutes down, listed out, a change of team, a teammate
 * back in the lineup. The same checks the card runs (lineFlags and
 * teammateFlags), for many lines in one read: the board once, the injury
 * report and the roles once, each team's record once. The blowout note is
 * never a reason to stay off, so the game context is not fetched.
 *
 * Returns {sportKey, at, checked, flags}: the ids found on the board, and
 * for the ones with a red flag, [{key, title, text}].
 */
export async function redFlags(env, sportKey, rowIds, ctx, { now = Date.now(), deps = {} } = {}) {
  const ids = [...new Set((rowIds ?? []).map(String))].slice(0, RED_CHECK_LINES);
  const t = deps.trends ? await deps.trends() : await getTrends(env, sportKey);
  const want = new Set(ids);
  const found = (t?.rows ?? []).filter((r) => want.has(r.id));
  const rows = attachSeries(found, t?.logs);
  const [report, roles] = await Promise.all([
    deps.report ? deps.report() : loadInjuries(env, sportKey).catch(() => ({ players: {} })),
    deps.roles ? deps.roles() : loadRoles(env, sportKey).catch(() => null),
  ]);
  const teams = deps.teams ? await deps.teams(rows) : await loadBundleTeams(env, sportKey, rows.map((r) => r.team)).catch(() => new Map());
  // A player's games in a stat are read once, however many lines ask for them.
  const memo = new Map();
  const gamesIn = (statKey) => deps.gamesOf ?? ((p) => { const k = `${p.id ?? p.name}|${statKey}`; if (!memo.has(k)) memo.set(k, statGames(sportKey, p.log, statKey)); return memo.get(k); });
  const flags = {};
  for (const base of rows) {
    const row = { ...base, injury: injuryFor(report, base.athleteId), role: roles ? roleFor(roles, base.athleteId) : null };
    let bad = lineFlags(row);
    try { bad = [...bad, ...teammateFlags(row, teams.get(String(row.team ?? '').toUpperCase()), report, { gamesOf: gamesIn(row.statKey) })]; } catch (e) { console.error('Red flags, teammates:', e); }
    bad = bad.filter((f) => f.tone === 'bad').map(({ key, title, text }) => ({ key, title, text }));
    if (bad.length) flags[row.id] = bad;
  }
  return { sportKey, at: now, checked: rows.map((r) => r.id), flags };
}
