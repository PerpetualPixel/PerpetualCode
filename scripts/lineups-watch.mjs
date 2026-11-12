/**
 * The starters, kept current through the day (2026-11-08 direction:
 * "ensure the starters are accurate daily, as they could change"), from
 * a runner that stays up: GitHub delivers a few of a half-hourly cron's
 * firings a day (the injury report's cron ran five times on 2026-11-07),
 * so a pass that waits for the next firing is hours late. This one runs
 * for its hours limit, a pass every few minutes, then the workflow starts
 * the next run itself with the default token (the Live watcher's
 * pattern, .github/workflows/live-auto.yml), so the day is covered.
 *
 * Each pass (scripts/espn-bundle.mjs's recordRoles): the box score of
 * every game in play or final, once; the posted lineup of every game
 * inside two hours of tip, from ESPN's core API, every pass until it
 * tips. Every half hour the injury report is refreshed too, so a starter
 * ruled out in the afternoon reads out before his lineup is posted, and
 * with it the game context (recordContext: spreads, totals, the NFL
 * depth charts) the Slip Check reads.
 *
 *   node scripts/lineups-watch.mjs [--hours 5.5] [--every 10] [--leagues nba,epl] [--dry-run]
 *
 * A heartbeat (espn:lineups:beat) says a chain is alive; a second run
 * that finds a fresh one steps aside so the cron backstop never doubles
 * the chain.
 */
import { appendFileSync } from 'node:fs';
import { LEAGUES, recordRoles, recordContext, injuryEntries, leagueTeams, rosterOf, pool, readKv, writeKv, say } from './espn-bundle.mjs';
import { injuriesKey } from '../worker/src/espn-bundle.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const DRY = args.includes('--dry-run');
const hours = Number(opt('--hours', 5.5));
const every = Math.max(2, Number(opt('--every', 10)));
const only = String(opt('--leagues', '')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const BEAT_KEY = 'espn:lineups:beat';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The leagues whose box score flags starters: the NBA and the soccer leagues (the NFL and the NHL carry no flag). */
const leagues = Object.entries(LEAGUES).filter(([name, l]) => l.lineups !== false && (!only.length || only.includes(name)));

async function injuries(now) {
  for (const [name, league] of Object.entries(LEAGUES)) {
    if (only.length && !only.includes(name)) continue;
    try {
      const teams = await leagueTeams(league);
      if (!teams.length) continue;
      const players = {};
      await pool(teams, async (team) => Object.assign(players, injuryEntries(league, team, await rosterOf(league, team))));
      say(`${name.toUpperCase()}: ${Object.keys(players).length} players on the injury report`);
      if (!DRY) await writeKv([{ key: injuriesKey(league.sportKey), value: { sportKey: league.sportKey, builtAt: now, players } }]);
      // The spreads move through the day and a depth chart changes with the week's news: both ride the same half hour.
      await recordContext(league, now, { teams });
    } catch (e) { say(`  ! ${name} injuries: ${e.message}`); }
  }
}

function finish(more) {
  const line = `more=${more ? 'yes' : 'no'}`;
  say(more ? 'hours up: the workflow starts the next run' : 'standing aside');
  if (process.env.GITHUB_OUTPUT) { try { appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`); } catch { /* printed below either way */ } }
  console.log(line);
}

const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const start = Date.now();
if (!DRY) {
  const beat = await readKv(BEAT_KEY).catch(() => null);
  if (beat?.at && Date.now() - beat.at < (every + 3) * 60e3 && beat.run !== run) { say(`another run (${beat.run}) passed ${Math.round((Date.now() - beat.at) / 60e3)} min ago: standing aside`); finish(false); process.exit(0); }
}
let tick = 0;
while (Date.now() - start < hours * 3600e3) {
  const now = Date.now();
  say(`--- pass ${tick + 1} at ${new Date(now).toISOString().slice(11, 19)}Z`);
  for (const [name, league] of leagues) {
    say(`${name.toUpperCase()}:`);
    try { await recordRoles(league, now); } catch (e) { say(`  ! roles: ${e.message}`); }
  }
  if (tick % Math.max(1, Math.round(30 / every)) === 0) await injuries(now);
  if (!DRY) { try { await writeKv([{ key: BEAT_KEY, value: { at: Date.now(), run, pass: tick + 1 } }], 86400); } catch (e) { say(`! beat: ${e.message}`); } }
  tick++;
  const left = start + hours * 3600e3 - Date.now();
  if (left <= 0) break;
  await sleep(Math.min(every * 60e3, left));
}
finish(true);
