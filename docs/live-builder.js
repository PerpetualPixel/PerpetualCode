/**
 * The Live tab's custom parlay (2026-11-26, the owner: "a Custom Parlay
 * Builder mode. This mode allows users to view live player props (ordered
 * by their likelihood/pace to complete) and check boxes to build a custom
 * parlay for a specific, single sportsbook ... Users cannot mix and match
 * legs from different books").
 *
 * The board builds a slip a game at each book. Here every live line a
 * sportsbook has up is listed one a row, in the order the reader chooses,
 * and the reader ticks the ones to put on one ticket: one for a straight
 * bet, more for a parlay.
 *
 * It first listed only the legs the slips are drawn from. A user saw one
 * or two (2026-11-26, the owner: "show all legs. Not just good pacing
 * legs"), so it is every line now, the ones that clear the slips' bar
 * marked `pick`.
 *
 * Pure and shared: the worker lists a game's lines at one book
 * (worker/src/live-board.js bookLegs), and the app sorts them, keeps the
 * ticked ones and prices the ticket (docs/app.js).
 */
import { americanToDecimal, decimalToAmerican } from './engine.js';
import { livePace, parlayDecimal } from './trends.js';

/** The most legs of one game the worker sends for a book: every line a book has up, short of a list too long for a phone to draw. */
export const BUILDER_GAME_LEGS = 250;
/**
 * The fewest legs a ticket has: one, a straight bet (2026-11-26, the
 * owner: "remove the requirement to have two legs. This could be a
 * straight as well"). A pick'em lineup still starts at two.
 */
export const BUILDER_MIN_LEGS = 1;
export const PICKEM_MIN_LEGS = 2;
/** The most legs one ticket takes when a book has no limit of its own listed. */
export const BUILDER_MAX_LEGS = 20;

const low = (s) => String(s ?? '').toLowerCase().trim();
/** The line a leg is on: one player on one stat. A book takes one number of it on a ticket. */
export const legLine = (l) => `${low(l?.player)}|${low(l?.stat ?? l?.label)}`;
/** A leg's name on the board: its game, its line and its number. */
export const legId = (gameId, l) => `${gameId}|${legLine(l)}|${l?.point}`;

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
      rows.push({ ...l, id: legId(g.espnEventId, l), gameId: g.espnEventId, game: g.name ?? '', league: g.league ?? null, elapsed: g.elapsed ?? null, clock: g.tick?.detail ?? null, pacePct: pace?.pct ?? null, paceLevel: pace?.level ?? null, decimal: americanToDecimal(l.price), pick: l.pick === true, need: Number.isFinite(l.current) ? Math.max(0, l.point - l.current) : null });
    }
  }
  return sortBoard(rows, 'pace');
}

/**
 * The orders the board can be read in (2026-11-26, the owner: "since
 * we're showing all legs ... introduce a sorting button to sort them by
 * pace percentage and other things like odds"): [key, label].
 */
export const BOARD_SORTS = [
  ['pace', 'Pace %, highest first'],
  ['close', 'Closest to the number'],
  ['short', 'Shortest odds first'],
  ['long', 'Longest odds first'],
  ['pick', 'Our picks first'],
  ['player', 'Player, A to Z'],
];
/**
 * The board in one of those orders; an unknown key reads as pace. Ties
 * fall to pace, then the shorter price, then the player and the number,
 * so the order is the same every time it is drawn.
 */
export function sortBoard(rows, key = 'pace') {
  const pct = (r) => (Number.isFinite(r.pacePct) ? r.pacePct : -Infinity);
  // How much of the number is still to come: a yard short of 59.5 is closer than a catch short of 1.5.
  const left = (r) => (Number.isFinite(r.need) && r.point > 0 ? r.need / r.point : Infinity);
  const name = (a, b) => low(a.player).localeCompare(low(b.player)) || low(a.stat).localeCompare(low(b.stat)) || a.point - b.point;
  const base = (a, b) => pct(b) - pct(a) || a.price - b.price || name(a, b);
  const by = {
    pace: base,
    close: (a, b) => left(a) - left(b) || base(a, b),
    short: (a, b) => a.price - b.price || base(a, b),
    long: (a, b) => b.price - a.price || base(a, b),
    pick: (a, b) => Number(b.pick === true) - Number(a.pick === true) || base(a, b),
    player: (a, b) => name(a, b) || base(a, b),
  };
  return [...(rows ?? [])].sort(by[key] ?? by.pace);
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
export function builderView(board, picked, { maxLegs = BUILDER_MAX_LEGS, pickem = false, minLegs = pickem ? PICKEM_MIN_LEGS : BUILDER_MIN_LEGS } = {}) {
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
  // One leg is a straight at its own price; more are the legs multiplied (a pick'em lineup pays its table, from two).
  const decimal = live.length >= minLegs ? parlayDecimal(live.map((l) => l.decimal ?? americanToDecimal(l.price)), { pickem }) : null;
  const price = Number.isFinite(decimal) && decimal > 1 ? { decimal: Math.round(decimal * 10000) / 10000, american: live.length === 1 && !pickem ? live[0].price : decimalToAmerican(decimal) } : null;
  const sameGame = new Set(live.map((l) => l.gameId)).size < live.length;
  return { rows, chosen, live, price, sameGame, full, minLegs, ready: live.length >= minLegs };
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
