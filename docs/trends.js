/**
 * Trends — every player-prop line on today's games, with the player's real
 * hit rate at that exact number over the last 5, 10 and 20 games and the
 * season, and the per-game values a bar chart draws. The research view the
 * popular prop tools lead with: pick a league, a window and a sort, and
 * the lines a player clears most often float to the top.
 *
 * Pure: the worker (worker/src/trends.js) feeds it per-event odds and ESPN
 * game logs and stores the rows; the browser (docs/app.js) sorts, filters
 * and draws them. Shared by both the way docs/engine.js is, and testable
 * on its own.
 */

import { decimalToAmerican } from './engine.js';

/** The windows a hit rate is read over. 'season' is every logged game. */
export const TREND_WINDOWS = ['l5', 'l10', 'l20', 'season'];

/** The first value that wins an Over on `point`, and the last that wins an Under. */
export const overNeed = (point) => (Number.isInteger(point) ? point + 1 : Math.ceil(point));
export const underNeed = (point) => (Number.isInteger(point) ? point - 1 : Math.floor(point));

/**
 * Every priced line from one game's per-event odds payload, both sides,
 * one entry per player + market + number: the best registry price for
 * Over and for Under (with the book that posts it) and how many books
 * price the line. `markets` is { [marketKey]: { stat, label, marketLabel } }.
 */
export function extractTrendLines(eventOdds, game, markets, { isRegistryBook = () => true, normalizeName = (n) => String(n ?? '').toLowerCase().trim() } = {}) {
  const pool = new Map();
  for (const book of eventOdds?.bookmakers ?? []) {
    if (!isRegistryBook(book.key)) continue;
    for (const market of book.markets ?? []) {
      const spec = markets[market.key];
      if (!spec) continue;
      for (const outcome of market.outcomes ?? []) {
        const side = String(outcome.name ?? '').toLowerCase();
        if (side !== 'over' && side !== 'under') continue;
        const playerName = outcome.description ?? '';
        const point = Number(outcome.point);
        const american = Number(outcome.price);
        if (!playerName || !Number.isFinite(point) || !Number.isFinite(american)) continue;
        const decimal = american > 0 ? 1 + american / 100 : 1 + 100 / -american;
        const key = `${spec.stat}|${normalizeName(playerName)}|${point}`;
        if (!pool.has(key)) {
          pool.set(key, {
            id: `${game.eventId}:${spec.stat}:${normalizeName(playerName)}:${point}`,
            eventId: game.eventId, sportKey: game.sportKey, sportTitle: game.sportTitle,
            commenceMs: game.commenceMs, home: game.home, away: game.away,
            playerName, statKey: spec.stat, statLabel: spec.label, marketLabel: spec.marketLabel, point,
            over: null, under: null, books: new Set(),
          });
        }
        const entry = pool.get(key);
        entry.books.add(book.key);
        const quote = { american, decimal, book: book.title ?? book.key, bookKey: book.key };
        if (!entry[side] || decimal > entry[side].decimal) entry[side] = quote;
      }
    }
  }
  return [...pool.values()].map((e) => ({ ...e, bookCount: e.books.size, books: undefined }));
}

/**
 * Hit flags for a line over a list of per-game rows (most recent first):
 * 1 when the side landed, 0 when it missed, null on a push. `side` is
 * 'over' or 'under'.
 */
export function hitFlags(rows, point, side) {
  return rows.map(({ value }) => {
    if (Number.isInteger(point) && value === point) return null;
    return side === 'over' ? (value >= overNeed(point) ? 1 : 0) : (value <= underNeed(point) ? 1 : 0);
  });
}

/** Hit rate over the first `n` flags (null when nothing counts), pushes excluded. */
export function hitRate(flags, n = flags.length) {
  const slice = flags.slice(0, n).filter((f) => f !== null);
  if (!slice.length) return null;
  return Math.round((slice.reduce((s, f) => s + f, 0) / slice.length) * 1000) / 1000;
}

/**
 * One trend row per side of a line: the player's game rows (last 20,
 * most recent first), the hit flags, the hit rate per window, the
 * average, and the best price. `rows` is the player's per-game stat log
 * (docs/prop-legs.js's seasonColumnRows).
 */
export function trendRowsFor(line, rows) {
  const recent = rows.slice(0, 20);
  const avg = (list) => (list.length ? Math.round((list.reduce((s, r) => s + r.value, 0) / list.length) * 10) / 10 : null);
  const out = [];
  for (const side of ['over', 'under']) {
    const quote = line[side];
    if (!quote) continue;
    const flags = hitFlags(rows, line.point, side);
    out.push({
      id: `${line.id}:${side}`,
      eventId: line.eventId,
      sportKey: line.sportKey,
      sportTitle: line.sportTitle,
      commenceMs: line.commenceMs,
      home: line.home,
      away: line.away,
      playerName: line.playerName,
      team: line.team ?? null,
      statKey: line.statKey,
      statLabel: line.statLabel,
      marketLabel: line.marketLabel,
      point: line.point,
      side,
      selection: `${line.playerName} ${side === 'over' ? 'Over' : 'Under'} ${line.point} ${line.statLabel}`,
      american: quote.american,
      decimal: quote.decimal,
      book: quote.book,
      bookKey: quote.bookKey,
      bookCount: line.bookCount,
      games: rows.length,
      rates: { l5: hitRate(flags, 5), l10: hitRate(flags, 10), l20: hitRate(flags, 20), season: hitRate(flags) },
      avg: { l5: avg(rows.slice(0, 5)), l10: avg(rows.slice(0, 10)), season: avg(rows) },
      streak: flags.findIndex((f) => f === 0) < 0 ? flags.filter((f) => f !== null).length : flags.findIndex((f) => f === 0),
      series: recent.map((r, i) => ({ value: r.value, hit: flags[i], date: r.date, opponent: r.opponent, atVs: r.atVs })),
    });
  }
  return out;
}

/**
 * Order rows for the board: by hit rate in the chosen window (ties to the
 * better price, then the larger sample), or by price (heaviest favourite
 * first — the lines the books are surest of). Rows without a rate in the
 * window sink to the bottom.
 */
export function sortTrends(rows, { window = 'l10', by = 'hitRate' } = {}) {
  const w = TREND_WINDOWS.includes(window) ? window : 'l10';
  const rate = (r) => (Number.isFinite(r.rates?.[w]) ? r.rates[w] : -1);
  return [...rows].sort((a, b) => {
    if (by === 'odds') return (a.decimal - b.decimal) || (rate(b) - rate(a));
    return (rate(b) - rate(a)) || (b.decimal - a.decimal) || ((b.games ?? 0) - (a.games ?? 0));
  });
}

/** A row's price as the card prints it. */
export const trendPrice = (row) => (Number.isFinite(row.american) ? row.american : decimalToAmerican(row.decimal));
