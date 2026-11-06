/**
 * Tennis in the Trends tab (2026-11-06: "under trends, I'd like to be able
 * to find lines for aces, games won etc. There should be some props that
 * tennis players are consistent in, like Elena Rybakina for 3 aces"). Every
 * player on either tour with matches on the card gets a line per prop at
 * the number they clear most often:
 *
 *   games won, total games, first-set games (over), the game spread (+N.5),
 *   the set spread (+1.5)  from the card's results, match by match, the
 *                          last TENNIS_WINDOW matches in the window
 *   aces (over)            from the player's ace rate this year (the serve
 *                          profiles): a match's aces are a Poisson draw at
 *                          aces a service game times the service games the
 *                          player's matches run to. ESPN posts no per-match
 *                          aces, so this one is modeled and says so.
 *
 * Today's matches carry the feed's lines (the cached boards: the winner
 * price, the game spread, the total) so a line can be found at the price.
 * Built in the tennis tick (worker/src/tennis-picks.js) once an hour, kept
 * under tennis:trends, read at /tennis/trends. Pure except for the build
 * entry points.
 */
import { nameKey, setDone } from './tennis-card-parse.js';
import { formOf } from './tennis-form.js';
import { bookIdFor } from '../../docs/engine.js';

export const TENNIS_TRENDS_KEY = 'tennis:trends';
export const TENNIS_TRENDS_TTL = 60 * 60e3;
export const TENNIS_WINDOW = 10;
/** A line posts at the highest number the player clears this often in the window, from this many matches. */
export const CONSISTENT = 0.8;
export const MIN_WINDOW = 5;
/** Aces: the highest number cleared this often in the model. */
export const ACE_CONSISTENT = 0.85;
export const MIN_ACE_MATCHES = 15;
export const TENNIS_TREND_MARKETS = {
  aces: 'Aces', games_won: 'Games won', games_total: 'Total games', set1_total: '1st set games', games_spread: 'Game spread', set_spread: 'Set spread',
};
const LADDERS = {
  games_won: [6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5, 13.5],
  games_total: [15.5, 16.5, 17.5, 18.5, 19.5, 20.5, 21.5, 22.5, 23.5, 24.5],
  set1_total: [6.5, 7.5, 8.5, 9.5, 10.5, 11.5],
  games_spread: [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5],
};
const POINTS_PER_GAME = 6.4;

const retiredLike = (r) => /retire|walkover/i.test(String(r.statusName ?? '')) || /ret\.|retired|w\/o|walkover/i.test(String(r.note ?? ''));

/** A player's matches from the results, newest first: {ms, won, gamesWon, gamesLost, total, set1, margin, wonASet, sets, opponent, event, clean}. */
export function playerMatches(player, results, now = Date.now()) {
  const out = [];
  for (const r of results ?? []) {
    if (!r?.completed) continue;
    const side = r.a?.id === player.id || r.a?.key === player.key ? 'a' : r.b?.id === player.id || r.b?.key === player.key ? 'b' : null;
    if (!side) continue;
    const ms = Date.parse(r.date); if (!Number.isFinite(ms) || ms > now) continue;
    const sets = r.sets ?? []; if (!sets.length) continue;
    const i = side === 'a' ? 0 : 1; const j = 1 - i;
    const gamesWon = sets.reduce((n, s) => n + (s[i] ?? 0), 0); const gamesLost = sets.reduce((n, s) => n + (s[j] ?? 0), 0);
    const won = r.winner ? r.winner === side : gamesWon > gamesLost;
    const s1 = sets[0] && setDone(sets[0]) ? sets[0][0] + sets[0][1] : null;
    out.push({ ms, date: r.date, won, gamesWon, gamesLost, total: gamesWon + gamesLost, set1: s1, margin: gamesWon - gamesLost, wonASet: sets.some((s) => setDone(s) && s[i] > s[j]), setsDone: sets.filter(setDone).length, sets: sets.map((s) => `${s[i]}-${s[j]}`).join(' '), opponent: r[side === 'a' ? 'b' : 'a']?.name ?? null, event: r.eventName ?? null, clean: !retiredLike(r) });
  }
  return out.sort((x, y) => y.ms - x.ms);
}

/** The share of `values` past `line` (strictly over), with the hits. */
const over = (values, line) => { const hits = values.filter((v) => v > line).length; return { hits, n: values.length, rate: values.length ? Math.round((hits / values.length) * 1000) / 1000 : 0 }; };

/** One prop's ladder and its line: the highest number cleared at `bar` in the window; null short of MIN_WINDOW matches. */
function ladderProp(market, values, bar = CONSISTENT) {
  const vals = values.filter((v) => v != null).slice(0, TENNIS_WINDOW);
  if (vals.length < MIN_WINDOW) return null;
  const ladder = LADDERS[market].map((line) => ({ line, ...over(vals, line) }));
  const clears = ladder.filter((l) => l.rate >= bar);
  const pick = clears.length ? clears.at(-1) : null;
  return { market, label: TENNIS_TREND_MARKETS[market], line: pick?.line ?? null, rate: pick?.rate ?? ladder[0].rate, hits: pick?.hits ?? ladder[0].hits, n: vals.length, ladder, values: vals, modeled: false };
}

/** Poisson tail P(X >= k) for mean `lambda`. */
export function poissonAtLeast(lambda, k) {
  if (k <= 0) return 1;
  let p = Math.exp(-lambda); let cum = p;
  for (let i = 1; i < k; i++) { p *= lambda / i; cum += p; }
  return Math.max(0, Math.min(1, 1 - cum));
}

/**
 * The aces prop from the rate: the mean per match (aces a service game
 * times the service games the player's matches run to, half the total
 * games) and the highest count cleared at ACE_CONSISTENT.
 */
export function acesProp(profile, matches, { bar = ACE_CONSISTENT } = {}) {
  const line = profile?.overall;
  if (!line || !((line.matches ?? 0) >= MIN_ACE_MATCHES)) return null;
  const perGame = line.acesPerGame ?? (line.ace != null ? line.ace * POINTS_PER_GAME : null);
  if (perGame == null) return null;
  const clean = matches.filter((m) => m.clean);
  const avgTotal = clean.length >= 3 ? clean.slice(0, TENNIS_WINDOW).reduce((n, m) => n + m.total, 0) / Math.min(clean.length, TENNIS_WINDOW) : 21;
  const serviceGames = avgTotal / 2;
  const lambda = perGame * serviceGames;
  const ladder = [];
  for (let k = 1; k <= 14; k++) ladder.push({ line: k - 0.5, rate: Math.round(poissonAtLeast(lambda, k) * 1000) / 1000 });
  const clears = ladder.filter((l) => l.rate >= bar);
  const pick = clears.length ? clears.at(-1) : null;
  return { market: 'aces', label: TENNIS_TREND_MARKETS.aces, line: pick?.line ?? null, rate: pick?.rate ?? ladder[0].rate, n: line.matches, ladder, modeled: true, perGame: Math.round(perGame * 100) / 100, mean: Math.round(lambda * 10) / 10, serviceGames: Math.round(serviceGames * 10) / 10 };
}

/** The feed's lines for a player on a cached board event: the winner price, the game spread, the total, best book each. */
export function linesFor(event, name) {
  const same = (x, y) => nameKey(x) === nameKey(y) || (nameKey(x).split(' ').at(-1) === nameKey(y).split(' ').at(-1) && nameKey(x)[0] === nameKey(y)[0]);
  const best = (list) => [...list].sort((x, y) => y.american - x.american)[0] ?? null;
  const h2h = []; const spread = []; const total = [];
  for (const bm of event?.bookmakers ?? []) {
    const bookId = bookIdFor(bm.key); if (!bookId) continue;
    for (const m of bm.markets ?? []) for (const o of m.outcomes ?? []) {
      const q = { bookId, book: bm.title ?? bm.key, american: Number(o.price), point: Number.isFinite(Number(o.point)) ? Number(o.point) : null, link: o.link ?? bm.link ?? null };
      if (!Number.isFinite(q.american)) continue;
      if (m.key === 'h2h' && same(o.name, name)) h2h.push(q);
      if (m.key === 'spreads' && same(o.name, name)) spread.push(q);
      if (m.key === 'totals' && /over/i.test(String(o.name))) total.push(q);
    }
  }
  return { h2h: best(h2h), spread: best(spread), total: best(total) };
}

/**
 * The build: {at, window, players: [{key, name, tour, matches, form, last, props, today}], counts}.
 * `boards` is {tour: [feed events]} as the tick's cache holds them; `profiles` is {tour: {players}}.
 */
export function buildTennisTrends({ card, profiles, boards = {}, now = Date.now() }) {
  const results = [...(card?.results ?? []), ...(card?.slate ?? []).filter((m) => m.completed)];
  const slate = (card?.slate ?? []).filter((m) => !m.completed && !m.qualifying && m.tier !== 'challenger' && Date.parse(m.date) > now - 4 * 3600e3 && Date.parse(m.date) < now + 36 * 3600e3);
  const players = [];
  const seen = new Set();
  const add = (tour, id, name, key) => {
    const k = `${tour}:${key}`; if (seen.has(k)) return; seen.add(k);
    const matches = playerMatches({ id, key }, results.filter((r) => r.tour === tour), now);
    const profile = profiles?.[tour]?.players?.[key] ?? null;
    const clean = matches.filter((m) => m.clean);
    const props = [
      acesProp(profile, matches),
      ladderProp('games_won', clean.map((m) => m.gamesWon)),
      ladderProp('games_total', clean.map((m) => m.total)),
      ladderProp('set1_total', matches.map((m) => m.set1)),
      spreadProp(clean),
      setSpreadProp(matches),
    ].filter(Boolean);
    if (!props.length) return;
    const f = formOf({ id, key }, results, now);
    const match = slate.find((m) => m.tour === tour && (m.a.id === id || m.b.id === id || m.a.key === key || m.b.key === key));
    let today = null;
    if (match) {
      const mine = match.a.id === id || match.a.key === key ? 'a' : 'b';
      const ev = (boards[tour] ?? []).find((e) => [e.home_team, e.away_team].some((t) => nameKey(t) === key || (nameKey(t).split(' ').at(-1) === key.split(' ').at(-1) && nameKey(t)[0] === key[0])) && [e.home_team, e.away_team].some((t) => nameKey(t) === match[mine === 'a' ? 'b' : 'a'].key || nameKey(t).split(' ').at(-1) === match[mine === 'a' ? 'b' : 'a'].key.split(' ').at(-1)));
      today = { matchId: `${tour}:${match.id}`, opponent: match[mine === 'a' ? 'b' : 'a'].name, event: match.eventName, round: match.round, date: match.date, state: match.state, lines: ev ? linesFor(ev, name) : null };
    }
    players.push({ key, id, name, tour, matches: matches.length, form: f.last.slice(0, TENNIS_WINDOW).map((m) => (m.won ? 'W' : 'L')).join(''), record: `${f.wins}-${f.losses}`, flags: [f.injury ? 'injury' : null, f.fatigue ? 'fatigue' : null, f.rust ? 'rust' : null].filter(Boolean), last: matches.slice(0, TENNIS_WINDOW).map((m) => ({ date: m.date, opponent: m.opponent, event: m.event, sets: m.sets, won: m.won, gamesWon: m.gamesWon, total: m.total, set1: m.set1, margin: m.margin, clean: m.clean })), props, best: Math.max(...props.filter((p) => p.line != null).map((p) => p.rate), 0), today });
  };
  for (const r of results) { for (const side of ['a', 'b']) if (r[side]?.name) add(r.tour, r[side].id, r[side].name, r[side].key ?? nameKey(r[side].name)); }
  for (const m of slate) for (const side of ['a', 'b']) if (m[side]?.name) add(m.tour, m[side].id, m[side].name, m[side].key ?? nameKey(m[side].name));
  players.sort((x, y) => (y.today ? 1 : 0) - (x.today ? 1 : 0) || y.best - x.best || y.matches - x.matches);
  return { at: now, window: TENNIS_WINDOW, bar: { consistent: CONSISTENT, aces: ACE_CONSISTENT, minWindow: MIN_WINDOW }, markets: TENNIS_TREND_MARKETS, players, counts: { atp: players.filter((p) => p.tour === 'atp').length, wta: players.filter((p) => p.tour === 'wta').length, today: players.filter((p) => p.today).length, results: results.length } };
}

/** The game spread: the smallest cushion the player stays inside at the bar (margin + N > 0), from the window. */
function spreadProp(clean) {
  const vals = clean.slice(0, TENNIS_WINDOW).map((m) => m.margin);
  if (vals.length < MIN_WINDOW) return null;
  const ladder = LADDERS.games_spread.map((line) => { const hits = vals.filter((v) => v + line > 0).length; return { line, hits, n: vals.length, rate: Math.round((hits / vals.length) * 1000) / 1000 }; });
  const pick = ladder.find((l) => l.rate >= CONSISTENT) ?? null;
  return { market: 'games_spread', label: TENNIS_TREND_MARKETS.games_spread, line: pick?.line ?? null, rate: pick?.rate ?? ladder.at(-1).rate, hits: pick?.hits ?? ladder.at(-1).hits, n: vals.length, ladder, values: vals, modeled: false, plus: true };
}
/** The set spread (+1.5): the share of the window's matches with a set taken. */
function setSpreadProp(matches) {
  const vals = matches.slice(0, TENNIS_WINDOW);
  if (vals.length < MIN_WINDOW) return null;
  const hits = vals.filter((m) => m.wonASet).length;
  const rate = Math.round((hits / vals.length) * 1000) / 1000;
  return { market: 'set_spread', label: TENNIS_TREND_MARKETS.set_spread, line: rate >= CONSISTENT ? 1.5 : null, rate, hits, n: vals.length, ladder: [{ line: 1.5, hits, n: vals.length, rate }], values: vals.map((m) => (m.wonASet ? 1 : 0)), modeled: false, plus: true };
}

/** The cached boards by tour from the tick's KV cache, no feed call: {atp: [events], wta: [events]}. */
export async function cachedBoards(env) {
  const read = async (key) => { const raw = await env.POTD_KV.get(key).catch(() => null); if (!raw) return null; try { return JSON.parse(raw).body ?? null; } catch { return null; } };
  const sports = await read('tennis:feed:sports');
  const out = { atp: [], wta: [] };
  for (const s of Array.isArray(sports) ? sports : []) {
    const tour = String(s.key).startsWith('tennis_atp_') ? 'atp' : String(s.key).startsWith('tennis_wta_') ? 'wta' : null;
    if (!tour || !s.active) continue;
    const board = await read(`tennis:odds:board:${s.key}`);
    if (Array.isArray(board)) out[tour].push(...board);
  }
  return out;
}

/** The build when the stored one is stale, written under tennis:trends; the stored one otherwise. */
export async function ensureTennisTrends(env, { card, profiles, now = Date.now(), boards = null, force = false } = {}) {
  const raw = await env.POTD_KV.get(TENNIS_TRENDS_KEY).catch(() => null);
  if (raw && !force) { try { const t = JSON.parse(raw); if (now - (t.at ?? 0) < TENNIS_TRENDS_TTL) return { built: false, trends: t }; } catch { /* rebuild */ } }
  if (!card) return { built: false, trends: null };
  const trends = buildTennisTrends({ card, profiles, boards: boards ?? await cachedBoards(env), now });
  await env.POTD_KV.put(TENNIS_TRENDS_KEY, JSON.stringify(trends), { expirationTtl: 3 * 86400 }).catch(() => {});
  return { built: true, trends };
}

/** The tab's read. */
export async function getTennisTrends(env) {
  const raw = await env.POTD_KV.get(TENNIS_TRENDS_KEY).catch(() => null);
  if (!raw) return { at: null, window: TENNIS_WINDOW, markets: TENNIS_TREND_MARKETS, players: [], counts: { atp: 0, wta: 0, today: 0, results: 0 } };
  try { return JSON.parse(raw); } catch { return { at: null, window: TENNIS_WINDOW, markets: TENNIS_TREND_MARKETS, players: [], counts: { atp: 0, wta: 0, today: 0, results: 0 } }; }
}
