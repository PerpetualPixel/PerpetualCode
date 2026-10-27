/**
 * Pull the ESPN half of the Trends build from a runner that ESPN answers,
 * and write it into the worker's KV (see worker/src/espn-bundle.js for
 * why: ESPN refuses every JSON path from a Cloudflare Worker).
 *
 * For each league in LEAGUES: the teams playing today or tomorrow (ET),
 * from ESPN's scoreboard; each team's roster; each player's game log
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
import { etParts, etDatePlusDays } from '../worker/src/potd.js';
import { espnAbbr } from '../docs/team-logos.js';
import { priorSeasonKey } from '../docs/prop-legs.js';
import { bundleKey, bundleIndexKey } from '../worker/src/espn-bundle.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY = args.includes('--league') ? args[args.indexOf('--league') + 1] : null;
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

/** Teams on the scoreboard for today and tomorrow ET, keyed the way the worker keys them (docs/team-logos.js). */
async function teamsPlaying(league, now) {
  const days = [etParts(now).date, etDatePlusDays(now, 1)].map((d) => String(d).replace(/-/g, ''));
  const teams = new Map();
  for (const day of days) {
    const board = await getJson(`${league.site}/scoreboard?dates=${day}`);
    for (const ev of board?.events ?? []) {
      for (const c of ev?.competitions?.[0]?.competitors ?? []) {
        const name = c?.team?.displayName;
        const abbr = (espnAbbr(league.sportKey, name) ?? c?.team?.abbreviation ?? '').toLowerCase();
        if (abbr) teams.set(abbr.toUpperCase(), { abbr, name });
      }
    }
  }
  return [...teams.values()];
}

async function buildTeam(league, team, now) {
  const roster = await getJson(`${league.site}/teams/${team.abbr}/roster`);
  const groups = Array.isArray(roster?.athletes) ? roster.athletes : [];
  const items = groups.flatMap((g) => (Array.isArray(g?.items) ? g.items : Array.isArray(g) ? g : [g]));
  const athletes = items.filter((a) => a?.id && a?.displayName && league.keep(a?.position?.abbreviation));
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
  return { sportKey: league.sportKey, team: team.abbr.toUpperCase(), builtAt: now, players: kept };
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
  const teams = await teamsPlaying(league, now);
  say(`teams playing today/tomorrow: [${teams.map((t) => t.abbr.toUpperCase()).join(',')}]`);
  const records = [];
  for (const team of teams) records.push(await buildTeam(league, team, now));
  const entries = records.map((r) => ({ key: bundleKey(league.sportKey, r.team), value: r }));
  entries.push({ key: bundleIndexKey(league.sportKey), value: { sportKey: league.sportKey, builtAt: now, teams: records.map((r) => r.team), players: records.reduce((n, r) => n + r.players.length, 0) } });
  const size = entries.reduce((n, e) => n + JSON.stringify(e.value).length, 0);
  say(`${records.length} team records, ${(size / 1e6).toFixed(2)} MB`);
  if (DRY) continue;
  try { await writeKv(entries); } catch (e) { failed = true; say(`  ! ${e.message}`); }
}
if (failed) process.exit(1);
