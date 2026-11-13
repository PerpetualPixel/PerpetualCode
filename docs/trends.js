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
/** A row from an alternate market (the label ends in "(alt)"). */
export const isAltLine = (row) => /\(alt\)\s*$/i.test(row?.marketLabel ?? '');

export function extractTrendLines(eventOdds, game, markets, { isRegistryBook = () => true, normalizeName = (n) => String(n ?? '').toLowerCase().trim() } = {}) {
  const pool = new Map();
  for (const book of eventOdds?.bookmakers ?? []) {
    if (!isRegistryBook(book.key)) continue;
    for (const market of book.markets ?? []) {
      const spec = markets[market.key];
      if (!spec) continue;
      // The feed prices every PrizePicks projection at the same flat
      // number, which is right for a standard projection (the Power Play
      // table pays it) and wrong for an alternate one: on PrizePicks an
      // alternate number is a goblin or demon with its own multiplier
      // the feed does not carry, so those are not quoted at all.
      if (book.key === 'prizepicks' && /_alternate$/.test(market.key)) continue;
      for (const outcome of market.outcomes ?? []) {
        let side; let playerName; let point;
        if (spec.yesNo) {
          // A yes-or-no prop (anytime touchdown, first basket): "Yes" on a player reads as Over 0.5, "No" as Under; a feed that names the player as the outcome, with no description, is a Yes.
          const nm = String(outcome.name ?? '').toLowerCase();
          if (nm === 'yes' || nm === 'no') { side = nm === 'yes' ? 'over' : 'under'; playerName = outcome.description ?? ''; }
          else { side = 'over'; playerName = outcome.description ?? outcome.name ?? ''; }
          point = 0.5;
        } else {
          side = String(outcome.name ?? '').toLowerCase();
          if (side !== 'over' && side !== 'under') continue;
          playerName = outcome.description ?? '';
          point = Number(outcome.point);
        }
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
            yesNo: Boolean(spec.yesNo), noLog: Boolean(spec.noLog),
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
      yesNo: Boolean(line.yesNo),
      selection: line.yesNo ? `${line.playerName} ${side === 'over' ? '' : 'No '}${line.marketLabel}` : `${line.playerName} ${side === 'over' ? 'Over' : 'Under'} ${line.point} ${line.statLabel}`,
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
 * Rows for a market with no stat behind it (2026-11-08 direction: first
 * basket, and the first basket on the team, in the Parlay Builder,
 * ranked by how likely they are): the chance is the market's own, read
 * off the best price and normalized across the field, every player
 * priced in the game for the first basket and every player on the side
 * for the team's, so the favorite reads as the likeliest and the stars
 * rank the field (legScore). Over only: no book hangs a "No" on these.
 */
export function chanceRowsFor(lines, { byTeam = false } = {}) {
  const groups = new Map();
  for (const line of lines ?? []) {
    if (!line?.over?.length) continue;
    const k = `${line.eventId}|${line.statKey}|${byTeam ? line.team ?? '?' : ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(line);
  }
  const out = [];
  for (const group of groups.values()) {
    const implied = group.map((l) => { const best = sortQuotes(l.over)[0]; return best && best.decimal > 1 ? 1 / best.decimal : 0; });
    const total = implied.reduce((s, q) => s + q, 0);
    if (!(total > 0)) continue;
    const probs = implied.map((q) => q / total);
    const top = Math.max(...probs);
    const order = probs.map((p, i) => i).sort((a, b) => probs[b] - probs[a]);
    const rank = new Map(order.map((i, r) => [i, r + 1]));
    group.forEach((line, i) => {
      const quotes = sortQuotes(line.over);
      const best = quotes[0];
      out.push({
        id: `${line.id}:over`, eventId: line.eventId, sportKey: line.sportKey, sportTitle: line.sportTitle, commenceMs: line.commenceMs, home: line.home, away: line.away,
        playerName: line.playerName, team: line.team ?? null, opponent: line.opponent ?? null, athleteId: line.athleteId ?? null, headshot: line.headshot ?? null,
        statKey: line.statKey, statLabel: line.statLabel, marketLabel: line.marketLabel, point: 0.5, side: 'over', yesNo: true,
        selection: `${line.playerName} ${line.marketLabel}`,
        american: best.american, decimal: best.decimal, book: best.book, bookKey: best.bookKey, quotes, bookCount: line.bookCount ?? quotes.length,
        games: 0, seasons: [], rates: {}, periods: {}, streak: null, series: [],
        prob: Math.round(probs[i] * 1000) / 1000, favoriteProb: Math.round(top * 1000) / 1000, fieldRank: rank.get(i), fieldSize: group.length,
      });
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
/** The quotes best price first: the longest decimal (the most back per dollar), with American odds as the tie-break and fallback. */
export function sortQuotes(quotes) {
  const dec = (q) => (Number.isFinite(q?.decimal) ? q.decimal : Number.isFinite(q?.american) ? americanToDecimalLoose(q.american) : 0);
  return [...(quotes ?? [])].filter(Boolean).sort((a, b) => dec(b) - dec(a) || (b.american ?? 0) - (a.american ?? 0));
}
const americanToDecimalLoose = (a) => (a >= 100 ? 1 + a / 100 : a <= -100 ? 1 + 100 / -a : 0);
/** The best price on offer: the first of sortQuotes, or null. */
export const bestQuote = (quotes) => sortQuotes(quotes)[0] ?? null;

export function sortTrends(rows, { window = 'l10', by = 'hitRate', dir = 'desc' } = {}) {
  const sign = dir === 'asc' ? -1 : 1;
  // A chance row (first basket) sorts by its market chance, so it keeps a place on a capped board.
  const rate = (r) => (Number.isFinite(r.rates?.[window]) ? r.rates[window] : Number.isFinite(r.prob) ? r.prob : null);
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

/**
 * The Parlay Builder's score for a line, 0 to 5 stars: the hit rate over
 * the last 5, 10 and 20 games and the season, head to head when there is
 * any, the current streak, and the injury report. Thin samples count
 * less. The same number on the worker and in the app.
 */
export function legScore(row, injury = row?.injury ?? null) {
  if (row?.yesNo && Number.isFinite(row?.prob)) {
    // A chance row (first basket): the stars rank the field, the favorite at five, a player half as likely at two and a half.
    let score = (5 * row.prob) / (row.favoriteProb || row.prob);
    if (injury?.level === 'out') score = 0;
    else if (injury?.level === 'questionable') score -= 1;
    return Math.max(0, Math.min(5, Math.round(score * 10) / 10));
  }
  const p = row?.periods ?? {};
  const rate = (k) => (Number.isFinite(p[k]?.rate) ? p[k].rate : null);
  const seasonKey = row?.seasons?.[0] ? `s${row.seasons[0]}` : null;
  const parts = [[rate('l5'), 0.25], [rate('l10'), 0.3], [rate('l20'), 0.25], [seasonKey ? rate(seasonKey) : null, 0.2]].filter(([r]) => r !== null);
  if (!parts.length) return 0;
  const weight = parts.reduce((s, [, w]) => s + w, 0);
  let score = (parts.reduce((s, [r, w]) => s + r * w, 0) / weight) * 5;
  const h2h = p.h2h;
  if (h2h?.games >= 2) score += h2h.rate === 1 ? 0.3 : h2h.rate < 0.5 ? -0.6 : 0;
  if (Number.isFinite(row?.streak)) score += Math.min(0.3, row.streak * 0.03);
  if ((p.l20?.games ?? 0) < 5) score *= 0.6;
  else if ((p.l20?.games ?? 0) < 10) score *= 0.85;
  if (injury?.level === 'out') score = 0;
  else if (injury?.level === 'questionable') score -= 0.5;
  return Math.max(0, Math.min(5, Math.round(score * 10) / 10));
}

/**
 * A live line's pace the way PrizePicks' Pulse shows it (2026-11-13: "for
 * live plays have the lines calculate pace % like PrizePicks does"): the
 * target pace is the line times the share of the game played, what the
 * player should have by now to land exactly on his number, and the pace
 * is what he has over that. 12.5 a third of the way in is a target of 4.2,
 * and 5 on the board is 119%. `level` is ahead at 100%+, near from 85%,
 * behind under it. Null before the game has a clock or without a line.
 */
export const PACE_NEAR = 85;
export function livePace(current, point, elapsed) {
  if (![current, point, elapsed].every(Number.isFinite) || point <= 0 || elapsed <= 0) return null;
  const target = point * Math.min(1, elapsed);
  const pct = Math.round((current / target) * 100);
  return { target: Math.round(target * 10) / 10, pct, level: pct >= 100 ? 'ahead' : pct >= PACE_NEAR ? 'near' : 'behind' };
}

/**
 * A suggested stake in units from how likely a play is (2026-11-12
 * direction: "size them by confidence; the higher the confidence or the
 * likelier the play wins, more units"): by the chance when a model gives
 * one (tennis, UFC), else by the Pixel score. Half a unit to two.
 */
export function suggestedUnits({ score = null, prob = null } = {}) {
  if (Number.isFinite(prob)) return prob >= 0.8 ? 2 : prob >= 0.7 ? 1.5 : prob >= 0.6 ? 1 : 0.5;
  if (!Number.isFinite(score)) return 0.5;
  return score >= 4.7 ? 2 : score >= 4.2 ? 1.5 : score >= 3.5 ? 1 : 0.5;
}

/**
 * How likely a league line is to land, for sizing a suggested stake: the
 * last-20 hit rate pulled toward the price's own chance, as if the price
 * were five more games. A 12-of-14 line at -105 reads about 77%; a line
 * with no log reads as its price. Null with neither a log nor a price.
 */
export function winLikelihood({ hits = 0, games = 0, american = null } = {}) {
  const implied = Number.isFinite(american) && american !== 0 ? (american > 0 ? 100 / (american + 100) : -american / (-american + 100)) : null;
  const n = Number.isFinite(games) && games > 0 ? games : 0;
  if (implied === null) return n ? hits / n : null;
  return ((n ? hits : 0) + 5 * implied) / (n + 5);
}

/** PrizePicks Power Play multipliers by lineup size; a sportsbook parlay multiplies its legs. */
export const PICKEM_POWER = { 2: 3, 3: 5, 4: 10, 5: 20, 6: 25 };
export function parlayDecimal(decimals, { pickem = false } = {}) {
  if (!decimals.length) return null;
  if (pickem) return PICKEM_POWER[decimals.length] ?? null;
  return decimals.reduce((d, x) => d * x, 1);
}
