/**
 * The world rankings for the matches below the tours (2026-11-27, the
 * owner, of the Challenger and ITF leans: "maybe not live tennis but
 * maybe good pre-game leans in the tennis section under an ITF or
 * Challenger tab along with ATP and WTA").
 *
 * A lean off the price alone is the book's own favourite. The one thing
 * to set against the price that costs nothing is the ranking: the metered
 * source the grading has a key for (worker/src/tennis-results.js) lists
 * the singles rankings 500 players a call, so a few calls a week put a
 * rank and its points beside nearly every Challenger and ITF player.
 * worker/src/tennis-lower.js reads the price against them.
 *
 * Read a page a minute until a tour's list ends, both tours, then not
 * again until the next Monday's list is out (the rankings change once a
 * week). The list in use stays in use until the new one is whole. At most
 * RANKS_DAILY calls a day.
 */
import { nameKey } from './tennis-card-parse.js';

export const LOWER_RANKS_KEY = 'tennis:lower:ranks';
export const LOWER_RANKS_WORK_KEY = 'tennis:lower:ranks:work';
const HOST = 'tennis-api-atp-wta-itf.p.rapidapi.com';
export const RANKS_PAGE = 500;
/** The most pages read of one tour's list: 2,500 players is past where a ranking says anything. */
export const RANKS_MAX_PAGES = 5;
export const RANKS_DAILY = 10;
const TOURS = ['atp', 'wta'];
/** The reader's version: a list begun by an older reader is begun again by this one. */
const RANKS_VERSION = 1;
const TTL = 30 * 86400;

/** The latest Monday noon UTC at or before `now`: a list read before it is last week's. */
export function rankingWeek(now) {
  const d = new Date(now);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday, 12);
  return monday <= now ? monday : monday - 7 * 864e5;
}

const rowsOf = (body) => { if (Array.isArray(body)) return body; for (const k of ['data', 'results', 'result', 'rankings', 'ranking']) if (Array.isArray(body?.[k])) return body[k]; return Object.values(body ?? {}).find(Array.isArray) ?? []; };
const numberOf = (...vals) => { for (const v of vals) { const n = Number(v); if (v != null && v !== '' && Number.isFinite(n)) return n; } return null; };
const nameOf = (r) => { for (const v of [r?.player?.name, r?.player?.fullName, r?.name, r?.playerName, r?.fullName, typeof r?.player === 'string' ? r.player : null]) if (typeof v === 'string' && v.trim()) return v.trim(); return null; };

/**
 * One page of the source's ranking list as {rows: [{name, rank,
 * points}], more}: `more` says another page follows (the source's own
 * word for it, else a full page).
 */
export function parseRanks(body, pageSize = RANKS_PAGE) {
  const raw = rowsOf(body);
  const rows = [];
  for (const r of raw) {
    const name = nameOf(r); const rank = numberOf(r?.position, r?.rank, r?.ranking, r?.place); const points = numberOf(r?.point, r?.points, r?.pts, r?.rankingPoints);
    if (name && rank != null && rank > 0) rows.push({ name, rank, points: points ?? 0 });
  }
  const more = typeof body?.hasNextPage === 'boolean' ? body.hasNextPage : raw.length >= pageSize;
  return { rows, more, raw: raw.length };
}

const surname = (key) => key.split(' ').filter(Boolean).at(-1) ?? '';
/**
 * A player's rank and points from a tour's list ({key: [rank, points]}):
 * the name as it is, else the one player with the same surname and first
 * initial. Null when the list has no such player, or more than one.
 */
export function rankOf(list, name) {
  if (!list) return null;
  const key = nameKey(name); if (!key) return null;
  const hit = list[key];
  if (hit) return { rank: hit[0], points: hit[1] };
  const sn = surname(key); if (sn.length < 4) return null;
  const same = Object.keys(list).filter((k) => surname(k) === sn && k[0] === key[0]);
  return same.length === 1 ? { rank: list[same[0]][0], points: list[same[0]][1] } : null;
}

const etDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(ms);
const readJson = async (env, key) => { const raw = await env.POTD_KV.get(key).catch(() => null); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } };

// Between reads the tick rests in memory, so a minute with nothing to do costs no storage read.
let restUntil = 0;

/**
 * One tick: when the list on file is older than this week's, read the
 * next page; when both tours are read, the new list takes the old one's
 * place. Returns what it did. `deps.fetchPage(tour, page)` stands in for
 * the source in tests.
 */
export async function runLowerRanksTick(env, now = Date.now(), { deps = {} } = {}) {
  if (!deps.noRest && now < restUntil) return { skipped: true, reason: 'resting' };
  const rest = (until, reason) => { restUntil = until; return { skipped: true, reason }; };
  const week = rankingWeek(now);
  let work = await readJson(env, LOWER_RANKS_WORK_KEY);
  if (work?.v === RANKS_VERSION && work.doneFor === week) return rest(now + 6 * 3600e3, 'this week\'s list is on file');
  if (work?.v === RANKS_VERSION && work.retryAt > now) return rest(Math.min(work.retryAt, now + 6 * 3600e3), 'the last list came back empty');
  const key = (env.RAPIDAPI_TENNIS_KEY ?? '').trim();
  if (!key && !deps.fetchPage) return rest(now + 30 * 60e3, 'no key');
  // A list begun for an earlier week is begun again.
  if (!work || work.v !== RANKS_VERSION || work.week !== week || !work.lists) work = { v: RANKS_VERSION, week, tour: TOURS[0], page: 1, lists: {}, day: work?.day ?? null, calls: work?.calls ?? 0, doneFor: work?.doneFor ?? null, shape: work?.shape ?? null };
  const day = etDay(now);
  const calls = work.day === day ? work.calls ?? 0 : 0;
  if (calls >= RANKS_DAILY) return rest(now + 30 * 60e3, 'the day\'s calls are spent');
  let body = null; let error = null;
  try {
    if (deps.fetchPage) body = await deps.fetchPage(work.tour, work.page);
    else { const res = await fetch(`https://${HOST}/tennis/v2/${work.tour}/ranking/singles?pageSize=${RANKS_PAGE}&pageNo=${work.page}`, { headers: { 'x-rapidapi-host': HOST, 'x-rapidapi-key': key, Accept: 'application/json' } }); if (res.ok) body = await res.json(); else error = `HTTP ${res.status}`; }
  } catch (e) { error = String(e?.message ?? e).slice(0, 120); }
  work.day = day; work.calls = calls + 1; work.error = error; work.at = now;
  if (!body) { await env.POTD_KV.put(LOWER_RANKS_WORK_KEY, JSON.stringify(work), { expirationTtl: TTL }); return rest(now + 10 * 60e3, `read failed: ${error}`); }
  const { rows, more, raw } = parseRanks(body);
  // What the source sent, cut short, the first page of each tour: for holding the reader to it.
  if (work.page === 1) work.shape = { ...(work.shape ?? {}), [work.tour]: { top: Array.isArray(body) ? 'array' : Object.entries(body ?? {}).slice(0, 10).map(([k, v]) => `${k}:${Array.isArray(v) ? `list of ${v.length}` : v && typeof v === 'object' ? `{${Object.keys(v).slice(0, 10).join(',')}}` : JSON.stringify(v)?.slice(0, 50)}`), rows: raw, parsed: rows.length, first: rowsOf(body).slice(0, 2).map((r) => JSON.stringify(r).slice(0, 700)) } };
  const list = work.lists[work.tour] ?? {};
  for (const r of rows) { const k = nameKey(r.name); if (k && !list[k]) list[k] = [r.rank, r.points]; }
  work.lists[work.tour] = list;
  const tourDone = !more || !rows.length || work.page >= RANKS_MAX_PAGES;
  if (!tourDone) work.page += 1;
  else if (work.tour !== TOURS.at(-1)) { work.tour = TOURS[TOURS.indexOf(work.tour) + 1]; work.page = 1; }
  else {
    // Both tours read: the new list goes into use, unless it came back empty (the old one stands).
    const counts = Object.fromEntries(TOURS.map((t) => [t, Object.keys(work.lists[t] ?? {}).length]));
    const whole = TOURS.every((t) => counts[t] > 0);
    if (whole) await env.POTD_KV.put(LOWER_RANKS_KEY, JSON.stringify({ at: now, week, ...work.lists }), { expirationTtl: TTL });
    // An empty list is tried again half a day on, from the first page.
    work = whole ? { ...work, doneFor: week, counts, lists: {} } : { ...work, counts, lists: null, retryAt: now + 12 * 3600e3 };
  }
  await env.POTD_KV.put(LOWER_RANKS_WORK_KEY, JSON.stringify(work), { expirationTtl: TTL });
  restUntil = now + 50e3;
  return { skipped: false, tour: work.tour, page: work.page, parsed: rows.length, done: work.doneFor === week, calls: work.calls, error };
}

/** The rankings in use: {at, week, atp: {key: [rank, points]}, wta: {...}}, or null. */
export const getLowerRanks = (env) => readJson(env, LOWER_RANKS_KEY);

/** Where the read of the rankings stands, for checking: the counts, the day's calls and the source's first rows. */
export async function lowerRanksStatus(env) {
  const [ranks, work] = await Promise.all([readJson(env, LOWER_RANKS_KEY), readJson(env, LOWER_RANKS_WORK_KEY)]);
  return { at: ranks?.at ?? null, inUse: Object.fromEntries(TOURS.map((t) => [t, Object.keys(ranks?.[t] ?? {}).length])), reading: work ? { week: work.week, tour: work.tour, page: work.page, doneFor: work.doneFor ?? null, calls: work.calls ?? 0, day: work.day ?? null, error: work.error ?? null, soFar: Object.fromEntries(TOURS.map((t) => [t, Object.keys(work.lists?.[t] ?? {}).length])) } : null, shape: work?.shape ?? null };
}
