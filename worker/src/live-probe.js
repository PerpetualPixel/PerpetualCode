/**
 * The live-props probe (2026-11-01 direction: "let's try this out on the
 * Eagles / Commanders game tonight"). Before a halftime parlay can be
 * built, the gating question is which books post which player-prop
 * ladders in play, and when they come back after the half. So, for one
 * game inside one window, every cron tick takes a snapshot of the feed's
 * in-play player props for that game and keeps it under KV, and the
 * runner's live-watch job (scripts/live-watch.mjs) logs the clock, the
 * score and the box score every minute beside it. /live/probe reads both.
 *
 * Credits: one call per tick with LIVE_MARKETS markets (one credit a
 * market), about eight ticks an hour across the two crons: on the order
 * of 300 credits for a game, out of a monthly budget near 100,000.
 */
import { UPSTREAM, TREND_BOOKMAKERS } from './odds.js';
import { listLeagueGames } from './prop-legs.js';

/** The one game and window the probe watches. Teams as the feed names them. */
export const LIVE_PROBE = {
  sportKey: 'americanfootball_nfl',
  teams: ['Philadelphia Eagles', 'Washington Commanders'],
  from: Date.UTC(2026, 10, 2, 0, 45),   // 7:45 PM ET, Nov 1: the pre-game board
  until: Date.UTC(2026, 10, 2, 5, 30),  // past the final whistle
};
/** The alt ladders the halftime parlay would use, and the main lines beside them. */
export const LIVE_MARKETS = 'player_pass_yds_alternate,player_rush_yds_alternate,player_reception_yds_alternate,player_receptions_alternate,player_pass_yds,player_rush_yds,player_reception_yds,player_receptions';
export const liveProbeKey = (eventId) => `live:probe:${eventId}`;
/** The latest raw props payload for the game, whole, for the Live board's ladders (worker/src/live-board.js). */
export const liveLatestKey = (eventId) => `live:probe:${eventId}:latest`;
export const liveWatchKey = (espnEventId) => `live:watch:${espnEventId}`;
export const LIVE_WATCH_INDEX = 'live:watch:index';
const MAX_SNAPSHOTS = 80;

/** The feed event for the probe's teams, either way round, or null. */
export function pickLiveEvent(events, teams = LIVE_PROBE.teams) {
  const want = teams.map((t) => String(t).toLowerCase());
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

/** One tick: inside the window, one props call for the game, appended to the log. Returns what it did. */
export async function runLiveProbe(env, ctx, now = Date.now(), { deps = {} } = {}) {
  const cfg = deps.config ?? LIVE_PROBE;
  if (now < cfg.from || now > cfg.until) return { skipped: true, reason: 'outside the window' };
  const events = deps.events ? await deps.events() : await listLeagueGames(cfg.sportKey, env, ctx).catch(() => []);
  const event = pickLiveEvent(events, cfg.teams);
  if (!event) return { skipped: true, reason: 'game not on the feed' };
  const payload = deps.props ? await deps.props(event.id) : await fetchLiveProps(cfg.sportKey, event.id, env);
  const snap = summariseProps(payload, now);
  snap.commence = event.commence_time ?? null;
  snap.status = payload?.error ?? null;
  const key = liveProbeKey(event.id);
  const raw = await env.POTD_KV.get(key).catch(() => null);
  const log = raw ? JSON.parse(raw) : { eventId: event.id, sportKey: cfg.sportKey, home: event.home_team, away: event.away_team, commence: event.commence_time ?? null, snapshots: [] };
  log.snapshots = [...log.snapshots, snap].slice(-MAX_SNAPSHOTS);
  log.updatedAt = now;
  await env.POTD_KV.put(key, JSON.stringify(log), { expirationTtl: 14 * 86400 });
  await env.POTD_KV.put('live:probe:latest', event.id, { expirationTtl: 14 * 86400 }).catch(() => {});
  if (payload?.bookmakers?.length) await env.POTD_KV.put(liveLatestKey(event.id), JSON.stringify({ at: now, bookmakers: payload.bookmakers }), { expirationTtl: 2 * 86400 }).catch(() => {});
  return { skipped: false, eventId: event.id, booksPosting: snap.booksPosting, markets: snap.books.reduce((n, b) => n + b.markets.length, 0) };
}

async function fetchLiveProps(sportKey, eventId, env) {
  const url = new URL(`${UPSTREAM}/sports/${sportKey}/events/${eventId}/odds`);
  url.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  url.searchParams.set('regions', 'us');
  url.searchParams.set('bookmakers', TREND_BOOKMAKERS);
  url.searchParams.set('markets', LIVE_MARKETS);
  url.searchParams.set('oddsFormat', 'american');
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
