/**
 * The live-props probe. For every game the runner is watching
 * (scripts/live-watch.mjs writes live:watch:index), inside that game's
 * window (forty minutes before kick-off to five hours after), every cron
 * tick takes one snapshot of the feed's in-play player props for the game
 * and keeps it under KV, whole for the Live board's ladders and summarised
 * for the record of who posted what and when. At the half the tick also
 * builds the game's plays (worker/src/live-board.js's ensureLivePlays), so
 * a slip is ready whether or not anyone has the tab open.
 *
 * Credits: one call per game per tick with LIVE_MARKETS markets (one
 * credit a market), about eight ticks an hour across the two crons: on
 * the order of 300 credits for a game, out of a monthly budget near
 * 100,000.
 */
import { UPSTREAM } from './odds.js';
import { listLeagueGames } from './prop-legs.js';
import { ensureLivePlays } from './live-board.js';

/** The alt ladders the live parlay would use, and the main lines beside them, per league. */
export const LIVE_MARKETS = {
  nfl: 'player_pass_yds_alternate,player_rush_yds_alternate,player_reception_yds_alternate,player_receptions_alternate,player_pass_yds,player_rush_yds,player_reception_yds,player_receptions',
  nba: 'player_points_alternate,player_rebounds_alternate,player_assists_alternate,player_points,player_rebounds,player_assists',
  // Hockey: shots, saves and points for the slips, and the game lines (moneyline, puck line, total, main and alternate) for the game read.
  nhl: 'player_shots_on_goal_alternate,player_total_saves_alternate,player_points_alternate,player_shots_on_goal,player_total_saves,player_points,h2h,spreads,totals,alternate_spreads,alternate_totals',
};
export { SOCCER_LIVE, LIVE_SPORT } from './live-leagues.js';
import { SOCCER_LIVE, LIVE_SPORT, LIVE_ON } from './live-leagues.js';
const SOCCER_GAME_MARKETS = 'h2h,totals,alternate_totals,btts,draw_no_bet';
for (const id of Object.keys(SOCCER_LIVE)) LIVE_MARKETS[id] = id === 'ucl' ? SOCCER_GAME_MARKETS : `${SOCCER_GAME_MARKETS},player_shots_on_target,player_shots`;
/**
 * Every book the site lists that posts player props (docs/engine.js's
 * SPORTSBOOKS, less Kalshi, which has none): ten names, the most the feed
 * prices as one region, so the live call costs what the pre-game one does.
 */
export const LIVE_BOOKMAKERS = 'draftkings,fanduel,williamhill_us,fanatics,betmgm,prizepicks,hardrockbet,bet365,betrivers,espnbet';
export const liveProbeKey = (eventId) => `live:probe:${eventId}`;
/** The latest raw props payload for the game, whole, for the Live board's ladders (worker/src/live-board.js). */
export const liveLatestKey = (eventId) => `live:probe:${eventId}:latest`;
export const liveWatchKey = (espnEventId) => `live:watch:${espnEventId}`;
export const LIVE_WATCH_INDEX = 'live:watch:index';
/** One index per league (2026-11-05): the leagues' watchers run side by side, and a shared key lost entries to each other's writes. */
export const liveWatchIndexKey = (league) => `live:watch:index:${league}`;

/** Every watched game: the per-league indexes merged with the old shared one, newest first, one entry per game. */
export async function readWatchIndex(env) {
  const keys = [LIVE_WATCH_INDEX, ...Object.keys(LIVE_SPORT).map(liveWatchIndexKey)];
  const lists = await Promise.all(keys.map(async (k) => { const raw = await env.POTD_KV.get(k).catch(() => null); try { return raw ? JSON.parse(raw).games ?? [] : []; } catch { return []; } }));
  const seen = new Set(); const games = [];
  for (const g of lists.flat().sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))) { if (!g?.id || seen.has(g.id)) continue; seen.add(g.id); games.push(g); }
  return { games };
}
const MAX_SNAPSHOTS = 80;
const BEFORE_MS = 40 * 60e3;
const AFTER_MS = 5 * 3600e3;

/** The two teams in a watched game's name ("Chicago Bears at Seattle Seahawks"): away first, home second. */
export const liveGameTeams = (name) => String(name ?? '').split(/\s+at\s+|\s+vs\.?\s+/i).map((s) => s.trim()).filter(Boolean).slice(0, 2);

/** The feed event for the teams, either way round, or null. */
/** Words that name a kind of club, not the club: dropped before two names are compared by their words. */
const CLUB_WORDS = new Set(['fc', 'sk', 'ac', 'cf', 'sc', 'afc', 'cfc', 'club', 'de', 'the', 'fk', 'bk', 'if', 'as', 'ss', 'us', 'rc', 'ca', 'cd', 'sv', 'tsv', 'vfb', 'vfl', 'bsc', 'rb']);
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const words = (s) => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !CLUB_WORDS.has(w));

/**
 * The feed event for the watched game: its two teams match the feed's
 * two, either way round. A name contains the other (Chicago Bears,
 * Bears) or, failing that, they share a word once the club words are
 * dropped (ESPN's "Slavia Prague" against the feed's "SK Slavia Praha",
 * 2026-11-04: the probe never found the Champions League game). The
 * best-scoring event wins, the closest kick-off to `date` breaking ties.
 */
export function pickLiveEvent(events, teams, { date = null } = {}) {
  const want = (teams ?? []).map((t) => String(t));
  if (want.length !== 2) return null;
  const contains = (a, b) => { const x = fold(a); const y = fold(b); return Boolean(x && y) && (x.includes(y) || y.includes(x)); };
  const shared = (a, b) => { const wb = new Set(words(b)); return words(a).filter((w) => wb.has(w)).length; };
  const score = (w, n) => (contains(w, n) ? 10 : shared(w, n));
  const at = date ? Date.parse(date) : NaN;
  let best = null;
  for (const e of events ?? []) {
    const names = [e.home_team, e.away_team];
    // Each watched team to a different feed team, both matched, the better pairing counted.
    const straight = Math.min(score(want[0], names[0]), score(want[1], names[1])) > 0 ? score(want[0], names[0]) + score(want[1], names[1]) : 0;
    const crossed = Math.min(score(want[0], names[1]), score(want[1], names[0])) > 0 ? score(want[0], names[1]) + score(want[1], names[0]) : 0;
    const total = Math.max(straight, crossed);
    if (!total) continue;
    const gap = Number.isFinite(at) && e.commence_time ? Math.abs(Date.parse(e.commence_time) - at) : Infinity;
    if (!best || total > best.total || (total === best.total && gap < best.gap)) best = { e, total, gap };
  }
  return best?.e ?? null;
}

/**
 * One snapshot of the feed's props for the game: per book, the markets it
 * posts with how many outcomes each, when the book last updated, and a
 * few sample lines per market, so the log says what was available
 * without keeping every ladder.
 */
export function summariseProps(payload, at) {
  const books = (payload?.bookmakers ?? []).map((b) => ({
    key: b.key,
    lastUpdate: b.last_update ?? null,
    markets: (b.markets ?? []).map((m) => ({
      key: m.key,
      outcomes: (m.outcomes ?? []).length,
      players: new Set((m.outcomes ?? []).map((o) => o.description).filter(Boolean)).size,
      lastUpdate: m.last_update ?? null,
      sample: (m.outcomes ?? []).slice(0, 4).map((o) => ({ player: o.description ?? null, side: o.name ?? null, point: o.point ?? null, price: o.price ?? null })),
    })),
  }));
  return { at, booksPosting: books.filter((b) => b.markets.length).length, books };
}

/** The watched games inside their windows now. */
export function liveGamesNow(index, now) {
  return (index?.games ?? []).filter((g) => { const t = Date.parse(g.date); return Number.isFinite(t) && now >= t - BEFORE_MS && now <= t + AFTER_MS; });
}

/** One tick: for each watched game in its window, one props call, appended to its log; in play, the plays rebuilt from it. Returns what it did. */
export async function runLiveProbe(env, ctx, now = Date.now(), { deps = {} } = {}) {
  const index = deps.index ?? await readWatchIndex(env);
  // A whole slate at once (2026-11-05, the Live tab unattended): the earliest games first, up to twelve a tick; each is one feed call.
  const games = liveGamesNow(index, now).filter((g) => LIVE_ON.includes(g.league ?? 'nfl')).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  if (!games.length) return { skipped: true, reason: 'no watched game in its window' };
  const done = [];
  for (const g of games.slice(0, 12)) {
    const league = g.league ?? 'nfl';
    const sportKey = LIVE_SPORT[league]; if (!sportKey) continue;
    const events = deps.events ? await deps.events(sportKey) : await listLeagueGames(sportKey, env, ctx).catch(() => []);
    const event = pickLiveEvent(events, liveGameTeams(g.name), { date: g.date });
    if (!event) {
      // The miss is written down with what the feed listed, so /live/probe?espn= can say why the game has no odds log.
      await env.POTD_KV.put(`live:probe:miss:${g.id}`, JSON.stringify({ at: now, name: g.name, sportKey, feed: (events ?? []).slice(0, 12).map((e) => `${e.away_team} at ${e.home_team} (${e.commence_time ?? '?'})`) }), { expirationTtl: 2 * 86400 }).catch(() => {});
      done.push({ game: g.id, skipped: true, reason: 'game not on the feed' }); continue;
    }
    const payload = deps.props ? await deps.props(event.id) : await fetchLiveProps(sportKey, event.id, env, LIVE_MARKETS[league]);
    const snap = summariseProps(payload, now);
    snap.commence = event.commence_time ?? null;
    snap.status = payload?.error ?? null;
    const key = liveProbeKey(event.id);
    const raw = await env.POTD_KV.get(key).catch(() => null);
    const log = raw ? JSON.parse(raw) : { eventId: event.id, espnEventId: g.id, sportKey, home: event.home_team, away: event.away_team, commence: event.commence_time ?? null, snapshots: [] };
    log.snapshots = [...log.snapshots, snap].slice(-MAX_SNAPSHOTS);
    log.updatedAt = now;
    await env.POTD_KV.put(key, JSON.stringify(log), { expirationTtl: 14 * 86400 });
    await env.POTD_KV.put(`live:probe:for:${g.id}`, event.id, { expirationTtl: 14 * 86400 }).catch(() => {});
    await env.POTD_KV.put('live:probe:latest', event.id, { expirationTtl: 14 * 86400 }).catch(() => {});
    if (payload?.bookmakers?.length) await env.POTD_KV.put(liveLatestKey(event.id), JSON.stringify({ at: now, bookmakers: payload.bookmakers }), { expirationTtl: 2 * 86400 }).catch(() => {});
    // The slips are rebuilt here on every tick in play, so the tab opens on the current ones.
    const watchRaw = await env.POTD_KV.get(liveWatchKey(g.id)).catch(() => null);
    const tick = watchRaw ? JSON.parse(watchRaw)?.ticks?.at(-1) ?? null : null;
    const plays = tick ? await ensureLivePlays(env, g, payload?.bookmakers?.length ? payload : null, tick, { league, now }).catch(() => null) : null;
    done.push({ game: g.id, eventId: event.id, booksPosting: snap.booksPosting, markets: snap.books.reduce((n, b) => n + b.markets.length, 0), plays: plays ? plays.slips.length : 0 });
  }
  return { skipped: false, games: done };
}

async function fetchLiveProps(sportKey, eventId, env, markets) {
  const url = new URL(`${UPSTREAM}/sports/${sportKey}/events/${eventId}/odds`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('bookmakers', LIVE_BOOKMAKERS);
  url.searchParams.set('markets', markets);
  url.searchParams.set('oddsFormat', 'american');
  // The book's deep link for each line, so a leg imports to the slip (a request flag, not a credit).
  url.searchParams.set('includeLinks', 'true');
  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) return { error: `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`, bookmakers: [] };
  return res.json();
}

/** What /live/probe answers: the latest (or named) game's props log and the runner's watch log. */
export async function getLiveProbe(env, { eventId = null, espnEventId = null } = {}) {
  // A named ESPN game reads its own odds log (not the latest game's), and the miss note when the feed never matched it.
  const forEspn = espnEventId ? await env.POTD_KV.get(`live:probe:for:${espnEventId}`).catch(() => null) : null;
  const id = eventId ?? forEspn ?? (espnEventId ? null : await env.POTD_KV.get('live:probe:latest').catch(() => null));
  const probe = id ? JSON.parse((await env.POTD_KV.get(liveProbeKey(id)).catch(() => null)) ?? 'null') : null;
  const miss = espnEventId && !probe ? JSON.parse((await env.POTD_KV.get(`live:probe:miss:${espnEventId}`).catch(() => null)) ?? 'null') : null;
  const index = await readWatchIndex(env);
  const espnId = espnEventId ?? index.games?.[0]?.id ?? null;
  const watch = espnId ? JSON.parse((await env.POTD_KV.get(liveWatchKey(espnId)).catch(() => null)) ?? 'null') : null;
  return { probe, miss, watch, watched: index.games ?? [] };
}
