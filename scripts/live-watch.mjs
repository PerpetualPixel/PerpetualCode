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
 * running for NBA games right now"): today's games (Eastern), every one
 * in play or starting inside the lead, picking up later games as they
 * come into it. With nothing inside the lead yet it waits, a scoreboard
 * read every five minutes, rather than exiting: GitHub's scheduler
 * delivered three of forty-eight cron firings on 2026-11-05, so a run
 * cannot count on the next one. It exits once no game of the day is
 * left, and at its hours limit with games still to come it says so
 * (more=yes on GITHUB_OUTPUT) and the workflow (.github/workflows/
 * live-auto.yml) starts the next run itself.
 */
import { appendFileSync } from 'node:fs';
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

/** The calendar day of a moment in the Eastern time zone ("2026-11-05"): the day a slate belongs to. */
export const dayKey = (ms, tz = 'America/New_York') => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
/** The state of a scoreboard event: pre, in or post. */
const stateOf = (e) => e.competitions?.[0]?.status?.type?.state ?? e.status?.type?.state ?? 'pre';
/**
 * Today's slate on the scoreboard (2026-11-06: "only show the games on the
 * current day"): the games of the current Eastern day still to come or in
 * play, plus any game in play from the day before (a late tip past
 * midnight). The NFL scoreboard lists the whole week; only today's stay.
 */
export function todaySlate(sb, now = Date.now()) {
  const today = dayKey(now);
  return (sb?.events ?? []).filter((e) => { const st = stateOf(e); const t = Date.parse(e.date); return st === 'in' || (st === 'pre' && Number.isFinite(t) && dayKey(t) === today); });
}
/** How many of today's games are still to come or in play. */
export const slateLeft = (sb, now = Date.now()) => todaySlate(sb, now).length;

/** The games to watch on the scoreboard: the team's, or (--all) every game of today in play or starting inside the lead. */
export function pickGames(sb, { team: want = '', all = false, leadMs = lead * 60e3, now = Date.now() } = {}) {
  const out = [];
  const today = all ? new Set(todaySlate(sb, now).map((e) => e.id)) : null;
  for (const e of sb?.events ?? []) {
    const comp = e.competitions?.[0];
    const state = comp?.status?.type?.state ?? e.status?.type?.state ?? 'pre';
    const start = Date.parse(e.date);
    if (want) { if ((comp?.competitors ?? []).some((c) => String(c.team?.abbreviation ?? '').toUpperCase() === want)) out.push(e); continue; }
    if (!all || !today.has(e.id)) continue;
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
  registry.set(event.id, { id: event.id, name: event.name, date: event.date, league });
  if (!DRY && listOnly) { try { await writeKv([{ key, value: log }], { ttlSeconds: 14 * 86400 }); } catch (e) { say(`! KV: ${e.message}`); } }
  say(`${listOnly ? 'listed' : 'watching'} ${event.name} (${event.id}), ${event.date}`);
  return { event, key, log, finalSince: null };
}

/**
 * This league's index, written from what this run knows (worker/src/live-probe.js merges the leagues). The store is
 * eventually consistent, so a read straight after a write can hand back the old list; every game this run registered
 * is kept in memory and written as one union with whatever the read returns, so none is lost to a stale read.
 */
const registry = new Map();
async function flushIndex() {
  if (DRY || !registry.size) return;
  const idxKey = `live:watch:index:${league}`;
  const existing = (await readKv(idxKey).catch(() => null))?.games ?? [];
  const games = [...registry.values(), ...existing.filter((g) => g?.id && !registry.has(g.id))].slice(0, 60);
  try { await writeKv([{ key: idxKey, value: { games } }], { ttlSeconds: 14 * 86400 }); } catch (e) { say(`! KV index: ${e.message}`); }
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

/** The watcher's heartbeat for the league: when it last looked, and what is next, so the board can say whether a watcher is on. */
async function beat(sb) {
  if (DRY) return;
  const left = todaySlate(sb).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const next = left.find((e) => stateOf(e) === 'pre');
  const value = { at: Date.now(), league, inPlay: left.filter((e) => stateOf(e) === 'in').length, left: left.length, next: next ? { name: next.name, date: next.date } : null };
  try { await writeKv([{ key: `live:watch:beat:${league}`, value }], { ttlSeconds: 86400 }); } catch (e) { say(`! KV beat: ${e.message}`); }
}
/** What the workflow reads after the run: whether the day still has games for a next run to pick up. */
function finish(more) {
  const line = `more=${more ? 'yes' : 'no'}`;
  say(more ? 'hours up with games still to come today: the workflow starts the next run' : 'nothing left today; watch over');
  if (process.env.GITHUB_OUTPUT) { try { appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`); } catch { /* printed below either way */ } }
  console.log(line);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  if (!team && !ALL) { console.error('usage: node scripts/live-watch.mjs --league nfl (--team PHI | --all) [--hours 5] [--every 60] [--lead 45]'); process.exit(2); }
  const deadline = Date.now() + hours * 3600e3;
  let sb = await scoreboard();
  let first = pickGames(sb, { team, all: ALL });
  if (!first.length && !ALL) { say(`no ${league.toUpperCase()} game for ${team} on today's scoreboard`); process.exit(1); }
  const watches = new Map();
  const listed = new Set();
  // --all: today's slate is listed up front (a scoreboard tick each), so the tab shows every game of the day with its tip-off.
  const listRest = async (sb) => { for (const e of ALL ? todaySlate(sb) : []) if (!watches.has(e.id) && !listed.has(e.id)) { listed.add(e.id); await openWatch(e, { listOnly: true }); } };
  await listRest(sb);
  await flushIndex();
  if (ALL) await beat(sb);
  // --all with nothing inside the lead yet: wait for the first game, a scoreboard read every five minutes, as long as the day has games.
  while (ALL && !first.length && Date.now() < deadline) {
    const left = todaySlate(sb).filter((e) => stateOf(e) !== 'post');
    if (!left.length) { say(`no ${league.toUpperCase()} game left on today's scoreboard`); finish(false); process.exit(0); }
    const next = left.map((e) => Date.parse(e.date)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    say(`no ${league.toUpperCase()} game inside ${lead} minutes yet; ${left.length} today, the first at ${next ? new Date(next).toISOString() : '?'}; looking again in five minutes`);
    await sleep(5 * 60e3);
    sb = await scoreboard();
    first = pickGames(sb, { all: true });
    await listRest(sb); await flushIndex(); await beat(sb);
  }
  if (!first.length) { finish(slateLeft(sb) > 0); process.exit(0); }
  for (const e of first) watches.set(e.id, await openWatch(e));
  await flushIndex();
  let lastScan = Date.now();
  while (Date.now() < deadline) {
    for (const w of [...watches.values()]) { if (await tickWatch(w)) watches.delete(w.event.id); }
    // --all: every five minutes (at once when nothing is being watched), the scoreboard again for games now inside the lead, and any new listing.
    if (ALL && (Date.now() - lastScan >= 5 * 60e3 || !watches.size)) {
      lastScan = Date.now();
      sb = await scoreboard();
      for (const e of pickGames(sb, { all: true })) if (!watches.has(e.id)) watches.set(e.id, await openWatch(e));
      await listRest(sb); await flushIndex(); await beat(sb);
      if (!watches.size && !todaySlate(sb).some((e) => stateOf(e) !== 'post')) break;
    }
    if (!ALL && !watches.size) break;
    if (!watches.size) say(`every watched ${league.toUpperCase()} game final; ${todaySlate(sb).filter((e) => stateOf(e) === 'pre').length} still to come today`);
    await sleep(watches.size ? every * 1000 : 5 * 60e3);
  }
  if (!ALL) { say(watches.size ? 'hours up; watch over' : 'game final; watch over'); }
  else finish(Date.now() >= deadline && (watches.size > 0 || todaySlate(sb).some((e) => stateOf(e) !== 'post')));
}
