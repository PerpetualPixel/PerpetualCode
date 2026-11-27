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
 *
 * The lean on a match in play is the live tennis model's own
 * (worker/src/tennis-live-model.js liveRead and liveCall, the same that
 * call the tour matches): the score, the games in the order they were
 * seen, and serve numbers solved from the pre-match price on the lower
 * board, since none are on file for these players. No live price is
 * read, so a lean names the price to take it at or better. One lean is
 * open on a match at a time; it is graded when its set or the match ends
 * and kept on a tally of its own, never on a record. A score here is as
 * old as the last read, and every lean says how old.
 */
import { nameKey } from './tennis-card-parse.js';
import { TENNIS_LOWER_KEY, lowerShares } from './tennis-lower.js';
import { samePlayer } from './tennis-fanduel.js';
import { advanceTimeline, liveRead, liveCall, serveFromMarket, LIVE_LEAN_UNITS } from './tennis-live-model.js';

export const LOWER_LIVE_KEY = 'tennis:lower:live';
const HOST = 'tennis-api-atp-wta-itf.p.rapidapi.com';
const LIVE_URL = `https://${HOST}/tennis/v2/extend/api/events/live`;
/** The free plan's share: with the grading's 30 this stays under the provider's 50 a day. */
export const LOWER_LIVE_DAILY = 18;
export const LOWER_LIVE_EVERY_MIN = 20;
/** From this many calls a day the source is read whether or not the board has a match in play: matches the board never listed are followed too. */
const ALWAYS_FROM = 500;
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

/** The rows of the source's answer: {success, results: [...], count} as it comes (seen 2026-11-27), or a bare list, or a list under another name. */
export function liveRows(body) {
  if (Array.isArray(body)) return body;
  for (const k of ['results', 'data', 'result', 'events']) if (Array.isArray(body?.[k])) return body[k];
  return Object.values(body ?? {}).find(Array.isArray) ?? [];
}
/** The shape on file was read by this version of the reader; a newer reader takes one fresh read for its own. */
const SHAPE_VERSION = 2;

const text = (...vals) => { for (const v of vals) { if (typeof v === 'string' && v.trim()) return v.trim(); if (v && typeof v === 'object' && typeof v.name === 'string' && v.name.trim()) return v.name.trim(); } return null; };

/**
 * The source's list of matches in play as the tick keeps them: [{id, a,
 * b, tour, status, sets, points, server, tournament}]. `server` is 'a',
 * 'b' or null. A doubles pair or a row without two names is left out.
 */
export function parseLiveEvents(body) {
  const out = [];
  for (const e of liveRows(body)) {
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

const flipPoints = (p) => { const m = /^\s*(\S+)\s*-\s*(\S+)\s*$/.exec(String(p ?? '')); return m ? `${m[2]}-${m[1]}` : p ?? null; };
/** The source's row for a lower-board match, turned to the match's own order of players; null when the source has no such match in play. */
export function eventFor(m, events) {
  for (const e of events ?? []) {
    if (samePlayer(m.a, e.a) && samePlayer(m.b, e.b)) return e;
    if (samePlayer(m.a, e.b) && samePlayer(m.b, e.a)) return { ...e, a: e.b, b: e.a, sets: e.sets.map(([x, y]) => [y, x]), points: flipPoints(e.points), server: e.server === 'a' ? 'b' : e.server === 'b' ? 'a' : null };
  }
  return null;
}

const setOver = ([a, b]) => (Math.max(a, b) >= 6 && Math.abs(a - b) >= 2) || Math.max(a, b) === 7;
/** The winner of a best of three by its sets: 'a', 'b', or null while it is not decided. */
export function matchWinner(sets) {
  let a = 0; let b = 0;
  for (const st of sets ?? []) if (setOver(st)) { if (st[0] > st[1]) a += 1; else b += 1; }
  return a >= 2 ? 'a' : b >= 2 ? 'b' : null;
}
/**
 * A lean against the score: 'win', 'loss', 'void', or null while it is
 * open. A set lean settles with its set; a match lean with the match, by
 * the sets or by the draw (`drawWinner`: who was listed in the next
 * round). `ended` says the match has left the court: what is not settled
 * by then is void.
 */
export function settleLean(lean, sets, { ended = false, drawWinner = null } = {}) {
  if (lean.market === 'live_set') {
    const st = (sets ?? [])[lean.set - 1];
    if (st && setOver(st)) return (st[0] > st[1] ? 'a' : 'b') === lean.side ? 'win' : 'loss';
    return ended ? 'void' : null;
  }
  const w = matchWinner(sets) ?? drawWinner;
  if (w) return w === lean.side ? 'win' : 'loss';
  return ended ? 'void' : null;
}

/** A tournament below the tours by the source's own name for it ("Playford Challenger", "M15 Orlando", "W75 Playford"); the tours and the team events are not. */
export const lowerSourceTier = (name) => { const n = String(name ?? ''); return /challenger/i.test(n) ? 'challenger' : /\bitf\b|^[MW]\d{2,3}\b/i.test(n) ? 'itf' : /\b125k?\b/i.test(n) ? '125' : null; };

/** A match stays on file this long after its listed start; a match lean with no result by LEAN_VOID_MS after it is void. */
const MATCH_KEEP_MS = 14 * 3600e3;
const LEAN_VOID_MS = 8 * 3600e3;
const ENDED = /end|finish|retir|complet|cancel|walkover|abandon/i;
const decimalOf = (american) => (american > 0 ? 1 + american / 100 : 1 + 100 / -american);
const round3 = (x) => Math.round(x * 1000) / 1000;
const lineOf = (sets) => (sets ?? []).map(([a, b]) => `${a}-${b}`).join(' ') || '0-0';

/**
 * The matches on file with one read of the source folded in: each lower
 * board match the source has in play gets its score, its games carried
 * forward, the model's read and call, and a lean when the call is one
 * and none is open; an open lean is settled when the score, the draw or
 * the match's end decides it. Returns {matches, tally}.
 */
export function advanceLower(prevMatches, prevTally, log, events, now = Date.now()) {
  const tally = { wins: 0, losses: 0, voids: 0, units: 0, ...(prevTally ?? {}) };
  const matches = {};
  const board = Object.values(log?.matches ?? {}).filter((m) => m.start <= now + 30 * 60e3 && now - m.start <= MATCH_KEEP_MS);
  // The source's own matches below the tours that the board never listed (FanDuel's page did not carry them, or carried them before the board was kept):
  // read from the score alone, with no pre-match price and no draw to grade by. A match already followed that way is carried until it ages out.
  const onBoard = (x) => board.some((m) => (samePlayer(m.a, x.a) && samePlayer(m.b, x.b)) || (samePlayer(m.a, x.b) && samePlayer(m.b, x.a)));
  const offBoard = new Map();
  for (const p of Object.values(prevMatches ?? {})) if (p.source && now - p.start <= MATCH_KEEP_MS && !onBoard(p)) offBoard.set(p.id, { id: p.id, comp: p.comp, tour: p.tour, tier: p.tier, a: p.a, b: p.b, start: p.start, ml: null, source: true });
  for (const e of events ?? []) {
    const tier = lowerSourceTier(e.tournament); const id = `src:${e.id}`;
    if (!tier || offBoard.has(id) || onBoard(e)) continue;
    offBoard.set(id, { id, comp: e.tournament, tour: e.tour, tier, a: e.a, b: e.b, start: now, ml: null, source: true });
  }
  for (const m of [...board, ...offBoard.values()]) {
    const prev = prevMatches?.[m.id] ?? null;
    const drawWinner = m.result === 'a' || m.result === 'b' ? m.result : null;
    const e = drawWinner ? null : eventFor(m, events);
    if (!e && !prev) continue;
    const sets = e ? e.sets : prev.sets ?? [];
    const live = Boolean(e) && !ENDED.test(e.status) && !matchWinner(sets);
    const timeline = e ? advanceTimeline(prev?.timeline, sets) : prev.timeline ?? { sets: [], games: [] };
    const share = lowerShares(m.ml)?.a ?? null;
    const serve = prev?.serve ?? serveFromMarket(share ?? 0.5, { tour: m.tour });
    const names = { a: m.a, b: m.b };
    let lean = prev?.lean ?? null;
    if (lean && !lean.result) {
      let r = settleLean(lean, sets, { drawWinner });
      // Off the court: a set lean not seen to finish is void at once; a match lean waits for the draw, then is void.
      if (!r && !live && (lean.market === 'live_set' || now - m.start > LEAN_VOID_MS)) r = settleLean(lean, sets, { ended: true, drawWinner });
      if (r) {
        lean = { ...lean, result: r, settledAt: now, final: lineOf(sets) };
        if (r === 'win') { tally.wins += 1; tally.units = Math.round((tally.units + LIVE_LEAN_UNITS * (decimalOf(lean.playable) - 1)) * 100) / 100; } else if (r === 'loss') { tally.losses += 1; tally.units = Math.round((tally.units - LIVE_LEAN_UNITS) * 100) / 100; } else tally.voids += 1;
      }
    }
    let read = prev?.read ?? null; let call = prev?.call ?? null;
    if (live) {
      const r = liveRead({ sets, games: timeline.games, serve, market: null, bestOf: 3, names });
      call = liveCall(r, { names, gamesSeen: timeline.games.length, thin: share == null });
      read = { prob: round3(r.prob), set: round3(r.model.set), setNumber: r.state.setNumber, inSet: r.state.inSet, why: r.why.slice(0, 4) };
      if (call.kind === 'lean' && (!lean || lean.result)) lean = { market: call.market, side: call.side, set: call.set ?? null, selection: call.selection, prob: call.prob, playable: call.playable, basis: call.basis, score: lineOf(sets), at: now };
    }
    matches[m.id] = { id: m.id, comp: m.comp ?? null, tour: m.tour, tier: m.tier, a: m.a, b: m.b, start: m.start, priced: share != null, ...(m.source ? { source: true } : {}), sets, points: e?.points ?? null, server: e?.server ?? null, live, seenAt: e ? now : prev.seenAt ?? null, timeline, serve, read, call, lean };
  }
  return { matches, tally };
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
  // On the free plan a read is spent only while a board match should be in play; a plan with calls to spare reads the clock round.
  if (!playing.length && state.shape?.v === SHAPE_VERSION && daily < ALWAYS_FROM) return rest(now + 5 * 60e3, 'nothing in play');
  const key = (env.RAPIDAPI_TENNIS_KEY ?? '').trim();
  if (!key && !deps.fetchLive) return rest(now + 30 * 60e3, 'no key');
  let body = null; let error = null;
  try {
    if (deps.fetchLive) body = await deps.fetchLive();
    else { const res = await fetch(LIVE_URL, { headers: { 'x-rapidapi-host': HOST, 'x-rapidapi-key': key, Accept: 'application/json' } }); if (res.ok) body = await res.json(); else error = `HTTP ${res.status}`; }
  } catch (e) { error = String(e?.message ?? e).slice(0, 120); }
  const events = body ? parseLiveEvents(body) : [];
  const raw = liveRows(body);
  // The scores folded into the matches on file; a read that did not come leaves them as they were.
  const folded = body ? advanceLower(state.matches, state.tally, log, events, now) : { matches: state.matches ?? {}, tally: state.tally ?? null };
  const next = {
    at: now, fetchedAt: now, day, calls: calls + 1, error, matches: folded.matches, tally: folded.tally,
    events: body ? events : state.events ?? [], eventsAt: body ? now : state.eventsAt ?? null,
    // What the source sent, cut short: the top-level fields, how many rows, and the first rows as they came.
    shape: body ? { v: SHAPE_VERSION, top: Array.isArray(body) ? 'array' : Object.entries(body ?? {}).slice(0, 12).map(([k, v]) => `${k}:${Array.isArray(v) ? `list of ${v.length}` : v && typeof v === 'object' ? `{${Object.keys(v).slice(0, 12).join(',')}}` : JSON.stringify(v)?.slice(0, 60)}`), rows: raw.length, parsed: events.length, first: raw.slice(0, 3).map((r) => JSON.stringify(r).slice(0, 1500)) } : state.shape ?? null,
    playing: playing.length,
  };
  await env.POTD_KV.put(LOWER_LIVE_KEY, JSON.stringify(next), { expirationTtl: STATE_TTL });
  restUntil = now + Math.min(everyMs, 60e3);
  return { skipped: false, events: events.length, playing: playing.length, calls: next.calls, error };
}

/**
 * The Live tab's read of the state: the matches in play at the last
 * read, each with its score, its call and its lean; the leans settled
 * lately; the tally; how old the scores are and how often they are read.
 */
export function lowerLiveView(state, env, now = Date.now()) {
  if (!state) return null;
  const { daily, everyMs } = lowerLiveBudget(env);
  const all = Object.values(state.matches ?? {});
  const view = (m) => ({ id: m.id, comp: m.comp, tour: m.tour, tier: m.tier, a: m.a, b: m.b, start: m.start, priced: m.priced, sets: m.sets, points: m.points, server: m.server, read: m.read, call: m.call, lean: m.lean });
  const matches = all.filter((m) => m.live && m.seenAt === state.eventsAt).sort((x, y) => x.start - y.start || String(x.a).localeCompare(String(y.a))).map(view);
  const settled = all.filter((m) => m.lean?.result).sort((x, y) => (y.lean.settledAt ?? 0) - (x.lean.settledAt ?? 0)).slice(0, 8).map((m) => ({ id: m.id, comp: m.comp, a: m.a, b: m.b, ...m.lean }));
  const used = state.day === etDay(now) ? state.calls ?? 0 : 0;
  return { at: state.eventsAt ?? null, everyMin: Math.round(everyMs / 60e3), readsLeft: Math.max(0, daily - used), error: state.error ?? null, matches, settled, tally: state.tally ?? { wins: 0, losses: 0, voids: 0, units: 0 } };
}

/** What the last read holds, for the Live tab; `debug` adds the source's rows as they came. */
export async function getLowerLive(env, now = Date.now(), { debug = false } = {}) {
  const s = await readJson(env, LOWER_LIVE_KEY);
  const view = lowerLiveView(s, env, now);
  return view && debug ? { ...view, calls: s.calls ?? 0, day: s.day ?? null, playing: s.playing ?? 0, events: (s.events ?? []).length, shape: s.shape ?? null } : view;
}
