#!/usr/bin/env node
/**
 * Watch games live from a runner (ESPN answers runners, not the worker)
 * and log, every minute, the clock, the score and every skill player's
 * box line into the worker's KV, beside the worker's own in-play props
 * snapshots (worker/src/live-probe.js). Free of odds credits: ESPN only.
 *
 *   node scripts/live-watch.mjs --league nba --team LAL [--hours 5] [--every 60]
 *   node scripts/live-watch.mjs --league nba --all [--lead 45] [--hours 5.5] [--every 60]
 *
 * --team watches one game: today's game for the team on the league
 * scoreboard, until it is final (plus a few minutes) or the hours run
 * out. --all watches the whole slate (2026-11-05: "the live should be
 * running for NBA games right now"): every game in play or starting
 * inside the lead, picking up later games as they come into it, and
 * exits once none is left; the scheduled workflow (.github/workflows/
 * live-auto.yml) runs it every half hour per league so a night's games
 * are always covered.
 */
import { readKv, writeKv } from './lib/kv.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const DRY = args.includes('--dry-run');
const ALL = args.includes('--all');
const league = String(opt('--league', 'nfl')).toLowerCase();
const team = String(opt('--team', '')).toUpperCase();
const hours = Number(opt('--hours', ALL ? 5.5 : 5));
const every = Math.max(30, Number(opt('--every', 60)));
const lead = Math.max(0, Number(opt('--lead', 45)));
const fixture = opt('--scoreboard-file', null);
if (!team && !ALL) { console.error('usage: node scripts/live-watch.mjs --league nfl (--team PHI | --all) [--hours 5] [--every 60] [--lead 45]'); process.exit(2); }

const SOCCER = { ucl: 'uefa.champions', epl: 'eng.1', laliga: 'esp.1', seriea: 'ita.1', bundesliga: 'ger.1', ligue1: 'fra.1' };
const SITE = { nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl', nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba', nhl: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl', ...Object.fromEntries(Object.entries(SOCCER).map(([k, slug]) => [k, `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}`])) }[league];
if (!SITE) { console.error(`unknown league ${league}`); process.exit(2); }
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  // A read that hangs would stall every game's minute: fifteen seconds, then on to the next.
  try { const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); if (!res.ok) throw new Error(`HTTP ${res.status}`); return await res.json(); } catch (e) { say(`! ${url}: ${e.message}`); return null; }
}
async function scoreboard() {
  if (fixture) { const fs = await import('node:fs'); return JSON.parse(fs.readFileSync(fixture, 'utf8')); }
  return getJson(`${SITE}/scoreboard`);
}

/** The games to watch on the scoreboard: the team's, or (--all) every game in play or starting inside the lead. */
export function pickGames(sb, { team: want = '', all = false, leadMs = lead * 60e3, now = Date.now() } = {}) {
  const out = [];
  for (const e of sb?.events ?? []) {
    const comp = e.competitions?.[0];
    const state = comp?.status?.type?.state ?? e.status?.type?.state ?? 'pre';
    const start = Date.parse(e.date);
    if (want) { if ((comp?.competitors ?? []).some((c) => String(c.team?.abbreviation ?? '').toUpperCase() === want)) out.push(e); continue; }
    if (!all) continue;
    if (state === 'in') out.push(e);
    else if (state === 'pre' && Number.isFinite(start) && start - now <= leadMs && start - now > -3 * 3600e3) out.push(e);
  }
  return out;
}

/** The summary's skill-player box lines, compact: one row per athlete with the stats of every block he is in. */
function boxLines(summary) {
  const rows = new Map();
  // Soccer: each side's roster with stats as { name, value } pairs; only players who took the pitch.
  if (Array.isArray(summary?.rosters) && !summary?.boxscore?.players?.length) {
    for (const side of summary.rosters) for (const p of side?.roster ?? []) {
      const id = String(p?.athlete?.id ?? ''); if (!id) continue;
      const stats = {}; for (const s of p.stats ?? []) if (s?.name && s.value != null) stats[s.name] = String(s.value);
      if (!(p.starter || p.subbedIn || Number(stats.appearances ?? 0) > 0)) continue;
      rows.set(id, { id, name: p.athlete?.displayName ?? null, team: side.team?.abbreviation ?? null, stats });
    }
    return [...rows.values()];
  }
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

/** Every game on the scoreboard still to come or in play: the whole slate, listed on the Live tab ahead of its watch. */
export function listGames(sb) {
  return (sb?.events ?? []).filter((e) => { const st = e.competitions?.[0]?.status?.type?.state ?? e.status?.type?.state ?? 'pre'; return st === 'pre' || st === 'in'; });
}

/** A tick from the scoreboard alone (a game listed ahead of its watch): the state, the score and the sides, no box. */
function scoreboardTick(event) {
  const comp = event.competitions?.[0]; const st = comp?.status ?? {}; const competitors = comp?.competitors ?? [];
  return { at: Date.now(), state: st.type?.state ?? 'pre', detail: st.type?.detail ?? st.type?.description ?? null, period: st.period ?? null, clock: st.displayClock ?? null, score: Object.fromEntries(competitors.map((c) => [c.team?.abbreviation ?? c.homeAway, Number(c.score ?? 0)])), home: competitors.find((c) => c.homeAway === 'home')?.team?.abbreviation ?? null, away: competitors.find((c) => c.homeAway === 'away')?.team?.abbreviation ?? null, box: [] };
}

/** One game's watch: its log from KV (or fresh), listed in the index. `listOnly` registers a game ahead of its window with a scoreboard tick, so the Live tab shows the whole slate. */
async function openWatch(event, { listOnly = false } = {}) {
  const key = `live:watch:${event.id}`;
  const existing = DRY ? null : await readKv(key).catch(() => null);
  const log = existing ?? { espnEventId: event.id, name: event.name, date: event.date, league, team: team || null, ticks: [] };
  if (listOnly && !log.ticks.length) log.ticks = [scoreboardTick(event)];
  if (!DRY) {
    // This league's own index: one watcher per league at a time, so no other job writes it (worker/src/live-probe.js merges them).
    const idxKey = `live:watch:index:${league}`;
    const idx = (await readKv(idxKey).catch(() => null)) ?? { games: [] };
    idx.games = [{ id: event.id, name: event.name, date: event.date, league }, ...idx.games.filter((g) => g.id !== event.id)].slice(0, 40);
    await writeKv([{ key: idxKey, value: idx }, ...(listOnly ? [{ key, value: log }] : [])], { ttlSeconds: 14 * 86400 });
  }
  say(`${listOnly ? 'listed' : 'watching'} ${event.name} (${event.id}), ${event.date}`);
  return { event, key, log, finalSince: null };
}

/** One read of a game: the clock, the score, the box; true once the game has been final for a while. */
async function tickWatch(w) {
  const comp = w.event.competitions?.[0];
  // A fixture run (a dry run on a saved scoreboard) reads the game's state from the scoreboard, no summary call.
  const summary = fixture ? { header: { competitions: [comp] } } : await getJson(`${SITE}/summary?event=${w.event.id}`);
  const st = summary?.header?.competitions?.[0]?.status ?? comp?.status ?? {};
  const competitors = summary?.header?.competitions?.[0]?.competitors ?? comp?.competitors ?? [];
  const tick = {
    at: Date.now(),
    state: st.type?.state ?? null, detail: st.type?.detail ?? st.type?.description ?? null, period: st.period ?? null, clock: st.displayClock ?? null,
    score: Object.fromEntries(competitors.map((c) => [c.team?.abbreviation ?? c.homeAway, Number(c.score ?? 0)])),
    // Which abbreviation is the home side, for the game read (the odds feed names teams in full).
    home: competitors.find((c) => c.homeAway === 'home')?.team?.abbreviation ?? null,
    away: competitors.find((c) => c.homeAway === 'away')?.team?.abbreviation ?? null,
    box: boxLines(summary),
  };
  w.log.ticks = [...w.log.ticks, tick].slice(-400);
  say(`${w.event.shortName ?? w.event.name}: ${tick.state} ${tick.detail} P${tick.period} ${tick.clock} ${JSON.stringify(tick.score)} ${tick.box.length} box lines`);
  if (!DRY) { try { await writeKv([{ key: w.key, value: w.log }], { ttlSeconds: 14 * 86400 }); } catch (e) { say(`! KV: ${e.message}`); } }
  if (tick.state === 'post') { w.finalSince = w.finalSince ?? Date.now(); if (Date.now() - w.finalSince > 8 * 60e3) { say(`${w.event.shortName ?? w.event.name}: final; done`); return true; } }
  return false;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const sb = await scoreboard();
  const first = pickGames(sb, { team, all: ALL });
  if (!first.length) {
    // Nothing to watch yet: the slate is still listed, so the tab shows what is coming.
    if (ALL) for (const e of listGames(sb)) await openWatch(e, { listOnly: true });
    say(ALL ? `no ${league.toUpperCase()} game in play or inside ${lead} minutes on today's scoreboard` : `no ${league.toUpperCase()} game for ${team} on today's scoreboard`);
    process.exit(ALL ? 0 : 1);
  }
  const watches = new Map();
  const listed = new Set();
  // --all: the rest of the slate is listed up front (a scoreboard tick each), so the tab shows every game of the night with its tip-off.
  const listRest = async (sb) => { for (const e of ALL ? listGames(sb) : []) if (!watches.has(e.id) && !listed.has(e.id)) { listed.add(e.id); await openWatch(e, { listOnly: true }); } };
  for (const e of first) watches.set(e.id, await openWatch(e));
  await listRest(sb);
  const deadline = Date.now() + hours * 3600e3;
  let lastScan = Date.now();
  while (Date.now() < deadline && watches.size) {
    for (const w of [...watches.values()]) { if (await tickWatch(w)) watches.delete(w.event.id); }
    // --all: every five minutes, the scoreboard again for games now inside the lead, and any new listing.
    if (ALL && Date.now() - lastScan >= 5 * 60e3) {
      lastScan = Date.now();
      const again = await scoreboard();
      for (const e of pickGames(again, { all: true })) if (!watches.has(e.id)) watches.set(e.id, await openWatch(e));
      await listRest(again);
    }
    if (watches.size) await sleep(every * 1000);
  }
  say(watches.size ? 'hours up; watch over' : 'every game final; watch over');
}
