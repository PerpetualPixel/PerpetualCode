#!/usr/bin/env node
/**
 * The Tennis tab's serve profiles (2026-11-06: aces, games and sets need
 * each player's serve and return numbers; ESPN carries none, Tennis
 * Abstract and tennis-db sit behind a browser challenge, and the match
 * database on GitHub stopped in 2024). Wheelo Ratings publishes the last
 * 52 weeks for both tours, overall and by surface, as the JSON behind its
 * stats table; a runner reads it and writes one profile per player to the
 * worker's KV (tennis:profiles:<tour>; worker/src/tennis-picks.js reads
 * them). Fail-open: a page that will not parse leaves the last profiles
 * standing.
 *
 *   node scripts/tennis-data.mjs            read and write
 *   node scripts/tennis-data.mjs --dry-run  read and print, write nothing
 *   node scripts/tennis-data.mjs --columns  print the table's columns (for a new column map)
 */
import { writeKv } from './lib/kv.mjs';

export const PAGES = { atp: 'https://www.wheeloratings.com/tennis_atp_stats_last52.html', wta: 'https://www.wheeloratings.com/tennis_wta_stats_last52.html' };
export const tennisProfilesKey = (tour) => `tennis:profiles:${tour}`;
const UA = 'PerpetualPicks/1.0 (+https://perpetualpicks.com; reads the public stats table once a day)';
const say = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
export const nameKey = (name) => String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** The Reactable table's JSON out of the page: {data: {column: [...]}, columns: [{id, name, cell?}]}. Null when it is not there. */
export function tableJson(html) {
  const at = html.indexOf('data-for="player-stats-table"');
  if (at < 0) return null;
  const start = html.indexOf('>', at) + 1;
  const end = html.indexOf('</script>', start);
  try { const x = JSON.parse(html.slice(start, end)); const attribs = x?.x?.tag?.attribs ?? {}; return { data: attribs.data ?? {}, columns: attribs.columns ?? [] }; } catch { return null; }
}

/** The first column whose id or name matches. */
const col = (t, re) => t.columns.find((c) => re.test(String(c.id ?? '')) || re.test(String(c.name ?? ''))) ?? null;
const series = (t, re) => { const c = col(t, re); return c ? t.data[c.id] ?? null : null; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
/** A share from a column that may hold 0.62 or 62. */
const share = (v) => { const n = num(v); return n == null ? null : n > 1.5 ? n / 100 : n; };

/**
 * The rows as profiles: one per player, the overall line and the surface
 * lines (the surface from a Surface column, else from the ball icon in
 * the player cell). Each line: {matches, serve, firstIn, firstWon,
 * secondWon, return, acesPerGame, ace (per service point), points}.
 */
export function parseProfiles(t) {
  const players = series(t, /^Player$/i) ?? [];
  const playerCol = col(t, /^Player$/i);
  const surfaceCol = series(t, /^Surface$/i);
  const matches = series(t, /^Matches$|MatchesPlayed|^Match(es)?Count$/i);
  const firstIn = series(t, /^FirstServePercentage$|^FirstServeIn|1st Serve %$/i);
  const firstWon = series(t, /^FirstServeWonPercentage$|1st Serve Won/i);
  const secondWon = series(t, /^SecondServeWonPercentage$|2nd Serve Won/i);
  const servePts = series(t, /^ServicePointsWonPercentage$|^ServePointsWon|Service Points Won/i);
  const returnPts = series(t, /^ReturnPointsWonPercentage$|^Return Points Won %$/i);
  const acesPerGame = series(t, /^AcesPerServiceGame$/i);
  const acePct = series(t, /^AcePercentage$/i);
  const aces = series(t, /^Aces$/i);
  const dfs = series(t, /^DoubleFaults$/i);
  const serviceGames = series(t, /^ServiceGames$|ServiceGamesPlayed/i);
  const holdPct = series(t, /^ServiceGamesWonPercentage$|Service Games Won/i);
  const breakPct = series(t, /^ReturnGamesWonPercentage$|Return Games Won/i);
  const elo = series(t, /^Elo$/i); const eloRank = series(t, /^EloRank$/i); const eloServe = series(t, /^EloServe$/i); const eloReturn = series(t, /^EloReturn$/i);
  const wins = series(t, /^Wins$/i); const losses = series(t, /^Losses$/i); const tbPct = series(t, /^TieBreaksWonPercentage$/i); const decPct = series(t, /^DecSetWinPercentage$/i);
  const bpSaved = series(t, /^BreakPointsSavedPercentage$/i); const bpConverted = series(t, /^BreakPointsConvertedPercentage$/i);
  const out = {};
  for (let i = 0; i < players.length; i++) {
    const name = String(players[i] ?? '').trim(); if (!name) continue;
    const cell = String(playerCol?.cell?.[i] ?? '');
    const surface = surfaceCol ? String(surfaceCol[i] ?? '').toLowerCase() : /ball_clay/.test(cell) ? 'clay' : /ball_grass/.test(cell) ? 'grass' : /ball_hard/.test(cell) ? 'hard' : 'all';
    const fi = share(firstIn?.[i]); const fw = share(firstWon?.[i]); const sw = share(secondWon?.[i]);
    const serve = share(servePts?.[i]) ?? (fi != null && fw != null && sw != null ? fi * fw + (1 - fi) * sw : null);
    if (serve == null) continue;
    const m = num(matches?.[i]);
    const games = num(serviceGames?.[i]) ?? (m != null ? m * 11 : null);
    const apg = num(acesPerGame?.[i]) ?? (num(aces?.[i]) != null && games ? num(aces[i]) / games : null);
    const line = { matches: m, serve: round(serve), firstIn: round(fi), firstWon: round(fw), secondWon: round(sw), return: round(share(returnPts?.[i])), hold: round(share(holdPct?.[i])), break: round(share(breakPct?.[i])), acesPerGame: apg != null ? round(apg, 3) : null, ace: share(acePct?.[i]) != null ? round(share(acePct[i]), 4) : apg != null ? round(apg / 6.4, 4) : null, aces: num(aces?.[i]), doubleFaults: num(dfs?.[i]), points: games ? Math.round(games * 6.4) : null, elo: num(elo?.[i]), eloRank: num(eloRank?.[i]), eloServe: num(eloServe?.[i]), eloReturn: num(eloReturn?.[i]), wins: num(wins?.[i]), losses: num(losses?.[i]), tiebreak: round(share(tbPct?.[i])), deciding: round(share(decPct?.[i])), bpSaved: round(share(bpSaved?.[i])), bpConverted: round(share(bpConverted?.[i])) };
    const key = nameKey(name);
    if (!out[key]) out[key] = { name, key, matches: null, overall: null, bySurface: {} };
    if (surface === 'all' || surface === 'overall' || surface === '') { out[key].overall = line; out[key].matches = m; } else out[key].bySurface[surface] = line;
  }
  // A player with surface lines only takes the deepest as the overall line.
  for (const p of Object.values(out)) if (!p.overall) { const lines = Object.values(p.bySurface).filter((l) => l.matches != null).sort((x, y) => y.matches - x.matches); if (lines[0]) { p.overall = lines[0]; p.matches = lines[0].matches; } }
  return out;
}
const round = (x, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run'); const columns = args.includes('--columns');
  const entries = [];
  for (const tour of ['atp', 'wta']) {
    try {
      const html = await get(PAGES[tour]);
      const t = tableJson(html);
      if (!t) { say(`! ${tour}: no stats table in the page`); continue; }
      if (columns) say(`${tour} columns: ${t.columns.map((c) => `${c.id}${c.name && c.name !== c.id ? ` (${c.name})` : ''}`).join(' | ')}`);
      const players = parseProfiles(t);
      const list = Object.values(players);
      const deep = list.filter((p) => (p.matches ?? 0) >= 10).length;
      say(`${tour.toUpperCase()}: ${list.length} players, ${deep} with 10+ matches, ${list.filter((p) => Object.keys(p.bySurface).length).length} with surface lines`);
      for (const p of list.slice(0, 3)) say(`  ${p.name}: ${JSON.stringify(p.overall)} surfaces ${Object.keys(p.bySurface).join(',')}`);
      if (!list.length) { say(`! ${tour}: no rows parsed; the last profiles stand`); continue; }
      entries.push({ key: tennisProfilesKey(tour), value: { at: Date.now(), source: 'wheeloratings', tour, players } });
    } catch (e) { say(`! ${tour}: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (dry) { say(`dry run: would write ${entries.map((e) => `${e.key} (${JSON.stringify(e.value).length} bytes)`).join(', ') || 'nothing'}`); process.exit(0); }
  if (!entries.length) { say('nothing parsed; nothing written'); process.exit(0); }
  await writeKv(entries, { ttlSeconds: 14 * 86400, say });
  say(`wrote ${entries.map((e) => e.key).join(', ')}`);
}
