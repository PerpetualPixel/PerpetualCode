/**
 * The tennis board at FanDuel as the runner wrote it (scripts/tennis-fanduel.mjs,
 * KV tennis:fanduel), turned into the odds feed's own event shape so the
 * match read (worker/src/tennis-picks.js) prices from it the same way it
 * prices from the feed.
 *
 * 2026-11-12: the feed carries no board for the smaller tournaments (the
 * Stockholm week had none at all), so a week of matches went unread. The
 * user's own screenshots of that week were FanDuel's board, which lists
 * every match with the markets asked for: "moneyline, spread, to win a
 * set". FanDuel's public page data answers a runner and gives each market
 * its marketId and each runner its selectionId, so every price here also
 * carries a link that puts the selection on a FanDuel slip.
 *
 *   FanDuel market                      feed key              the leg
 *   MATCH_BETTING                       h2h                   moneyline
 *   MAIN_MATCH_GAME_HANDICAP            spreads               game spread
 *   MATCH_TOTAL_GAMES                   totals                total games
 *   ALTERNATIVE_MATCH_TOTAL_GAMES       alternate_totals      total games, every number
 *   MAIN_SET_TOTAL_GAMES (Set 1, 2)     totals_s1, alternate_totals_s2
 *   SET_1_WINNER, SET_2_WINNER          h2h_s1, h2h_s2        set winner
 *   PLAYER_x_TO_WIN_AT_LEAST_1_SET      alternate_set_spreads Yes is the player +1.5 sets, No the other -1.5
 *   EXACT_NUMBER_OF_SETS                alternate_set_totals  "3 Sets" is over 2.5, "2 Sets" under
 *   PLAYER_x_ACES                       player_aces           "7+" is over 6.5 aces
 *
 * The two set markets read that way only in a best of three; a best of
 * five leaves them out.
 */
import { fanduelSlipLink } from './ufc-fanduel.js';
import { nameKey } from './tennis-card-parse.js';

export const TENNIS_FANDUEL_KEY = 'tennis:fanduel';
/** A read older than this is no price to post on. */
export const FANDUEL_MAX_AGE = 6 * 3600e3;
/** The tabs of a match's page read beside the default one. */
export const FANDUEL_TENNIS_TABS = ['popular', 'set-markets'];
/** The market types kept from a match's page. */
export const FANDUEL_TENNIS_TYPES = new Set(['MATCH_BETTING', 'MAIN_MATCH_GAME_HANDICAP', 'MATCH_TOTAL_GAMES', 'ALTERNATIVE_MATCH_TOTAL_GAMES', 'MAIN_SET_TOTAL_GAMES', 'SET_1_WINNER', 'SET_2_WINNER', 'SET_BETTING', 'PLAYER_A_TO_WIN_AT_LEAST_1_SET', 'PLAYER_B_TO_WIN_AT_LEAST_1_SET', 'EXACT_NUMBER_OF_SETS', 'PLAYER_A_ACES', 'PLAYER_B_ACES']);

const surname = (name) => nameKey(name).split(' ').filter(Boolean).at(-1) ?? '';
/** Two spellings of one player: the same folded name, or the same surname and first initial. */
export const samePlayer = (x, y) => { const a = nameKey(x); const b = nameKey(y); return Boolean(a && b) && (a === b || (surname(a) === surname(b) && surname(a).length >= 4 && a[0] === b[0])); };

/** A FanDuel event's two players from its name ("Taylor Fritz v Holger Rune"); null for a doubles pair or an outright. */
export function fanduelPlayers(name) {
  const parts = String(name ?? '').split(/\s+v\s+/i);
  if (parts.length !== 2 || parts.some((p) => !p.trim() || p.includes('/'))) return null;
  return [parts[0].trim(), parts[1].trim()];
}

/** The FanDuel event for a card match: both names fit, either order. Null when the read is missing, stale or has no such match. */
export function fanduelEventFor(match, fd, now = Date.now()) {
  if (!fd?.events?.length || !(now - (fd.at ?? 0) < FANDUEL_MAX_AGE)) return null;
  for (const e of fd.events) {
    const p = fanduelPlayers(e.name); if (!p) continue;
    if ((samePlayer(match.a.name, p[0]) && samePlayer(match.b.name, p[1])) || (samePlayer(match.a.name, p[1]) && samePlayer(match.b.name, p[0]))) return e;
  }
  return null;
}

const numberAtEnd = (s) => { const m = /^(.*?)\s*\(?([+-]?\d+(?:\.\d+)?)\)?$/.exec(String(s ?? '').trim()); return m ? { name: m[1].trim(), point: Number(m[2]) } : null; };
const overUnder = (s) => { const m = /^(over|under)\s*\(?(\d+(?:\.\d+)?)\)?$/i.exec(String(s ?? '').trim()); return m ? { name: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), point: Number(m[2]) } : null; };

/**
 * A FanDuel event as the feed would give it: {board, deep}, each a feed
 * event with one bookmaker (fanduel) whose outcomes carry a slip link.
 * `board` holds what the feed's tournament board holds (h2h, spreads,
 * totals), `deep` the rest. Null for an event with no two players.
 */
export function fanduelFeedEvent(e, { bestOf = 3 } = {}) {
  const players = fanduelPlayers(e?.name); if (!players) return null;
  const [pa, pb] = players;
  const board = []; const deep = [];
  const out = (market, runner, name, point = null) => ({ name, ...(point != null ? { point } : {}), price: runner.american, link: fanduelSlipLink(market.marketId, runner.selectionId) });
  const priced = (m) => (m.runners ?? []).filter((r) => Number.isFinite(r.american));
  const five = bestOf === 5 || (e.markets ?? []).some((m) => m.marketType === 'SET_BETTING' && (m.runners ?? []).some((r) => /\b3-[012]\b/.test(r.runnerName)));
  const setSpreads = []; const aces = []; const s1 = []; const s2 = [];
  for (const m of e.markets ?? []) {
    const rs = priced(m); if (!rs.length) continue;
    switch (m.marketType) {
      case 'MATCH_BETTING': board.push({ key: 'h2h', outcomes: rs.map((r) => out(m, r, r.runnerName)) }); break;
      case 'MAIN_MATCH_GAME_HANDICAP': {
        const outcomes = rs.map((r) => { const p = numberAtEnd(r.runnerName) ?? (r.handicap ? { name: r.runnerName, point: r.handicap } : null); return p ? out(m, r, p.name, p.point) : null; }).filter(Boolean);
        if (outcomes.length) board.push({ key: 'spreads', outcomes });
        break;
      }
      case 'MATCH_TOTAL_GAMES': case 'ALTERNATIVE_MATCH_TOTAL_GAMES': {
        const outcomes = rs.map((r) => { const p = overUnder(r.runnerName) ?? (r.handicap && /^(over|under)$/i.test(r.runnerName) ? { name: r.runnerName, point: r.handicap } : null); return p ? out(m, r, p.name, p.point) : null; }).filter(Boolean);
        if (outcomes.length) (m.marketType === 'MATCH_TOTAL_GAMES' ? board : deep).push({ key: m.marketType === 'MATCH_TOTAL_GAMES' ? 'totals' : 'alternate_totals', outcomes });
        break;
      }
      case 'MAIN_SET_TOTAL_GAMES': {
        const set = /set\s*(\d)/i.exec(m.marketName)?.[1];
        const outcomes = rs.map((r) => { const p = overUnder(r.runnerName); return p ? out(m, r, p.name, p.point) : null; }).filter(Boolean);
        if (set === '1') s1.push(...outcomes); else if (set === '2') s2.push(...outcomes);
        break;
      }
      case 'SET_1_WINNER': deep.push({ key: 'h2h_s1', outcomes: rs.map((r) => out(m, r, r.runnerName)) }); break;
      case 'SET_2_WINNER': deep.push({ key: 'h2h_s2', outcomes: rs.map((r) => out(m, r, r.runnerName)) }); break;
      case 'PLAYER_A_TO_WIN_AT_LEAST_1_SET': case 'PLAYER_B_TO_WIN_AT_LEAST_1_SET': {
        if (five) break;
        const me = m.marketType.startsWith('PLAYER_A') ? pa : pb; const other = me === pa ? pb : pa;
        for (const r of rs) { if (/\byes$/i.test(r.runnerName)) setSpreads.push(out(m, r, me, 1.5)); else if (/\bno$/i.test(r.runnerName)) setSpreads.push(out(m, r, other, -1.5)); }
        break;
      }
      case 'EXACT_NUMBER_OF_SETS': {
        if (five) break;
        const outcomes = rs.map((r) => (/^3\b/.test(r.runnerName) ? out(m, r, 'Over', 2.5) : /^2\b/.test(r.runnerName) ? out(m, r, 'Under', 2.5) : null)).filter(Boolean);
        if (outcomes.length) deep.push({ key: 'alternate_set_totals', outcomes });
        break;
      }
      case 'PLAYER_A_ACES': case 'PLAYER_B_ACES': {
        const me = m.marketType === 'PLAYER_A_ACES' ? pa : pb;
        for (const r of rs) { const n = /^(\d+)\+$/.exec(String(r.runnerName).trim()); if (n) aces.push(out(m, r, me, Number(n[1]) - 0.5)); }
        break;
      }
      default: break;
    }
  }
  if (s1.length) deep.push({ key: 'totals_s1', outcomes: s1 });
  if (s2.length) deep.push({ key: 'alternate_totals_s2', outcomes: s2 });
  if (setSpreads.length) deep.push({ key: 'alternate_set_spreads', outcomes: setSpreads });
  if (aces.length) deep.push({ key: 'player_aces', outcomes: aces });
  const base = { id: `fd:${e.eventId}`, sportKey: null, commence_time: e.openDate, home_team: pa, away_team: pb };
  const bookmaker = (markets) => [{ key: 'fanduel', title: 'FanDuel', markets }];
  return { board: { ...base, bookmakers: bookmaker(board) }, deep: { ...base, bookmakers: bookmaker(deep) } };
}

/**
 * A feed event with FanDuel's own read laid over it: the feed's FanDuel
 * bookmaker (its prices are the same book's, without slip links) gives way
 * to the page's, the other books stay. Either side may be missing.
 */
export function withFanduel(feedEvent, fdEvent) {
  if (!fdEvent?.bookmakers?.[0]?.markets?.length) return feedEvent ?? null;
  if (!feedEvent) return fdEvent;
  const fd = fdEvent.bookmakers[0];
  const keys = new Set(fd.markets.map((m) => m.key));
  const rest = (feedEvent.bookmakers ?? []).map((bm) => (bm.key === 'fanduel' ? { ...bm, markets: (bm.markets ?? []).filter((m) => !keys.has(m.key)) } : bm)).filter((bm) => bm.key !== 'fanduel' || bm.markets.length);
  return { ...feedEvent, bookmakers: [...rest, fd] };
}
