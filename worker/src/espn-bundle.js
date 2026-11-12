/**
 * ESPN data delivered by a GitHub Actions runner, read from KV.
 *
 * 2026-10-27: ESPN refuses every one of its JSON endpoints from a
 * Cloudflare Worker (an HTML 403 on the roster, search, game log and core
 * paths alike; the Trends trace's "espn probe" line shows it), while a
 * GitHub runner fetches the same URLs without trouble. So the runner
 * does the ESPN half: scripts/espn-bundle.mjs pulls the roster and the
 * game logs (this season and last) for every team in the league and
 * writes one record per team here, and the Trends build and
 * Pixel's Picks read players from these records instead of calling ESPN.
 *
 * Keys: `espn:<sportKey>:<ABBR>` holds a team, `espn:<sportKey>` the
 * index the runner wrote last (when, which teams). A team record:
 *
 *   { sportKey, team: 'BOS', builtAt, players: [{ id, name, position,
 *     injuries: [{ status, detail }], log }] }
 *
 * where `log` is the player's game log in ESPN's own shape (names,
 * labels, displayNames, seasonTypes, events), this season's and last
 * season's blocks merged the way the build merges them, trimmed to the
 * fields the parsers read — so basketballStatRows / seasonColumnRows
 * work on it unchanged.
 */

export const bundleKey = (sportKey, abbr) => `espn:${sportKey}:${String(abbr ?? '').toUpperCase()}`;
export const bundleIndexKey = (sportKey) => `espn:${sportKey}`;
/** Every player in the league, name, team, position and headshot: what the Players tab searches. */
export const playersIndexKey = (sportKey) => `espn:${sportKey}:players`;
/** The league's injury report, by athlete id, written every half hour (the ESPN injuries workflow). */
export const injuriesKey = (sportKey) => `espn:${sportKey}:injuries`;

/** Who started each team's last game, by athlete id, written with the injury report (scripts/espn-bundle.mjs's recordRoles). */
export const rolesKey = (sportKey) => `espn:${sportKey}:roles`;

/**
 * The starter flags in one ESPN summary (2026-11-08 direction: "a toggle
 * for the parlay builder to only show starters and not bench players"):
 * one entry per athlete the box score lists with a starter flag, the
 * soccer lineups included. A league whose box carries no flag (the NFL)
 * yields nothing, so its players stay untagged rather than read as bench.
 */
export function startersFromSummary(summary) {
  const out = new Map();
  const add = (id, name, team, starter) => { if (id && typeof starter === 'boolean' && !out.has(id)) out.set(id, { id, name: name ?? null, team: team ?? null, starter }); };
  if (Array.isArray(summary?.rosters) && !summary?.boxscore?.players?.length) {
    for (const side of summary.rosters) for (const p of side?.roster ?? []) add(String(p?.athlete?.id ?? ''), p?.athlete?.displayName, side?.team?.abbreviation, p?.starter);
    return [...out.values()];
  }
  for (const side of summary?.boxscore?.players ?? []) for (const block of side?.statistics ?? []) for (const a of block?.athletes ?? []) add(String(a?.athlete?.id ?? ''), a?.athlete?.displayName, side?.team?.abbreviation, a?.starter);
  return [...out.values()];
}

/**
 * The starter flags in a competitor's roster from ESPN's core API
 * (events/<id>/competitions/<id>/competitors/<teamId>/roster), which
 * carries the lineup before tip-off: the NBA posts starters about half
 * an hour out, and ESPN flags them there before the box score exists.
 * Until the lineup is in, every entry reads starter false (or carries no
 * flag at all a day out), so a side with no starter at all yields
 * nothing rather than reading as a whole bench.
 */
export function startersFromRoster(roster) {
  const entries = Array.isArray(roster?.entries) ? roster.entries : [];
  const out = [];
  for (const e of entries) {
    const id = String(e?.playerId ?? e?.athlete?.id ?? '');
    if (!id || typeof e?.starter !== 'boolean') continue;
    out.push({ id, name: e.displayName ?? null, starter: e.starter, active: e.active !== false });
  }
  return out.some((p) => p.starter) ? out : [];
}

/** The Eastern calendar day of a moment, the day a slate belongs to. */
const etDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/** The roles record as the runner wrote it: { builtAt, games: { eventId: { at, date } }, players: { id: { name, team, starter, eventId, date } } }, or empty. */
export async function loadRoles(env, sportKey) {
  const raw = await env?.POTD_KV?.get?.(rolesKey(sportKey)).catch(() => null);
  if (!raw) return { builtAt: null, games: {}, players: {} };
  try { const v = JSON.parse(raw); return { builtAt: v.builtAt ?? null, games: v.games ?? {}, players: v.players ?? {} }; } catch { return { builtAt: null, games: {}, players: {} }; }
}

/**
 * The role tag for one player: { starter, team, date, source, today }, or
 * null when nothing has listed him. `source` is lineup (today's posted
 * lineup, before tip) or box (the box score, at tip and after); `today`
 * when the game is today's in the East, so a tag can say "starting
 * tonight" rather than "started last game".
 */
export function roleFor(record, athleteId, now = Date.now()) {
  const entry = record?.players?.[String(athleteId ?? '')];
  if (!entry || typeof entry.starter !== 'boolean') return null;
  const ms = entry.date ? Date.parse(entry.date) : NaN;
  return { starter: entry.starter, team: entry.team ?? null, date: entry.date ?? null, source: entry.source === 'lineup' ? 'lineup' : 'box', today: Number.isFinite(ms) && etDay(ms) === etDay(now) };
}

/** Rows with `role` set from the record by athleteId. */
export function withRoles(rows, record, now = Date.now()) {
  return (rows ?? []).map((r) => ({ ...r, role: roleFor(record, r.athleteId ?? r.id, now) }));
}

/**
 * The game context a prop is judged against beside its hit rates
 * (2026-11-12 direction: "check all variables that could hinder the
 * prop": blowout potential, the primary player at a position). The
 * runner writes one record per league: the spread and total of each game
 * to come, by team, and for the NFL the depth chart's skill positions.
 */
export const contextKey = (sportKey) => `espn:${sportKey}:context`;

const lineNumber = (v) => {
  if (Number.isFinite(v)) return v;
  const text = String(v ?? '').trim();
  if (/^(pk|pick|even)$/i.test(text)) return 0;
  const n = Number(text.replace(/^[ou]/i, '').replace('+', ''));
  return text && Number.isFinite(n) ? n : null;
};

/**
 * The lines on an ESPN scoreboard, by team abbreviation: {TEAM: {spread,
 * total, opp, home, eventId, date}} for each game not yet started that
 * carries odds. `spread` is the team's own: negative for a favorite.
 * `abbrOf` maps an ESPN team to the letters the Trends rows use.
 */
export function linesFromScoreboard(scoreboard, { abbrOf = (team) => team?.abbreviation ?? null } = {}) {
  const out = {};
  for (const e of scoreboard?.events ?? []) {
    const comp = e?.competitions?.[0];
    const odds = comp?.odds?.[0];
    const state = comp?.status?.type?.state ?? e?.status?.type?.state ?? 'pre';
    if (!odds || state !== 'pre') continue;
    const side = (homeAway) => (comp.competitors ?? []).find((c) => c?.homeAway === homeAway)?.team ?? null;
    const homeTeam = side('home'); const awayTeam = side('away');
    const home = abbrOf(homeTeam); const away = abbrOf(awayTeam);
    if (!home || !away) continue;
    const H = String(home).toUpperCase(); const A = String(away).toUpperCase();
    // ESPN's own letters for the two sides, which its odds line names.
    const eH = String(homeTeam?.abbreviation ?? home).toUpperCase(); const eA = String(awayTeam?.abbreviation ?? away).toUpperCase();
    let homeSpread = lineNumber(odds.pointSpread?.home?.close?.line);
    if (homeSpread === null) { const a = lineNumber(odds.pointSpread?.away?.close?.line); if (a !== null) homeSpread = -a; }
    if (homeSpread === null) {
      // "DAL -5.5": the favorite and its number.
      const m = /^([A-Za-z]{2,4})\s+([+-]?\d+(?:\.\d+)?)/.exec(String(odds.details ?? ''));
      if (m) homeSpread = m[1].toUpperCase() === eH ? Number(m[2]) : m[1].toUpperCase() === eA ? -Number(m[2]) : null;
    }
    const total = Number.isFinite(odds.overUnder) ? odds.overUnder : lineNumber(odds.total?.over?.close?.line);
    if (homeSpread === null && total === null) continue;
    const base = { total: total ?? null, eventId: String(e.id ?? ''), date: e.date ?? null };
    out[H] = { ...base, spread: homeSpread, opp: A, home: true };
    out[A] = { ...base, spread: homeSpread === null ? null : -homeSpread, opp: H, home: false };
  }
  return out;
}

const DEPTH_POSITIONS = new Set(['QB', 'RB', 'FB', 'WR', 'TE', 'PK', 'K']);

/**
 * The skill positions of one team's ESPN depth chart: [{id, name, team,
 * pos, rank}], rank 1 the first listed at his slot. The receivers come
 * as three slots (wr1, wr2, wr3), each with its own order, so a team has
 * three receivers at rank 1. A player listed twice keeps his better place.
 */
export function depthFromChart(chart, team) {
  const out = new Map();
  for (const formation of chart?.depthchart ?? chart?.items ?? []) {
    for (const slot of Object.values(formation?.positions ?? {})) {
      const pos = String(slot?.position?.abbreviation ?? '').toUpperCase();
      if (!DEPTH_POSITIONS.has(pos)) continue;
      (slot?.athletes ?? []).forEach((a, i) => {
        const id = String(a?.id ?? '');
        if (!id) return;
        const prev = out.get(id);
        if (!prev || i + 1 < prev.rank) out.set(id, { id, name: a?.displayName ?? null, team: team ? String(team).toUpperCase() : null, pos, rank: i + 1 });
      });
    }
  }
  return [...out.values()];
}

/** The context record as the runner wrote it: { builtAt, lines, depth, depthAt }, or empty. */
export async function loadContext(env, sportKey) {
  const raw = await env?.POTD_KV?.get?.(contextKey(sportKey)).catch(() => null);
  const empty = { builtAt: null, lines: {}, depth: {}, depthAt: null };
  if (!raw) return empty;
  try { const v = JSON.parse(raw); return { builtAt: v.builtAt ?? null, lines: v.lines ?? {}, depth: v.depth ?? {}, depthAt: v.depthAt ?? null }; } catch { return empty; }
}

/**
 * Who is out, by team, with what makes an absence matter: {TEAM: [{id,
 * name, starter, pos, rank}]}. `starter` is the roles record's flag (he
 * started the team's last game); pos and rank the depth chart's.
 */
export function outByTeam(report, roles, depth) {
  const out = {};
  for (const [id, entry] of Object.entries(report?.players ?? {})) {
    if (injuryFor(report, id)?.level !== 'out' || !/\bout\b|injured reserve|\bir\b|suspend|inactive/i.test(entry.status ?? '')) continue;
    const team = String(entry.team ?? depth?.[id]?.team ?? roles?.players?.[id]?.team ?? '').toUpperCase();
    if (!team) continue;
    const d = depth?.[id] ?? null;
    const starter = typeof roles?.players?.[id]?.starter === 'boolean' ? roles.players[id].starter : null;
    // Only an absence that moves the rest: a starter, or a player the depth chart lists first.
    if (starter !== true && !(d && d.rank === 1)) continue;
    (out[team] ??= []).push({ id, name: entry.name ?? d?.name ?? null, starter, pos: d?.pos ?? null, rank: d?.rank ?? null });
  }
  return out;
}

/** The injury report as the runner wrote it: { builtAt, players: { id: { name, team, status, detail, date } } }, or empty. */
export async function loadInjuries(env, sportKey) {
  const raw = await env?.POTD_KV?.get?.(injuriesKey(sportKey)).catch(() => null);
  if (!raw) return { builtAt: null, players: {} };
  try { const v = JSON.parse(raw); return { builtAt: v.builtAt ?? null, players: v.players ?? {} }; } catch { return { builtAt: null, players: {} }; }
}

const OUT_WORDS = /\b(out|doubtful|injured reserve|ir|suspend\w*|inactive)\b/i;
const QUESTIONABLE_WORDS = /\b(questionable|day[- ]to[- ]day|probable|gtd|game[- ]time)\b/i;

/** The tag for one player: { status, detail, level: 'out' | 'questionable' }, or null when he is not listed or the listing says he plays. */
export function injuryFor(report, athleteId) {
  const entry = report?.players?.[String(athleteId ?? '')];
  if (!entry?.status) return null;
  const level = OUT_WORDS.test(entry.status) ? 'out' : QUESTIONABLE_WORDS.test(entry.status) ? 'questionable' : null;
  if (!level) return null;
  return { status: entry.status, detail: entry.detail ?? '', level, date: entry.date ?? null };
}

/** Rows (or legs, or players) with `injury` set from the report by athleteId; the report wins over whatever the row carried. */
export function withInjuries(rows, report) {
  return (rows ?? []).map((r) => ({ ...r, injury: injuryFor(report, r.athleteId ?? r.id) }));
}

/** A record older than this is still used, but the trace says so. */
export const BUNDLE_STALE_HOURS = 30;

/** The team records for `abbrs`, as a Map of upper-cased abbr -> record (missing teams absent). */
export async function loadBundleTeams(env, sportKey, abbrs) {
  const wanted = [...new Set((abbrs ?? []).filter(Boolean).map((a) => String(a).toUpperCase()))];
  const loaded = new Map();
  if (!env?.POTD_KV?.get) return loaded;
  await Promise.all(wanted.map(async (abbr) => {
    const raw = await env.POTD_KV.get(bundleKey(sportKey, abbr)).catch(() => null);
    if (!raw) return;
    try {
      const record = JSON.parse(raw);
      if (Array.isArray(record?.players)) loaded.set(abbr, record);
    } catch { /* a corrupt record reads as missing */ }
  }));
  return loaded;
}

/** The runner's last index for a league, or null. */
export async function loadBundleIndex(env, sportKey) {
  const raw = await env?.POTD_KV?.get?.(bundleIndexKey(sportKey)).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** One player's record from a team's bundle, by athlete id, or null. */
export async function bundlePlayer(env, sportKey, abbr, athleteId) {
  if (!abbr || athleteId == null) return null;
  const teams = await loadBundleTeams(env, sportKey, [abbr]);
  const record = teams.get(String(abbr).toUpperCase());
  return record?.players.find((p) => String(p.id) === String(athleteId)) ?? null;
}

/** One line for the Trends trace: which of the chunk's teams the bundle holds, and how old it is. */
export function bundleLine(loaded, abbrs, now = Date.now()) {
  const wanted = [...new Set((abbrs ?? []).filter(Boolean).map((a) => String(a).toUpperCase()))];
  if (!loaded?.size) return `espn bundle: none of [${wanted.join(',')}] in KV (run the "ESPN bundle" workflow)`;
  const missing = wanted.filter((a) => !loaded.has(a));
  const ages = [...loaded.values()].map((r) => now - (r.builtAt ?? 0)).filter(Number.isFinite);
  const oldest = ages.length ? Math.max(...ages) / 3.6e6 : 0;
  const players = [...loaded.values()].reduce((n, r) => n + r.players.length, 0);
  return `espn bundle: ${loaded.size} of ${wanted.length} teams, ${players} players, oldest ${oldest.toFixed(1)}h${oldest > BUNDLE_STALE_HOURS ? ' (stale)' : ''}${missing.length ? `, missing [${missing.join(',')}]` : ''}`;
}

/**
 * The build's readers, answered from the loaded teams. A team the bundle
 * holds is authoritative: a name not on it is unresolved, with no call to
 * ESPN (which would be refused anyway, and costs a subrequest). A team the
 * bundle does not hold falls through to the league's own readers.
 */
export function bundleDeps(loaded, spec) {
  const logsById = new Map();
  for (const record of loaded.values()) for (const p of record.players) logsById.set(String(p.id), p.log);
  const norm = spec.normalizeName ?? ((n) => String(n ?? '').toLowerCase().trim());
  return {
    async resolve(name, abbrs, ctx) {
      const target = norm(name);
      for (const abbr of abbrs ?? []) {
        if (!abbr) continue;
        const record = loaded.get(String(abbr).toUpperCase());
        if (record) {
          const hit = record.players.find((p) => norm(p.name) === target);
          if (hit) return String(hit.id);
          continue;
        }
        const id = spec.resolve ? await spec.resolve(name, [abbr], ctx) : null;
        if (id) return id;
      }
      return null;
    },
    async gamelog(athleteId, ctx) {
      return logsById.get(String(athleteId)) ?? (spec.gamelog ? spec.gamelog(athleteId, ctx) : null);
    },
    // A bundled log already carries last season.
    priorGamelog(athleteId, ctx, now, log) {
      if (logsById.has(String(athleteId))) return null;
      return spec.priorGamelog ? spec.priorGamelog(athleteId, ctx, now, log) : null;
    },
    async roster(abbr, ctx) {
      const record = loaded.get(String(abbr ?? '').toUpperCase());
      if (record) return { athletes: [{ items: record.players.map((p) => ({ id: p.id, displayName: p.name })) }] };
      return spec.roster ? spec.roster(abbr, ctx) : undefined;
    },
  };
}
