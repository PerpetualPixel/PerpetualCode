/**
 * Tennis below the tours: the Challenger and ITF matches (2026-11-27, the
 * owner, with a sportsbook's live list of Challenger and ITF matches:
 * "does the watcher look out for these challengers and other games? I'd
 * like all the matches to have a lean unless it's a truly unpredictable
 * match. Not all matches are good matches to bet on but I feel there is
 * money to be had here").
 *
 * The Tennis tab's card is ESPN's two tour scoreboards, and ESPN lists
 * nothing below the tours; the odds feed prices none of it either. The
 * one source that has these matches is FanDuel's public tennis page,
 * which the runner already reads (scripts/tennis-fanduel.mjs): every
 * singles match with its moneyline. So that page is the match list and
 * the price here.
 *
 * What a lean is here, and is not. No serve numbers, ranking or results
 * are on file for these players, so the only read is the price itself:
 * the two prices with the book's cut taken out give each player's share,
 * and the price as first seen against the price now says which way the
 * money has gone. A match gets a lean on the favourite when that share is
 * clear of a coin flip and the money has not gone against it: to take
 * alone at a price that pays, as a parlay piece at a shorter one, and
 * named with no bet in it when the favourite is priced as all but won. A
 * match is left with no lean, and the reason, when the book has it near
 * even, when the favourite's price has drifted, or when the book's cut is
 * too wide to bet into. A lean is never a tracked play and never counts
 * in the day's units.
 *
 * Whether the leans are any good is kept as a tally of their own. FanDuel
 * shows no results, but a knockout draw does: the player who is listed
 * again later in the same tournament went through. A final has no later
 * match, so it is never graded.
 *
 * Pure and shared: the runner keeps the log (KV tennis:lower), the worker
 * reads it for the Tennis tab.
 */
import { nameKey } from './tennis-card-parse.js';
import { fanduelSlipLink } from './ufc-fanduel.js';
import { rankOf, getLowerRanks } from './tennis-lower-ranks.js';

export const TENNIS_LOWER_KEY = 'tennis:lower';
/** A match stays in the log this long after its start: long enough for the next round to be listed. */
export const LOWER_KEEP_MS = 8 * 864e5;
/** A started match with no later match for either player by now is left ungraded (a final, or a draw the page stopped listing). */
export const LOWER_GIVE_UP_MS = 4 * 864e5;
/** The most matches kept in the log. */
export const LOWER_MAX = 600;
/** Under this share for the favourite the book has it near even: no lean. */
export const LOWER_CLOSE = 0.57;
/** A favourite shorter than the first is a parlay piece, not a bet alone; shorter than the second is named with no bet in it (the Tennis tab's own floors). */
export const LOWER_STRAIGHT_FLOOR = -250;
export const LOWER_SHORT = -700;
/** The favourite's share fallen this far since the price was first seen: the money is against it, no lean. */
export const LOWER_DRIFT = 0.05;
/** The favourite's share up this far since the price was first seen is said on the card. */
export const LOWER_STEAM = 0.03;
/** A book's cut wider than this on the two prices is no market to bet into. */
export const LOWER_CUT_MAX = 0.12;

/** The tier of a competition by FanDuel's name for it; null for one this board does not read (the tours, the exhibitions, an outright). */
export function lowerTierOf(comp) {
  const n = String(comp ?? '');
  if (/\butr\b/i.test(n)) return null; // round-robin exhibitions: no draw to read a result from
  if (/challenger/i.test(n)) return 'challenger';
  if (/\bitf\b/i.test(n)) return 'itf';
  if (/\b125k?\b/i.test(n)) return '125';
  return null;
}
/** Which of the tab's two tour chips a competition sits under: the women's events with the WTA, the rest with the ATP. */
export const lowerTourOf = (comp) => { const n = String(comp ?? ''); return /\bitf\s+w\d|women|ladies|\bwta\b/i.test(n) || (/\b125k?\b/i.test(n) && !/challenger|\batp\b/i.test(n)) ? 'wta' : 'atp'; };
export const LOWER_TIER_LABEL = { challenger: 'Challenger', itf: 'ITF', 125: 'WTA 125' };

const decimalOf = (american) => (american > 0 ? 1 + american / 100 : 1 + 100 / -american);
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const pct = (x) => `${Math.round(x * 100)}%`;
const round3 = (x) => Math.round(x * 1000) / 1000;

/** The two players' shares from the two prices with the book's cut taken out: {a, b, cut}; null without both prices. */
export function lowerShares(ml) {
  if (!Number.isFinite(ml?.a) || !Number.isFinite(ml?.b) || !ml.a || !ml.b) return null;
  const ia = 1 / decimalOf(ml.a); const ib = 1 / decimalOf(ml.b);
  return { a: ia / (ia + ib), b: ib / (ia + ib), cut: ia + ib - 1 };
}

/** A player's points count for this much against the other's: the win share is each side's points to this power, over the two together. */
export const LOWER_RANK_POWER = 0.85;
/** Points added to both players before that: a handful of points apart says little, and a player with none is not nothing. */
export const LOWER_RANK_PRIOR = 10;
/** The ranking's say against the price's in the read, where both players are ranked. */
export const LOWER_RANK_WEIGHT = 0.5;
/** The price and the ranking further apart than this on who wins: the price knows something the ranking does not, and there is no lean. */
export const LOWER_APART = 0.15;
/** A lean the read gives this much more than its price asks is marked as having room. */
export const LOWER_VALUE = 0.02;

/** Player A's share of a match on ranking points alone. */
export function rankShare(pointsA, pointsB) {
  const a = (Math.max(0, pointsA) + LOWER_RANK_PRIOR) ** LOWER_RANK_POWER; const b = (Math.max(0, pointsB) + LOWER_RANK_PRIOR) ** LOWER_RANK_POWER;
  return a / (a + b);
}

/**
 * The call on one match: {kind: 'lean', side, name, opponent, american,
 * share, implied, edge, how: 'straight'|'parlay'|'short', basis:
 * 'rank'|'price', value, moved, ranks, why} or {kind: 'none', reason,
 * text, why}. `m` is a logged match: {tour, a, b, ml: {a, b}, open: {a,
 * b}}, the prices American. `ranks` is the week's rankings
 * (worker/src/tennis-lower-ranks.js), or null.
 *
 * Where both players are ranked the read is the ranking's share and the
 * price's, half each (`basis: 'rank'`), and a lean it gives more than its
 * price asks has `value`. Where one is not, the price is the whole read
 * (`basis: 'price'`). A 'short' lean is the winner named at a price with
 * no bet in it.
 */
export function lowerCall(m, ranks = null) {
  const list = ranks?.[m?.tour] ?? null;
  const ra = rankOf(list, m?.a); const rb = rankOf(list, m?.b);
  const ranked = Boolean(ra && rb);
  const pRankA = ranked ? rankShare(ra.points, rb.points) : null;
  const rankLine = ranked ? `Rankings: ${m.a} #${ra.rank} (${ra.points} points), ${m.b} #${rb.rank} (${rb.points})` : null;
  const now = lowerShares(m?.ml);
  if (!now) {
    const fav = ranked ? (pRankA >= 0.5 ? m.a : m.b) : null;
    return { kind: 'none', reason: 'unpriced', text: fav ? `No price up yet. The rankings favour ${fav}` : 'No price up yet', ranks: { a: ra, b: rb }, why: rankLine ? [rankLine] : [] };
  }
  const pA = ranked ? LOWER_RANK_WEIGHT * pRankA + (1 - LOWER_RANK_WEIGHT) * now.a : now.a;
  const side = pA >= 0.5 ? 'a' : 'b'; const other = side === 'a' ? 'b' : 'a';
  const name = m[side]; const opponent = m[other];
  const of = (p) => (side === 'a' ? p : 1 - p);
  const share = of(pA); const market = of(now.a); const rankP = ranked ? of(pRankA) : null;
  const american = m.ml[side];
  const implied = 1 / decimalOf(american);
  const edge = share - implied;
  const open = lowerShares(m.open);
  const moved = open ? round3(market - open[side]) : null;
  const prices = `${m.a} ${signed(m.ml.a)}, ${m.b} ${signed(m.ml.b)}`;
  const missing = [ra ? null : m.a, rb ? null : m.b].filter(Boolean);
  const base = [
    ranked ? `${rankLine}. On points alone that is ${name} ${pct(rankP)}` : list ? `No ranking on file for ${missing.join(' or ')}: the price is the only read` : `The price is the only read here: no rankings are on file yet`,
    `FanDuel: ${prices}. With the book's cut out that is ${name} ${pct(market)}, ${opponent} ${pct(1 - market)}`,
  ];
  const facts = { side, name, opponent, share: round3(share), market: round3(market), rankShare: rankP == null ? null : round3(rankP), basis: ranked ? 'rank' : 'price', moved, ranks: { a: ra, b: rb } };
  const none = (reason, text, extra = []) => ({ kind: 'none', reason, text, ...facts, why: [...base, ...extra] });
  if (now.cut > LOWER_CUT_MAX) return none('cut', `Poorly priced: the book keeps ${pct(now.cut)} on this match`);
  if (ranked && Math.abs(pRankA - now.a) > LOWER_APART) {
    const byPrice = now.a >= 0.5 ? 'a' : 'b'; const byRank = pRankA >= 0.5 ? 'a' : 'b';
    return none('apart', `The price and the rankings disagree: the price has ${m[byPrice]} ${pct(Math.max(now.a, now.b))}, the rankings ${m[byRank]} ${pct(Math.max(pRankA, 1 - pRankA))}`, [`This far apart the price usually knows something the ranking does not: an injury, a player back from a long break, a junior on the way up`]);
  }
  if (moved != null && moved <= -LOWER_DRIFT) return none('drift', `The money is against ${name}: ${signed(m.open[side])} when first seen, ${signed(american)} now`, [`A side whose price lengthens this far before the start is one to leave alone`]);
  if (share < LOWER_CLOSE) return none('close', `Too close to call: ${pct(share)} to ${pct(1 - share)} by ${ranked ? 'the read' : 'the price'}`);
  const how = american >= LOWER_STRAIGHT_FLOOR ? 'straight' : american >= LOWER_SHORT ? 'parlay' : 'short';
  const value = ranked && how !== 'short' && edge >= LOWER_VALUE;
  const why = [...base];
  const room = Math.round(Math.abs(edge) * 100);
  if (ranked) why.push(`The read is the two together: ${name} ${pct(share)}. ${signed(american)} asks for ${pct(implied)}${edge >= LOWER_VALUE ? `, so the read leaves ${room} point${room === 1 ? '' : 's'} of room` : edge >= 0 ? ', about what the read gives' : `, ${room} point${room === 1 ? '' : 's'} more than the read gives: that is the book's cut`}`);
  if (moved != null && moved >= LOWER_STEAM) why.push(`The price has shortened since it was first seen, ${signed(m.open[side])} to ${signed(american)}: the money agrees`);
  why.push(how === 'straight' ? `Playable alone at ${signed(american)} or better, half a unit at most: a lean, not a tracked play` : how === 'parlay' ? `Too short to take alone at ${signed(american)}: a parlay piece` : `Priced as all but won at ${signed(american)}: the lean is plain, and there is no bet in it, alone or in a parlay`);
  return { kind: 'lean', ...facts, american, implied: round3(implied), edge: round3(edge), how, value, why };
}

const compKey = (m) => String(m.compId ?? m.comp ?? '');
const hasPlayer = (m, key) => nameKey(m.a) === key || nameKey(m.b) === key;

/**
 * The winner of a started match, read from the draw: 'a' or 'b' when
 * exactly one of its players is listed in a later match of the same
 * tournament, null otherwise (neither yet, or both: a match listed again).
 */
export function winnerFromDraw(m, all) {
  const ka = nameKey(m.a); const kb = nameKey(m.b);
  let a = false; let b = false;
  for (const n of all) {
    if (n.id === m.id || compKey(n) !== compKey(m) || !(n.start > m.start)) continue;
    const na = hasPlayer(n, ka); const nb = hasPlayer(n, kb);
    if (na && nb) continue;
    if (na) a = true;
    if (nb) b = true;
  }
  return a === b ? null : a ? 'a' : 'b';
}

const emptyTally = () => ({ straight: { wins: 0, losses: 0, units: 0 }, parlay: { wins: 0, losses: 0 }, short: { wins: 0, losses: 0 }, value: { wins: 0, losses: 0, units: 0 }, since: null });

/**
 * The log with one read of the page folded in.
 *
 * `board` is the page's lower-tier singles: [{id, comp, compId, a, b,
 * start, inPlay, ml: {a, b, market, selA, selB}|null}]. A match not yet
 * started takes the price read and its call; one in play, or past its
 * start, keeps the last price it had before (that is the price a lean is
 * graded at). Then every started match without a result is read against
 * the draw, a graded lean goes on the tally, and old matches fall off.
 * Returns the new log: {at, matches: {id: match}, tally}.
 */
export function mergeLower(log, board, now = Date.now(), ranks = null) {
  const matches = { ...(log?.matches ?? {}) };
  const tally = { ...emptyTally(), ...(log?.tally ?? {}) };
  tally.straight = { ...emptyTally().straight, ...tally.straight }; tally.parlay = { ...emptyTally().parlay, ...tally.parlay }; tally.short = { ...emptyTally().short, ...tally.short }; tally.value = { ...emptyTally().value, ...tally.value };
  for (const e of board ?? []) {
    if (!e?.id || !e.a || !e.b || !Number.isFinite(e.start)) continue;
    const tier = lowerTierOf(e.comp); if (!tier) continue;
    const prev = matches[e.id];
    if (prev?.result) continue;
    const started = e.inPlay === true || e.start <= now;
    const base = { id: String(e.id), comp: e.comp ?? null, compId: e.compId ?? null, tour: lowerTourOf(e.comp), tier, a: e.a, b: e.b, start: e.start, firstAt: prev?.firstAt ?? now, seenAt: now };
    if (started) { matches[e.id] = { ...base, ml: prev?.ml ?? null, open: prev?.open ?? null, call: prev?.call ?? null, live: true }; continue; }
    const ml = e.ml && Number.isFinite(e.ml.a) && Number.isFinite(e.ml.b) ? e.ml : prev?.ml ?? null;
    const open = prev?.open ?? (ml ? { a: ml.a, b: ml.b } : null);
    const m = { ...base, ml, open };
    const call = lowerCall(m, ranks);
    m.call = call.kind === 'lean' ? { kind: 'lean', side: call.side, how: call.how, american: call.american, basis: call.basis, ...(call.value ? { value: true } : {}) } : { kind: 'none', reason: call.reason };
    matches[e.id] = m;
  }
  const all = Object.values(matches);
  for (const m of all) {
    if (m.result || !(m.start <= now)) continue;
    const winner = winnerFromDraw(m, all);
    if (!winner) { if (now - m.start > LOWER_GIVE_UP_MS) { m.result = 'unknown'; m.gradedAt = now; } continue; }
    m.result = winner; m.gradedAt = now;
    if (m.call?.kind !== 'lean') continue;
    const won = m.call.side === winner;
    m.call = { ...m.call, result: won ? 'win' : 'loss' };
    tally.since = tally.since ?? now;
    const count = (t) => { if (won) { t.wins += 1; t.units = Math.round((t.units + decimalOf(m.call.american) - 1) * 100) / 100; } else { t.losses += 1; t.units = Math.round((t.units - 1) * 100) / 100; } };
    // The leans the rankings gave room on, whatever their price, counted apart: they are the ones with a view of their own.
    if (m.call.value) count(tally.value);
    if (m.call.how === 'straight') count(tally.straight); else { const t = m.call.how === 'short' ? tally.short : tally.parlay; if (won) t.wins += 1; else t.losses += 1; }
  }
  const kept = all.filter((m) => m.start > now - LOWER_KEEP_MS).sort((x, y) => y.start - x.start).slice(0, LOWER_MAX);
  return { at: now, matches: Object.fromEntries(kept.map((m) => [m.id, m])), tally };
}

/** A player's wins in this tournament so far, by the draw. */
const winsHere = (name, m, all) => { const k = nameKey(name); return all.filter((n) => n.id !== m.id && compKey(n) === compKey(m) && n.start < m.start && ((n.result === 'a' && nameKey(n.a) === k) || (n.result === 'b' && nameKey(n.b) === k))).length; };

/**
 * The Tennis tab's read of the log: the matches still to come, each with
 * its call, the soonest first; the leans' tally; and the leans graded in
 * the last few days. {at, matches, tally, recent}.
 */
export function lowerBoard(log, now = Date.now(), ranks = null) {
  const all = Object.values(log?.matches ?? {});
  const matches = all.filter((m) => !m.live && !m.result && m.start > now).sort((x, y) => x.start - y.start || String(x.comp).localeCompare(String(y.comp)) || String(x.a).localeCompare(String(y.a))).map((m) => {
    const call = lowerCall(m, ranks);
    const run = { a: winsHere(m.a, m, all), b: winsHere(m.b, m, all) };
    if (call.why.length >= 2 && (run.a || run.b)) call.why.splice(2, 0, `Here this week: ${m.a} ${run.a} win${run.a === 1 ? '' : 's'}, ${m.b} ${run.b}`);
    const link = call.kind === 'lean' && m.ml?.market && m.ml[call.side === 'a' ? 'selA' : 'selB'] != null ? fanduelSlipLink(m.ml.market, m.ml[call.side === 'a' ? 'selA' : 'selB']) : null;
    return { id: m.id, tour: m.tour, tier: m.tier, comp: m.comp, a: m.a, b: m.b, start: m.start, ml: m.ml ? { a: m.ml.a, b: m.ml.b } : null, open: m.open ?? null, pricedAt: m.seenAt ?? null, call: { ...call, link } };
  });
  const recent = all.filter((m) => m.call?.result).sort((x, y) => (y.gradedAt ?? 0) - (x.gradedAt ?? 0)).slice(0, 12).map((m) => ({ id: m.id, comp: m.comp, tour: m.tour, a: m.a, b: m.b, start: m.start, name: m[m.call.side], american: m.call.american, how: m.call.how, result: m.call.result }));
  return { at: log?.at ?? null, ranksAt: ranks?.at ?? null, matches, tally: { ...emptyTally(), ...(log?.tally ?? {}) }, recent };
}

/** The Tennis tab's lower-tier board from KV; an empty one when the runner has not written it. */
export async function getTennisLower(env, now = Date.now()) {
  const raw = await env.POTD_KV.get(TENNIS_LOWER_KEY).catch(() => null);
  let log = null;
  try { log = raw ? JSON.parse(raw) : null; } catch { log = null; }
  return lowerBoard(log, now, await getLowerRanks(env).catch(() => null));
}
