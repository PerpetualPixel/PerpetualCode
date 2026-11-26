/**
 * The Live tab's custom parlay (2026-11-26, the owner: "a Custom Parlay
 * Builder mode. This mode allows users to view live player props (ordered
 * by their likelihood/pace to complete) and check boxes to build a custom
 * parlay for a specific, single sportsbook ... Users cannot mix and match
 * legs from different books").
 *
 * The board builds a slip a game at each book. Here the legs those slips
 * are drawn from are listed one a row, at one sportsbook, the furthest
 * ahead of pace first, and the reader ticks the ones to put on one ticket.
 *
 * Pure and shared: the worker cuts a game's legs down to one book's
 * (builderLegs, worker/src/live-board.js), and the app lists them, keeps
 * the ticked ones and prices the ticket (docs/app.js).
 */
import { americanToDecimal, decimalToAmerican } from './engine.js';
import { livePace, parlayDecimal } from './trends.js';

/** The most legs of one game the worker sends for a book. */
export const BUILDER_GAME_LEGS = 30;
/** The fewest legs a parlay has. */
export const BUILDER_MIN_LEGS = 2;
/** The most legs one ticket takes when a book has no limit of its own listed. */
export const BUILDER_MAX_LEGS = 20;

const low = (s) => String(s ?? '').toLowerCase().trim();
/** The line a leg is on: one player on one stat. A book takes one number of it on a ticket. */
export const legLine = (l) => `${low(l?.player)}|${low(l?.stat ?? l?.label)}`;
/** A leg's name on the board: its game, its line and its number. */
export const legId = (gameId, l) => `${gameId}|${legLine(l)}|${l?.point}`;

/**
 * One book's legs of a game, from the game's candidates (every leg that
 * clears the board's bar at every book): one row a player, stat and number
 * at the book's best price for it, the widest cushion first.
 */
export function builderLegs(candidates, bookId, { limit = BUILDER_GAME_LEGS } = {}) {
  if (!bookId) return [];
  const best = new Map();
  for (const c of candidates ?? []) {
    if (!c || c.bookId !== bookId || !Number.isFinite(c.point) || !Number.isFinite(c.price) || !Number.isFinite(c.current) || !c.player) continue;
    const key = `${legLine(c)}|${c.point}`;
    const had = best.get(key);
    if (!had || c.price > had.price) best.set(key, c);
  }
  return [...best.values()]
    .sort((a, b) => (Number(b.cushion) || 0) - (Number(a.cushion) || 0) || b.price - a.price)
    .slice(0, limit)
    .map((c) => ({ bookId: c.bookId, book: c.book ?? c.bookId, player: c.player, team: c.team ?? null, stat: c.stat ?? null, label: c.label ?? c.stat ?? '', point: c.point, price: c.price, current: c.current, pace: c.pace ?? null, cushion: c.cushion ?? null, link: c.link ?? null }));
}

/**
 * The board at one book: every in-play game's legs there, each with its
 * game and its pace (docs/trends.js livePace: what the player has against
 * what the line needs by this point of the game), the furthest ahead first.
 */
export function boardLegs(games, bookId) {
  const rows = [];
  for (const g of games ?? []) {
    if (g?.tick?.state !== 'in') continue;
    for (const l of g.legs ?? []) {
      if (!l || l.bookId !== bookId || !Number.isFinite(l.point) || !Number.isFinite(l.price)) continue;
      const pace = livePace(l.current, l.point, g.elapsed);
      rows.push({ ...l, id: legId(g.espnEventId, l), gameId: g.espnEventId, game: g.name ?? '', league: g.league ?? null, elapsed: g.elapsed ?? null, clock: g.tick?.detail ?? null, pacePct: pace?.pct ?? null, paceLevel: pace?.level ?? null, decimal: americanToDecimal(l.price) });
    }
  }
  const pct = (r) => (Number.isFinite(r.pacePct) ? r.pacePct : -Infinity);
  return rows.sort((a, b) => pct(b) - pct(a) || (Number(b.cushion) || 0) - (Number(a.cushion) || 0) || b.price - a.price || low(a.player).localeCompare(low(b.player)));
}

/** Two legs on the same line of the same game: a ticket takes one of them. */
export const sameLine = (a, b) => Boolean(a && b) && a.gameId === b.gameId && legLine(a) === legLine(b);

/**
 * The board with the reader's ticks on it.
 *
 * `picked` is the ticked legs as they were when ticked, in the order
 * ticked. A ticked leg still on the board is read at its numbers now; one
 * the board no longer has (the player got there, or the book took the line
 * down) is kept on the list marked `gone`, off the price and off the link.
 *
 * Returns {rows, chosen, live, price, sameGame, full}: every board row with
 * `checked` and `blocked` ('line' when another number of the same player
 * and stat is ticked, 'full' when the ticket holds all it can); the ticked
 * legs; the ones still on the board; the ticket's price with the legs
 * multiplied (a pick'em app's own table for a lineup), null under two
 * legs; and whether two of them are from one game.
 */
export function builderView(board, picked, { maxLegs = BUILDER_MAX_LEGS, pickem = false } = {}) {
  const byId = new Map((board ?? []).map((r) => [r.id, r]));
  const chosen = (picked ?? []).map((p) => (byId.has(p.id) ? { ...byId.get(p.id), gone: false } : { ...p, gone: true }));
  const live = chosen.filter((c) => !c.gone);
  const full = live.length >= maxLegs;
  const ticked = new Set(live.map((c) => c.id));
  const rows = (board ?? []).map((r) => {
    const checked = ticked.has(r.id);
    const blocked = checked ? null : live.some((c) => sameLine(c, r)) ? 'line' : full ? 'full' : null;
    return { ...r, checked, blocked };
  });
  const decimal = live.length >= BUILDER_MIN_LEGS ? parlayDecimal(live.map((l) => l.decimal ?? americanToDecimal(l.price)), { pickem }) : null;
  const price = Number.isFinite(decimal) && decimal > 1 ? { decimal: Math.round(decimal * 10000) / 10000, american: decimalToAmerican(decimal) } : null;
  const sameGame = new Set(live.map((l) => l.gameId)).size < live.length;
  return { rows, chosen, live, price, sameGame, full };
}

/**
 * The ticks after a tap on a row: ticked comes off; unticked goes on,
 * unless another number of its line is ticked or the ticket is full (the
 * ticks are returned as they were). Legs the board no longer has do not
 * count against either.
 */
export function toggleLeg(picked, row, board, { maxLegs = BUILDER_MAX_LEGS } = {}) {
  const list = picked ?? [];
  if (!row?.id) return list;
  if (list.some((p) => p.id === row.id)) return list.filter((p) => p.id !== row.id);
  const onBoard = new Set((board ?? []).map((r) => r.id));
  const live = list.filter((p) => onBoard.has(p.id));
  if (live.some((p) => sameLine(p, row)) || live.length >= maxLegs) return list;
  // A number of the same line that has left the board gives way to the one now ticked.
  return [...list.filter((p) => !sameLine(p, row)), { id: row.id, gameId: row.gameId, game: row.game ?? '', bookId: row.bookId, player: row.player, team: row.team ?? null, stat: row.stat ?? null, label: row.label ?? '', point: row.point, price: row.price }];
}
