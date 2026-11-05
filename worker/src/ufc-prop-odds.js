/**
 * The fight props' prices from the BestFightOdds board the runner writes
 * (scripts/ufc-prop-odds.mjs, KV ufc:propodds). The odds feed carries no
 * fight props for MMA, so the parlay legs (worker/src/ufc-props.js) take
 * their prices from here: each leg maps to the board's row wording, and
 * the row's prices become the leg's quotes, best first, each linking to
 * the event's page on the board (no deep link into a slip).
 */
import { SPORTSBOOKS, americanToDecimal } from '../../docs/engine.js';
import { normalizeName } from './ufc-events.js';

export const UFC_PROP_ODDS_KEY = 'ufc:propodds';
export const BOARD_NOTE = 'No book on the odds board has posted this prop yet; the price comes once one does.';

/** The board from KV, or null. */
export async function readPropOdds(env) {
  const raw = await env.POTD_KV.get(UFC_PROP_ODDS_KEY).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const key = (n) => normalizeName(String(n ?? '').replace(/-/g, ' '));
const surname = (n) => key(n).split(' ').filter(Boolean).at(-1) ?? '';
const first = (n) => key(n).split(' ').filter(Boolean)[0] ?? '';
const alike = (x, y) => Boolean(x && y) && (x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x))));
/** How well a board name fits one of ours: 2 for the whole name, 1 for the surname, 0.5 for the first name alone, else 0. */
const fit = (ours, theirs) => (key(ours) === key(theirs) ? 2 : alike(surname(ours), surname(theirs)) ? 1 : alike(first(ours), first(theirs)) ? 0.5 : 0);
/** A pairing: both sides fit by surname or better, or one side is the whole name and the other fits by first name (Jose Henrique on the board, Jose Souza on ESPN). */
const pairs = (x, y) => (x >= 1 && y >= 1) || (x === 2 && y >= 0.5) || (y === 2 && x >= 0.5);

/**
 * The board's matchup for a bout, with which of its two fighters is our
 * side a: both names fit either way round, and no other matchup fits as
 * well. Null when the board does not carry the bout.
 */
export function matchupFor(bout, board) {
  const events = board?.events ?? [];
  let best = null;
  for (const ev of events) {
    for (const m of ev.matchups ?? []) {
      const [f1, f2] = m.fighters ?? [];
      if (!f1 || !f2) continue;
      const a1 = fit(bout.a?.name, f1); const b2 = fit(bout.b?.name, f2); const a2 = fit(bout.a?.name, f2); const b1 = fit(bout.b?.name, f1);
      const straight = pairs(a1, b2) ? a1 + b2 : 0;
      const flipped = pairs(a2, b1) ? a2 + b1 : 0;
      const score = Math.max(straight, flipped);
      const flip = flipped > straight;
      if (score < 2) continue;
      if (!best || score > best.score) best = { score, matchup: m, event: ev, aIndex: flip ? 1 : 0, tie: false };
      else if (score === best.score) best.tie = true;
    }
  }
  return best && !best.tie ? best : null;
}

const METHOD_WORD = { ko: 'TKO/KO', sub: 'submission', dec: 'decision' };
const point = (p) => String(p).replace(/\.5$/, '.5');

/**
 * The board rows a leg can price from, in its wording ("Parsons wins by
 * TKO/KO in round 1", "Over 1.5 rounds", "Fight starts round 2"); the
 * surname is the board's own for that fighter. Null for a prop the board
 * does not list (the minute specials, the either-fighter combos).
 */
export function boardLabelsFor(leg, { aName, bName }) {
  const who = leg.side === 'a' ? surname(aName) : leg.side === 'b' ? surname(bName) : null;
  const sn = who ? who.charAt(0).toUpperCase() + who.slice(1) : null;
  const k = leg.method ?? null;
  switch (leg.prop) {
    case 'ml': return sn ? [{ fighter: leg.side }] : null; // the fighter row itself
    case 'rounds': return Number.isFinite(leg.point) ? [`${leg.sideWord === 'under' ? 'Under' : 'Over'} ${point(leg.point)} rounds`] : null;
    case 'distance': return [/does not/i.test(leg.selection) ? "Fight doesn't go to decision" : 'Fight goes to decision'];
    case 'round_start': return Number.isFinite(leg.round) ? [leg.answer === 'no' ? `Fight won't start round ${leg.round}` : `Fight starts round ${leg.round}`] : null;
    case 'method': return sn && k ? [`${sn} wins by ${METHOD_WORD[k]}`] : null;
    case 'double': return sn && Array.isArray(leg.methods) && leg.methods.includes('ko') && leg.methods.includes('sub') ? [`${sn} wins inside distance`] : null;
    case 'end_round': return Number.isFinite(leg.round) ? [`Fight ends in round ${leg.round}`] : /Round (\d)/.test(leg.selection) ? [`Fight ends in round ${/Round (\d)/.exec(leg.selection)[1]}`] : null;
    case 'end_method': return k === 'dec' || /Points/.test(leg.selection) ? ['Fight goes to decision'] : /KO/.test(leg.selection) ? ['Either fighter wins by TKO/KO'] : /Submission/.test(leg.selection) ? ['Either fighter wins by submission'] : null;
    case 'method_round': return sn && k && Number.isFinite(leg.round) ? [`${sn} wins by ${METHOD_WORD[k]} in round ${leg.round}`] : null;
    case 'win_round': return sn && Number.isFinite(leg.round) ? [`${sn} wins in round ${leg.round}`] : null;
    default: return null;
  }
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

/**
 * The legs priced from the board: a leg whose wording the board lists
 * gets the row's prices as quotes (best first, each linking to the event
 * page), with `priced` set; the feed's own quotes on a moneyline stay
 * ahead of the board's. Legs the board does not list carry BOARD_NOTE.
 */
export function priceLegsFromBoard(legs, bout, board) {
  const hit = matchupFor(bout, board);
  if (!hit) return { legs, matched: false };
  const { matchup, event, aIndex } = hit;
  const names = { aName: matchup.fighters[aIndex], bName: matchup.fighters[1 - aIndex] };
  const link = event?.url ?? null;
  // The board repeats a label on one row per book group; the rows merge, the first price a book posts for the label kept.
  const rows = new Map();
  for (const p of matchup.props ?? []) {
    const k = norm(p.label); const have = rows.get(k) ?? []; const seen = new Set(have.map((q) => q.bookId));
    rows.set(k, [...have, ...(p.quotes ?? []).filter((q) => !seen.has(q.bookId))]);
  }
  const toQuotes = (list) => (list ?? []).filter((q) => SPORTSBOOKS[q.bookId] && Number.isFinite(q.american)).map((q) => ({ bookId: q.bookId, book: SPORTSBOOKS[q.bookId]?.name ?? q.book, american: q.american, decimal: americanToDecimal(q.american), link, source: 'bestfightodds' })).sort((x, y) => y.american - x.american);
  let priced = 0;
  const out = legs.map((leg) => {
    const labels = boardLabelsFor(leg, names);
    if (!labels) return leg.priced ? leg : { ...leg, note: BOARD_NOTE };
    let quotes = [];
    for (const l of labels) {
      if (typeof l === 'object') { const idx = l.fighter === 'a' ? aIndex : 1 - aIndex; quotes = toQuotes(matchup.moneyline?.[idx]); }
      else quotes = toQuotes(rows.get(norm(l)));
      if (quotes.length) break;
    }
    if (!quotes.length) return leg.priced ? leg : { ...leg, note: BOARD_NOTE };
    const have = new Set((leg.quotes ?? []).map((q) => q.bookId));
    const merged = [...(leg.quotes ?? []).filter((q) => q.bookId !== 'engine'), ...quotes.filter((q) => !have.has(q.bookId))].sort((x, y) => y.american - x.american);
    priced++;
    return { ...leg, quotes: merged, priced: true, note: null, boardRow: typeof labels[0] === 'string' ? labels[0] : null };
  });
  return { legs: out, matched: true, priced };
}
