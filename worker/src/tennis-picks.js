/**
 * The Tennis tab's plays (2026-11-06: "very picky ... aces, over games,
 * over in the first or second set, plus spreads for games and sets ...
 * WTA and ATP ... only display high conviction"). Every tick:
 *
 *   1. The card the runner wrote (scripts/tennis-card.mjs, KV tennis:card):
 *      today's and tomorrow's singles on both tours, and the results.
 *   2. The serve profiles the data runner wrote (scripts/tennis-data.mjs,
 *      KV tennis:profiles:<tour>): each player's serve and return numbers
 *      and ace rate from the match data.
 *   3. For each main-draw match still to come with both players profiled:
 *      the feed's board for the tournament (one call per tournament key,
 *      cached), the model (worker/src/tennis-model.js) fitted to the
 *      market's winner, and the shape of the match simulated from it.
 *   4. The plays: a leg clears only when the model gives it at least
 *      MIN_PROB and the price gives it at least MIN_EDGE less, inside the
 *      price band; the best one per match, a few per tour per day. The
 *      aces leg has no book market on the feed, so it posts the number the
 *      model clears at ACE_PROB with the price left to the user's book.
 *   5. Grading from the results' set scores (aces from the data runner's
 *      ace log once the match data lands), one unit a play.
 *
 * 2026-11-06, the second ask: "recent form ... play style matchup, surface
 * type, and possible injury and possible player fatigue ... at least one
 * play for tennis posted ... a 2 leg parlay or a 4 leg moneyline parlay
 * ... Max 5U in plays a day." So the winner is the model's own read first
 * (worker/src/tennis-form.js: the surface Elo and the serve simulation,
 * then the form gap, a heavy week, a recent retirement, rust and the style
 * on the surface), blended half and half with the market before the shape
 * is simulated; a player flagged for injury or fatigue is never the side
 * of a play; and once a day the clearest favourites (the blended share at
 * PARLAY_LEG_PROB or better, no flag) go into one moneyline parlay of two
 * to four legs at one book. The day's plays stop at MAX_UNITS_DAY units,
 * one unit kept for the parlay until it posts.
 *
 * Records live under tennis:picks:<ET date>, listed in tennis:picks:index.
 */
import { UPSTREAM, TREND_BOOKMAKERS, recordOddsDiag } from './odds.js';
import { bookIdFor, americanToDecimal } from '../../docs/engine.js';
import { etParts } from './potd.js';
import { betRecordOf } from './trend-picks.js';
import { matchServeProbs, simulate, fitToTarget, distributions, shareOver, shareUnder, aceCounts, devig, impliedOf, highestLineAt, winShare } from './tennis-model.js';
import { nameKey, surfaceOf, setDone } from './tennis-card-parse.js';
import { formOf, formLine, styleOf, matchupProb, flagsOf, STYLE_LABEL } from './tennis-form.js';
import { ensureTennisTrends } from './tennis-trends.js';

export { surfaceOf, setDone };

export const TENNIS_CARD_KEY = 'tennis:card';
export const tennisProfilesKey = (tour) => `tennis:profiles:${tour}`;
export const TENNIS_ACELOG_KEY = (tour) => `tennis:acelog:${tour}`;
export const tennisPicksKey = (date) => `tennis:picks:${date}`;
export const TENNIS_PICKS_INDEX = 'tennis:picks:index';
/** The Parlay Builder's tennis legs (2026-11-06: "add tennis to the parlay builder too"): every priced leg on the matches read, scored. */
export const TENNIS_PARLAY_KEY = 'tennis:parlay';
export const TENNIS_RECORD_VERSION = 1;
const KV_TTL = 90 * 86400;

/** The bar (2026-11-06: "funnel out the close calls"): the model's share for the leg, the edge over the price, the price band. */
export const MIN_PROB = 0.74;
export const MIN_EDGE = 0.07;
export const ACE_PROB = 0.8;
export const PRICE_BAND = [-250, 250];
export const MAX_PER_TOUR = 5;
export const MAX_ACES_PER_TOUR = 3;
/** A player needs this many matches in the last 52 weeks before the model reads them; an ace leg needs more, and a surface line stands in for the overall one from this many. */
export const MIN_MATCHES = 10;
export const MIN_ACE_MATCHES = 15;
export const MIN_SURFACE_MATCHES = 8;
/** The day's plays stop here (2026-11-06: "Max 5U in plays a day"), one unit each; one unit is kept for the parlay until it posts. */
export const MAX_UNITS_DAY = 5;
/** The moneyline parlay: a leg needs the blended share here (relaxed to fill the second leg), the parlay's own share at least PARLAY_MIN_PROB, two to four legs. */
export const PARLAY_LEG_PROB = 0.78;
export const PARLAY_LEG_PROB_RELAXED = 0.72;
export const PARLAY_MIN_PROB = 0.58;
export const PARLAY_LEGS = [2, 4];
/** The model's say against the market's in the winner the shape is simulated from. */
export const MODEL_WEIGHT = 0.5;
export const TOURS = ['atp', 'wta'];
export const TENNIS_MARKETS = {
  games_spread: 'Game spread', games_total: 'Total games', set_spread: 'Set spread', set1_total: '1st set games', set2_total: '2nd set games', aces: 'Aces', ml_parlay: 'Moneyline parlay',
};
const BOARD_MARKETS = 'h2h,spreads,totals';
const EVENT_MARKETS = 'alternate_spreads,alternate_totals,alternate_set_spreads,totals_s1,alternate_totals_s1,alternate_totals_s2';
const BOARD_TTL = 30 * 60e3;
const EVENT_TTL = 3 * 3600e3;
const SPORTS_TTL = 6 * 3600e3;

const surname = (name) => nameKey(name).split(' ').filter(Boolean).at(-1) ?? '';
const sameName = (x, y) => { const a = nameKey(x); const b = nameKey(y); return Boolean(a && b) && (a === b || (surname(a) === surname(b) && surname(a).length >= 4 && a[0] === b[0])); };

const readJson = async (env, key) => { const raw = await env.POTD_KV.get(key).catch(() => null); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } };

/** A feed call cached in KV for `ttl`, with the credits left noted; null on a failure (the stale copy, when there is one, stands). */
async function feedJson(env, ctx, url, cacheKey, ttl, { now = Date.now(), sport = 'tennis', cachedOnly = false } = {}) {
  const cached = await readJson(env, cacheKey);
  if (cached && (cachedOnly || now - (cached.at ?? 0) < ttl)) return cached.body;
  if (cachedOnly) return null;
  const u = new URL(url); u.searchParams.set('apiKey', (env.ODDS_API_KEY ?? '').trim());
  try {
    const res = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
    recordOddsDiag(env, ctx, res.ok
      ? { at: now, sport, ok: true, status: res.status, remaining: res.headers.get('x-requests-remaining'), used: res.headers.get('x-requests-used'), lastCost: res.headers.get('x-requests-last') }
      : { at: now, sport, ok: false, status: res.status, detail: (await res.clone().text().catch(() => '')).slice(0, 200) });
    if (!res.ok) return cached?.body ?? null;
    const body = await res.json();
    await env.POTD_KV.put(cacheKey, JSON.stringify({ at: now, body }), { expirationTtl: 7 * 86400 }).catch(() => {});
    return body;
  } catch { return cached?.body ?? null; }
}

/** The feed's live tennis keys by tour (free): tennis_atp_* and tennis_wta_* that are active. */
export async function tennisSportKeys(env, ctx, now = Date.now()) {
  const list = await feedJson(env, ctx, `${UPSTREAM}/sports`, 'tennis:feed:sports', SPORTS_TTL, { now });
  const keys = { atp: [], wta: [] };
  for (const s of Array.isArray(list) ? list : []) {
    if (!s?.active || s.has_outrights) continue;
    if (String(s.key).startsWith('tennis_atp_')) keys.atp.push({ key: s.key, title: s.title });
    if (String(s.key).startsWith('tennis_wta_')) keys.wta.push({ key: s.key, title: s.title });
  }
  return keys;
}

/** The board for one tournament key: every match with h2h, the game spread and the total at the site's books. */
async function tournamentBoard(env, ctx, key, now) {
  const url = `${UPSTREAM}/sports/${key}/odds?bookmakers=${TREND_BOOKMAKERS}&markets=${BOARD_MARKETS}&oddsFormat=american&dateFormat=iso&includeLinks=true`;
  const body = await feedJson(env, ctx, url, `tennis:odds:board:${key}`, BOARD_TTL, { now, sport: key });
  return Array.isArray(body) ? body : [];
}
/** One match's deeper markets (the set spread, the set totals, the alternate games lines): only for a match the model has a case on. */
async function eventMarkets(env, ctx, key, eventId, now, { cachedOnly = false } = {}) {
  const url = `${UPSTREAM}/sports/${key}/events/${eventId}/odds?bookmakers=${TREND_BOOKMAKERS}&markets=${EVENT_MARKETS}&oddsFormat=american&dateFormat=iso&includeLinks=true`;
  return feedJson(env, ctx, url, `tennis:odds:event:${eventId}`, EVENT_TTL, { now, sport: key, cachedOnly });
}

/** The feed event for a card match on a board: both names fit, either order. */
export function feedEventFor(match, events) {
  for (const e of events ?? []) {
    const straight = sameName(match.a.name, e.home_team) && sameName(match.b.name, e.away_team);
    const flipped = sameName(match.a.name, e.away_team) && sameName(match.b.name, e.home_team);
    if (straight || flipped) return { event: e, aIsHome: straight };
  }
  return null;
}

/** Every quote on a feed event for a market key: [{bookId, book, name, point, american, link}], the site's books only. */
export function quotesOf(event, marketKey) {
  const out = [];
  for (const bm of event?.bookmakers ?? []) {
    const bookId = bookIdFor(bm.key); if (!bookId) continue;
    for (const m of bm.markets ?? []) {
      if (m.key !== marketKey) continue;
      for (const o of m.outcomes ?? []) if (Number.isFinite(Number(o.price))) out.push({ bookId, book: bm.title ?? bm.key, name: o.name, point: Number.isFinite(Number(o.point)) ? Number(o.point) : null, american: Number(o.price), link: o.link ?? bm.link ?? null });
    }
  }
  return out;
}

/** The market's say on the winner: the de-vigged h2h, the median across the books. Null without a two-sided quote. */
export function marketWinShare(event, aName) {
  const shares = [];
  for (const bm of event?.bookmakers ?? []) {
    const m = (bm.markets ?? []).find((x) => x.key === 'h2h'); if (!m) continue;
    const a = m.outcomes?.find((o) => sameName(o.name, aName)); const b = m.outcomes?.find((o) => !sameName(o.name, aName));
    if (!a || !b) continue;
    shares.push(devig(Number(a.price), Number(b.price)).a);
  }
  if (!shares.length) return null;
  shares.sort((x, y) => x - y);
  return shares[Math.floor(shares.length / 2)];
}

/**
 * A player's serve rates for a match from the data runner's profile
 * (scripts/tennis-data.mjs: the last 52 weeks, overall and by surface):
 * the surface's own line when it is deep enough, else the overall line.
 * Null when the player is too thin on file. The ace rate is per service
 * point; the match count stands in for the sample.
 */
export function ratesFor(profile, surface) {
  if (!profile) return null;
  const overall = profile.overall;
  if (!overall || !((overall.matches ?? 0) >= MIN_MATCHES) || overall.serve == null) return null;
  const line = surface && profile.bySurface?.[surface] && (profile.bySurface[surface].matches ?? 0) >= MIN_SURFACE_MATCHES ? profile.bySurface[surface] : overall;
  return { serve: line.serve, firstIn: line.firstIn ?? null, return: line.return ?? overall.return ?? null, ace: line.ace ?? overall.ace ?? null, acesPerGame: line.acesPerGame ?? overall.acesPerGame ?? null, points: line.points ?? overall.points ?? 0, matches: overall.matches, aceMatches: overall.matches, surfaceUsed: line !== overall, elo: line.elo ?? overall.elo ?? null, eloOverall: overall.elo ?? null };
}

const stars = (p) => (p >= 0.86 ? 5 : p >= 0.8 ? 4 : 3);
const pct = (x) => `${Math.round(x * 100)}%`;
const best = (quotes) => [...quotes].sort((x, y) => y.american - x.american)[0] ?? null;

/**
 * The legs the model has a case on for one match, each with its share, and
 * priced where the board carries the number: the dog's game spread, the
 * total games over, the dog's +1.5 sets, the first- and second-set games
 * over, and each player's aces. Unpriced legs other than aces are dropped.
 */
export function readMatch(match, { dist, aceA, aceB, board, deep, ratesA, ratesB, pMarket, pModel = null, context = [] }) {
  const legs = [];
  const dog = dist.pA < 0.5 ? 'a' : 'b';
  const dogName = match[dog].name; const favName = match[dog === 'a' ? 'b' : 'a'].name;
  const dogMargin = dist.marginA.map((m) => (dog === 'a' ? m : -m));
  const push = (market, side, selection, point, quotes, prob, why) => {
    const q = best(quotes);
    if (!q && market !== 'aces') return;
    const implied = q ? impliedOf(q.american) : null;
    legs.push({ market, side, selection, point, prob: Math.round(prob * 1000) / 1000, implied: implied != null ? Math.round(implied * 1000) / 1000 : null, edge: implied != null ? Math.round((prob - implied) * 1000) / 1000 : null, bookId: q?.bookId ?? null, book: q?.book ?? null, american: q?.american ?? null, link: q?.link ?? null, why });
  };
  const favShare = (p) => (p == null ? null : dog === 'a' ? 1 - p : p);
  const why = (extra = []) => [
    pMarket != null && pModel != null
      ? `${favName} to win: the market ${pct(favShare(pMarket))}, the model's own read ${pct(favShare(pModel))}; the shape is simulated from the two blended`
      : `Market: ${favName} ${pct(Math.max(pMarket ?? dist.pA, 1 - (pMarket ?? dist.pA)))} to win; the model is fitted to that`,
    `${match.a.name} holds on ${pct(ratesA.serve)} of serve points, ${match.b.name} on ${pct(ratesB.serve)}; ${Math.round(dist.meanGames)} games expected, straight sets ${pct(dist.straightSets)}`,
    ...context,
    ...extra,
  ];
  // Game spread: the dog plus games, from the board's spread and the alternate ladder.
  const spreads = [...quotesOf(board, 'spreads'), ...quotesOf(deep, 'alternate_spreads')].filter((q) => sameName(q.name, dogName) && q.point > 0);
  const byPoint = new Map(); for (const q of spreads) { if (!byPoint.has(q.point)) byPoint.set(q.point, []); byPoint.get(q.point).push(q); }
  for (const [point, quotes] of byPoint) {
    const prob = shareOver(dogMargin, -point);
    if (prob >= MIN_PROB) push('games_spread', dog, `${dogName} +${point} games`, point, quotes, prob, why([`${pct(prob)} of simulations keep ${dogName} within ${Math.floor(point)} games`]));
  }
  // Total games over.
  const totals = [...quotesOf(board, 'totals'), ...quotesOf(deep, 'alternate_totals')].filter((q) => /over/i.test(q.name) && q.point != null);
  const byTotal = new Map(); for (const q of totals) { if (!byTotal.has(q.point)) byTotal.set(q.point, []); byTotal.get(q.point).push(q); }
  for (const [point, quotes] of byTotal) {
    const prob = shareOver(dist.games, point);
    if (prob >= MIN_PROB) push('games_total', null, `Over ${point} games`, point, quotes, prob, why([`${pct(prob)} of simulations run past ${point} games`]));
  }
  // The dog +1.5 sets.
  const dogSet = dog === 'a' ? dist.aWinsASet : dist.bWinsASet;
  if (dogSet >= MIN_PROB) {
    const quotes = quotesOf(deep, 'alternate_set_spreads').filter((q) => sameName(q.name, dogName) && q.point === 1.5);
    push('set_spread', dog, `${dogName} +1.5 sets`, 1.5, quotes, dogSet, why([`${pct(dogSet)} of simulations give ${dogName} a set`]));
  }
  // First- and second-set games over.
  const s1 = [...quotesOf(deep, 'totals_s1'), ...quotesOf(deep, 'alternate_totals_s1')].filter((q) => /over/i.test(q.name) && q.point != null);
  const byS1 = new Map(); for (const q of s1) { if (!byS1.has(q.point)) byS1.set(q.point, []); byS1.get(q.point).push(q); }
  for (const [point, quotes] of byS1) { const prob = shareOver(dist.set1, point); if (prob >= MIN_PROB) push('set1_total', null, `1st set over ${point} games`, point, quotes, prob, why([`${pct(prob)} of simulated first sets run past ${point} games`])); }
  const s2 = quotesOf(deep, 'alternate_totals_s2').filter((q) => /over/i.test(q.name) && q.point != null);
  const byS2 = new Map(); for (const q of s2) { if (!byS2.has(q.point)) byS2.set(q.point, []); byS2.get(q.point).push(q); }
  for (const [point, quotes] of byS2) { const prob = shareOver(dist.set2, point); if (prob >= MIN_PROB) push('set2_total', null, `2nd set over ${point} games`, point, quotes, prob, why([`${pct(prob)} of simulated second sets run past ${point} games`])); }
  // Aces: the number the model clears at ACE_PROB, the price at the user's book (the feed carries no aces market).
  for (const [side, counts, rates] of [['a', aceA, ratesA], ['b', aceB, ratesB]]) {
    if (!counts || !(rates.aceMatches >= MIN_ACE_MATCHES) || rates.ace == null) continue;
    const line = highestLineAt(counts, ACE_PROB);
    if (line == null || line < 4.5) continue;
    const prob = shareOver(counts, line);
    const mean = counts.reduce((s, k) => s + k, 0) / counts.length;
    push('aces', side, `${match[side].name} over ${line} aces`, line, [], prob, why([`${match[side].name} serves ${(rates.acesPerGame ?? rates.ace * 6.4).toFixed(2)} aces a service game over ${rates.aceMatches} matches this year; ${mean.toFixed(1)} expected here, ${pct(prob)} clear ${line}`]));
  }
  return legs;
}

/** The legs that clear the bar: the price inside the band and the edge over it; aces by their share alone. */
export const clearsBar = (leg) => (leg.market === 'aces' ? leg.prob >= ACE_PROB : leg.american != null && leg.american >= PRICE_BAND[0] && leg.american <= PRICE_BAND[1] && leg.prob >= MIN_PROB && leg.edge >= MIN_EDGE);

/** The h2h quotes for one player on a board event: [{bookId, book, american, link}]. */
const h2hQuotesFor = (board, name) => quotesOf(board, 'h2h').filter((q) => sameName(q.name, name));
const americanOfDecimal = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));

/** The units the day's plays have taken so far (every posted play is one unit; a void gives its unit back). */
export const unitsPosted = (plays) => (plays ?? []).filter((p) => p.status !== 'void').reduce((n, p) => n + (p.units ?? 1), 0);

/**
 * The day's moneyline parlay from the candidates (one per match read: the
 * favourite's blended share, flags, and h2h quotes): the clearest
 * favourites first, two to four legs, the parlay's share at least
 * PARLAY_MIN_PROB, at the one book that prices every leg best. Null when
 * two legs cannot be found.
 */
export function buildParlay(candidates, now = Date.now()) {
  const live = (c) => c.commenceMs > now && c.quotes?.length;
  const clean = (c) => !(c.flags ?? []).length;
  const strict = candidates.filter((c) => live(c) && clean(c) && c.prob >= PARLAY_LEG_PROB).sort((x, y) => y.prob - x.prob);
  const relaxed = candidates.filter((c) => live(c) && clean(c) && c.prob >= PARLAY_LEG_PROB_RELAXED && c.prob < PARLAY_LEG_PROB).sort((x, y) => y.prob - x.prob);
  const legs = [];
  let product = 1;
  for (const c of strict) { if (legs.length >= PARLAY_LEGS[1]) break; if (product * c.prob < PARLAY_MIN_PROB && legs.length >= PARLAY_LEGS[0]) break; if (legs.some((l) => l.matchId === c.matchId)) continue; legs.push(c); product *= c.prob; }
  for (const c of relaxed) { if (legs.length >= PARLAY_LEGS[0]) break; if (product * c.prob < 0.55) break; legs.push(c); product *= c.prob; }
  if (legs.length < PARLAY_LEGS[0]) return null;
  // The book: the one carrying the most legs, the best combined price among those; the legs it does not carry drop.
  const books = new Map();
  for (const l of legs) for (const q of l.quotes) { if (!books.has(q.bookId)) books.set(q.bookId, { bookId: q.bookId, book: q.book, legs: new Map() }); const b = books.get(q.bookId); if (!b.legs.has(l.matchId) || q.american > b.legs.get(l.matchId).american) b.legs.set(l.matchId, q); }
  const ranked = [...books.values()].map((b) => ({ ...b, n: b.legs.size, dec: [...b.legs.values()].reduce((d, q) => d * americanToDecimal(q.american), 1) })).sort((x, y) => y.n - x.n || y.dec - x.dec);
  const pick = ranked[0];
  if (!pick || pick.n < PARLAY_LEGS[0]) return null;
  const chosen = legs.filter((l) => pick.legs.has(l.matchId));
  const prob = chosen.reduce((p, l) => p * l.prob, 1);
  const dec = chosen.reduce((d, l) => d * americanToDecimal(pick.legs.get(l.matchId).american), 1);
  const american = americanOfDecimal(dec);
  const implied = 1 / dec;
  const legList = chosen.map((l) => { const q = pick.legs.get(l.matchId); return { matchId: l.matchId, tour: l.tour, event: l.event, round: l.round, commenceMs: l.commenceMs, a: l.a, b: l.b, side: l.side, selection: `${l.name} to win`, american: q.american, link: q.link ?? null, prob: l.prob, pModel: l.pModel, pMarket: l.pMarket, opponentFlags: l.opponentFlags ?? [], why: l.why ?? [] }; });
  return {
    market: 'ml_parlay', side: null, point: null, selection: `${legList.length}-leg moneyline parlay: ${legList.map((l) => l.selection.replace(' to win', '')).join(' + ')}`,
    prob: Math.round(prob * 1000) / 1000, implied: Math.round(implied * 1000) / 1000, edge: Math.round((prob - implied) * 1000) / 1000, bookId: pick.bookId, book: pick.book, american, link: legList.find((l) => l.link)?.link ?? null,
    legs: legList, commenceMs: Math.min(...legList.map((l) => l.commenceMs)), lastMs: Math.max(...legList.map((l) => l.commenceMs)),
    why: [`${legList.length} favourites with a clear advantage, none flagged for injury, fatigue or rust; together ${pct(prob)} by the model against the price's ${pct(implied)}`, ...legList.map((l) => `${l.selection} (${pct(l.prob)} blended: model ${pct(l.pModel)}, market ${pct(l.pMarket)})${l.opponentFlags.length ? `, opponent flagged for ${l.opponentFlags.join(' and ')}` : ''}`)],
  };
}

/** A builder leg's score, 1 to 5: the model's share (50% is 1, 90% is 5), half a star for edge over the price, a star off a flagged side. */
export const legScoreOf = (prob, edge, flagged = false) => Math.max(1, Math.min(5, Math.round((1 + 4 * Math.max(0, Math.min(1, (prob - 0.5) / 0.4)) + (edge >= 0.05 ? 0.5 : 0) - (flagged ? 1 : 0)) * 10) / 10));
export const BUILDER_MARKETS = { ml: 'Moneyline', games_spread: 'Game spread', games_total: 'Total games', set_spread: 'Set spread', set1_total: '1st set games' };

/**
 * Every priced leg on one match for the Parlay Builder: each side's
 * moneyline at the blended share, every game spread and total on the
 * board (and the alternates when the deeper markets are cached), the set
 * spread and the first-set total, each with its share from the
 * simulation, the price at every book, the edge at the best, a score, and
 * the player's consistency at the number from the Trends build.
 */
export function builderLegs(match, { dist, board, deep, pFinal, flags = { a: [], b: [] }, context = [], consistency = () => null }) {
  const legs = [];
  const bookQuotes = (quotes) => { const by = new Map(); for (const q of quotes) if (!by.has(q.bookId) || q.american > by.get(q.bookId).american) by.set(q.bookId, q); return [...by.values()].map((q) => ({ bookId: q.bookId, book: q.book, american: q.american, decimal: Math.round(americanToDecimal(q.american) * 1000) / 1000, link: q.link ?? null })); };
  const push = (market, side, selection, point, sideWord, quotes, prob, why, cons = null) => {
    const qs = bookQuotes(quotes); if (!qs.length) return;
    const bestQ = [...qs].sort((x, y) => y.american - x.american)[0];
    const implied = impliedOf(bestQ.american); const edge = prob - implied;
    const flagged = Boolean(side && flags[side]?.length);
    legs.push({ id: `${match.tour}:${match.id}:${market}:${side ?? 'm'}:${point ?? ''}:${sideWord ?? ''}`, matchId: `${match.tour}:${match.id}`, tour: match.tour, event: match.eventName, round: match.round, commenceMs: Date.parse(match.date), a: match.a.name, b: match.b.name, side, name: side ? match[side].name : null, opponent: side ? match[side === 'a' ? 'b' : 'a'].name : null, market, label: BUILDER_MARKETS[market], selection, point, sideWord, prob: Math.round(prob * 1000) / 1000, implied: Math.round(implied * 1000) / 1000, edge: Math.round(edge * 1000) / 1000, score: legScoreOf(prob, edge, flagged), flags: side ? flags[side] ?? [] : [], opponentFlags: side ? flags[side === 'a' ? 'b' : 'a'] ?? [] : [], quotes: qs, consistency: cons, why: [...why, ...context] });
  };
  const pct = (x) => `${Math.round(x * 100)}%`;
  const dog = pFinal < 0.5 ? 'a' : 'b';
  // Moneyline, both sides.
  for (const side of ['a', 'b']) {
    const prob = side === 'a' ? pFinal : 1 - pFinal;
    push('ml', side, `${match[side].name} to win`, null, null, h2hQuotesFor(board, match[side].name), prob, [`${match[side].name} ${pct(prob)} to win by the model (form, fatigue, style and surface read, blended with the market)`]);
  }
  // Game spreads: every number on the board and the alternate ladder, both sides.
  const spreads = [...quotesOf(board, 'spreads'), ...quotesOf(deep, 'alternate_spreads')].filter((q) => q.point != null);
  const bySpread = new Map();
  for (const q of spreads) { const side = sameName(q.name, match.a.name) ? 'a' : sameName(q.name, match.b.name) ? 'b' : null; if (!side) continue; const k = `${side}:${q.point}`; if (!bySpread.has(k)) bySpread.set(k, { side, point: q.point, quotes: [] }); bySpread.get(k).quotes.push(q); }
  for (const { side, point, quotes } of bySpread.values()) {
    const margin = side === 'a' ? dist.marginA : dist.marginA.map((m) => -m);
    const prob = shareOver(margin, -point);
    push('games_spread', side, `${match[side].name} ${point > 0 ? '+' : ''}${point} games`, point, null, quotes, prob, [`${pct(prob)} of simulations have ${match[side].name} ${point > 0 ? `within ${point} games` : `clear by more than ${-point} games`}`], point > 0 ? consistency(match[side], 'games_spread', point) : null);
  }
  // Total games, over and under, every number.
  const totals = [...quotesOf(board, 'totals'), ...quotesOf(deep, 'alternate_totals')].filter((q) => q.point != null);
  const byTotal = new Map();
  for (const q of totals) { const w = /over/i.test(q.name) ? 'over' : /under/i.test(q.name) ? 'under' : null; if (!w) continue; const k = `${w}:${q.point}`; if (!byTotal.has(k)) byTotal.set(k, { sideWord: w, point: q.point, quotes: [] }); byTotal.get(k).quotes.push(q); }
  for (const { sideWord, point, quotes } of byTotal.values()) {
    const prob = sideWord === 'over' ? shareOver(dist.games, point) : shareUnder(dist.games, point);
    const cons = sideWord === 'over' ? [consistency(match.a, 'games_total', point), consistency(match.b, 'games_total', point)].filter(Boolean).sort((x, y) => y.rate - x.rate)[0] ?? null : null;
    push('games_total', null, `${sideWord === 'over' ? 'Over' : 'Under'} ${point} games`, point, sideWord, quotes, prob, [`${pct(prob)} of simulations ${sideWord === 'over' ? 'run past' : 'stay under'} ${point} games (${Math.round(dist.meanGames)} expected)`], cons);
  }
  // The set spread: the dog +1.5, the favourite -1.5.
  for (const q of quotesOf(deep, 'alternate_set_spreads')) {
    const side = sameName(q.name, match.a.name) ? 'a' : sameName(q.name, match.b.name) ? 'b' : null; if (!side || Math.abs(q.point) !== 1.5) continue;
    const key = `${side}:${q.point}`; if (legs.some((l) => l.market === 'set_spread' && l.side === side && l.point === q.point)) continue;
    const quotes = quotesOf(deep, 'alternate_set_spreads').filter((x) => sameName(x.name, q.name) && x.point === q.point);
    const prob = q.point > 0 ? (side === 'a' ? dist.aWinsASet : dist.bWinsASet) : 1 - (side === 'a' ? dist.bWinsASet : dist.aWinsASet);
    push('set_spread', side, `${match[side].name} ${q.point > 0 ? '+' : ''}${q.point} sets`, q.point, null, quotes, prob, [q.point > 0 ? `${pct(prob)} of simulations give ${match[side].name} a set` : `${pct(prob)} of simulations have ${match[side].name} winning in straight sets`], q.point > 0 ? consistency(match[side], 'set_spread', 1.5) : null);
    void key;
  }
  // The first set's games, over and under.
  const s1 = [...quotesOf(deep, 'totals_s1'), ...quotesOf(deep, 'alternate_totals_s1')].filter((q) => q.point != null);
  const byS1 = new Map();
  for (const q of s1) { const w = /over/i.test(q.name) ? 'over' : /under/i.test(q.name) ? 'under' : null; if (!w) continue; const k = `${w}:${q.point}`; if (!byS1.has(k)) byS1.set(k, { sideWord: w, point: q.point, quotes: [] }); byS1.get(k).quotes.push(q); }
  for (const { sideWord, point, quotes } of byS1.values()) {
    const prob = sideWord === 'over' ? shareOver(dist.set1, point) : shareUnder(dist.set1, point);
    const cons = sideWord === 'over' ? [consistency(match.a, 'set1_total', point), consistency(match.b, 'set1_total', point)].filter(Boolean).sort((x, y) => y.rate - x.rate)[0] ?? null : null;
    push('set1_total', null, `1st set ${sideWord} ${point} games`, point, sideWord, quotes, prob, [`${pct(prob)} of simulated first sets ${sideWord === 'over' ? 'run past' : 'stay under'} ${point} games`], cons);
  }
  void dog;
  return legs;
}

/** A player's consistency at a number from the Trends build: the ladder rung at the line (the nearest below it), as {rate, hits, n, line}. */
export function consistencyFrom(trends) {
  const byKey = new Map((trends?.players ?? []).map((p) => [`${p.tour}:${p.key}`, p]));
  return (player, market, line, tour) => {
    const p = byKey.get(`${tour ?? ''}:${player?.key ?? nameKey(player?.name)}`) ?? [...byKey.values()].find((x) => x.key === (player?.key ?? nameKey(player?.name)));
    const prop = p?.props?.find((x) => x.market === market); if (!prop || prop.modeled) return null;
    const rung = [...(prop.ladder ?? [])].filter((r) => r.line <= line).sort((x, y) => y.line - x.line)[0] ?? null;
    return rung ? { rate: rung.rate, hits: rung.hits, n: rung.n ?? prop.n, line: rung.line, window: prop.n } : null;
  };
}

/** The Parlay Builder's read. */
export async function getTennisParlay(env) {
  return (await readJson(env, TENNIS_PARLAY_KEY)) ?? { at: null, legs: [], matches: [] };
}

/** One tick: read, price, post and grade. Returns what it did. */
export async function runTennisTick(env, ctx, now = Date.now(), { deps = {} } = {}) {
  const card = deps.card ? await deps.card() : await readJson(env, TENNIS_CARD_KEY);
  if (!card) return { skipped: true, reason: 'no card' };
  const profiles = {};
  for (const tour of TOURS) profiles[tour] = deps.profiles ? await deps.profiles(tour) : await readJson(env, tennisProfilesKey(tour));
  const date = etParts(now).date;
  const key = tennisPicksKey(date);
  const record = (await readJson(env, key)) ?? { version: TENNIS_RECORD_VERSION, date, generatedAt: now, plays: [], reads: {}, oddsAt: null };
  record.refreshedAt = now;
  const keys = deps.sportKeys ? await deps.sportKeys() : await tennisSportKeys(env, ctx, now);
  const boards = new Map();
  const boardFor = async (tour) => {
    if (!boards.has(tour)) {
      const all = [];
      for (const k of keys[tour] ?? []) { const b = deps.board ? await deps.board(k.key) : await tournamentBoard(env, ctx, k.key, now); for (const e of b) all.push({ ...e, sportKey: k.key }); }
      boards.set(tour, all);
    }
    return boards.get(tour);
  };
  // The results for form: the card's last six weeks and whatever on the slate has finished.
  const allResults = [...(card.results ?? []), ...(card.slate ?? []).filter((m) => m.completed)];
  const parlayPosted = () => record.plays.some((p) => p.market === 'ml_parlay');
  const roomFor = (market) => unitsPosted(record.plays) + (market === 'ml_parlay' || parlayPosted() ? 0 : 1) < MAX_UNITS_DAY;
  let posted = 0; let considered = 0;
  const candidates = [];
  // The Trends tab's tennis lines (worker/src/tennis-trends.js), rebuilt once an hour from the same card and profiles and the last boards; the builder legs read their consistency.
  const trends = deps.trends === false ? { built: false, trends: null } : await ensureTennisTrends(env, { card, profiles, now }).catch((e) => { console.error('Tennis trends build failed:', e); return { built: false, trends: null }; });
  const consistency = consistencyFrom(trends.trends);
  const builder = { at: now, legs: [], matches: [] };
  const upcoming = (card.slate ?? []).filter((m) => m.state === 'pre' && !m.qualifying && m.tier !== 'challenger' && Date.parse(m.date) > now && Date.parse(m.date) < now + 30 * 3600e3);
  for (const m of upcoming) {
    const id = `${m.tour}:${m.id}`;
    const prof = profiles[m.tour]?.players ?? {};
    const surface = surfaceOf(m.eventName);
    const ratesA = ratesFor(prof[m.a.key] ?? prof[nameKey(m.a.name)], surface); const ratesB = ratesFor(prof[m.b.key] ?? prof[nameKey(m.b.name)], surface);
    const base = { a: m.a.name, b: m.b.name, event: m.eventName, round: m.round, start: m.date, surface };
    if (!ratesA || !ratesB) { if (!record.reads[id]?.pMarket) record.reads[id] = { ...base, passed: `no serve numbers on file for ${!ratesA ? m.a.name : m.b.name}` }; continue; }
    const events = await boardFor(m.tour);
    const hit = feedEventFor(m, events);
    if (!hit) { if (!record.reads[id]?.pMarket) record.reads[id] = { ...base, passed: 'the feed has no board for this match yet' }; continue; }
    const board = hit.event;
    const pMarket = marketWinShare(board, m.a.name);
    // The read of the two players: form and flags, style, Elo, the serve simulation, and the model's winner from all of it.
    const formA = formOf({ id: m.a.id, key: m.a.key ?? nameKey(m.a.name) }, allResults, now); const formB = formOf({ id: m.b.id, key: m.b.key ?? nameKey(m.b.name) }, allResults, now);
    const styleA = styleOf(ratesA, m.tour); const styleB = styleOf(ratesB, m.tour);
    const { pA, pB } = matchServeProbs(ratesA, ratesB, m.tour);
    const pSim = winShare(simulate(pA, pB, { n: 1200, seed: 5, bestOf: m.bestOf }));
    const read = matchupProb({ pSim, eloA: ratesA.elo, eloB: ratesB.elo, formA, formB, styleA, styleB, surface, nameA: m.a.name, nameB: m.b.name });
    const pModel = read.p;
    const pFinal = pMarket != null ? Math.round((MODEL_WEIGHT * pModel + (1 - MODEL_WEIGHT) * pMarket) * 1000) / 1000 : pModel;
    const context = [`Form: ${formLine(m.a.name, formA)}; ${formLine(m.b.name, formB)}`, `Style on ${surface}: ${m.a.name} a ${STYLE_LABEL[styleA.style]}, ${m.b.name} a ${STYLE_LABEL[styleB.style]}${read.pElo != null ? `; surface Elo gives ${m.a.name} ${pct(read.pElo)}` : ''}`, ...read.reasons];
    const flags = read.flags;
    const favSide = pFinal >= 0.5 ? 'a' : 'b';
    const favName = m[favSide].name;
    if (pMarket != null) candidates.push({ matchId: id, tour: m.tour, event: m.eventName, round: m.round, commenceMs: Date.parse(m.date), a: m.a.name, b: m.b.name, side: favSide, name: favName, prob: favSide === 'a' ? pFinal : Math.round((1 - pFinal) * 1000) / 1000, pModel: favSide === 'a' ? pModel : Math.round((1 - pModel) * 1000) / 1000, pMarket: favSide === 'a' ? pMarket : 1 - pMarket, flags: flags[favSide], opponentFlags: flags[favSide === 'a' ? 'b' : 'a'], quotes: h2hQuotesFor(board, favName), why: context });
    const alreadyPosted = record.plays.some((p) => p.matchId === id); // posted once; the price stands as drawn
    if (!alreadyPosted) considered++;
    const fit = fitToTarget(pA, pB, pFinal, { bestOf: m.bestOf, seed: 7 });
    const sims = simulate(fit.pA, fit.pB, { n: 3000, seed: 11, bestOf: m.bestOf });
    const dist = distributions(sims);
    const aceA = aceCounts(dist.svptA, ratesA.ace ?? 0, { seed: 13, tour: m.tour, samplePoints: ratesA.points });
    const aceB = aceCounts(dist.svptB, ratesB.ace ?? 0, { seed: 17, tour: m.tour, samplePoints: ratesB.points });
    // The deeper markets are one billed call per match: only when the board's own legs or the shape give the model a case; a match already posted reads the cached copy only.
    const dogSet = dist.pA < 0.5 ? dist.aWinsASet : dist.bWinsASet;
    const shapeCase = dogSet >= MIN_PROB || shareOver(dist.set1, 8.5) >= MIN_PROB || shareOver(dist.games, 20.5) >= MIN_PROB || shareOver(dist.set2, 8.5) >= MIN_PROB;
    const deep = shapeCase || alreadyPosted ? (deps.eventMarkets ? await deps.eventMarkets(board.sportKey, board.id, { cachedOnly: alreadyPosted && !shapeCase }) : await eventMarkets(env, ctx, board.sportKey, board.id, now, { cachedOnly: alreadyPosted && !shapeCase })) : null;
    // The Parlay Builder's legs for this match (every priced number, scored), posted or not.
    builder.matches.push({ id, tour: m.tour, event: m.eventName, round: m.round, commenceMs: Date.parse(m.date), a: m.a.name, b: m.b.name, pFinal, flags });
    builder.legs.push(...builderLegs(m, { dist, board, deep, pFinal, flags, context, consistency: (player, market, line) => consistency(player, market, line, m.tour) }));
    if (alreadyPosted) continue;
    const legs = readMatch(m, { dist, aceA, aceB, board, deep, ratesA, ratesB, pMarket, pModel, context });
    // A leg on a player flagged for injury or fatigue never posts: a side with a doubt is not a clear advantage.
    const sideClear = (l) => !l.side || !flags[l.side].length;
    const clear = legs.filter((l) => clearsBar(l) && sideClear(l));
    const flagged = legs.filter((l) => clearsBar(l) && !sideClear(l));
    record.reads[id] = { ...base, pMarket: pMarket != null ? Math.round(pMarket * 1000) / 1000 : null, pModel, pFinal, pElo: read.pElo, meanGames: Math.round(dist.meanGames * 10) / 10, straightSets: Math.round(dist.straightSets * 100) / 100, dogSet: Math.round(dogSet * 100) / 100, flags, form: { a: formLine(m.a.name, formA), b: formLine(m.b.name, formB) }, style: { a: styleA.style, b: styleB.style }, reasons: read.reasons, legs: legs.length, clear: clear.length, passed: clear.length ? null : flagged.length ? `the only legs that clear sit on a player flagged for ${[...new Set(flagged.flatMap((l) => flags[l.side]))].join(' and ')}` : legs.length ? 'nothing clears the bar: the best leg is short of the price' : 'no leg the model likes at this price' };
    if (!clear.length) continue;
    // The best priced leg, then the best aces leg, each under its cap for the tour and the day's units.
    const tourCount = (market) => record.plays.filter((p) => p.tour === m.tour && (market === 'aces' ? p.market === 'aces' : p.market !== 'aces' && p.market !== 'ml_parlay')).length;
    const priced = clear.filter((l) => l.market !== 'aces').sort((x, y) => (y.edge * y.prob) - (x.edge * x.prob))[0] ?? null;
    const ace = clear.filter((l) => l.market === 'aces').sort((x, y) => y.prob - x.prob)[0] ?? null;
    for (const leg of [priced, ace]) {
      if (!leg) continue;
      if (tourCount(leg.market) >= (leg.market === 'aces' ? MAX_ACES_PER_TOUR : MAX_PER_TOUR)) continue;
      if (!roomFor(leg.market)) { record.reads[id].passed = `cleared, but the day's ${MAX_UNITS_DAY} units are placed`; continue; }
      record.plays.push({ id: `${id}:${leg.market}`, matchId: id, tour: m.tour, event: m.eventName, tier: m.tier, round: m.round, surface, commenceMs: Date.parse(m.date), a: m.a.name, b: m.b.name, aId: m.a.id, bId: m.b.id, ...leg, flags: { a: flags.a, b: flags.b }, stars: stars(leg.prob), units: 1, postedAt: now, status: 'pending', result: null, net: null, actual: null });
      posted++;
    }
  }
  // The day's moneyline parlay (2026-11-06: "at least one play for tennis posted ... a 2 leg parlay or a 4 leg moneyline parlay"), once.
  let parlay = null;
  if (!parlayPosted() && roomFor('ml_parlay')) {
    parlay = buildParlay(candidates, now);
    if (parlay) {
      const tours = [...new Set(parlay.legs.map((l) => l.tour))];
      record.plays.push({ id: `parlay:${date}`, matchId: null, tour: tours.length === 1 ? tours[0] : 'both', event: tours.length === 1 ? parlay.legs[0].event : 'ATP and WTA', tier: null, round: null, surface: null, a: null, b: null, ...parlay, stars: stars(parlay.prob + 0.2), units: 1, postedAt: now, status: 'pending', result: null, net: null, actual: null });
      posted++;
    }
  }
  record.candidates = candidates.length;
  record.oddsAt = now;
  await env.POTD_KV.put(TENNIS_PARLAY_KEY, JSON.stringify(builder), { expirationTtl: 2 * 86400 }).catch(() => {});
  // Grading: every pending play whose match has a result.
  let graded = 0;
  const results = new Map((card.results ?? []).map((r) => [`${r.tour}:${r.id}`, r]));
  for (const s of card.slate ?? []) if (s.completed) results.set(`${s.tour}:${s.id}`, s);
  const aceLogs = {};
  for (const p of record.plays) {
    if (p.status !== 'pending') continue;
    if (p.market === 'ml_parlay') { const g = gradeParlay(p, results); if (g) { Object.assign(p, g); graded++; } continue; }
    const r = results.get(p.matchId);
    if (p.market === 'aces') {
      if (!aceLogs[p.tour]) aceLogs[p.tour] = (deps.aceLog ? await deps.aceLog(p.tour) : await readJson(env, TENNIS_ACELOG_KEY(p.tour))) ?? {};
      const g = gradeAces(p, aceLogs[p.tour], now);
      if (g) { Object.assign(p, g); graded++; }
      continue;
    }
    if (!r) continue;
    const g = gradePlay(p, r);
    if (g) { Object.assign(p, g); graded++; }
  }
  await env.POTD_KV.put(key, JSON.stringify(record), { expirationTtl: KV_TTL });
  const index = (await readJson(env, TENNIS_PICKS_INDEX)) ?? { dates: [] };
  if (!index.dates.includes(date)) { index.dates = [date, ...index.dates].slice(0, 120); await env.POTD_KV.put(TENNIS_PICKS_INDEX, JSON.stringify(index), { expirationTtl: KV_TTL }).catch(() => {}); }
  return { skipped: false, date, considered, candidates: candidates.length, posted, parlay: parlay ? parlay.legs.length : 0, graded, plays: record.plays.length, units: unitsPosted(record.plays), trendsBuilt: Boolean(trends.built), builderLegs: builder.legs.length, keys: Object.fromEntries(TOURS.map((t) => [t, (keys[t] ?? []).map((k) => k.key)])) };
}

/**
 * A moneyline parlay against the results: a leg loses with its match, wins
 * with it, and is void (its price dropped) on a walkover or a retirement
 * before a set was completed. The parlay loses on the first lost leg, wins
 * once every leg is won or void, and waits otherwise.
 */
export function gradeParlay(play, results) {
  const legs = (play.legs ?? []).map((l) => {
    const r = results.get(l.matchId);
    if (!r?.completed) return { ...l, result: null };
    const retired = /retire|walkover/i.test(String(r.statusName ?? '')) || /ret\.|retired|w\/o|walkover/i.test(String(r.note ?? ''));
    const setsDone = (r.sets ?? []).filter(setDone).length;
    const walkover = /walkover/i.test(String(r.statusName ?? '')) || /w\/o|walkover/i.test(String(r.note ?? ''));
    if (walkover || (retired && !setsDone) || !r.winner) return { ...l, result: 'void', actual: walkover ? 'walkover' : retired ? 'retired before a set was completed' : 'no winner listed' };
    const line = (r.sets ?? []).map(([a, b]) => `${a}-${b}`).join(' ');
    return { ...l, result: r.winner === l.side ? 'win' : 'loss', actual: `${line}${retired ? ' (ret.)' : ''}` };
  });
  const lost = legs.find((l) => l.result === 'loss');
  if (lost) return { status: 'graded', result: 'loss', net: -play.units, actual: `${lost.selection.replace(' to win', '')} lost (${lost.actual})`, legs, gradedAt: Date.now() };
  if (legs.some((l) => l.result == null)) return null;
  const standing = legs.filter((l) => l.result === 'win');
  if (!standing.length) return { status: 'void', result: 'void', net: 0, actual: 'every leg was void', legs, gradedAt: Date.now() };
  const dec = standing.reduce((d, l) => d * americanToDecimal(l.american), 1);
  return { status: 'graded', result: 'win', net: Math.round((dec - 1) * play.units * 100) / 100, actual: `${standing.length} of ${legs.length} legs won${legs.length > standing.length ? `, ${legs.length - standing.length} void` : ''}`, legs, gradedAt: Date.now() };
}

const settle = (play, won, actual, { push = false, voided = false } = {}) => {
  const result = voided ? 'void' : push ? 'push' : won ? 'win' : 'loss';
  const net = result === 'win' ? Math.round((americanToDecimal(play.american) - 1) * play.units * 100) / 100 : result === 'loss' ? -play.units : 0;
  return { status: voided ? 'void' : 'graded', result, net: play.american == null && result !== 'void' ? null : net, actual, gradedAt: Date.now() };
};

/** A play against a completed match's set scores; null while the result does not settle it. */
export function gradePlay(play, r) {
  const sets = r.sets ?? [];
  const final = r.statusName === 'STATUS_FINAL' || (r.completed && !/retire|walkover/i.test(String(r.statusName ?? '')) && !/ret\.|w\/o|walkover/i.test(String(r.note ?? '')));
  const gamesA = sets.reduce((n, [a]) => n + a, 0); const gamesB = sets.reduce((n, [, b]) => n + b, 0);
  const sideGames = (side) => (side === 'a' ? gamesA : gamesB);
  const line = sets.map(([a, b]) => `${a}-${b}`).join(' ');
  if (!sets.length) return r.completed ? settle(play, false, 'no set scores came through', { voided: true }) : null;
  // A match still in play settles only what a completed set already decides; the rest waits for the final.
  const live = !r.completed;
  switch (play.market) {
    case 'games_spread': {
      if (live) return null;
      if (!final) return settle(play, false, `${line}: not played to a finish`, { voided: true });
      const margin = sideGames(play.side) - sideGames(play.side === 'a' ? 'b' : 'a') + play.point;
      return settle(play, margin > 0, `${line}: ${play.side === 'a' ? play.a : play.b} ${margin > 0 ? 'covered' : margin === 0 ? 'pushed' : 'fell short'} at +${play.point}`, { push: margin === 0 });
    }
    case 'games_total': {
      if (live) return null;
      if (!final) return settle(play, false, `${line}: not played to a finish`, { voided: true });
      const total = gamesA + gamesB;
      return settle(play, total > play.point, `${line}: ${total} games`, { push: total === play.point });
    }
    case 'set_spread': {
      const dogSets = sets.filter((x) => setDone(x) && (play.side === 'a' ? x[0] > x[1] : x[1] > x[0])).length;
      if (dogSets >= 1) return settle(play, true, `${line}: took a set`);
      if (live) return null;
      if (!final) return settle(play, false, `${line}: not played to a finish`, { voided: true });
      return settle(play, false, `${line}: straight sets`);
    }
    case 'set1_total': {
      const s = sets[0]; const done = s && setDone(s);
      if (!done) return r.completed ? settle(play, false, `${line}: the first set was not completed`, { voided: true }) : null;
      const total = s[0] + s[1];
      return settle(play, total > play.point, `${line}: ${total} games in the first set`, { push: total === play.point });
    }
    case 'set2_total': {
      const s = sets[1]; const done = s && setDone(s);
      if (!done) return r.completed ? settle(play, false, `${line}: the second set was not completed`, { voided: true }) : null;
      const total = s[0] + s[1];
      return settle(play, total > play.point, `${line}: ${total} games in the second set`, { push: total === play.point });
    }
    default: return null;
  }
}

/** An aces play against the data runner's ace log ({'date|winner key|loser key': {wAces, lAces}}); void after 45 days unsettled. */
export function gradeAces(play, log, now = Date.now()) {
  const day = new Date(play.commenceMs);
  const me = nameKey(play.side === 'a' ? play.a : play.b); const other = nameKey(play.side === 'a' ? play.b : play.a);
  for (const d of [-1, 0, 1]) {
    const date = new Date(day.getTime() + d * 864e5).toISOString().slice(0, 10);
    const w = log?.[`${date}|${me}|${other}`]; const l = log?.[`${date}|${other}|${me}`];
    const aces = w ? w.wAces : l ? l.lAces : null;
    if (aces == null) continue;
    return settle(play, aces > play.point, `${aces} aces (${w ? 'won' : 'lost'} the match)`);
  }
  if (now - play.commenceMs > 45 * 864e5) return settle(play, false, 'the serve stats never came through', { voided: true });
  return null;
}

/** The tab's read: today's record, the recent records, the running record overall and per tour. */
export async function getTennisPicks(env, now = Date.now(), { days = 45 } = {}) {
  const index = (await readJson(env, TENNIS_PICKS_INDEX)) ?? { dates: [] };
  const today = etParts(now).date;
  const dates = [...new Set([today, ...index.dates])].sort().reverse().slice(0, days);
  const history = [];
  for (const d of dates) { const r = await readJson(env, tennisPicksKey(d)); if (r) history.push(r); }
  const all = history.flatMap((r) => r.plays ?? []);
  const current = history.find((r) => r.date === today) ?? null;
  const card = await readJson(env, TENNIS_CARD_KEY);
  return { date: today, current, history: history.map((r) => ({ date: r.date, plays: r.plays, refreshedAt: r.refreshedAt ?? null })), record: betRecordOf(all), byTour: Object.fromEntries(TOURS.map((t) => [t, betRecordOf(all.filter((p) => p.tour === t))])), byMarket: Object.fromEntries(Object.keys(TENNIS_MARKETS).map((k) => [k, betRecordOf(all.filter((p) => p.market === k))])), markets: TENNIS_MARKETS, cardAt: card?.at ?? null, slate: (card?.slate ?? []).filter((m) => !m.qualifying).map((m) => ({ id: `${m.tour}:${m.id}`, tour: m.tour, event: m.eventName, tier: m.tier, round: m.round, date: m.date, state: m.state, a: m.a.name, b: m.b.name, sets: m.sets, winner: m.winner })), bar: { minProb: MIN_PROB, minEdge: MIN_EDGE, aceProb: ACE_PROB, band: PRICE_BAND, maxUnits: MAX_UNITS_DAY, parlayLegProb: PARLAY_LEG_PROB, parlayLegs: PARLAY_LEGS }, unitsToday: unitsPosted(current?.plays) };
}
