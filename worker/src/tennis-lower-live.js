/**
 * Live scores for the matches below the tours (2026-11-27, the owner, of
 * the Challenger and ITF board: "for live leans"). ESPN's scoreboards,
 * which the live tennis tick reads, list nothing below the tours, and
 * FanDuel's page shows a price in play and no score. The metered source
 * the grading already has a key for (worker/src/tennis-results.js) lists
 * every match in play, ATP, WTA and ITF, in one call: the set scores, the
 * points of the game in play and who is serving.
 *
 * The cost is the whole design (the owner: "keep API calls cost low"). The
 * free plan is 50 calls a day and the grading keeps 30 of them, so this
 * reads at most LOWER_LIVE_DAILY times a day, no more often than every
 * LOWER_LIVE_EVERY_MIN minutes, and only while a match on the lower board
 * (worker/src/tennis-lower.js) should be in play. A paid plan lifts both
 * numbers from the worker's variables (TENNIS_LOWER_LIVE_DAILY,
 * TENNIS_LOWER_LIVE_EVERY_MIN) with no change here: one call a minute is
 * under 45,000 a month.
 *
 * One call serves every match, so the count does not grow with the board.
 */
import { nameKey } from './tennis-card-parse.js';
import { TENNIS_LOWER_KEY } from './tennis-lower.js';

export const LOWER_LIVE_KEY = 'tennis:lower:live';
const HOST = 'tennis-api-atp-wta-itf.p.rapidapi.com';
const LIVE_URL = `https://${HOST}/tennis/v2/extend/api/events/live`;
/** The free plan's share: with the grading's 30 this stays under the provider's 50 a day. */
export const LOWER_LIVE_DAILY = 18;
export const LOWER_LIVE_EVERY_MIN = 20;
/** A match is taken to be in play from its listed start for this long. */
export const LOWER_LIVE_WINDOW_MS = 3.5 * 3600e3;
const STATE_TTL = 2 * 86400;

const num = (v, fallback) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback; };
/** The plan's two numbers: the worker's variables when set, the free plan's otherwise. */
export const lowerLiveBudget = (env) => ({ daily: num(env?.TENNIS_LOWER_LIVE_DAILY, LOWER_LIVE_DAILY), everyMs: num(env?.TENNIS_LOWER_LIVE_EVERY_MIN, LOWER_LIVE_EVERY_MIN) * 60e3 });

/** "6-4,3-2" as [[6, 4], [3, 2]]; a tiebreak's points in brackets are dropped. Empty for a score that will not read. */
export function parseSets(score) {
  const out = [];
  for (const part of String(score ?? '').split(/[,;]|\s{2,}/)) {
    const m = /^\s*(\d{1,2})\s*[-:]\s*(\d{1,2})/.exec(part.replace(/\([^)]*\)/g, ''));
    if (m) out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}

const text = (...vals) => { for (const v of vals) { if (typeof v === 'string' && v.trim()) return v.trim(); if (v && typeof v === 'object' && typeof v.name === 'string' && v.name.trim()) return v.name.trim(); } return null; };

/**
 * The source's list of matches in play as the tick keeps them: [{id, a,
 * b, tour, status, sets, points, server, tournament}]. `server` is 'a',
 * 'b' or null. A doubles pair or a row without two names is left out.
 */
export function parseLiveEvents(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.result) ? body.result : Array.isArray(body?.events) ? body.events : [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const a = text(e.player1, e.player1Name, e.home, e.homeName, e.team1, e.participant1);
    const b = text(e.player2, e.player2Name, e.away, e.awayName, e.team2, e.participant2);
    if (!a || !b || a.includes('/') || b.includes('/')) continue;
    const ind = String(e.indicator ?? '').replace(/\s/g, '');
    out.push({
      id: String(e.id ?? e.matchId ?? `${nameKey(a)}|${nameKey(b)}`), a, b,
      tour: /wta/i.test(String(e.tourType ?? e.type ?? '')) ? 'wta' : 'atp',
      status: String(e.status ?? ''), sets: parseSets(e.score ?? e.result), points: typeof e.points === 'string' ? e.points : null,
      server: ind === '1,0' ? 'a' : ind === '0,1' ? 'b' : null,
      tournament: text(e.tournament, e.tournamentName, e.league, e.competition),
    });
  }
  return out;
}

const etDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(ms);
const readJson = async (env, key) => { const raw = await env.POTD_KV.get(key).catch(() => null); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } };

/** The lower board's matches that should be in play at `now`. */
export const lowerInPlay = (log, now) => Object.values(log?.matches ?? {}).filter((m) => !m.result && m.start <= now && now - m.start < LOWER_LIVE_WINDOW_MS);

// Between reads the tick rests in memory, so a minute with nothing to do costs no storage read.
let restUntil = 0;

/**
 * One tick: read the source when a lower-board match should be in play,
 * the last read is old enough and the day has a call left. Returns what
 * it did. `deps.fetchLive()` stands in for the source in tests.
 */
export async function runLowerLiveTick(env, now = Date.now(), { deps = {} } = {}) {
  if (!deps.noRest && now < restUntil) return { skipped: true, reason: 'resting' };
  const { daily, everyMs } = lowerLiveBudget(env);
  const state = (await readJson(env, LOWER_LIVE_KEY)) ?? {};
  const day = etDay(now);
  const calls = state.day === day ? state.calls ?? 0 : 0;
  const rest = (until, reason) => { restUntil = until; return { skipped: true, reason }; };
  if (state.fetchedAt && now - state.fetchedAt < everyMs) return rest(state.fetchedAt + everyMs, 'read not long ago');
  if (calls >= daily) return rest(now + 10 * 60e3, 'the day\'s calls are spent');
  const log = await readJson(env, TENNIS_LOWER_KEY);
  const playing = lowerInPlay(log, now);
  // The first read is made with nothing in play too, once, so the shape of the source is on file.
  if (!playing.length && state.fetchedAt) return rest(now + 5 * 60e3, 'nothing in play');
  const key = (env.RAPIDAPI_TENNIS_KEY ?? '').trim();
  if (!key && !deps.fetchLive) return rest(now + 30 * 60e3, 'no key');
  let body = null; let error = null;
  try {
    if (deps.fetchLive) body = await deps.fetchLive();
    else { const res = await fetch(LIVE_URL, { headers: { 'x-rapidapi-host': HOST, 'x-rapidapi-key': key, Accept: 'application/json' } }); if (res.ok) body = await res.json(); else error = `HTTP ${res.status}`; }
  } catch (e) { error = String(e?.message ?? e).slice(0, 120); }
  const events = body ? parseLiveEvents(body) : [];
  const raw = Array.isArray(body) ? body : body?.data ?? body?.result ?? body?.events ?? [];
  const next = {
    at: now, fetchedAt: now, day, calls: calls + 1, error,
    events: body ? events : state.events ?? [], eventsAt: body ? now : state.eventsAt ?? null,
    // What the source sent, cut short: the top-level fields, how many rows, and the first rows as they came.
    shape: body ? { top: Array.isArray(body) ? 'array' : Object.keys(body ?? {}).slice(0, 20), rows: Array.isArray(raw) ? raw.length : null, parsed: events.length, first: (Array.isArray(raw) ? raw : []).slice(0, 3).map((r) => JSON.stringify(r).slice(0, 1500)) } : state.shape ?? null,
    playing: playing.length,
  };
  await env.POTD_KV.put(LOWER_LIVE_KEY, JSON.stringify(next), { expirationTtl: STATE_TTL });
  restUntil = now + Math.min(everyMs, 60e3);
  return { skipped: false, events: events.length, playing: playing.length, calls: next.calls, error };
}

/** What the last read holds, for the Live tab. */
export async function getLowerLive(env) {
  const s = await readJson(env, LOWER_LIVE_KEY);
  return s ? { at: s.eventsAt ?? null, fetchedAt: s.fetchedAt ?? null, calls: s.calls ?? 0, day: s.day ?? null, error: s.error ?? null, playing: s.playing ?? 0, events: s.events ?? [], shape: s.shape ?? null } : null;
}
