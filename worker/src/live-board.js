/**
 * The Live tab's board (2026-11-01 direction: "a live tab with an
 * indicator on what games it is probing, update times, and the props to
 * play; once a play is ready, the current lines to take and where the
 * player is"). For each game the runner is watching (scripts/live-watch.mjs)
 * the board pairs the last box-score read with the worker's last odds
 * snapshot (worker/src/live-probe.js), lists which books post lines, and
 * works the ladders against the box: every Over whose number the player's
 * pace clears with margin is a candidate, shown with where he is now; at
 * the half the best three to five at one book become the play, priced
 * near +100. A first, deterministic cut: no model read yet, and the play
 * is shown, not tracked.
 */
import { liveWatchKey, LIVE_WATCH_INDEX, liveProbeKey, liveLatestKey } from './live-probe.js';
import { bookIdFor, SPORTSBOOKS, americanToDecimal } from '../../docs/engine.js';

/** The box-score key each market settles on, per league. */
export const LIVE_STAT = {
  nfl: { player_pass_yds: 'passingYards', player_pass_yds_alternate: 'passingYards', player_rush_yds: 'rushingYards', player_rush_yds_alternate: 'rushingYards', player_reception_yds: 'receivingYards', player_reception_yds_alternate: 'receivingYards', player_receptions: 'receptions', player_receptions_alternate: 'receptions' },
  nba: { player_points: 'points', player_points_alternate: 'points', player_rebounds: 'rebounds', player_rebounds_alternate: 'rebounds', player_assists: 'assists', player_assists_alternate: 'assists' },
};
export const LIVE_LABEL = { passingYards: 'Pass Yds', rushingYards: 'Rush Yds', receivingYards: 'Rec Yds', receptions: 'Rec', points: 'Pts', rebounds: 'Reb', assists: 'Ast' };
const GAME_MINUTES = { nfl: 60, nba: 48 };
const PERIODS = { nfl: 4, nba: 4 };
export const LEG_PRICE = [-300, 150];
export const PLAY_PRICE = [-160, 200];
export const PLAY_TARGET = 100;
const MARGIN = 1.25;

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

/**
 * Every Over on the board the box score says is reachable: the player's
 * current number, his pace to the final whistle, and the margin by which
 * it clears the line. Game script in the simplest terms: a side up by
 * seventeen or more leans on the run and sits its passing game; a side
 * down by that much throws, so its rushing lines are passed over.
 */
export function liveCandidates(payload, tick, league = 'nfl') {
  const stats = LIVE_STAT[league] ?? {};
  const box = new Map((tick?.box ?? []).map((p) => [String(p.name ?? '').toLowerCase(), p]));
  const elapsed = elapsedFraction(tick, league);
  if (!elapsed || elapsed >= 1) return [];
  const teams = Object.entries(tick?.score ?? {});
  const lead = teams.length === 2 ? teams[0][1] - teams[1][1] : 0;
  const leader = Math.abs(lead) >= 17 ? (lead > 0 ? teams[0][0] : teams[1][0]) : null;
  const trailer = leader ? (leader === teams[0][0] ? teams[1][0] : teams[0][0]) : null;
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
        if (leader && p.team === leader && /passing|receiving|receptions/.test(stat)) continue;
        if (trailer && p.team === trailer && stat === 'rushingYards') continue;
        const pace = cur / elapsed;
        if (pace < o.point * MARGIN) continue;
        out.push({ bookId, book: SPORTSBOOKS[bookId]?.name ?? b.key, market: m.key, stat, label: LIVE_LABEL[stat] ?? stat, player: o.description, team: p.team ?? null, athleteId: p.id ?? null, point: o.point, price: o.price, decimal: americanToDecimal(o.price), current: cur, pace: Math.round(pace * 10) / 10, cushion: Math.round(((pace - o.point) / o.point) * 100) / 100, link: o.link ?? null });
      }
    }
  }
  return out.sort((x, y) => y.cushion - x.cushion || y.price - x.price);
}

/**
 * The play: at one book, one line per player, three to five legs whose
 * combined price lands nearest PLAY_TARGET inside PLAY_PRICE. Each
 * player offers every number of his that clears; the search picks the
 * numbers that make the price, with a nod to cushion.
 */
export function buildLivePlay(candidates, { legs = [3, 4, 5] } = {}) {
  const byBook = new Map();
  for (const c of candidates) {
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

/** The board: every watched game with its last reads, the books posting, the candidates and the play. */
export async function getLiveBoard(env, now = Date.now()) {
  const idxRaw = await env.POTD_KV.get(LIVE_WATCH_INDEX).catch(() => null);
  const games = (idxRaw ? JSON.parse(idxRaw).games : []) ?? [];
  const latestProbeId = await env.POTD_KV.get('live:probe:latest').catch(() => null);
  const probe = latestProbeId ? JSON.parse((await env.POTD_KV.get(liveProbeKey(latestProbeId)).catch(() => null)) ?? 'null') : null;
  const payload = latestProbeId ? JSON.parse((await env.POTD_KV.get(liveLatestKey(latestProbeId)).catch(() => null)) ?? 'null') : null;
  const out = [];
  for (const g of games.slice(0, 4)) {
    const watch = JSON.parse((await env.POTD_KV.get(liveWatchKey(g.id)).catch(() => null)) ?? 'null');
    const tick = watch?.ticks?.at(-1) ?? null;
    const league = g.league ?? watch?.league ?? 'nfl';
    // The probe pairs with the game by team names.
    const names = String(g.name ?? '').toLowerCase();
    const paired = probe && [probe.home, probe.away].every((t) => names.includes(String(t ?? '').toLowerCase().split(' ').at(-1)));
    const snap = paired ? probe.snapshots.at(-1) : null;
    const candidates = paired && payload && tick ? liveCandidates(payload, tick, league) : [];
    const half = isHalftime(tick, league);
    const play = half && candidates.length ? buildLivePlay(candidates) : null;
    out.push({
      espnEventId: g.id, name: g.name, date: g.date, league,
      tick: tick ? { at: tick.at, state: tick.state, detail: tick.detail, period: tick.period, clock: tick.clock, score: tick.score } : null,
      elapsed: elapsedFraction(tick, league), halftime: half,
      probe: snap ? { at: snap.at, booksPosting: snap.booksPosting, books: snap.books.map((b) => ({ key: b.key, bookId: bookIdFor(b.key) ?? b.key, markets: b.markets.map((m) => ({ key: m.key, outcomes: m.outcomes, players: m.players })) })), snapshots: probe.snapshots.length } : null,
      candidates: candidates.slice(0, 12),
      play: play ? { ...play, ready: true, at: now } : null,
      players: (tick?.box ?? []).filter((p) => Object.keys(p.stats ?? {}).some((k) => /Yards|receptions|points/.test(k))).slice(0, 40),
    });
  }
  return { at: now, games: out };
}
