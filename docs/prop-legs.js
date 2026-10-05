/**
 * Player-prop legs for the boards' tickets (docs/tickets.js) — the pure,
 * sport-agnostic part shared by worker/src/football-props.js (NFL) and
 * worker/src/basketball-props.js (WNBA, NBA).
 *
 * A prop leg is an ALTERNATE line checked against the player's real game
 * log: how often the player has cleared this exact number this season and
 * over the last five games, shrunk toward the price's own implied
 * probability (the Prop Play's propEdge), and required to beat it by the
 * edge floor. The leg's probability IS that shrunk hit rate — the claim the
 * ticket makes about itself — and its grade is the blend of the two rates
 * on the board's 0-100 scale.
 */

import { decimalToAmerican } from './engine.js';

/**
 * The price band a prop line may be a leg at: -650 to +100. The deep end
 * (-650..-200) is the anchor the direction describes — "10+ points when
 * they average 15 to 20" — and pays too little past -650 even inside a
 * ticket. The light end lets a line like "10+ rushing yards at -132" be a
 * partner, or a straight play on its own, exactly as the winning slips
 * carried it; past +100 it is no longer a comfort-zone line at all.
 */
export const PROP_LEG_DECIMAL = { MIN: 1 + 100 / 650, MAX: 2.0 };

/**
 * The edge a prop leg's shrunk hit rate must hold over its price. Same
 * number and reasoning as the Prop Play's PROP_MIN_EDGE: a -650 line
 * implies 86.7%, and a player at 75% passes every hit-rate gate while
 * paying thirteen cents on the dollar to take it.
 */
export const PROP_MIN_EDGE = 0.04;

/** Pseudo-games the measured hit rate is shrunk toward the price with — a short sample is evidence, not the truth. */
export const PROP_PRIOR_GAMES = 10;

/** The first value that wins an Over on `point`: .5 lines round up, integer lines must be beaten. */
export function needFor(point) {
  return Number.isInteger(point) ? point + 1 : Math.ceil(point);
}

/**
 * Hit-rate profile of `values` (most recent first) against `need`. Same
 * shape the Prop Play stores and quotes: season and recent rates, the
 * current streak, and the averages the write-up puts next to the line.
 */
export function hitProfile(values, need) {
  if (!values?.length) return null;
  const hits = (list) => list.filter((v) => v >= need).length;
  const rate = (n) => { const slice = values.slice(0, n); return slice.length ? hits(slice) / slice.length : 0; };
  let streak = 0;
  for (const v of values) { if (v >= need) streak++; else break; }
  const avg = (list) => list.reduce((s, v) => s + v, 0) / list.length;
  return {
    games: values.length,
    season: hits(values) / values.length,
    l10: rate(10),
    l5: rate(5),
    streak,
    avgSeason: Math.round(avg(values) * 10) / 10,
    avgL5: Math.round(avg(values.slice(0, 5)) * 10) / 10,
  };
}

/**
 * A prop leg's edge over its own price: the blended season/last-five hit
 * rate, shrunk toward the implied probability by PROP_PRIOR_GAMES, minus
 * that implied probability. Null when the profile can't state a rate.
 */
export function propEdge(profile, decimal) {
  if (!profile || !Number.isFinite(profile.season) || !Number.isFinite(profile.l5)) return null;
  if (!(decimal > 1)) return null;
  const implied = 1 / decimal;
  const blended = 0.5 * profile.season + 0.5 * profile.l5;
  const n = Number(profile.games) || 0;
  const shrunk = (blended * n + implied * PROP_PRIOR_GAMES) / (n + PROP_PRIOR_GAMES);
  return Math.round((shrunk - implied) * 1e4) / 1e4;
}

/** Whether a profile clears a sport's conviction gates ({ MIN_GAMES, MIN_SEASON_RATE, MIN_L5_RATE }). */
export function clearsPropGates(profile, gates) {
  return Boolean(profile)
    && profile.games >= gates.MIN_GAMES
    && profile.season >= gates.MIN_SEASON_RATE
    && profile.l5 >= gates.MIN_L5_RATE;
}

/**
 * A candidate line with its game-log profile attached, or null when the
 * gates or the edge floor say no. `consensusProb` is the shrunk blended
 * hit rate; `ev` the leg's expected value at its price under that rate.
 */
export function propLegFrom(candidate, values, gates) {
  const profile = hitProfile(values, candidate.need);
  if (!clearsPropGates(profile, gates)) return null;
  const edge = propEdge(profile, candidate.decimal);
  if (!(edge >= PROP_MIN_EDGE)) return null;
  const implied = 1 / candidate.decimal;
  const consensusProb = Math.min(0.97, implied + edge);
  const ev = consensusProb * (candidate.decimal - 1) - (1 - consensusProb);
  return {
    ...candidate,
    profile,
    edge,
    consensusProb: Math.round(consensusProb * 1e4) / 1e4,
    fairAmerican: decimalToAmerican(1 / consensusProb),
    ev: Math.round(ev * 1e4) / 1e4,
    score: Math.min(95, Math.round(100 * (0.5 * profile.season + 0.5 * profile.l5))),
  };
}

/**
 * Grade one prop leg against the player's final stat row. No row at all
 * means the player recorded nothing in any category — did not play — and
 * the leg voids, as a book would. A row without this stat is a real zero
 * and grades. An integer line landed on exactly pushes.
 */
export function gradePropLeg(leg, row) {
  if (!row) return { void: true, reason: 'player not in the final boxscore — did not play' };
  const actual = Number.isFinite(row[leg.statKey]) ? row[leg.statKey] : 0;
  if (Number.isInteger(leg.point) && actual === leg.point) return { void: true, reason: 'push — landed exactly on the line', actual };
  return { won: actual >= leg.need, actual };
}

/**
 * Safe-band Over alternates from one game's per-event odds payload, for
 * the markets in `markets` ({ [marketKey]: { stat, label, marketLabel } }),
 * one candidate per player + market + line with its quotes across books.
 * The best price must be at a registry (bettable) book — `isRegistryBook`
 * decides — and at least `minBooks` books must price the line, so one
 * book's stale alternate never becomes an anchor.
 */
export function extractAltCandidates(eventOdds, game, markets, { now = Date.now(), minBooks = 2, isRegistryBook = () => true, normalizeName = (n) => String(n ?? '').toLowerCase().trim() } = {}) {
  if (!Number.isFinite(game?.commenceMs) || game.commenceMs <= now) return [];
  const pool = new Map();
  for (const book of eventOdds?.bookmakers ?? []) {
    for (const market of book.markets ?? []) {
      const spec = markets[market.key];
      if (!spec) continue;
      const updatedMs = new Date(market.last_update ?? book.last_update ?? game.commenceMs).getTime();
      for (const outcome of market.outcomes ?? []) {
        if (String(outcome.name ?? '').toLowerCase() !== 'over') continue;
        const playerName = outcome.description ?? '';
        const point = Number(outcome.point);
        const american = Number(outcome.price);
        if (!playerName || !Number.isFinite(point) || !Number.isFinite(american)) continue;
        const decimal = american > 0 ? 1 + american / 100 : 1 + 100 / -american;
        if (decimal < PROP_LEG_DECIMAL.MIN || decimal > PROP_LEG_DECIMAL.MAX) continue;
        const key = `${market.key}|${normalizeName(playerName)}|${point}`;
        if (!pool.has(key)) pool.set(key, { marketKey: market.key, spec, playerName, point, quotes: [] });
        pool.get(key).quotes.push({
          book: book.title ?? book.key, bookKey: book.key, american, decimal,
          updatedMs: Number.isFinite(updatedMs) ? updatedMs : now,
        });
      }
    }
  }
  const candidates = [];
  for (const entry of pool.values()) {
    if (entry.quotes.length < minBooks) continue;
    const registry = entry.quotes.filter((q) => isRegistryBook(q.bookKey));
    if (!registry.length) continue;
    const best = registry.reduce((a, b) => (b.decimal > a.decimal ? b : a));
    const need = needFor(entry.point);
    candidates.push({
      id: `${game.eventId}:${entry.marketKey}:${normalizeName(entry.playerName)}:${entry.point}:Over`,
      kind: 'prop',
      eventId: game.eventId,
      sportKey: game.sportKey,
      sportTitle: game.sportTitle,
      commenceMs: game.commenceMs,
      home: game.home,
      away: game.away,
      marketKey: entry.marketKey,
      marketLabel: entry.spec.marketLabel,
      statKey: entry.spec.stat,
      playerName: entry.playerName,
      outcomeName: 'Over',
      point: entry.point,
      need,
      selection: `${entry.playerName} ${need}+ ${entry.spec.label}`,
      american: best.american,
      decimal: best.decimal,
      book: best.book,
      bookKey: best.bookKey,
      bettable: true,
      updatedMs: best.updatedMs,
      bookCount: entry.quotes.length,
      quotes: [...entry.quotes].sort((a, b) => b.decimal - a.decimal),
    });
  }
  return candidates;
}
