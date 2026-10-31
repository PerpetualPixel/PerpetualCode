/**
 * Pull the ESPN half of the Trends build from a runner that ESPN answers,
 * and write it into the worker's KV (see worker/src/espn-bundle.js for
 * why: ESPN refuses every JSON path from a Cloudflare Worker).
 *
 * For each league in LEAGUES: every team's roster; each player's game log
 * this season and last, merged and trimmed to what the parsers read.
 * One KV record per team, plus an index per league.
 *
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/espn-bundle.mjs
 *   node scripts/espn-bundle.mjs --dry-run      # fetch and report, write nothing
 *   node scripts/espn-bundle.mjs --league nba   # one league
 *
 * The token needs Workers KV Storage: Edit — the "Edit Cloudflare
 * Workers" template the deploy workflow's token was made from has it.
 */
import { readFileSync } from 'node:fs';
import { espnAbbr } from '../docs/team-logos.js';
import { priorSeasonKey } from '../docs/prop-legs.js';
import { bundleKey, bundleIndexKey, playersIndexKey, injuriesKey } from '../worker/src/espn-bundle.js';
import { boxKey, boxLegKey, findBoxEvent, eventFinal, boxLine, boxActual } from '../worker/src/box-grading.js';
import { basketballHeadshotUrl } from '../worker/src/basketball-props.js';
import { nflHeadshotUrl } from '../worker/src/football-props.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY = args.includes('--league') ? args[args.indexOf('--league') + 1] : null;
/** Rosters only, for the injury report, plus the game logs behind any open ticket so it grades within the hour: every half hour, a few seconds. */
const INJURIES_ONLY = args.includes('--injuries');
const CONCURRENCY = 6;
const TTL_SECONDS = 3 * 86400;

const LEAGUES = {
  nba: {
    sportKey: 'basketball_nba',
    site: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba',
    gamelog: 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes',
    keep: () => true,
    prior: (log) => priorSeasonKey(log),
  },
  nfl: {
    sportKey: 'americanfootball_nfl',
    site: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl',
    gamelog: 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes',
    // The prop markets are passing, rushing, receiving and kicking.
    keep: (pos) => ['QB', 'RB', 'FB', 'WR', 'TE', 'K'].includes(String(pos ?? '').toUpperCase()),
    prior: () => new Date().getUTCFullYear() - 1,
  },
};

const say = (...a) => console.log(...a);

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) { say(`  ! ${url}: ${e.message}`); return null; }
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  return null;
}

async function pool(items, worker, size = CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await worker(items[i], i); }
  }));
  return out;
}

/** The game log, trimmed to the fields the parsers read (docs/prop-legs.js's seasonColumnRows and the stat indexes). */
function trimLog(log) {
  if (!log || !Array.isArray(log.seasonTypes)) return null;
  const seasonTypes = log.seasonTypes.map((s) => ({
    displayName: s?.displayName ?? '',
    categories: (s?.categories ?? []).map((c) => ({ events: (c?.events ?? []).map((e) => ({ eventId: e?.eventId, stats: e?.stats })) })),
  }));
  const events = {};
  for (const [id, m] of Object.entries(log.events ?? {})) {
    events[id] = {
      gameDate: m?.gameDate, atVs: m?.atVs, gameResult: m?.gameResult, score: m?.score,
      opponent: m?.opponent ? { abbreviation: m.opponent.abbreviation, displayName: m.opponent.displayName } : undefined,
    };
  }
  return { names: log.names ?? [], labels: log.labels ?? [], displayNames: log.displayNames ?? [], seasonTypes, events };
}

/** This season's and last season's logs merged the way the Trends build merges them. */
function mergeLogs(current, prior) {
  if (!current) return null;
  if (!prior?.seasonTypes?.length) return current;
  return { ...current, seasonTypes: [...current.seasonTypes, ...prior.seasonTypes], events: { ...prior.events, ...current.events } };
}

/**
 * Every team in the league, keyed the way the worker keys them
 * (docs/team-logos.js). The whole league rather than the scoreboard's
 * teams: ESPN answered a day's scoreboard with a broken body on the first
 * run, which left four teams out, and the runner pulls thirty teams'
 * logs in seconds anyway. The worker reads only the teams it needs.
 */
async function leagueTeams(league) {
  const list = await getJson(`${league.site}/teams?limit=40`);
  const teams = new Map();
  for (const entry of list?.sports?.[0]?.leagues?.[0]?.teams ?? []) {
    const name = entry?.team?.displayName;
    const abbr = (espnAbbr(league.sportKey, name) ?? entry?.team?.abbreviation ?? '').toLowerCase();
    if (abbr) teams.set(abbr.toUpperCase(), { abbr, name });
  }
  return [...teams.values()];
}

/** The roster's athletes, every position. */
async function rosterOf(league, team) {
  const roster = await getJson(`${league.site}/teams/${team.abbr}/roster`);
  const groups = Array.isArray(roster?.athletes) ? roster.athletes : [];
  return groups.flatMap((g) => (Array.isArray(g?.items) ? g.items : Array.isArray(g) ? g : [g])).filter((a) => a?.id && a?.displayName);
}

/** The injury report ESPN files on the roster: one entry per listed player, with the status, the detail and when it was filed. */
function injuryEntries(league, team, items) {
  const out = {};
  for (const a of items) {
    const inj = (a?.injuries ?? [])[0];
    if (!inj?.status) continue;
    out[String(a.id)] = { name: a.displayName, team: team.abbr.toUpperCase(), position: a?.position?.abbreviation ?? null, status: inj.status, detail: inj?.details?.detail ?? inj?.details?.type ?? '', date: inj?.date ?? null };
  }
  return out;
}

async function buildTeam(league, team, now) {
  const items = await rosterOf(league, team);
  const athletes = items.filter((a) => league.keep(a?.position?.abbreviation));
  const players = await pool(athletes, async (a) => {
    const current = await getJson(`${league.gamelog}/${a.id}/gamelog`);
    const priorKey = current ? league.prior(current) : null;
    const prior = priorKey ? await getJson(`${league.gamelog}/${a.id}/gamelog?season=${priorKey}`) : null;
    const log = mergeLogs(trimLog(current), trimLog(prior));
    if (!log) return null;
    return {
      id: String(a.id),
      name: a.displayName,
      position: a?.position?.abbreviation ?? null,
      injuries: (a?.injuries ?? []).map((i) => ({ status: i?.status ?? '', detail: i?.details?.detail ?? i?.details?.type ?? '' })),
      log,
    };
  });
  const kept = players.filter(Boolean);
  const games = kept.reduce((n, p) => n + Object.keys(p.log.events).length, 0);
  say(`  ${team.abbr.toUpperCase()} ${team.name}: ${athletes.length} on roster, ${kept.length} logs, ${games} logged games`);
  return { sportKey: league.sportKey, team: team.abbr.toUpperCase(), builtAt: now, players: kept, injuries: injuryEntries(league, team, items) };
}

/** One KV value by key, parsed, or null when it is not there. */
async function readKv(key) {
  const { namespace, token, account } = kvConfig();
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV read failed: HTTP ${res.status}`);
  return res.json();
}

const etDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

/**
 * The game logs behind the open Pixel's Picks tickets, refreshed so the
 * worker grades them on its next tick rather than after the morning
 * bundle: the pending legs from today's and yesterday's records
 * (worker/src/trend-picks.js keys them trendpicks:<date>), their
 * players' logs pulled fresh and written back into the team records.
 */
async function refreshTicketLogs(league, now) {
  const wanted = new Map();
  for (const date of [etDate(now), etDate(now - 864e5)]) {
    const record = await readKv(`trendpicks:${date}`).catch((e) => { say(`  ! ${e.message}`); return null; });
    for (const bet of record?.bets ?? []) {
      if (bet.status !== 'pending') continue;
      for (const leg of bet.legs ?? []) {
        if (leg.result != null || leg.sportKey !== league.sportKey || !leg.athleteId || !leg.team) continue;
        const team = String(leg.team).toUpperCase();
        if (!wanted.has(team)) wanted.set(team, new Set());
        wanted.get(team).add(String(leg.athleteId));
      }
    }
  }
  if (!wanted.size) { say('no open tickets to refresh'); return; }
  const entries = [];
  for (const [team, ids] of wanted) {
    const record = await readKv(bundleKey(league.sportKey, team)).catch(() => null);
    if (!Array.isArray(record?.players)) { say(`  ! ${team}: no team record to refresh`); continue; }
    let refreshed = 0;
    for (const id of ids) {
      const player = record.players.find((p) => String(p.id) === id);
      if (!player) continue;
      const current = await getJson(`${league.gamelog}/${id}/gamelog`);
      const priorKey = current ? league.prior(current) : null;
      const prior = priorKey ? await getJson(`${league.gamelog}/${id}/gamelog?season=${priorKey}`) : null;
      const log = mergeLogs(trimLog(current), trimLog(prior));
      if (!log) continue;
      player.log = log;
      refreshed++;
    }
    say(`  ${team}: ${refreshed} of ${ids.size} open-ticket logs refreshed`);
    if (refreshed) entries.push({ key: bundleKey(league.sportKey, team), value: { ...record, refreshedAt: now } });
  }
  if (!entries.length) return;
  if (DRY) { say(`  (dry run) would write ${entries.length} team records`); return; }
  await writeKv(entries);
}

/**
 * The open tickets' legs, graded off the box score (worker/src/boxscore.js):
 * each leg's game from the day's scoreboard once it is final, the
 * player's line from its summary, written under boxKey for the worker's
 * grader. A player missing from a final box, or listed did-not-play, is
 * written as a no-show so the leg voids now rather than 36 hours on.
 */
async function gradeTicketBoxes(league, now) {
  const legs = [];
  for (let i = 0; i < 3; i++) {
    const date = etDate(now - i * 864e5);
    const record = await readKv(`trendpicks:${date}`).catch((e) => { say(`  ! ${e.message}`); return null; });
    for (const bet of record?.bets ?? []) {
      if (bet.status !== 'pending') continue;
      for (const leg of bet.legs ?? []) {
        if (leg.result != null || leg.sportKey !== league.sportKey || !leg.athleteId || !leg.team || !leg.gameDate || !leg.statKey) continue;
        if (now < (leg.commenceMs ?? 0) + 2 * 3.6e6) continue;
        legs.push(leg);
      }
    }
  }
  if (!legs.length) { say('no open legs past tip-off to grade off the box'); return; }
  const byDate = new Map();
  for (const leg of legs) { if (!byDate.has(leg.gameDate)) byDate.set(leg.gameDate, []); byDate.get(leg.gameDate).push(leg); }
  const entries = [];
  for (const [gameDate, dayLegs] of byDate) {
    const scoreboard = await getJson(`${league.site}/scoreboard?dates=${gameDate.replaceAll('-', '')}`);
    if (!scoreboard) { say(`  ! ${gameDate}: no scoreboard`); continue; }
    const existing = (await readKv(boxKey(league.sportKey, gameDate)).catch(() => null)) ?? { sportKey: league.sportKey, gameDate, legs: {} };
    const summaries = new Map();
    let wrote = 0;
    for (const leg of dayLegs) {
      const k = boxLegKey(leg.athleteId, leg.statKey);
      if (existing.legs[k]) continue;
      const event = findBoxEvent(scoreboard, leg.team);
      if (!event) { say(`  ${leg.playerName}: ${leg.team} not on the ${gameDate} scoreboard`); continue; }
      if (!eventFinal(event)) { say(`  ${leg.playerName}: ${event.name ?? event.id} not final`); continue; }
      if (!summaries.has(event.id)) summaries.set(event.id, await getJson(`${league.site}/summary?event=${event.id}`));
      const summary = summaries.get(event.id);
      if (!summary?.boxscore) { say(`  ! ${event.id}: no box score`); continue; }
      const line = boxLine(summary, leg.athleteId);
      const value = boxActual(line, league.sportKey, leg.statKey);
      if (!line.dnp && value == null) { say(`  ${leg.playerName}: box has no ${leg.statKey}`); continue; }
      existing.legs[k] = { value: line.dnp ? null : value, dnp: line.dnp, reason: line.reason ?? null, eventId: String(event.id), at: now };
      wrote++;
      say(`  ${leg.playerName} ${leg.statKey}: ${line.dnp ? `no show (${line.reason})` : value}`);
    }
    if (wrote) entries.push({ key: boxKey(league.sportKey, gameDate), value: { ...existing, at: now } });
  }
  if (!entries.length) return;
  if (DRY) { say(`  (dry run) would write ${entries.length} box records`); return; }
  await writeKv(entries);
}

function kvConfig() {
  const toml = readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8');
  const block = /\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"POTD_KV"[\s\S]*?id\s*=\s*"([0-9a-f]+)"/.exec(toml);
  if (!block) throw new Error('POTD_KV namespace id not found in worker/wrangler.toml');
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required (or pass --dry-run)');
  return { namespace: block[1], token, account };
}

async function writeKv(entries) {
  const { namespace, token, account } = kvConfig();
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/bulk`;
  for (let i = 0; i < entries.length; i += 20) {
    const batch = entries.slice(i, i + 20).map((e) => ({ key: e.key, value: JSON.stringify(e.value), expiration_ttl: TTL_SECONDS }));
    const res = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.success === false) throw new Error(`KV write failed: HTTP ${res.status} ${JSON.stringify(body?.errors ?? body).slice(0, 300)}`);
    say(`  wrote ${batch.length} keys (${(batch.reduce((n, b) => n + b.value.length, 0) / 1e6).toFixed(2)} MB)`);
  }
}

const now = Date.now();
let failed = false;
for (const [name, league] of Object.entries(LEAGUES)) {
  if (ONLY && ONLY !== name) continue;
  say(`\n=== ${name.toUpperCase()} (${league.sportKey}) ===`);
  const teams = await leagueTeams(league);
  say(`teams: [${teams.map((t) => t.abbr.toUpperCase()).join(',')}]`);
  if (!teams.length) { failed = true; say('  ! no teams: the league list did not load'); continue; }
  if (INJURIES_ONLY) {
    const players = {};
    await pool(teams, async (team) => Object.assign(players, injuryEntries(league, team, await rosterOf(league, team))));
    say(`${Object.keys(players).length} players on the injury report`);
    if (!DRY) { try { await writeKv([{ key: injuriesKey(league.sportKey), value: { sportKey: league.sportKey, builtAt: now, players } }]); } catch (e) { failed = true; say(`  ! ${e.message}`); } }
    try { await refreshTicketLogs(league, now); } catch (e) { say(`  ! ticket logs: ${e.message}`); }
    try { await gradeTicketBoxes(league, now); } catch (e) { say(`  ! box scores: ${e.message}`); }
    continue;
  }
  const records = [];
  for (const team of teams) records.push(await buildTeam(league, team, now));
  const entries = records.map(({ injuries, ...r }) => ({ key: bundleKey(league.sportKey, r.team), value: r }));
  entries.push({ key: injuriesKey(league.sportKey), value: { sportKey: league.sportKey, builtAt: now, players: Object.assign({}, ...records.map((r) => r.injuries)) } });
  entries.push({ key: bundleIndexKey(league.sportKey), value: { sportKey: league.sportKey, builtAt: now, teams: records.map((r) => r.team), players: records.reduce((n, r) => n + r.players.length, 0) } });
  // Every player in the league, light enough for the Players tab to search as the user types (worker/src/player-search.js).
  const headshot = league.sportKey === 'americanfootball_nfl' ? nflHeadshotUrl : (id) => basketballHeadshotUrl(league.sportKey, id);
  entries.push({ key: playersIndexKey(league.sportKey), value: { sportKey: league.sportKey, builtAt: now, players: records.flatMap((r) => r.players.map((p) => ({ id: p.id, name: p.name, team: r.team, position: p.position ?? null, headshot: headshot(p.id) }))) } });
  const size = entries.reduce((n, e) => n + JSON.stringify(e.value).length, 0);
  say(`${records.length} team records, ${(size / 1e6).toFixed(2)} MB`);
  if (DRY) continue;
  try { await writeKv(entries); } catch (e) { failed = true; say(`  ! ${e.message}`); }
}
if (failed) process.exit(1);
