/**
 * A ticket at every book (2026-11-25, the owner, of a reader who has
 * neither of the two books the tickets named: "provide alternate books,
 * even if the lines are lower but never higher, and if it's not on the
 * books, it will drop the line ... also offer playbook links to copy
 * ... All possible books should be provided for pixel picks and the MVP
 * players").
 *
 * A Pixel's Pick or an MVP pick is drawn at one book, at the numbers that
 * book prices. This takes the same legs to every other book the feed
 * prices: a leg stands at the book's price on the same number when it
 * has one (the leg's own quotes), else at the nearest EASIER number the
 * book posts on the board (a lower Over, a higher Under; the Trends rows
 * carry every book's numbers), and never a harder one. A leg the book
 * prices at no usable number is dropped from that book's version, and
 * said so. Each version carries its legs with that book's links, what
 * moved and what was dropped, and its price with the legs multiplied, so
 * a reader can add it at their book or hand the lines to Playbook
 * (docs/playbook.js) for a slip there.
 *
 * Pure and shared: the worker computes a ticket's versions when it posts
 * (worker/src/trend-picks.js, worker/src/mvp-picks.js), and the app
 * draws them (docs/app.js) — or, for a ticket stored before this
 * existed, computes them from the legs' own quotes alone.
 */
import { bookIdFor, SPORTSBOOKS, americanToDecimal } from './engine.js';

/** Pick'em apps price every projection at one flat number: a ticket there is a lineup at its own payout, not a parlay at these numbers. */
export const LINEUP_BOOKS = ['prizepicks', 'underdog', 'sleeper'];
const EXTRA_NAMES = { prizepicks: 'PrizePicks', sleeper: 'Sleeper', underdog: 'Underdog' };

export const bookIdOf = (key) => bookIdFor(key) ?? (String(key ?? '').toLowerCase() || null);
export const bookNameOf = (id) => SPORTSBOOKS[id]?.name ?? EXTRA_NAMES[id] ?? String(id ?? '');
export const toAmerican = (decimal) => (decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1)));
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const round4 = (x) => Math.round(x * 10000) / 10000;

/** A quote's registry book id: as stored, else from the feed's key. */
const idOfQuote = (q) => q.bookId ?? bookIdOf(q.bookKey);
/** The book's quote on a list, when it has a price. */
const quoteAt = (quotes, bookId) => (quotes ?? []).find((q) => idOfQuote(q) === bookId && Number.isFinite(q.american)) ?? null;
/** The same player, stat and game as the leg: the board's row is the same line at another number. */
const sameLine = (row, leg) => row && leg && row.statKey === leg.statKey && fold(row.playerName) === fold(leg.playerName)
  && (!row.eventId || !leg.eventId || String(row.eventId) === String(leg.eventId)) && (!row.sportKey || !leg.sportKey || row.sportKey === leg.sportKey);
/** No harder to land than the leg's number: the number itself, a lower Over (or "to record"), a higher Under. */
const noHarder = (side, point, than) => point === than || (side === 'under' ? point > than : point < than);
const gameOf = (leg) => (leg?.away && leg?.home ? `${leg.away} @ ${leg.home}` : '');

/**
 * The leg at one book: its own number at that book's price when the book
 * prices it, else the nearest easier number the book prices on the board
 * (`rows`: the Trends rows for the leg's league), with that row's words
 * and link; null when the book has neither.
 */
export function legAtBook(leg, bookId, rows = []) {
  if (!leg || !bookId) return null;
  const own = quoteAt(leg.quotes, bookId);
  const keep = (point, selection, q, moved) => ({
    bookId, point, selection, american: q.american, decimal: round4(q.decimal ?? americanToDecimal(q.american)), link: q.link ?? null,
    moved, from: moved ? leg.point : null, playerName: leg.playerName ?? null, statKey: leg.statKey ?? null, statLabel: leg.statLabel ?? null, game: gameOf(leg), legId: leg.id ?? leg.selection ?? null,
  });
  if (own) return keep(leg.point, leg.selection, own, false);
  const side = leg.side ?? 'over';
  if (!Number.isFinite(leg.point)) return null;
  // The board: the same number at this book first (the leg's quotes may be a shorter list), else the nearest easier one.
  const options = (rows ?? [])
    .filter((r) => sameLine(r, leg) && (r.side ?? 'over') === side && Number.isFinite(r.point) && noHarder(side, r.point, leg.point))
    .map((r) => ({ row: r, quote: quoteAt(r.quotes, bookId) }))
    .filter((c) => c.quote)
    .sort((a, b) => (side === 'under' ? a.row.point - b.row.point : b.row.point - a.row.point)); // the nearest number first
  if (!options.length) return null;
  const { row, quote } = options[0];
  return keep(row.point, row.point === leg.point ? leg.selection : (row.selection ?? leg.selection), quote, row.point !== leg.point);
}

/**
 * The ticket at every other book that prices any of it: each book's
 * version with the legs it keeps (same number or an easier one), the
 * legs it drops, and the price of the kept legs multiplied. Complete
 * versions first, then the fewest dropped, then the best price. `exclude`
 * is the book the ticket is already at; `books` limits the list, else
 * every priced book in the legs' quotes and the board.
 */
export function ticketAtBooks(legs, rows = [], { exclude = null, books = null } = {}) {
  const list = (legs ?? []).filter((l) => l && l.selection);
  if (!list.length) return [];
  const seen = books ?? [...new Set([
    ...list.flatMap((l) => (l.quotes ?? []).map(idOfQuote)),
    ...(rows ?? []).filter((r) => list.some((l) => sameLine(r, l))).flatMap((r) => (r.quotes ?? []).map(idOfQuote)),
  ])];
  const ids = seen.filter((id) => id && id !== exclude && !LINEUP_BOOKS.includes(id) && !SPORTSBOOKS[id]?.noPrices);
  const out = [];
  for (const bookId of ids) {
    const at = list.map((leg) => ({ leg, at: legAtBook(leg, bookId, rows) }));
    const kept = at.filter((x) => x.at).map((x) => x.at);
    if (!kept.length) continue;
    const dropped = at.filter((x) => !x.at).map((x) => ({ selection: x.leg.selection, playerName: x.leg.playerName ?? null, legId: x.leg.id ?? x.leg.selection ?? null }));
    const decimal = round4(kept.reduce((d, l) => d * l.decimal, 1));
    // One leg is the book's own price; more are the legs multiplied (a same-game price at the book may differ).
    const american = kept.length === 1 ? kept[0].american : toAmerican(decimal);
    out.push({ bookId, book: bookNameOf(bookId), legs: kept, dropped, complete: dropped.length === 0, moved: kept.filter((l) => l.moved).length, decimal, american });
  }
  return out.sort((a, b) => (b.complete - a.complete) || (a.dropped.length - b.dropped.length) || (b.decimal - a.decimal));
}

/** A number as a line reads it: "15+" for Over 14.5 or to record 15, "under 15" for Under 15.5. */
export const lineWord = (point, side = 'over') => (side === 'under' ? `under ${Math.floor(point) === point ? point : Math.floor(point) + 1}` : `${Number.isInteger(point) ? point + 1 : Math.ceil(point)}+`);

/** What a book's version changes, in a phrase: the legs moved to an easier number and the legs left off; '' when it is the ticket as drawn. */
export function bookWayNote(way) {
  const last = (name) => String(name ?? '').trim().split(/\s+/).at(-1) ?? '';
  const moved = (way?.legs ?? []).filter((l) => l.moved).map((l) => `${last(l.playerName) || l.selection} ${l.statLabel ?? ''} ${lineWord(l.point)} instead of ${lineWord(l.from)}`.replace(/\s+/g, ' ').trim());
  const dropped = (way?.dropped ?? []).map((d) => d.selection);
  const parts = [];
  if (moved.length) parts.push(moved.join(', '));
  if (dropped.length) parts.push(`without ${dropped.join(' or ')}`);
  return parts.join(' · ');
}
