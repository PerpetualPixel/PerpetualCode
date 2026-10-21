/**
 * Diagnose the Trends build's ESPN half from anywhere with internet (a
 * GitHub Actions runner, a laptop) — the worker's own logs are not readable
 * from the app, and the sandbox this is written from cannot reach ESPN.
 *
 * Prints, for one player per league: the roster lookup, the resolved id,
 * the game log's column names and seasons, the rows each Trends stat reads,
 * and the prior season's log. Also prints what ESPN's MMA schedule names
 * (the Full Slate's "Card - MM/DD" labels mean it named nothing).
 *
 *   node scripts/diag-trends.mjs
 */
import { resolveNflAthleteId, fetchNflGamelog, fetchNflRoster, gamelogStatIndex, NFL_TREND_MARKETS } from '../worker/src/football-props.js';
import { resolveAthleteId, fetchBasketballGamelog, basketballStatIndex } from '../worker/src/basketball-props.js';
import { resolveNhlAthleteId, fetchNhlGamelog, nhlStatIndex } from '../worker/src/hockey-props.js';
import { fetchMmaSchedule, discoverMmaLeagues } from '../worker/src/ufc-events.js';
import { seasonColumnRows, priorSeasonKey } from '../docs/prop-legs.js';
import { espnAbbr } from '../docs/team-logos.js';

const ctx = { waitUntil() {} };
const say = (...a) => console.log(...a);
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).slice(0, 14).join(',') : String(o));

async function league(title, { sportKey, team, player, resolve, gamelog, statIndex, stats, prior }) {
  say(`\n=== ${title} ===`);
  const abbr = espnAbbr(sportKey, team);
  say(`abbr for "${team}": ${abbr}`);
  const id = await resolve(player, [abbr]);
  say(`resolve "${player}" on ${abbr}: ${id}`);
  if (!id) return;
  const log = await gamelog(id);
  say(`gamelog keys: ${keys(log)}`);
  say(`names: [${(log?.names ?? []).join(',')}]`);
  say(`labels: [${(log?.labels ?? []).join(',')}]`);
  say(`seasons: [${(log?.seasonTypes ?? []).map((s) => `${s?.displayName} (${(s?.categories ?? []).reduce((n, c) => n + (c?.events?.length ?? 0), 0)} games)`).join(' / ')}]`);
  say(`events: ${Object.keys(log?.events ?? {}).length}; sample: ${JSON.stringify(Object.values(log?.events ?? {})[0] ?? null).slice(0, 300)}`);
  for (const statKey of stats) {
    const idx = statIndex(log, statKey);
    const rows = seasonColumnRows(log, idx, { allSeasons: true });
    say(`${statKey}: column ${idx}, ${rows.length} rows; first: ${JSON.stringify(rows.slice(0, 3))}`);
  }
  const priorLog = await prior(id, log);
  say(`prior season log: ${priorLog ? `seasons [${(priorLog.seasonTypes ?? []).map((s) => s?.displayName).join(' / ')}], events ${Object.keys(priorLog.events ?? {}).length}` : 'null'}`);
}

const nflRoster = await fetchNflRoster('kc', ctx);
say(`NFL roster kc: keys ${keys(nflRoster)}; groups ${(nflRoster?.athletes ?? []).length}; sample [${(nflRoster?.athletes ?? []).flatMap((g) => g?.items ?? []).slice(0, 3).map((a) => `${a?.displayName}#${a?.id}`).join(' | ')}]`);

await league('NFL', {
  sportKey: 'americanfootball_nfl', team: 'Kansas City Chiefs', player: 'Patrick Mahomes',
  resolve: (n, a) => resolveNflAthleteId(n, a, ctx), gamelog: (id) => fetchNflGamelog(id, ctx),
  statIndex: gamelogStatIndex, stats: [...new Set(Object.values(NFL_TREND_MARKETS).map((m) => m.stat))],
  prior: (id) => fetchNflGamelog(id, ctx, new Date().getUTCFullYear() - 1),
});
await league('NBA', {
  sportKey: 'basketball_nba', team: 'New York Knicks', player: 'Jalen Brunson',
  resolve: (n, a) => resolveAthleteId('basketball_nba', n, a, ctx), gamelog: (id) => fetchBasketballGamelog('basketball_nba', id, ctx),
  statIndex: basketballStatIndex, stats: ['points', 'rebounds', 'assists'],
  prior: (id, log) => fetchBasketballGamelog('basketball_nba', id, ctx, priorSeasonKey(log)),
});
await league('NHL', {
  sportKey: 'icehockey_nhl', team: 'Edmonton Oilers', player: 'Connor McDavid',
  resolve: (n, a) => resolveNhlAthleteId(n, a, ctx), gamelog: (id) => fetchNhlGamelog(id, ctx),
  statIndex: nhlStatIndex, stats: ['shots', 'points', 'assists'],
  prior: (id, log) => fetchNhlGamelog(id, ctx, priorSeasonKey(log)),
});

say('\n=== MMA schedule (ESPN) ===');
try {
  say(`leagues: ${(await discoverMmaLeagues(ctx)).join(',')}`);
  const sched = await fetchMmaSchedule(ctx);
  say(`events: ${sched.length}`);
  for (const e of sched.slice(0, 10)) say(`  ${e.date ? new Date(e.date).toISOString() : 'no date'}  ${e.name}  (${e.fights.length} fights)`);
} catch (e) {
  say(`schedule failed: ${e?.message ?? e}`);
}

// Run 2: the MMA schedule check needs the Cache API guard in worker/src/ufc-events.js.
