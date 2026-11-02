#!/usr/bin/env node
/**
 * Watch one game live from a runner (ESPN answers runners, not the
 * worker) and log, every minute, the clock, the score and every skill
 * player's box line into the worker's KV, beside the worker's own
 * in-play props snapshots (worker/src/live-probe.js). Free of odds
 * credits: ESPN only.
 *
 *   node scripts/live-watch.mjs --league nfl --team PHI [--hours 5] [--every 60] [--dry-run]
 *
 * Finds today's game for the team on the league scoreboard, then loops
 * until the game is final (plus a few minutes) or the hours run out.
 */
import { readKv, writeKv } from './lib/kv.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const DRY = args.includes('--dry-run');
const league = String(opt('--league', 'nfl')).toLowerCase();
const team = String(opt('--team', '')).toUpperCase();
const hours = Number(opt('--hours', 5));
const every = Math.max(30, Number(opt('--every', 60)));
if (!team) { console.error('usage: node scripts/live-watch.mjs --league nfl --team PHI [--hours 5] [--every 60]'); process.exit(2); }

const SITE = { nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl', nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba' }[league];
if (!SITE) { console.error(`unknown league ${league}`); process.exit(2); }
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  try { const res = await fetch(url, { headers: { Accept: 'application/json' } }); if (!res.ok) throw new Error(`HTTP ${res.status}`); return await res.json(); } catch (e) { say(`! ${url}: ${e.message}`); return null; }
}

/** Today's scoreboard event with the team, by abbreviation. */
async function findEvent() {
  const sb = await getJson(`${SITE}/scoreboard`);
  for (const e of sb?.events ?? []) {
    const comp = e.competitions?.[0];
    if ((comp?.competitors ?? []).some((c) => String(c.team?.abbreviation ?? '').toUpperCase() === team)) return e;
  }
  return null;
}

/** The summary's skill-player box lines, compact: one row per athlete with the stats of every block he is in. */
function boxLines(summary) {
  const rows = new Map();
  for (const side of summary?.boxscore?.players ?? []) {
    for (const block of side?.statistics ?? []) {
      const keys = block?.keys?.length ? block.keys : (block?.names ?? []);
      for (const a of block?.athletes ?? []) {
        const id = String(a?.athlete?.id ?? ''); if (!id) continue;
        if (!rows.has(id)) rows.set(id, { id, name: a.athlete?.displayName ?? null, team: side.team?.abbreviation ?? null, stats: {} });
        keys.forEach((k, i) => { if (a.stats?.[i] != null) rows.get(id).stats[k] = a.stats[i]; });
      }
    }
  }
  return [...rows.values()];
}

const event = await findEvent();
if (!event) { say(`no ${league.toUpperCase()} game for ${team} on today's scoreboard`); process.exit(1); }
const comp = event.competitions?.[0];
say(`watching ${event.name} (${event.id}), ${event.date}`);
const key = `live:watch:${event.id}`;
const existing = DRY ? null : await readKv(key).catch(() => null);
const log = existing ?? { espnEventId: event.id, name: event.name, date: event.date, league, team, ticks: [] };
if (!DRY) {
  const idx = (await readKv('live:watch:index').catch(() => null)) ?? { games: [] };
  idx.games = [{ id: event.id, name: event.name, date: event.date, league }, ...idx.games.filter((g) => g.id !== event.id)].slice(0, 20);
  await writeKv([{ key: 'live:watch:index', value: idx }], { ttlSeconds: 14 * 86400 });
}
const deadline = Date.now() + hours * 3600e3;
let finalSince = null;
while (Date.now() < deadline) {
  const summary = await getJson(`${SITE}/summary?event=${event.id}`);
  const st = summary?.header?.competitions?.[0]?.status ?? comp?.status ?? {};
  const competitors = summary?.header?.competitions?.[0]?.competitors ?? comp?.competitors ?? [];
  const tick = {
    at: Date.now(),
    state: st.type?.state ?? null, detail: st.type?.detail ?? st.type?.description ?? null, period: st.period ?? null, clock: st.displayClock ?? null,
    score: Object.fromEntries(competitors.map((c) => [c.team?.abbreviation ?? c.homeAway, Number(c.score ?? 0)])),
    box: boxLines(summary),
  };
  log.ticks = [...log.ticks, tick].slice(-400);
  say(`${tick.state} ${tick.detail} Q${tick.period} ${tick.clock} ${JSON.stringify(tick.score)} ${tick.box.length} box lines`);
  if (!DRY) { try { await writeKv([{ key, value: log }], { ttlSeconds: 14 * 86400 }); } catch (e) { say(`! KV: ${e.message}`); } }
  if (tick.state === 'post') { finalSince = finalSince ?? Date.now(); if (Date.now() - finalSince > 8 * 60e3) { say('final; done'); break; } }
  await sleep(every * 1000);
}
say('watch over');
