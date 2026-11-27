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
 * clear of a coin flip and the money has not gone against it. A match is
 * left alone, with the reason, when the book has it near even, when the
 * favourite's price has drifted, when the favourite is priced as all but
 * won, or when the book's cut is too wide to bet into. A lean is never a
 * tracked play and never counts in the day's units.
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

export const TENNIS_LOWER_KEY = 'tennis:lower';
/** A match stays in the log this long after its start: long enough for the next round to be listed. */
export const LOWER_KEEP_MS = 8 * 864e5;
/** A started match with no later match for either player by now is left ungraded (a final, or a draw the page stopped listing). */
export const LOWER_GIVE_UP_MS = 4 * 864e5;
/** The most matches kept in the log. */
export const LOWER_MAX = 600;
/** Under this share for the favourite the book has it near even: no lean. */
export const LOWER_CLOSE = 0.57;
/** A favourite shorter than the first is a parlay piece, not a bet alone; shorter than the second is no bet at all (the Tennis tab's own floors). */
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

/**
 * The call on one match: {kind: 'lean', side, name, opponent, american,
 * share, implied, how: 'straight'|'parlay', moved, why} or {kind: 'none',
 * reason, text, why}. `m` is a logged match: {a, b, ml: {a, b}, open: {a,
 * b}}, the prices American.
 */
export function lowerCall(m) {
  const now = lowerShares(m?.ml);
  if (!now) return { kind: 'none', reason: 'unpriced', text: 'No price up yet', why: [] };
  const side = now.a >= now.b ? 'a' : 'b'; const other = side === 'a' ? 'b' : 'a';
  const name = m[side]; const opponent = m[other];
  const share = now[side]; const american = m.ml[side];
  const open = lowerShares(m.open);
  const moved = open ? round3(share - open[side]) : null;
  const prices = `${m.a} ${signed(m.ml.a)}, ${m.b} ${signed(m.ml.b)}`;
  const base = [`The price is the read here: no serve numbers or results are on file for players at this level`, `FanDuel: ${prices}. With the book's cut out that is ${name} ${pct(share)}, ${opponent} ${pct(1 - share)}`];
  const none = (reason, text, extra = []) => ({ kind: 'none', reason, text, side, name, opponent, share: round3(share), moved, why: [...base, ...extra] });
  if (now.cut > LOWER_CUT_MAX) return none('cut', `Poorly priced: the book keeps ${pct(now.cut)} on this match`);
  if (moved != null && moved <= -LOWER_DRIFT) return none('drift', `The money is against ${name}: ${signed(m.open[side])} when first seen, ${signed(american)} now`, [`A favourite whose price lengthens this far before the start is one to leave alone`]);
  if (share < LOWER_CLOSE) return none('close', `Too close to call: ${pct(share)} to ${pct(1 - share)} by the price`);
  if (american < LOWER_SHORT) return none('short', `${name} is priced as all but won at ${signed(american)}: nothing to take`);
  const how = american >= LOWER_STRAIGHT_FLOOR ? 'straight' : 'parlay';
  const why = [...base];
  if (moved != null && moved >= LOWER_STEAM) why.push(`The price has shortened since it was first seen, ${signed(m.open[side])} to ${signed(american)}: the money agrees`);
  why.push(how === 'straight' ? `Playable alone at ${signed(american)} or better, half a unit at most: a lean off the price, not a tracked play` : `Too short to take alone at ${signed(american)}: a parlay piece`);
  return { kind: 'lean', side, name, opponent, american, share: round3(share), implied: round3(1 / decimalOf(american)), how, moved, why };
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

const emptyTally = () => ({ straight: { wins: 0, losses: 0, units: 0 }, parlay: { wins: 0, losses: 0 }, since: null });

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
export function mergeLower(log, board, now = Date.now()) {
  const matches = { ...(log?.matches ?? {}) };
  const tally = { ...emptyTally(), ...(log?.tally ?? {}) };
  tally.straight = { ...emptyTally().straight, ...tally.straight }; tally.parlay = { ...emptyTally().parlay, ...tally.parlay };
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
    const call = lowerCall(m);
    m.call = call.kind === 'lean' ? { kind: 'lean', side: call.side, how: call.how, american: call.american } : { kind: 'none', reason: call.reason };
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
    if (m.call.how === 'straight') { const t = tally.straight; if (won) { t.wins += 1; t.units = Math.round((t.units + decimalOf(m.call.american) - 1) * 100) / 100; } else { t.losses += 1; t.units = Math.round((t.units - 1) * 100) / 100; } } else if (won) tally.parlay.wins += 1; else tally.parlay.losses += 1;
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
export function lowerBoard(log, now = Date.now()) {
  const all = Object.values(log?.matches ?? {});
  const matches = all.filter((m) => !m.live && !m.result && m.start > now).sort((x, y) => x.start - y.start || String(x.comp).localeCompare(String(y.comp)) || String(x.a).localeCompare(String(y.a))).map((m) => {
    const call = lowerCall(m);
    const run = { a: winsHere(m.a, m, all), b: winsHere(m.b, m, all) };
    if (call.why.length >= 2 && (run.a || run.b)) call.why.splice(2, 0, `Here this week: ${m.a} ${run.a} win${run.a === 1 ? '' : 's'}, ${m.b} ${run.b}`);
    const link = call.kind === 'lean' && m.ml?.market && m.ml[call.side === 'a' ? 'selA' : 'selB'] != null ? fanduelSlipLink(m.ml.market, m.ml[call.side === 'a' ? 'selA' : 'selB']) : null;
    return { id: m.id, tour: m.tour, tier: m.tier, comp: m.comp, a: m.a, b: m.b, start: m.start, ml: m.ml ? { a: m.ml.a, b: m.ml.b } : null, open: m.open ?? null, pricedAt: m.seenAt ?? null, call: { ...call, link } };
  });
  const recent = all.filter((m) => m.call?.result).sort((x, y) => (y.gradedAt ?? 0) - (x.gradedAt ?? 0)).slice(0, 12).map((m) => ({ id: m.id, comp: m.comp, tour: m.tour, a: m.a, b: m.b, start: m.start, name: m[m.call.side], american: m.call.american, how: m.call.how, result: m.call.result }));
  return { at: log?.at ?? null, matches, tally: log?.tally ?? emptyTally(), recent };
}

/** The Tennis tab's lower-tier board from KV; an empty one when the runner has not written it. */
export async function getTennisLower(env, now = Date.now()) {
  const raw = await env.POTD_KV.get(TENNIS_LOWER_KEY).catch(() => null);
  let log = null;
  try { log = raw ? JSON.parse(raw) : null; } catch { log = null; }
  return lowerBoard(log, now);
}
