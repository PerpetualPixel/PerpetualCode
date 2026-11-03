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
import { SOCCER_LIVE, LIVE_SPORT } from './live-leagues.js';
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
const MAX_SNAPSHOTS = 80;
const BEFORE_MS = 40 * 60e3;
const AFTER_MS = 5 * 3600e3;

/** The two teams in a watched game's name ("Chicago Bears at Seattle Seahawks"): away first, home second. */
export const liveGameTeams = (name) => String(name ?? '').split(/\s+at\s+|\s+vs\.?\s+/i).map((s) => s.trim()).filter(Boolean).slice(0, 2);

/** The feed event for the teams, either way round, or null. */
export function pickLiveEvent(events, teams) {
  const want = (teams ?? []).map((t) => String(t).toLowerCase());
  if (want.length !== 2) return null;
  return (events ?? []).find((e) => {
    const names = [e.home_team, e.away_team].map((t) => String(t ?? '').toLowerCase());
    return want.every((w) => names.some((n) => n.includes(w) || w.includes(n)));
  }) ?? null;
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
  const idxRaw = await env.POTD_KV.get(LIVE_WATCH_INDEX).catch(() => null);
  const index = deps.index ?? (idxRaw ? JSON.parse(idxRaw) : { games: [] });
  const games = liveGamesNow(index, now);
  if (!games.length) return { skipped: true, reason: 'no watched game in its window' };
  const done = [];
  for (const g of games.slice(0, 4)) {
    const league = g.league ?? 'nfl';
    const sportKey = LIVE_SPORT[league]; if (!sportKey) continue;
    const events = deps.events ? await deps.events(sportKey) : await listLeagueGames(sportKey, env, ctx).catch(() => []);
    const event = pickLiveEvent(events, liveGameTeams(g.name));
    if (!event) { done.push({ game: g.id, skipped: true, reason: 'game not on the feed' }); continue; }
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
  const id = eventId ?? await env.POTD_KV.get('live:probe:latest').catch(() => null);
  const probe = id ? JSON.parse((await env.POTD_KV.get(liveProbeKey(id)).catch(() => null)) ?? 'null') : null;
  const idxRaw = await env.POTD_KV.get(LIVE_WATCH_INDEX).catch(() => null);
  const index = idxRaw ? JSON.parse(idxRaw) : { games: [] };
  const espnId = espnEventId ?? index.games?.[0]?.id ?? null;
  const watch = espnId ? JSON.parse((await env.POTD_KV.get(liveWatchKey(espnId)).catch(() => null)) ?? 'null') : null;
  return { probe, watch, watched: index.games ?? [] };
}
