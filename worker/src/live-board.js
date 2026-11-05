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
 *   slips    from a fifth of the game in until a tenth is left, a
 *            three-to-five-leg play at every book that prices one,
 *            nearest +100, with where each player sits; rebuilt on every
 *            tick that has ladders (live:play:<game>), so the slip shown
 *            is the one the lines on the board make now.
 * A deterministic first cut: no model read yet, and the plays are
 * shown, not tracked.
 */
import { liveWatchKey, LIVE_WATCH_INDEX, liveProbeKey, liveLatestKey, liveGameTeams } from './live-probe.js';
import { bookIdFor, SPORTSBOOKS, americanToDecimal } from '../../docs/engine.js';
import { fetchWeather } from './weather.js';
import { gameReads } from './live-game.js';
import { SOCCER_LIVE, LIVE_SPORT, isSoccer } from './live-leagues.js';
import { espnAbbr } from '../../docs/team-logos.js';

/** The box-score key each market settles on, per league. */
export const LIVE_STAT = {
  nfl: { player_pass_yds: 'passingYards', player_pass_yds_alternate: 'passingYards', player_rush_yds: 'rushingYards', player_rush_yds_alternate: 'rushingYards', player_reception_yds: 'receivingYards', player_reception_yds_alternate: 'receivingYards', player_receptions: 'receptions', player_receptions_alternate: 'receptions' },
  nba: { player_points: 'points', player_points_alternate: 'points', player_rebounds: 'rebounds', player_rebounds_alternate: 'rebounds', player_assists: 'assists', player_assists_alternate: 'assists' },
  // Shots on goal are the box's shotsTotal (the "SOG"-labelled column is shootout goals); points are goals + assists, which the box does not carry as one column.
  nhl: { player_shots_on_goal: 'shotsTotal', player_shots_on_goal_alternate: 'shotsTotal', player_total_saves: 'saves', player_total_saves_alternate: 'saves', player_points: 'points', player_points_alternate: 'points' },
};
/** Soccer leagues on the tab (worker/src/live-leagues.js's SOCCER_LIVE): the same clock, box and stats for each. */
export { isSoccer };
const SOCCER_STAT = { player_shots: 'totalShots', player_shots_alternate: 'totalShots', player_shots_on_target: 'shotsOnTarget', player_shots_on_target_alternate: 'shotsOnTarget' };
for (const id of Object.keys(SOCCER_LIVE)) LIVE_STAT[id] = SOCCER_STAT;
export const LIVE_LABEL = { passingYards: 'Pass Yds', rushingYards: 'Rush Yds', receivingYards: 'Rec Yds', receptions: 'Rec', points: 'Pts', rebounds: 'Reb', assists: 'Ast', shotsTotal: 'SOG', saves: 'Saves', goals: 'G', totalShots: 'Shots', shotsOnTarget: 'SOT', totalGoals: 'G', goalAssists: 'A' };
const WATCH_STATS = { nfl: ['passingYards', 'rushingYards', 'receivingYards', 'receptions'], nba: ['points', 'rebounds', 'assists'], nhl: ['shotsTotal', 'saves', 'points', 'goals', 'assists'] };
const GAME_MINUTES = { nfl: 60, nba: 48, nhl: 60 };
const PERIODS = { nfl: 4, nba: 4, nhl: 3 };
/** The lead that sets the script: a football or basketball blowout, a two-goal hockey or soccer lead (the side behind pushes, the side ahead sits back). */
const BLOWOUT_BY_LEAGUE = { nfl: 17, nba: 17, nhl: 2 };
for (const id of Object.keys(SOCCER_LIVE)) { WATCH_STATS[id] = ['totalShots', 'shotsOnTarget', 'totalGoals', 'goalAssists', 'saves']; GAME_MINUTES[id] = 90; PERIODS[id] = 2; BLOWOUT_BY_LEAGUE[id] = 2; }
/** The sports where goals come one at a time and the score sets the script the same way. */
const goalSport = (league) => league === 'nhl' || isSoccer(league);

/** A box value by stat, with hockey points as goals + assists when the box has no points column. */
export function boxValue(p, stat) {
  const v = p?.stats?.[stat] == null ? null : num(p.stats[stat]);
  if (v != null) return v;
  if (stat === 'points') { const g = num(p?.stats?.goals); const a = num(p?.stats?.assists); return g != null && a != null ? g + a : null; }
  return null;
}
/** The intermission a hockey tick sits in (1 or 2), or null. */
export const intermissionOf = (tick, league = 'nfl') => (league === 'nhl' && tick?.state === 'in' && /end of (1st|2nd)/i.test(String(tick.detail ?? '')) ? (/1st/i.test(tick.detail) ? 1 : 2) : null);
export const LEG_PRICE = [-300, 150];
export const PLAY_PRICE = [-160, 300]; // wide enough at the top for a book whose rungs are priced near even (FanDuel), where three legs land past +200; the score still pulls the play to PLAY_TARGET
export const PLAY_TARGET = 100;
const MARGIN = 1.25;
const BLOWOUT = 17;
export const livePlayKey = (espnEventId) => `live:play:${espnEventId}`;

/** How much of the game is played, 0 to 1, from the period and the clock still on it; the half reads 0.5. */
export function elapsedFraction(tick, league = 'nfl') {
  if (!tick || tick.state === 'pre') return 0;
  if (tick.state === 'post') return 1;
  if (isSoccer(league)) {
    // The soccer clock counts up: "67'" or "45'+3'" in stoppage; half-time reads 0.5; a half with no clock reads its middle.
    if (/^ht$|half/i.test(String(tick.detail ?? ''))) return 0.5;
    const m = String(tick.clock ?? '').match(/(\d+)'/);
    const p = Number(tick.period) || 1;
    if (!m) return p >= 2 ? 0.75 : 0.25;
    const minutes = Math.min(Number(m[1]), p >= 2 ? 90 : 45);
    return Math.min(1, Math.max(0.02, minutes / 90));
  }
  const periods = PERIODS[league] ?? 4;
  const perPeriod = (GAME_MINUTES[league] ?? 60) / periods;
  if (/half/i.test(String(tick.detail ?? ''))) return 0.5;
  const p = Number(tick.period) || 1;
  const m = String(tick.clock ?? '').match(/^(\d+):(\d+)/);
  const left = m ? Number(m[1]) + Number(m[2]) / 60 : perPeriod;
  return Math.min(1, Math.max(0.02, ((p - 1) * perPeriod + (perPeriod - left)) / (GAME_MINUTES[league] ?? 60)));
}
export const isHalftime = (tick, league = 'nfl') => Boolean(tick) && tick.state === 'in' && (/^ht$|half/i.test(String(tick.detail ?? '')) || (!isSoccer(league) && Number(tick.period) === (PERIODS[league] ?? 4) / 2 && /^0:00/.test(String(tick.clock ?? ''))));

const num = (v) => { const n = Number(String(v ?? '').split('/')[0].replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const toAmerican = (decimal) => (decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1)));
const inRange = (x, [lo, hi]) => x >= lo && x <= hi;

/** The game script from the score: who is up big, who is down big. */
export function gameScript(tick, league = 'nfl') {
  const teams = Object.entries(tick?.score ?? {});
  if (teams.length !== 2) return { leader: null, trailer: null, margin: 0 };
  const lead = teams[0][1] - teams[1][1];
  if (Math.abs(lead) < (BLOWOUT_BY_LEAGUE[league] ?? BLOWOUT)) return { leader: null, trailer: null, margin: Math.abs(lead) };
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
export function projectStat(current, elapsed, stat, { team, script, weather, league = 'nfl' } = {}) {
  if (!Number.isFinite(current) || !elapsed) return null;
  let proj = current / elapsed;
  if (goalSport(league)) {
    // Score effects: the side behind by two shoots more and its goalie faces less; the side ahead sits back and its goalie faces more.
    const shooting = /shots|points|goals|assists/i.test(stat);
    if (script?.trailer && team === script.trailer) proj *= shooting ? 1.1 : 0.9;
    if (script?.leader && team === script.leader) proj *= shooting ? 0.9 : 1.1;
    return Math.round(proj);
  }
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
    for (const s of stats) { const v = boxValue(p, s); if (v != null) line[s] = v; }
    if (league === 'nfl') {
      const ca = String(p.stats?.['completions/passingAttempts'] ?? ''); if (ca.includes('/')) line.passing = ca;
      if (p.stats?.rushingAttempts != null) line.carries = num(p.stats.rushingAttempts);
      if (p.stats?.receivingTargets != null) line.targets = num(p.stats.receivingTargets);
    }
    // The table sorts on this: in hockey a goalie's saves would drown every skater, so shots and points carry the weight.
    line.total = league === 'nhl' ? (line.shotsTotal ?? 0) + 2 * (line.points ?? 0) + (line.saves ?? 0) / 4
      : isSoccer(league) ? (line.totalShots ?? 0) + (line.shotsOnTarget ?? 0) + 3 * (line.totalGoals ?? 0) + 2 * (line.goalAssists ?? 0) + (line.saves ?? 0) / 3
      : stats.reduce((n, s) => n + (line[s] ?? 0), 0);
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
  const script = gameScript(tick, league);
  const out = [];
  for (const b of payload?.bookmakers ?? []) {
    const bookId = bookIdFor(b.key) ?? b.key;
    for (const m of b.markets ?? []) {
      const stat = stats[m.key]; if (!stat) continue;
      for (const o of m.outcomes ?? []) {
        if (o.name !== 'Over' || !Number.isFinite(o.point) || !Number.isFinite(o.price)) continue;
        const p = box.get(String(o.description ?? '').toLowerCase()); if (!p) continue;
        const cur = boxValue(p, stat); if (cur == null) continue;
        if (cur >= o.point) continue; // already there; a book would not let it through anyway
        if (!inRange(o.price, LEG_PRICE)) continue;
        if (script.leader && p.team === script.leader && /passing|receiving|receptions/.test(stat)) continue;
        if (script.trailer && p.team === script.trailer && stat === 'rushingYards') continue;
        if (stat === 'passingYards' && roughWeather(weather)) continue;
        const proj = projectStat(cur, elapsed, stat, { team: p.team, script, weather, league });
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
  const script = gameScript(tick, league);
  const rows = [];
  for (const p of tick?.box ?? []) {
    for (const stat of WATCH_STATS[league] ?? []) {
      const cur = boxValue(p, stat); if (cur == null || cur <= 0) continue;
      const proj = projectStat(cur, elapsed, stat, { team: p.team, script, weather, league });
      const lines = candidates.filter((c) => c.player === p.name && c.stat === stat);
      const pick = (a, c) => (c.point > a.point || (c.point === a.point && c.price > a.price) ? c : a);
      const best = lines.length ? lines.reduce(pick) : null;
      // The best clearing line at each book, so a user who plays at one book sees that book's line and link.
      const perBook = [...new Set(lines.map((c) => c.bookId))].map((b) => lines.filter((c) => c.bookId === b).reduce(pick)).sort((a, c) => c.point - a.point || c.price - a.price).map((c) => ({ bookId: c.bookId, book: c.book, point: c.point, price: c.price, link: c.link }));
      const why = goalSport(league)
        ? (script.leader === p.team ? (stat === 'saves' ? 'up two: the lead sits back, the keeper sees more' : 'up two: the lead sits back') : script.trailer === p.team ? (stat === 'saves' ? 'down two: pressing, the keeper sees less' : 'down two: the side behind shoots more') : null)
        : script.leader === p.team ? (stat === 'rushingYards' ? 'up big: the run game carries the second half' : 'up big: the passing game sits') : script.trailer === p.team ? (stat === 'rushingYards' ? 'down big: the run game goes away' : 'down big: throwing to catch up') : null;
      rows.push({ player: p.name, team: p.team, athleteId: p.id ?? null, stat, label: LIVE_LABEL[stat] ?? stat, current: cur, projected: proj, why, line: best ? { bookId: best.bookId, book: best.book, point: best.point, price: best.price, link: best.link } : null, lines: perBook });
    }
  }
  // Yards first by projection; receptions and the like ride along with their player.
  const weight = (r) => (league === 'nhl' ? (r.stat === 'saves' ? r.projected : r.stat === 'shotsTotal' ? r.projected * 5 : r.projected * 8)
    : isSoccer(league) ? (r.stat === 'saves' ? r.projected : r.stat === 'totalShots' ? r.projected * 3 : r.stat === 'shotsOnTarget' ? r.projected * 5 : r.projected * 10)
    : r.stat === 'receptions' ? r.projected * 10 : r.stat === 'assists' || r.stat === 'rebounds' ? r.projected * 2.5 : r.projected);
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
    // The six players with the most cushion, each with five rungs: his three lowest clearing numbers (the cheap,
    // safe end that makes a +100 three-leg) and his two best-priced (the long end), so a deep ladder is not
    // read from the plus-money end alone, which no three legs can bring down to the target.
    const rungs = (opts) => { const low = [...opts].sort((x, y) => x.point - y.point).slice(0, 3); const high = [...opts].sort((x, y) => y.price - x.price).filter((o) => !low.includes(o)).slice(0, 2); return [...low, ...high]; };
    const list = [...players.values()].map(rungs).sort((x, y) => Math.max(...y.map((o) => o.cushion)) - Math.max(...x.map((o) => o.cushion))).slice(0, 6);
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

/** Slips build once this much of the game is played (a quarter and a bit, enough pace to project from) and stop this far in (books pull ladders late). */
export const BUILD_FROM = 0.2;
export const BUILD_UNTIL = 0.9;

/**
 * The plays for a game: rebuilt from the ladders on every tick while the
 * game is in play between BUILD_FROM and BUILD_UNTIL, and kept under
 * live:play. A tick with no ladders (a book pulling props at a timeout,
 * a feed miss) leaves the last build standing, as does any tick outside
 * the window. Null when nothing has been built.
 */
export async function ensureLivePlays(env, game, payload, tick, { league = 'nfl', now = Date.now(), weather = null } = {}) {
  const key = livePlayKey(game.id);
  const raw = await env.POTD_KV.get(key).catch(() => null);
  const stored = raw ? JSON.parse(raw) : null;
  const elapsed = elapsedFraction(tick, league);
  if (!tick || tick.state !== 'in' || elapsed < BUILD_FROM || elapsed > BUILD_UNTIL || !payload) return stored;
  const candidates = liveCandidates(payload, tick, league, { weather });
  const slips = buildLiveSlips(candidates);
  if (!slips.length) return stored;
  const record = {
    espnEventId: game.id, name: game.name, builtAt: now, firstBuiltAt: stored?.firstBuiltAt ?? now, builds: (stored?.builds ?? 0) + 1,
    score: tick.score ?? null, detail: tick.detail ?? null, period: tick.period ?? null, clock: tick.clock ?? null, elapsed, slips,
  };
  await env.POTD_KV.put(key, JSON.stringify(record), { expirationTtl: 3 * 86400 }).catch(() => {});
  return record;
}

/** The board: every watched game with its last reads, the books posting, the players, who to watch, and the slips. */
/** A watched game the board no longer shows: its last tick says final, or kick-off is six hours gone with nothing to say otherwise. */
export const liveGameOver = (g, tick, now) => tick ? tick.state === 'post' : now > Date.parse(g.date) + 6 * 3600e3;

/**
 * How playable a game is right now, for the order of the board (2026-11-05:
 * "playable lives at the very top in order of confidence"): the best slip's
 * mean cushion (how far the pace clears its numbers) against the best game
 * line's edge, as one score and as stars.
 */
export function playSummary(slips, reads) {
  const slipScore = Math.max(0, ...(slips ?? []).map((s) => (s.legs?.length ? s.legs.reduce((a, l) => a + (Number(l.cushion) || 0), 0) / s.legs.length : 0)));
  const readScore = Math.max(0, ...(reads ?? []).map((r) => Number(r.best?.edge) || 0)) * 2.5;
  const score = Math.min(1, Math.max(slipScore, readScore));
  const playable = (slips?.length ?? 0) > 0 || (reads?.length ?? 0) > 0;
  const stars = !playable ? 0 : score >= 0.5 ? 5 : score >= 0.35 ? 4 : score >= 0.22 ? 3 : score >= 0.12 ? 2 : 1;
  return { playable, score: Math.round(score * 100) / 100, stars, slips: slips?.length ?? 0, reads: reads?.length ?? 0 };
}

export async function getLiveBoard(env, now = Date.now(), { ctx = null } = {}) {
  const idxRaw = await env.POTD_KV.get(LIVE_WATCH_INDEX).catch(() => null);
  const games = (idxRaw ? JSON.parse(idxRaw).games : []) ?? [];
  const out = [];
  // The whole slate (2026-11-05: "I only see two games, should be way more"): every watched game not yet over, up to forty.
  for (const g of games.slice(0, 40)) {
    const watch = JSON.parse((await env.POTD_KV.get(liveWatchKey(g.id)).catch(() => null)) ?? 'null');
    const tick = watch?.ticks?.at(-1) ?? null;
    if (liveGameOver(g, tick, now)) continue; // the tab is for what is on or about to be, not last night
    const league = g.league ?? watch?.league ?? 'nfl';
    const probeId = await env.POTD_KV.get(`live:probe:for:${g.id}`).catch(() => null);
    const probe = probeId ? JSON.parse((await env.POTD_KV.get(liveProbeKey(probeId)).catch(() => null)) ?? 'null') : null;
    const payload = probeId ? JSON.parse((await env.POTD_KV.get(liveLatestKey(probeId)).catch(() => null)) ?? 'null') : null;
    const snap = probe?.snapshots?.at(-1) ?? null;
    const teams = liveGameTeams(g.name);
    const weather = league === 'nfl' && ctx ? await fetchWeather({ sportKey: 'americanfootball_nfl', homeTeam: teams[1] ?? null, commenceMs: Date.parse(g.date) }, ctx).catch(() => null) : null;
    const candidates = payload && tick ? liveCandidates(payload, tick, league, { weather }) : [];
    // Hockey: the game lines (moneyline, puck line, total) read against the score and the clock (worker/src/live-game.js).
    const homeName = probe?.home ?? teams[1] ?? null; const awayName = probe?.away ?? teams[0] ?? null;
    const game = goalSport(league) && payload && tick?.state === 'in'
      ? gameReads(payload, { home: homeName, away: awayName, homeAbbr: tick.home ?? espnAbbr(LIVE_SPORT[league], homeName), awayAbbr: tick.away ?? espnAbbr(LIVE_SPORT[league], awayName), score: tick.score ?? {}, elapsed: elapsedFraction(tick, league), sport: isSoccer(league) ? 'soccer' : 'nhl', minutes: GAME_MINUTES[league] ?? 60 })
      : [];
    // A read shows the slips the last tick built (worker/src/live-probe.js rebuilds them every tick); it does not rebuild them itself.
    const plays = tick ? await ensureLivePlays(env, g, null, tick, { league, now, weather }) : null;
    const slipList = plays ? refreshSlips(plays.slips, tick) : [];
    out.push({
      play: playSummary(slipList, game),
      espnEventId: g.id, name: g.name, date: g.date, league,
      tick: tick ? { at: tick.at, state: tick.state, detail: tick.detail, period: tick.period, clock: tick.clock, score: tick.score } : null,
      elapsed: elapsedFraction(tick, league), halftime: isHalftime(tick, league), intermission: intermissionOf(tick, league), script: gameScript(tick, league),
      game,
      weather: weather ? { ...weather, rough: roughWeather(weather) } : null,
      probe: snap ? { at: snap.at, booksPosting: snap.booksPosting, books: snap.books.map((b) => ({ key: b.key, bookId: bookIdFor(b.key) ?? b.key, markets: b.markets.map((m) => ({ key: m.key, outcomes: m.outcomes, players: m.players })) })), snapshots: probe.snapshots.length } : null,
      players: playerLines(tick, league),
      watch: whoToWatch(tick, candidates, league, { weather }),
      candidates: candidates.slice(0, 12),
      slips: plays ? { builtAt: plays.builtAt, firstBuiltAt: plays.firstBuiltAt ?? plays.builtAt, builds: plays.builds ?? 1, score: plays.score, detail: plays.detail ?? null, period: plays.period ?? null, clock: plays.clock ?? null, list: slipList } : null,
    });
  }
  return { at: now, games: out };
}
