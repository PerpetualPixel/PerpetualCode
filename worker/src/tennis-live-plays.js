/**
 * Live tennis plays (2026-11-12 direction: "live tennis ML plays ... to
 * take a ML or to win a set based off of probability, momentum, player
 * performances"). The worker half of worker/src/tennis-live-model.js.
 *
 * A tick a minute (wrangler.toml's minute cron) while a singles match is
 * in play on either tour, and one every few minutes when none is:
 *
 *   1. the scoreboard, read fresh, so each game is seen as it lands;
 *   2. each match's games carried forward in order (the serve order and
 *      the holds and breaks are read from them);
 *   3. the pre-match serve numbers from the Tennis tab's read of the
 *      match, or solved from the live price the first time it is seen;
 *   4. the live moneyline, a few minutes old at most, for the matches in
 *      play only;
 *   5. the read, and the plays it supports: posted once per match (the
 *      moneyline) and once per set (the set), with a stake sized by the
 *      chance, and graded when the set or the match ends.
 *
 * Tracked apart from the pre-match tennis plays: a live price moves, so
 * its record says what the model saw at the moment, not what a user got.
 * A set play takes the book's own set-winner price when the feed has one
 * (h2h_s1, h2h_s2; a deciding set is the moneyline) and posts only when
 * that price is at or better than the one the read needs. With no book
 * on the set it posts at the price to take it at or better, marked so.
 */
import { etParts } from './potd.js';
import { loadTennisScoreboard } from './tennis-live.js';
import { tennisPicksKey, tennisSportKeys, feedEventFor, quotesOf, marketWinShare, liveTournamentBoard, cachedTournamentBoard, liveSetMarket } from './tennis-picks.js';
import { advanceTimeline, liveRead, livePlays, serveFromMarket, scoreState, LIVE_SET_PRICE } from './tennis-live-model.js';
import { TOUR_AVG } from './tennis-model.js';
import { setDone } from './tennis-card-parse.js';

export const TENNIS_LIVE_STATE_KEY = 'tennis:live:state';
export const TENNIS_LIVE_READS_KEY = 'tennis:live:reads';
export const tennisLivePlaysKey = (date) => `tennis:liveplays:${date}`;
export const TENNIS_LIVE_PLAYS_INDEX = 'tennis:liveplays:index';
/** The cron this tick answers to (wrangler.toml). */
export const TENNIS_LIVE_CRON = '* * * * *';
/** How long the tick rests when nothing is in play and nothing is waiting on a result. */
export const IDLE_MS = 5 * 60e3;
/** The scoreboard is read again when the stored copy is older than this. */
const SCORE_MAX_AGE = 45e3;
const KV_TTL = 60 * 86400;

const readJson = async (env, key) => { const raw = await env.POTD_KV.get(key).catch(() => null); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } };
const putJson = (env, key, value, ttl = KV_TTL) => env.POTD_KV.put(key, JSON.stringify(value), { expirationTtl: ttl }).catch(() => {});
const decimalOf = (american) => (american < 0 ? 1 + 100 / -american : 1 + american / 100);
const scoreLine = (sets) => (sets ?? []).map(([a, b]) => `${a}-${b}`).join(' ') || '0-0';
const RETIRED = /\bret\b|retire|walkover|w\/o|default/i;

/**
 * A live play against the match as it stands: {status, result, actual,
 * profit} once it can be settled, else null. The moneyline settles on
 * the winner; the set on that set; a retirement voids whatever had not
 * finished.
 */
export function gradeLivePlay(play, m) {
  if (!m) return null;
  const sets = m.sets ?? [];
  const line = scoreLine(sets);
  const price = Number.isFinite(play.american) ? play.american : play.playable;
  const settle = (won) => ({ status: 'graded', result: won ? 'win' : 'loss', actual: line, profit: Math.round((won ? play.units * (decimalOf(price) - 1) : -play.units) * 100) / 100 });
  const voided = (why) => ({ status: 'void', result: 'void', actual: `${line}: ${why}`, profit: 0 });
  if (play.market === 'live_set') {
    const s = sets[play.set - 1];
    if (s && setDone(s)) return settle((s[0] > s[1]) === (play.side === 'a'));
    return m.completed ? voided('the set was not finished') : null;
  }
  if (!m.completed) return null;
  if (RETIRED.test(String(m.note ?? '')) || RETIRED.test(String(m.detail ?? ''))) return voided('a retirement');
  if (!m.winner) return voided('no winner listed');
  return settle(m.winner === play.side);
}

/** The record of a list of live plays: {wins, losses, voids, pending, staked, units, roi}. */
export function liveRecordOf(plays) {
  const out = { wins: 0, losses: 0, voids: 0, pending: 0, staked: 0, units: 0, roi: null };
  for (const p of plays ?? []) {
    if (p.status === 'void') { out.voids++; continue; }
    if (p.status !== 'graded') { out.pending++; continue; }
    if (p.result === 'win') out.wins++; else out.losses++;
    out.staked += p.units ?? 0; out.units += p.profit ?? 0;
  }
  out.staked = Math.round(out.staked * 100) / 100; out.units = Math.round(out.units * 100) / 100;
  // A fraction, as the other ledgers carry it: 0.125 is +12.5%.
  out.roi = out.staked > 0 ? Math.round((out.units / out.staked) * 1000) / 1000 : null;
  return out;
}

/** The live moneyline for a match: the tournament's board (found through the stored pre-match boards), the event, both sides' quotes and the market's chance of A. */
async function liveOddsFor(env, ctx, m, keys, now, deps) {
  const list = keys[m.tour] ?? [];
  if (!list.length) return null;
  const cached = deps.cachedBoard ?? ((key) => cachedTournamentBoard(env, key));
  const live = deps.liveBoard ?? ((key) => liveTournamentBoard(env, ctx, key, now));
  // The key whose stored board carries the match; a tour with one tournament on needs no search.
  let key = list.length === 1 ? list[0].key : null;
  if (!key) for (const k of list) { if (feedEventFor(m, await cached(k.key))) { key = k.key; break; } }
  for (const k of key ? [key] : list.slice(0, 2).map((x) => x.key)) {
    const hit = feedEventFor(m, await live(k));
    if (!hit) continue;
    const aFeed = hit.aIsHome ? hit.event.home_team : hit.event.away_team;
    const quotes = { a: [], b: [] };
    for (const q of quotesOf(hit.event, 'h2h')) quotes[q.name === aFeed ? 'a' : 'b'].push({ bookId: q.bookId, book: q.book, american: q.american, link: q.link ?? null });
    return { key: k, eventId: hit.event.id, aFeed, quotes, market: marketWinShare(hit.event, m.a.name) };
  }
  return null;
}

/**
 * The book's price for a set play: {american, bookId, book, link} when a
 * book has the set at the price the read needs or better, null when the
 * books price it and none is good enough, undefined when no book carries
 * the set at all (the play then posts at the price to take it at).
 */
async function setPriceFor(env, ctx, m, play, odds, read, now, deps) {
  if (!odds) return undefined;
  const need = m.bestOf === 5 ? 3 : 2;
  const deciding = read.state.setsA === need - 1 && read.state.setsB === need - 1;
  let quotes = null;
  if (deciding) quotes = odds.quotes[play.side] ?? [];
  else if (play.set <= 2) {
    const body = deps.setMarket ? await deps.setMarket(odds.key, odds.eventId, play.set) : await liveSetMarket(env, ctx, odds.key, odds.eventId, play.set, now);
    const all = quotesOf(body, `h2h_s${play.set}`);
    if (!all.length) return undefined;
    quotes = all.filter((q) => (q.name === odds.aFeed) === (play.side === 'a'));
  }
  if (!quotes || !quotes.length) return undefined;
  const best = [...quotes].filter((q) => Number.isFinite(q.american) && q.american >= LIVE_SET_PRICE[0] && q.american <= LIVE_SET_PRICE[1]).sort((x, y) => y.american - x.american)[0] ?? null;
  if (!best || best.american < play.playable) return null;
  return { american: best.american, bookId: best.bookId, book: best.book, link: best.link ?? null };
}

/**
 * One tick. Returns what it did: {skipped} when resting, else {inPlay,
 * posted, graded}. `deps` lets the tests stand in for the scoreboard,
 * the tournament keys and the boards.
 */
export async function runTennisLiveTick(env, ctx, now = Date.now(), { deps = {}, force = false } = {}) {
  const state = (await readJson(env, TENNIS_LIVE_STATE_KEY)) ?? { at: 0, nextAt: 0, matches: {} };
  if (!force && now < (state.nextAt ?? 0)) return { skipped: true };
  const board = deps.scoreboard ? await deps.scoreboard() : await loadTennisScoreboard(env, now, { maxAge: SCORE_MAX_AGE });
  const all = board?.matches ?? [];
  const idOf = (m) => `${m.tour}:${m.id}`;
  const byId = new Map(all.map((m) => [idOf(m), m]));
  const today = etParts(now).date; const yesterday = etParts(now - 864e5).date;
  const records = {};
  for (const d of [today, yesterday]) records[d] = (await readJson(env, tennisLivePlaysKey(d))) ?? { date: d, plays: [] };
  const dirty = new Set();

  // Settle what can be settled.
  let graded = 0;
  for (const d of [today, yesterday]) for (const p of records[d].plays) {
    if (p.status !== 'pending') continue;
    const g = gradeLivePlay(p, byId.get(p.matchId));
    if (g) { Object.assign(p, g, { gradedAt: now }); graded++; dirty.add(d); }
    // A match that fell off the scoreboard two days on is not coming back.
    else if (now - p.postedAt > 2 * 864e5) { Object.assign(p, { status: 'void', result: 'void', actual: 'the result never came through', profit: 0, gradedAt: now }); graded++; dirty.add(d); }
  }

  const inPlay = all.filter((m) => m.state === 'in' && (m.sets ?? []).length);
  const reads = [];
  let posted = 0;
  if (inPlay.length) {
    const keys = deps.sportKeys ? await deps.sportKeys() : await tennisSportKeys(env, ctx, now);
    const pre = {};
    for (const d of [today, yesterday]) Object.assign(pre, (await readJson(env, tennisPicksKey(d)))?.reads ?? {});
    const postedIds = new Set([...records[today].plays, ...records[yesterday].plays].map((p) => p.id));
    for (const m of inPlay) {
      const id = idOf(m);
      const names = { a: m.a.name, b: m.b.name };
      const prev = state.matches[id] ?? { firstAt: now, sets: [], games: [] };
      const timeline = advanceTimeline(prev, m.sets);
      const odds = await liveOddsFor(env, ctx, m, keys, now, deps).catch(() => null);
      // The serve numbers: the pre-match read's, else solved from the live price once and kept.
      let serve = prev.serve ?? null;
      if (!serve && pre[id]?.serve) serve = { ...pre[id].serve, source: 'the pre-match read' };
      if (!serve && odds?.market != null) serve = { ...serveFromMarket(odds.market, { tour: m.tour, ...scoreState(m.sets), bestOf: m.bestOf }), source: 'the live price when the match was first seen' };
      const thin = !serve;
      const base = (TOUR_AVG[m.tour] ?? TOUR_AVG.atp).serve;
      const read = liveRead({ sets: m.sets, games: timeline.games, serve: serve ?? { pA: base, pB: base }, market: odds?.market ?? null, bestOf: m.bestOf, names });
      // No serve numbers and no price: the score alone is not a play.
      const plays = thin ? [] : livePlays(read, { quotes: odds?.quotes ?? { a: [], b: [] }, names, gamesSeen: timeline.games.length });
      for (const play of plays) {
        const playId = play.market === 'live_ml' ? `${id}:live_ml` : `${id}:live_set:${play.set}`;
        if (postedIds.has(playId)) continue;
        if (play.market === 'live_set') {
          // The book's price on the set: the deciding set is the match, the first two have their own market.
          const priced = await setPriceFor(env, ctx, m, play, odds, read, now, deps).catch(() => undefined);
          if (priced === null) continue; // a book prices the set, and not well enough: no play
          if (priced) Object.assign(play, priced);
        }
        postedIds.add(playId);
        records[today].plays.push({ id: playId, matchId: id, tour: m.tour, event: m.eventName, round: m.round, a: m.a.name, b: m.b.name, ...play, score: scoreLine(m.sets), why: read.why, postedAt: now, status: 'pending', result: null, profit: null });
        posted++; dirty.add(today);
      }
      state.matches[id] = { ...timeline, serve, firstAt: prev.firstAt ?? now, lastAt: now };
      const best = (side) => [...(odds?.quotes?.[side] ?? [])].sort((x, y) => y.american - x.american)[0] ?? null;
      reads.push({
        id, tour: m.tour, event: m.eventName, round: m.round, a: m.a.name, b: m.b.name, sets: m.sets, bestOf: m.bestOf, detail: m.detail ?? null,
        prob: Math.round(read.prob * 1000) / 1000, model: { match: Math.round(read.model.match * 1000) / 1000, set: Math.round(read.model.set * 1000) / 1000, nextSet: Math.round(read.model.nextSet * 1000) / 1000 },
        market: read.market != null ? Math.round(read.market * 1000) / 1000 : null, fair: read.fair, state: read.state, momentum: read.momentum,
        serve: { first: read.serve.first, sure: read.serve.sure, aServesNext: read.serve.aServesNext, a: read.serve.a, b: read.serve.b, breaks: read.serve.breaks, source: serve?.source ?? 'the tour average: no pre-match read and no live price' },
        why: read.why, quotes: { a: best('a'), b: best('b') }, games: timeline.games.length,
        plays: [...records[today].plays, ...records[yesterday].plays].filter((p) => p.matchId === id),
      });
    }
  }
  // A match gone from play keeps its games for six hours (a rain delay), then is dropped.
  for (const [id, rec] of Object.entries(state.matches)) if (now - (rec.lastAt ?? 0) > 6 * 3600e3) delete state.matches[id];

  for (const d of dirty) {
    await putJson(env, tennisLivePlaysKey(d), { ...records[d], refreshedAt: now });
    const index = (await readJson(env, TENNIS_LIVE_PLAYS_INDEX)) ?? { dates: [] };
    if (!index.dates.includes(d)) { index.dates = [...index.dates, d].sort().slice(-120); await putJson(env, TENNIS_LIVE_PLAYS_INDEX, index, 400 * 86400); }
  }
  // The reads are written while a match is in play, and once more when the last one ends, so the tab empties; a resting tick writes nothing here.
  if (reads.length || state.hadReads) await putJson(env, TENNIS_LIVE_READS_KEY, { at: now, matches: reads }, 6 * 3600);
  state.hadReads = reads.length > 0;
  // A minute at a time while a match is in play, one is about to start, or a play waits on a result; else a rest.
  const waiting = [...records[today].plays, ...records[yesterday].plays].some((p) => p.status === 'pending');
  const soon = all.some((m) => m.state === 'pre' && Number.isFinite(Date.parse(m.date)) && Date.parse(m.date) - now < 10 * 60e3 && Date.parse(m.date) - now > -30 * 60e3);
  state.at = now;
  state.nextAt = inPlay.length || soon ? now : waiting ? now + 2 * 60e3 : now + IDLE_MS;
  await putJson(env, TENNIS_LIVE_STATE_KEY, state, 2 * 86400);
  return { inPlay: inPlay.length, posted, graded };
}

/** The Live tab's read: the matches in play with their reads and plays, today's plays, the recent days and the record, moneyline and sets apart. */
export async function getTennisLivePlays(env, now = Date.now(), { days = 30 } = {}) {
  const reads = (await readJson(env, TENNIS_LIVE_READS_KEY)) ?? { at: null, matches: [] };
  // When the minute tick last ran and when it runs next: the tab (and a probe) can tell a resting tick from a stopped one.
  const tick = (await readJson(env, TENNIS_LIVE_STATE_KEY)) ?? {};
  const index = (await readJson(env, TENNIS_LIVE_PLAYS_INDEX)) ?? { dates: [] };
  const today = etParts(now).date;
  const dates = [...new Set([today, ...index.dates])].sort().reverse().slice(0, days);
  const history = [];
  for (const d of dates) { const r = await readJson(env, tennisLivePlaysKey(d)); if (r?.plays?.length) history.push({ date: r.date, plays: r.plays }); }
  const all = history.flatMap((r) => r.plays);
  return {
    at: reads.at, tickAt: tick.at ?? null, nextTickAt: tick.nextAt ?? null, fresh: reads.at != null && now - reads.at < 5 * 60e3, matches: reads.at != null && now - reads.at < 10 * 60e3 ? reads.matches : [],
    today: history.find((r) => r.date === today)?.plays ?? [], history,
    record: { ml: liveRecordOf(all.filter((p) => p.market === 'live_ml')), sets: liveRecordOf(all.filter((p) => p.market === 'live_set')) },
  };
}
