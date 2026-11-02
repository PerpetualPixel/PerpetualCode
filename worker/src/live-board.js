/**
 * The Live tab's board (2026-11-01 direction: "a live tab with an
 * indicator on what games it is probing, update times, and the props to
 * play; once a play is ready, the current lines to take and where the
 * player is"; 2026-11-02: "the last updated players' yardage and stats,
 * who to watch for players performing well and the projected output for
 * the game, then any slips ready below it, with links").
 *
 * For each game the runner is watching (scripts/live-watch.mjs) the
 * board pairs the last box-score read with the worker's last odds
 * snapshot (worker/src/live-probe.js) and gives:
 *   players  every skill player's line as of the last read;
 *   watch    who to watch: the projected final per stat from pace, game
 *            script and weather, and the best clearing line, if any;
 *   slips    at the half, a three-to-five-leg play at every book that
 *            prices one, nearest +100, with where each player sits; the
 *            first play built is kept (live:play:<game>) so the slip does
 *            not change under the user as the lines move.
 * A deterministic first cut: no model read yet, and the plays are
 * shown, not tracked.
 */
import { liveWatchKey, LIVE_WATCH_INDEX, liveProbeKey, liveLatestKey, liveGameTeams } from './live-probe.js';
import { bookIdFor, SPORTSBOOKS, americanToDecimal } from '../../docs/engine.js';
import { fetchWeather } from './weather.js';

/** The box-score key each market settles on, per league. */
export const LIVE_STAT = {
  nfl: { player_pass_yds: 'passingYards', player_pass_yds_alternate: 'passingYards', player_rush_yds: 'rushingYards', player_rush_yds_alternate: 'rushingYards', player_reception_yds: 'receivingYards', player_reception_yds_alternate: 'receivingYards', player_receptions: 'receptions', player_receptions_alternate: 'receptions' },
  nba: { player_points: 'points', player_points_alternate: 'points', player_rebounds: 'rebounds', player_rebounds_alternate: 'rebounds', player_assists: 'assists', player_assists_alternate: 'assists' },
};
export const LIVE_LABEL = { passingYards: 'Pass Yds', rushingYards: 'Rush Yds', receivingYards: 'Rec Yds', receptions: 'Rec', points: 'Pts', rebounds: 'Reb', assists: 'Ast' };
const WATCH_STATS = { nfl: ['passingYards', 'rushingYards', 'receivingYards', 'receptions'], nba: ['points', 'rebounds', 'assists'] };
const GAME_MINUTES = { nfl: 60, nba: 48 };
const PERIODS = { nfl: 4, nba: 4 };
export const LEG_PRICE = [-300, 150];
export const PLAY_PRICE = [-160, 200];
export const PLAY_TARGET = 100;
const MARGIN = 1.25;
const BLOWOUT = 17;
export const livePlayKey = (espnEventId) => `live:play:${espnEventId}`;

/** How much of the game is played, 0 to 1, from the period and the clock still on it; the half reads 0.5. */
export function elapsedFraction(tick, league = 'nfl') {
  if (!tick || tick.state === 'pre') return 0;
  if (tick.state === 'post') return 1;
  const periods = PERIODS[league] ?? 4;
  const perPeriod = (GAME_MINUTES[league] ?? 60) / periods;
  if (/half/i.test(String(tick.detail ?? ''))) return 0.5;
  const p = Number(tick.period) || 1;
  const m = String(tick.clock ?? '').match(/^(\d+):(\d+)/);
  const left = m ? Number(m[1]) + Number(m[2]) / 60 : perPeriod;
  return Math.min(1, Math.max(0.02, ((p - 1) * perPeriod + (perPeriod - left)) / (GAME_MINUTES[league] ?? 60)));
}
export const isHalftime = (tick, league = 'nfl') => Boolean(tick) && tick.state === 'in' && (/half/i.test(String(tick.detail ?? '')) || (Number(tick.period) === (PERIODS[league] ?? 4) / 2 && /^0:00/.test(String(tick.clock ?? ''))));

const num = (v) => { const n = Number(String(v ?? '').split('/')[0].replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const toAmerican = (decimal) => (decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1)));
const inRange = (x, [lo, hi]) => x >= lo && x <= hi;

/** The game script from the score: who is up big, who is down big. */
export function gameScript(tick) {
  const teams = Object.entries(tick?.score ?? {});
  if (teams.length !== 2) return { leader: null, trailer: null, margin: 0 };
  const lead = teams[0][1] - teams[1][1];
  if (Math.abs(lead) < BLOWOUT) return { leader: null, trailer: null, margin: Math.abs(lead) };
  return { leader: lead > 0 ? teams[0][0] : teams[1][0], trailer: lead > 0 ? teams[1][0] : teams[0][0], margin: Math.abs(lead) };
}

/** Rough weather: wind of 15 mph or more, or a coin-flip chance of rain, fades the passing game. */
export const roughWeather = (w) => Boolean(w) && ((Number(String(w.windSpeed ?? '').match(/\d+/)?.[0]) || 0) >= 15 || (Number(w.precipChance) || 0) >= 50);

/**
 * A player's projected final for one stat: his pace to the whistle, then
 * the script. A side up big leans on the run (rushing up a sixth,
 * passing and catching down a fifth); a side down big throws (the
 * reverse); rough weather takes a sixth off passing and catching.
 */
export function projectStat(current, elapsed, stat, { team, script, weather } = {}) {
  if (!Number.isFinite(current) || !elapsed) return null;
  let proj = current / elapsed;
  const passing = /passing|receiving|receptions/.test(stat);
  if (script?.leader && team === script.leader) proj *= passing ? 0.8 : 1.15;
  if (script?.trailer && team === script.trailer) proj *= passing ? 1.15 : 0.8;
  if (passing && roughWeather(weather)) proj *= 0.85;
  return Math.round(proj);
}

/** Every skill player's line as of the tick, for the table. */
export function playerLines(tick, league = 'nfl') {
  const stats = WATCH_STATS[league] ?? [];
  return (tick?.box ?? []).map((p) => {
    const line = { id: p.id, name: p.name, team: p.team };
    for (const s of stats) { const v = num(p.stats?.[s]); if (v != null) line[s] = v; }
    if (league === 'nfl') {
      const ca = String(p.stats?.['completions/passingAttempts'] ?? ''); if (ca.includes('/')) line.passing = ca;
      if (p.stats?.rushingAttempts != null) line.carries = num(p.stats.rushingAttempts);
      if (p.stats?.receivingTargets != null) line.targets = num(p.stats.receivingTargets);
    }
    line.total = stats.reduce((n, s) => n + (line[s] ?? 0), 0);
    return line;
  }).filter((l) => stats.some((s) => l[s] != null)).sort((a, b) => b.total - a.total);
}

/**
 * Every Over on the board the box score says is reachable: the player's
 * current number, his projected final, and the margin by which it clears
 * the line. The script and the weather go through projectStat.
 */
export function liveCandidates(payload, tick, league = 'nfl', { weather = null } = {}) {
  const stats = LIVE_STAT[league] ?? {};
  const box = new Map((tick?.box ?? []).map((p) => [String(p.name ?? '').toLowerCase(), p]));
  const elapsed = elapsedFraction(tick, league);
  if (!elapsed || elapsed >= 1) return [];
  const script = gameScript(tick);
  const out = [];
  for (const b of payload?.bookmakers ?? []) {
    const bookId = bookIdFor(b.key) ?? b.key;
    for (const m of b.markets ?? []) {
      const stat = stats[m.key]; if (!stat) continue;
      for (const o of m.outcomes ?? []) {
        if (o.name !== 'Over' || !Number.isFinite(o.point) || !Number.isFinite(o.price)) continue;
        const p = box.get(String(o.description ?? '').toLowerCase()); if (!p) continue;
        const cur = num(p.stats?.[stat]); if (cur == null) continue;
        if (cur >= o.point) continue; // already there; a book would not let it through anyway
        if (!inRange(o.price, LEG_PRICE)) continue;
        if (script.leader && p.team === script.leader && /passing|receiving|receptions/.test(stat)) continue;
        if (script.trailer && p.team === script.trailer && stat === 'rushingYards') continue;
        if (stat === 'passingYards' && roughWeather(weather)) continue;
        const proj = projectStat(cur, elapsed, stat, { team: p.team, script, weather });
        if (proj < o.point * MARGIN) continue;
        out.push({ bookId, book: SPORTSBOOKS[bookId]?.name ?? b.key, market: m.key, stat, label: LIVE_LABEL[stat] ?? stat, player: o.description, team: p.team ?? null, athleteId: p.id ?? null, point: o.point, price: o.price, decimal: americanToDecimal(o.price), current: cur, pace: proj, cushion: Math.round(((proj - o.point) / o.point) * 100) / 100, link: o.link ?? null });
      }
    }
  }
  return out.sort((x, y) => y.cushion - x.cushion || y.price - x.price);
}

/**
 * Who to watch: the players with the most projected output per stat,
 * each with where he is now, the projection, and his best clearing line
 * on the board (the highest number that clears, at its best price).
 */
export function whoToWatch(tick, candidates, league = 'nfl', { weather = null, limit = 8 } = {}) {
  const elapsed = elapsedFraction(tick, league);
  if (!elapsed || elapsed >= 1) return [];
  const script = gameScript(tick);
  const rows = [];
  for (const p of tick?.box ?? []) {
    for (const stat of WATCH_STATS[league] ?? []) {
      const cur = num(p.stats?.[stat]); if (cur == null || cur <= 0) continue;
      const proj = projectStat(cur, elapsed, stat, { team: p.team, script, weather });
      const lines = candidates.filter((c) => c.player === p.name && c.stat === stat);
      const best = lines.length ? lines.reduce((a, c) => (c.point > a.point || (c.point === a.point && c.price > a.price) ? c : a)) : null;
      const why = script.leader === p.team ? (stat === 'rushingYards' ? 'up big: the run game carries the second half' : 'up big: the passing game sits') : script.trailer === p.team ? (stat === 'rushingYards' ? 'down big: the run game goes away' : 'down big: throwing to catch up') : null;
      rows.push({ player: p.name, team: p.team, athleteId: p.id ?? null, stat, label: LIVE_LABEL[stat] ?? stat, current: cur, projected: proj, why, line: best ? { bookId: best.bookId, book: best.book, point: best.point, price: best.price, link: best.link } : null });
    }
  }
  // Yards first by projection; receptions and the like ride along with their player.
  const weight = (r) => (r.stat === 'receptions' ? r.projected * 10 : r.stat === 'assists' || r.stat === 'rebounds' ? r.projected * 2.5 : r.projected);
  return rows.sort((a, b) => weight(b) - weight(a)).slice(0, limit);
}

/**
 * The play at one book: one line per player, three to five legs whose
 * combined price lands nearest PLAY_TARGET inside PLAY_PRICE. Each
 * player offers every number of his that clears; the search picks the
 * numbers that make the price, with a nod to cushion.
 */
export function buildLivePlay(candidates, { legs = [3, 4, 5], books = null } = {}) {
  const byBook = new Map();
  for (const c of candidates) {
    if (books && !books.includes(c.bookId)) continue;
    if (!byBook.has(c.bookId)) byBook.set(c.bookId, new Map());
    const players = byBook.get(c.bookId);
    if (!players.has(c.player)) players.set(c.player, []);
    players.get(c.player).push(c);
  }
  let best = null;
  for (const [bookId, players] of byBook) {
    // The six players with the most cushion, each with his four best-priced clearing numbers.
    const list = [...players.values()].map((opts) => opts.sort((x, y) => y.price - x.price).slice(0, 4)).sort((x, y) => Math.max(...y.map((o) => o.cushion)) - Math.max(...x.map((o) => o.cushion))).slice(0, 6);
    for (const n of legs) {
      if (list.length < n) continue;
      const pick = (start, chosen) => {
        if (chosen.length === n) {
          const dec = chosen.reduce((d, l) => d * l.decimal, 1); const am = toAmerican(dec);
          if (!inRange(am, PLAY_PRICE)) return;
          const score = Math.abs(am - PLAY_TARGET) - chosen.reduce((s, l) => s + l.cushion, 0) * 10;
          if (!best || score < best.score) best = { bookId, book: chosen[0].book, legs: chosen, decimal: Math.round(dec * 10000) / 10000, american: am, score };
          return;
        }
        for (let i = start; i < list.length; i++) for (const o of list[i]) pick(i + 1, [...chosen, o]);
      };
      pick(0, []);
    }
  }
  return best;
}

/**
 * A play at every book that can make one, best first, with no single
 * point of failure: each later slip is built again without the best
 * slip's players when the book's ladders allow it, so one player's bad
 * half does not sink every slip. A player still on more than one slip
 * is counted on each leg (onSlips) so the card can say so.
 */
export function buildLiveSlips(candidates) {
  const books = [...new Set(candidates.map((c) => c.bookId))];
  const slips = books.map((b) => buildLivePlay(candidates, { books: [b] })).filter(Boolean).sort((x, y) => x.score - y.score);
  if (!slips.length) return [];
  const core = new Set(slips[0].legs.map((l) => l.player));
  const out = [slips[0]];
  for (const s of slips.slice(1)) {
    const shares = s.legs.some((l) => core.has(l.player));
    const alt = shares ? buildLivePlay(candidates.filter((c) => !core.has(c.player)), { books: [s.bookId] }) : null;
    out.push(alt ? { ...alt, diversified: true } : s);
  }
  const counts = new Map();
  for (const s of out) for (const l of s.legs) counts.set(l.player, (counts.get(l.player) ?? 0) + 1);
  return out.map((s) => ({ ...s, legs: s.legs.map((l) => ({ ...l, onSlips: counts.get(l.player) ?? 1 })), shared: s.legs.filter((l) => (counts.get(l.player) ?? 1) > 1).map((l) => l.player) }));
}

/** The stored plays' legs with the players' current numbers brought up to the tick. */
function refreshSlips(slips, tick) {
  const box = new Map((tick?.box ?? []).map((p) => [String(p.name ?? '').toLowerCase(), p]));
  return (slips ?? []).map((s) => ({ ...s, legs: s.legs.map((l) => { const p = box.get(String(l.player).toLowerCase()); const cur = p ? num(p.stats?.[l.stat]) : null; return cur == null ? l : { ...l, current: cur, cleared: cur >= l.point }; }) }));
}

/**
 * The plays for a game at the half: built once from the ladders at the
 * first read or tick inside the half and kept under live:play, so the
 * slip stands while the lines move. Null outside the half with nothing
 * stored.
 */
export async function ensureLivePlays(env, game, payload, tick, { league = 'nfl', now = Date.now(), weather = null } = {}) {
  const key = livePlayKey(game.id);
  const raw = await env.POTD_KV.get(key).catch(() => null);
  if (raw) return JSON.parse(raw);
  if (!isHalftime(tick, league) || !payload) return null;
  const candidates = liveCandidates(payload, tick, league, { weather });
  const slips = buildLiveSlips(candidates);
  if (!slips.length) return null;
  const record = { espnEventId: game.id, name: game.name, builtAt: now, score: tick.score ?? null, slips };
  await env.POTD_KV.put(key, JSON.stringify(record), { expirationTtl: 3 * 86400 }).catch(() => {});
  return record;
}

/** The board: every watched game with its last reads, the books posting, the players, who to watch, and the slips. */
export async function getLiveBoard(env, now = Date.now(), { ctx = null } = {}) {
  const idxRaw = await env.POTD_KV.get(LIVE_WATCH_INDEX).catch(() => null);
  const games = (idxRaw ? JSON.parse(idxRaw).games : []) ?? [];
  const out = [];
  for (const g of games.slice(0, 4)) {
    const watch = JSON.parse((await env.POTD_KV.get(liveWatchKey(g.id)).catch(() => null)) ?? 'null');
    const tick = watch?.ticks?.at(-1) ?? null;
    const league = g.league ?? watch?.league ?? 'nfl';
    const probeId = await env.POTD_KV.get(`live:probe:for:${g.id}`).catch(() => null);
    const probe = probeId ? JSON.parse((await env.POTD_KV.get(liveProbeKey(probeId)).catch(() => null)) ?? 'null') : null;
    const payload = probeId ? JSON.parse((await env.POTD_KV.get(liveLatestKey(probeId)).catch(() => null)) ?? 'null') : null;
    const snap = probe?.snapshots?.at(-1) ?? null;
    const teams = liveGameTeams(g.name);
    const weather = league === 'nfl' && ctx ? await fetchWeather({ sportKey: 'americanfootball_nfl', homeTeam: teams[1] ?? null, commenceMs: Date.parse(g.date) }, ctx).catch(() => null) : null;
    const candidates = payload && tick ? liveCandidates(payload, tick, league, { weather }) : [];
    const plays = tick ? await ensureLivePlays(env, g, payload, tick, { league, now, weather }) : null;
    out.push({
      espnEventId: g.id, name: g.name, date: g.date, league,
      tick: tick ? { at: tick.at, state: tick.state, detail: tick.detail, period: tick.period, clock: tick.clock, score: tick.score } : null,
      elapsed: elapsedFraction(tick, league), halftime: isHalftime(tick, league), script: gameScript(tick),
      weather: weather ? { ...weather, rough: roughWeather(weather) } : null,
      probe: snap ? { at: snap.at, booksPosting: snap.booksPosting, books: snap.books.map((b) => ({ key: b.key, bookId: bookIdFor(b.key) ?? b.key, markets: b.markets.map((m) => ({ key: m.key, outcomes: m.outcomes, players: m.players })) })), snapshots: probe.snapshots.length } : null,
      players: playerLines(tick, league),
      watch: whoToWatch(tick, candidates, league, { weather }),
      candidates: candidates.slice(0, 12),
      slips: plays ? { builtAt: plays.builtAt, score: plays.score, list: refreshSlips(plays.slips, tick) } : null,
    });
  }
  return { at: now, games: out };
}
