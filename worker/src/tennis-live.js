/**
 * Tennis on the Live tab (2026-11-06: "once complete add this to the live
 * tab"): the day's ATP and WTA singles from ESPN's scoreboards, read from
 * the worker on request and cached two minutes, with the Tennis tab's
 * plays on each match and where each stands against the score so far.
 */
import { parseScoreboard } from './tennis-card-parse.js';
import { tennisPicksKey, gradePlay, setDone } from './tennis-picks.js';
import { etParts } from './potd.js';

export const TENNIS_LIVE_KEY = 'tennis:live';
export const TENNIS_LIVE_TTL = 2 * 60e3;
export const ESPN_TENNIS = { atp: 'https://site.web.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard', wta: 'https://site.web.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard' };
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

/** One ESPN page as JSON; null with the reason noted when it will not come (the same plain fetch worker/src/tennis-espn.js uses). */
async function getJson(url, note = () => {}) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
    if (!res.ok) { note(`HTTP ${res.status}`); return null; }
    return await res.json();
  } catch (e) { note(String(e?.message ?? e)); return null; }
}

/**
 * Where a play stands against the match so far: {state: 'won'|'lost'|'push'|'void'|'on'|'off'|'wait', text}.
 * A settled play reads from the grade; a live one from the games and sets to here.
 */
export function playStanding(play, m) {
  if (play.status === 'graded' || play.status === 'void') return { state: play.result === 'win' ? 'won' : play.result === 'loss' ? 'lost' : play.result, text: play.actual ?? play.result };
  if (!m) return { state: 'wait', text: 'Not started' };
  const sets = m.sets ?? [];
  if (m.completed || (m.state !== 'in' && sets.length)) { const g = gradePlay(play, m); if (g) return { state: g.result === 'win' ? 'won' : g.result === 'loss' ? 'lost' : g.result, text: g.actual }; }
  if (m.state !== 'in') return { state: 'wait', text: 'Not started' };
  const g = gradePlay(play, { ...m, completed: false });
  if (g) return { state: g.result === 'win' ? 'won' : g.result === 'loss' ? 'lost' : g.result, text: g.actual };
  const gamesA = sets.reduce((n, [a]) => n + a, 0); const gamesB = sets.reduce((n, [, b]) => n + b, 0);
  const line = sets.map(([a, b]) => `${a}-${b}`).join(' ') || 'first set under way';
  switch (play.market) {
    case 'games_spread': { const margin = (play.side === 'a' ? gamesA - gamesB : gamesB - gamesA) + play.point; return { state: margin > 0 ? 'on' : 'off', text: `${line}: ${margin > 0 ? 'inside' : 'outside'} the spread by ${Math.abs(margin)}` }; }
    case 'games_total': { const total = gamesA + gamesB; return { state: total + 6 * Math.max(0, (m.bestOf === 5 ? 3 : 2) - sets.length) > play.point ? 'on' : 'off', text: `${line}: ${total} games so far` }; }
    case 'set_spread': return { state: sets.filter(setDone).length <= 1 ? 'on' : 'off', text: `${line}: ${play.side === 'a' ? play.a : play.b} needs a set` };
    case 'set1_total': { const s = sets[0]; return { state: s && s[0] + s[1] >= play.point - 2 ? 'on' : 'wait', text: `${line}: ${s ? s[0] + s[1] : 0} games in the first` }; }
    case 'set2_total': { const s = sets[1]; return { state: s && s[0] + s[1] >= play.point - 2 ? 'on' : 'wait', text: `${line}: ${s ? s[0] + s[1] : 0} games in the second` }; }
    case 'aces': return { state: 'wait', text: `${line}: aces settle from the match stats` };
    default: return { state: 'wait', text: line };
  }
}

/**
 * The day's singles with the plays: {at, day, matches: [{id, tour, event, tier, round, date, state, completed, detail,
 * a, b, sets, winner, plays: [{id, market, selection, side, american, bookId, book, standing}]}], inPlay, parlay}.
 */
export async function getTennisLive(env, now = Date.now(), { fetchJson = getJson } = {}) {
  const raw = await env.POTD_KV.get(TENNIS_LIVE_KEY).catch(() => null);
  let scoreboard = null;
  if (raw) { try { const c = JSON.parse(raw); if (now - (c.at ?? 0) < TENNIS_LIVE_TTL) scoreboard = c; } catch { /* read again */ } }
  if (!scoreboard) {
    const byId = new Map();
    const sources = {};
    // Today (UTC) and, in the small hours, yesterday: the Americas' night matches run past midnight UTC.
    const days = new Date(now).getUTCHours() < 8 ? [ymd(now - 864e5), ymd(now)] : [ymd(now)];
    for (const tour of ['atp', 'wta']) for (const day of days) {
      const key = `${tour}:${day}`;
      const data = await fetchJson(`${ESPN_TENNIS[tour]}?dates=${day}`, (why) => { sources[key] = why; });
      if (!data) { sources[key] = sources[key] ?? 'no body'; continue; }
      const parsed = parseScoreboard(data, tour);
      sources[key] = `${(data.events ?? []).length} events, ${parsed.length} singles`;
      for (const m of parsed) { const prev = byId.get(`${tour}:${m.id}`); if (!prev || m.state === 'in' || (m.completed && !prev.completed) || (!prev.sets.length && m.sets.length)) byId.set(`${tour}:${m.id}`, m); }
    }
    scoreboard = { at: now, sources, matches: [...byId.values()].filter((m) => !m.qualifying && m.tier !== 'challenger') };
    await env.POTD_KV.put(TENNIS_LIVE_KEY, JSON.stringify(scoreboard), { expirationTtl: 3600 }).catch(() => {});
  }
  const day = etParts(now).date;
  // A scoreboard day answers with the tournament's whole draw: the Live tab wants today's matches (the Eastern day, as the board) and whatever is in play.
  const todays = scoreboard.matches.filter((m) => m.state === 'in' || (Number.isFinite(Date.parse(m.date)) && etParts(Date.parse(m.date)).date === day));
  const plays = [];
  for (const d of [day, etParts(now - 864e5).date]) { const r = await env.POTD_KV.get(tennisPicksKey(d)).catch(() => null); if (r) { try { plays.push(...(JSON.parse(r).plays ?? [])); } catch { /* a bad record is no record */ } } }
  const byMatch = new Map(scoreboard.matches.map((m) => [`${m.tour}:${m.id}`, m]));
  const playsOf = (id) => plays.filter((p) => p.matchId === id && p.market !== 'ml_parlay').map((p) => ({ id: p.id, market: p.market, selection: p.selection, side: p.side, point: p.point, american: p.american, bookId: p.bookId, book: p.book, link: p.link, prob: p.prob, standing: playStanding(p, byMatch.get(id)) }));
  const matches = todays.map((m) => { const id = `${m.tour}:${m.id}`; return { id, tour: m.tour, event: m.eventName, tier: m.tier, round: m.round, date: m.date, state: m.state, completed: m.completed, detail: m.detail, a: m.a.name, b: m.b.name, sets: m.sets, winner: m.winner, plays: playsOf(id) }; });
  const rank = (m) => (m.state === 'in' ? 0 : m.state === 'pre' ? 1 : 2);
  matches.sort((x, y) => rank(x) - rank(y) || (y.plays.length - x.plays.length) || Date.parse(x.date) - Date.parse(y.date));
  // The day's moneyline parlay with each leg's standing.
  const parlays = plays.filter((p) => p.market === 'ml_parlay' && p.status === 'pending').map((p) => ({ id: p.id, selection: p.selection, american: p.american, bookId: p.bookId, book: p.book, link: p.link, prob: p.prob, legs: (p.legs ?? []).map((l) => { const m = byMatch.get(l.matchId); const r = m ? legStanding(l, m) : { state: 'wait', text: 'Not started' }; return { ...l, standing: r }; }) }));
  return { at: scoreboard.at, day, sources: scoreboard.sources ?? {}, matches, inPlay: matches.filter((m) => m.state === 'in').length, parlays };
}

/** A moneyline leg against the match so far. */
export function legStanding(leg, m) {
  const sets = m.sets ?? [];
  const done = sets.filter(setDone);
  const mine = done.filter((s) => (leg.side === 'a' ? s[0] > s[1] : s[1] > s[0])).length; const theirs = done.length - mine;
  const line = sets.map(([a, b]) => `${a}-${b}`).join(' ');
  if (m.completed) { if (!m.winner) return { state: 'void', text: `${line || 'no score'}: no winner listed` }; return { state: m.winner === leg.side ? 'won' : 'lost', text: `${line}${m.winner === leg.side ? ': won' : ': lost'}` }; }
  if (m.state !== 'in') return { state: 'wait', text: 'Not started' };
  return { state: mine > theirs ? 'on' : mine < theirs ? 'off' : 'on', text: `${line || 'first set under way'}: ${mine}-${theirs} in sets` };
}
