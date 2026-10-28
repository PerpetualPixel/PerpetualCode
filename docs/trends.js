/**
 * Trends — every player-prop line on the week's games, with the player's
 * real hit rate at that exact number over the last 5, 10 and 20 games,
 * each season, and head-to-head against this opponent, plus the per-game
 * values a bar chart draws and every book's price on the line. The
 * research view the prop tools lead with: pick a period, a sort and your
 * filters, and the lines a player clears most often float to the top.
 *
 * Pure: the worker (worker/src/trends.js) feeds it per-event odds and ESPN
 * game logs and stores the rows; the browser (docs/app.js) sorts, filters
 * and draws them. Shared by both the way docs/engine.js is, and testable
 * on its own.
 */

import { decimalToAmerican } from './engine.js';

/** The periods a hit rate is read over. Season keys are added per row ('s2026', 's2025'); 'h2h' is this opponent. */
export const TREND_WINDOWS = ['l5', 'l10', 'l20'];
/** How many of the most recent games a row carries for its chart and log. */
export const SERIES_LENGTH = 20;
/** How many books a side keeps, best price first. */
export const MAX_QUOTES = 8;

/** The first value that wins an Over on `point`, and the last that wins an Under. */
export const overNeed = (point) => (Number.isInteger(point) ? point + 1 : Math.ceil(point));
export const underNeed = (point) => (Number.isInteger(point) ? point - 1 : Math.floor(point));

/**
 * Every priced line from one game's per-event odds payload, both sides,
 * one entry per player + market + number: every registry book's price for
 * Over and for Under, best first, and how many books price the line.
 * `markets` is { [marketKey]: { stat, label, marketLabel } }.
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
            over: [], under: [], books: new Set(),
          });
        }
        const entry = pool.get(key);
        entry.books.add(book.key);
        // The feed's deep link for this exact line at this book, when the
        // book supports one (The Odds API's includeLinks): opens the book
        // with the line on the slip. Outcome, then market, then the book.
        const link = outcome.link ?? market.link ?? book.link ?? null;
        const quote = { american, decimal, book: book.title ?? book.key, bookKey: book.key, link };
        const list = entry[side];
        const i = list.findIndex((q) => q.bookKey === book.key);
        if (i < 0) list.push(quote); else if (decimal > list[i].decimal) list[i] = quote;
      }
    }
  }
  return [...pool.values()].map((e) => ({
    ...e,
    over: e.over.length ? e.over.sort((a, b) => b.decimal - a.decimal).slice(0, MAX_QUOTES) : null,
    under: e.under.length ? e.under.sort((a, b) => b.decimal - a.decimal).slice(0, MAX_QUOTES) : null,
    bookCount: e.books.size,
    books: undefined,
  }));
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

/** Hits and games counted for a window ("3/5 events"). */
export function hitCount(flags, n = flags.length) {
  const slice = flags.slice(0, n).filter((f) => f !== null);
  return { hits: slice.reduce((s, f) => s + f, 0), games: slice.length };
}

const round1 = (v) => Math.round(v * 10) / 10;
export const mean = (values) => (values.length ? round1(values.reduce((s, v) => s + v, 0) / values.length) : null);
export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return round1(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

/** Period summary for one slice of rows: rate, count, average, median. */
function periodStats(rows, point, side) {
  const flags = hitFlags(rows, point, side);
  const values = rows.map((r) => r.value);
  const { hits, games } = hitCount(flags);
  return { rate: hitRate(flags), hits, games, avg: mean(values), median: median(values) };
}

/**
 * One trend row per side of a line. `rows` is the player's per-game stat
 * log, every season, most recent first (docs/prop-legs.js's
 * seasonColumnRows with allSeasons). `opponent` is the ESPN abbreviation
 * of the team the player faces in this game, for the head-to-head period.
 *
 * Each row carries: rates per period (l5, l10, l20, each season as
 * 's<year>', and h2h), with hits/games/avg/median for each; the last
 * SERIES_LENGTH games as bars with hit flags, opponent and final score;
 * every book's price on the side, best first; and the player's team and
 * headshot when the worker found them.
 */
export function trendRowsFor(line, rows, { opponent = null } = {}) {
  const recent = rows.slice(0, SERIES_LENGTH);
  const seasons = [...new Set(rows.map((r) => r.season).filter((y) => y > 0))].sort((a, b) => b - a);
  const out = [];
  for (const side of ['over', 'under']) {
    const quotes = line[side];
    if (!quotes?.length) continue;
    const flags = hitFlags(rows, line.point, side);
    const periods = {
      l5: periodStats(rows.slice(0, 5), line.point, side),
      l10: periodStats(rows.slice(0, 10), line.point, side),
      l20: periodStats(rows.slice(0, 20), line.point, side),
    };
    for (const y of seasons) periods[`s${y}`] = periodStats(rows.filter((r) => r.season === y), line.point, side);
    const h2hRows = opponent ? rows.filter((r) => r.opponent && r.opponent.toUpperCase() === opponent.toUpperCase()) : [];
    periods.h2h = h2hRows.length ? periodStats(h2hRows, line.point, side) : { rate: null, hits: 0, games: 0, avg: null, median: null };
    const best = quotes[0];
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
      opponent,
      athleteId: line.athleteId ?? null,
      headshot: line.headshot ?? null,
      statKey: line.statKey,
      statLabel: line.statLabel,
      marketLabel: line.marketLabel,
      point: line.point,
      side,
      selection: `${line.playerName} ${side === 'over' ? 'Over' : 'Under'} ${line.point} ${line.statLabel}`,
      american: best.american,
      decimal: best.decimal,
      book: best.book,
      bookKey: best.bookKey,
      quotes,
      bookCount: line.bookCount,
      games: rows.length,
      seasons,
      rates: Object.fromEntries(Object.entries(periods).map(([k, v]) => [k, v.rate])),
      periods,
      streak: flags.findIndex((f) => f === 0) < 0 ? flags.filter((f) => f !== null).length : flags.findIndex((f) => f === 0),
      series: recent.map((r, i) => ({ value: r.value, hit: flags[i], date: r.date, season: r.season, opponent: r.opponent, atVs: r.atVs, score: r.score, result: r.result })),
    });
  }
  return out;
}

/**
 * The stored shape shares one game series per player and stat instead
 * of repeating it on every line: a slate's thousands of lines are a few
 * hundred players' logs. detachSeries moves each row's series into
 * `logs` under the row's `logKey` (the hit flags go, they are the line's
 * and come back from the value); attachSeries puts it back, flags
 * recomputed for the row's point and side.
 */
export const logKeyFor = (row) => `${row.athleteId ?? row.playerName}:${row.statKey}`;

export function detachSeries(rows) {
  const logs = {};
  const slim = (rows ?? []).map((row) => {
    if (!Array.isArray(row.series)) return row;
    const { series, ...rest } = row;
    const logKey = logKeyFor(row);
    if (!logs[logKey]) logs[logKey] = series.map(({ hit, ...g }) => { void hit; return g; });
    return { ...rest, logKey };
  });
  return { rows: slim, logs };
}

export function attachSeries(rows, logs) {
  return (rows ?? []).map((row) => {
    if (Array.isArray(row.series)) return row;
    const games = logs?.[row.logKey ?? logKeyFor(row)];
    if (!Array.isArray(games)) return { ...row, series: [] };
    const flags = hitFlags(games, row.point, row.side);
    return { ...row, series: games.map((g, i) => ({ ...g, hit: flags[i] })) };
  });
}

/**
 * The NFL week (2026-10-28 direction: the NFL tab posts the whole week,
 * not two days). A week runs Tuesday to Monday, Eastern. nflWeekDates
 * lists the ET dates from today to the week's Monday; nflWeek numbers
 * the week from the season's first Tuesday, the day after Labor Day
 * (the season opens that Thursday), so 2026-10-28 is Week 8.
 */
const ET_TZ = 'America/New_York';
const DAY_MS = 864e5;
function etDateOf(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const noonOf = (date) => Date.parse(`${date}T12:00:00Z`);
export function nflWeekDates(now = Date.now()) {
  const today = noonOf(etDateOf(now));
  const weekday = new Date(today).getUTCDay();
  const count = ((2 - weekday + 7) % 7) || 7;
  return Array.from({ length: count }, (_, i) => new Date(today + i * DAY_MS).toISOString().slice(0, 10));
}
export function nflWeek(now = Date.now()) {
  const today = etDateOf(now);
  const year = Number(today.slice(0, 4));
  const seasonYear = Number(today.slice(5, 7)) >= 8 ? year : year - 1;
  const sep1 = noonOf(`${seasonYear}-09-01`);
  const laborDay = sep1 + ((1 - new Date(sep1).getUTCDay() + 7) % 7) * DAY_MS;
  return Math.floor((noonOf(today) - (laborDay + DAY_MS)) / (7 * DAY_MS)) + 1;
}

/**
 * Order rows for the board. `by` is 'hitRate' (in the chosen period),
 * 'odds' (price) or 'date' (kickoff); `dir` 'desc' (the default) or 'asc'.
 * Rows without a rate in the period sink to the bottom whichever way.
 */
export function sortTrends(rows, { window = 'l10', by = 'hitRate', dir = 'desc' } = {}) {
  const sign = dir === 'asc' ? -1 : 1;
  const rate = (r) => (Number.isFinite(r.rates?.[window]) ? r.rates[window] : null);
  return [...rows].sort((a, b) => {
    if (by === 'odds') return sign * ((b.decimal ?? 0) - (a.decimal ?? 0)) || ((rate(b) ?? -1) - (rate(a) ?? -1));
    if (by === 'date') return sign * ((a.commenceMs ?? 0) - (b.commenceMs ?? 0)) || ((rate(b) ?? -1) - (rate(a) ?? -1));
    const ra = rate(a); const rb = rate(b);
    if (ra === null && rb === null) return (b.decimal ?? 0) - (a.decimal ?? 0);
    if (ra === null) return 1;
    if (rb === null) return -1;
    return sign * (rb - ra) || ((b.periods?.[window]?.games ?? 0) - (a.periods?.[window]?.games ?? 0)) || ((b.decimal ?? 0) - (a.decimal ?? 0));
  });
}

/** A row's price as the card prints it. */
export const trendPrice = (row) => (Number.isFinite(row.american) ? row.american : decimalToAmerican(row.decimal));
