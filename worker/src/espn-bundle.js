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
