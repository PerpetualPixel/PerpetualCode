/**
 * Pixel's Picks for the UFC: odds, breakdowns, the picks and the grading
 * for the card the tab shows (worker/src/ufc-card.js's nextUfcEvent).
 *
 * Odds come from The Odds API's MMA key (moneylines at every listed
 * sportsbook, total rounds at the books that post them), polled on a
 * cadence that keeps the credits down: four times a day in the run-up,
 * hourly on fight day, every quarter hour inside two hours of the lock.
 * PrizePicks is not in the MMA feed, so UFC tickets are sportsbook only.
 *
 * Each bout with odds gets one breakdown from the model (both fighters'
 * records, last five, methods, bio, the odds) with a lean, a confidence
 * of 1 to 5, the straight it likes (the moneyline or the rounds total)
 * and whether it is a sound parlay piece; cached per pairing, so a
 * replacement fighter gets a fresh read.
 *
 * A pick posts when the confidence is 4 or better and a listed book
 * prices the straight inside STRAIGHT_RANGE; at most six per card, one
 * per bout, never forced. Picks lock at the first bout. Before the lock
 * a pick follows its price while the same selection posts, is voided
 * when its bout is scrapped or a fighter replaced (the bout can be picked
 * again on the next read), and after the lock only grades: as each bout
 * finishes, the moneyline settles on the winner (a draw or no contest
 * voids), the rounds total on the finish time, a decision being the full
 * distance. Records live apart from NBA and NFL under ufc:picks:<eventId>.
 */
import { getUfcEvents, getUfcEvent, nextUfcEvent, getUfcFighter } from './ufc-card.js';
import { normalizeName, namesLikelyMatch } from './ufc-events.js';
import { callModel, STRAIGHT_RANGE, betRecordOf, TICKET_UNITS } from './trend-picks.js';
import { bookIdFor, SPORTSBOOKS, americanToDecimal } from '../../docs/engine.js';

export const UFC_SPORT = 'mma_mixed_martial_arts';
/** The books a UFC ticket can sit at: the sportsbooks on the Pixel's Picks list (PrizePicks carries no MMA in the feed). */
export const UFC_BOOKS = ['fanduel', 'draftkings', 'caesars', 'hardrock', 'bet365', 'fanatics', 'betmgm'];
const UFC_FEED_BOOKS = 'fanduel,draftkings,williamhill_us,hardrockbet,bet365,fanatics,betmgm';
export const UFC_MAX_PICKS = 6;
export const UFC_MIN_CONFIDENCE = 4;
export const UFC_RECORD_VERSION = 1;
const ROUND_MS = 5 * 60e3;
const KV_TTL = 60 * 86400;

export const ufcOddsKey = 'ufc:odds';
export const ufcPicksKey = (eventId) => `ufc:picks:${eventId}`;
/** Every card with a picks record, newest first, so the ledger outlives the runner's two-month card window. */
export const ufcPicksIndexKey = 'ufc:picks:index';
export const ufcBreakdownKey = (bout) => `ufc:breakdown:v2:${bout.id}:${bout.a?.id ?? '-'}-${bout.b?.id ?? '-'}`;
const bookName = (id) => SPORTSBOOKS[id]?.name ?? id;
const bookUrl = (id) => SPORTSBOOKS[id]?.url ?? null;
const inRange = (american, [lo, hi]) => american >= lo && american <= hi;

/* ---------------- odds ---------------- */

/** How long the last odds read stays good, by the time to the lock. */
export function oddsTtlMs(lockMs, now) {
  const left = lockMs - now;
  if (left <= 2 * 3600e3) return 15 * 60e3;
  if (left <= 24 * 3600e3) return 60 * 60e3;
  return 6 * 3600e3;
}

/** The feed's MMA board, from KV while the last read is still good, else fetched and written. */
export async function fetchUfcOdds(env, ctx, lockMs, now = Date.now(), { deps = {} } = {}) {
  const raw = await env.POTD_KV.get(ufcOddsKey).catch(() => null);
  const stored = raw ? JSON.parse(raw) : null;
  if (stored && now - (stored.at ?? 0) < oddsTtlMs(lockMs, now)) return { ...stored, cached: true };
  let events = null;
  if (deps.odds) events = await deps.odds();
  else if (env.ODDS_API_KEY) {
    const url = new URL(`https://api.the-odds-api.com/v4/sports/${UFC_SPORT}/odds`);
    url.searchParams.set('apiKey', env.ODDS_API_KEY.trim());
    url.searchParams.set('bookmakers', UFC_FEED_BOOKS);
    url.searchParams.set('markets', 'h2h,totals');
    url.searchParams.set('oddsFormat', 'american');
    url.searchParams.set('dateFormat', 'iso');
    url.searchParams.set('includeLinks', 'true');
    try { const res = await fetch(url); if (res.ok) events = await res.json(); } catch { events = null; }
  }
  if (!Array.isArray(events)) return stored ? { ...stored, cached: true, stale: true } : { at: null, events: [] };
  const record = { at: now, events: events.map((e) => ({ id: e.id, commence: e.commence_time ?? e.commence ?? null, home: e.home_team ?? e.home, away: e.away_team ?? e.away, bookmakers: (e.bookmakers ?? []).map((b) => ({ key: b.key, link: b.link ?? null, markets: (b.markets ?? []).map((m) => ({ key: m.key, link: m.link ?? null, outcomes: (m.outcomes ?? []).map((o) => ({ name: o.name, point: o.point, price: o.price, link: o.link ?? null })) })) })) })) };
  await env.POTD_KV.put(ufcOddsKey, JSON.stringify(record), { expirationTtl: 7 * 86400 }).catch(() => {});
  return { ...record, cached: false };
}

/** The feed event for a bout: both fighter names match either way round. */
export function feedEventFor(bout, events) {
  const a = normalizeName(bout.a?.name); const b = normalizeName(bout.b?.name);
  if (!a || !b) return null;
  return (events ?? []).find((e) => { const h = normalizeName(e.home); const w = normalizeName(e.away); return (namesLikelyMatch(h, a) && namesLikelyMatch(w, b)) || (namesLikelyMatch(h, b) && namesLikelyMatch(w, a)); }) ?? null;
}

/**
 * A bout's quotes at the listed books: each fighter's moneyline, best
 * price first, and the rounds totals by number. Each quote carries the
 * book's deep link when the feed has one.
 */
export function boutOdds(bout, events) {
  const e = feedEventFor(bout, events);
  if (!e) return null;
  const a = normalizeName(bout.a?.name); const b = normalizeName(bout.b?.name);
  const ml = { a: [], b: [] }; const totals = new Map();
  for (const bk of e.bookmakers ?? []) {
    const bookId = bookIdFor(bk.key) ?? bk.key;
    if (!UFC_BOOKS.includes(bookId)) continue;
    for (const m of bk.markets ?? []) {
      for (const o of m.outcomes ?? []) {
        if (!Number.isFinite(o.price)) continue;
        const q = { bookId, book: bookName(bookId), american: o.price, decimal: americanToDecimal(o.price), link: o.link ?? m.link ?? bk.link ?? null };
        if (m.key === 'h2h') {
          const n = normalizeName(o.name);
          if (namesLikelyMatch(n, a)) ml.a.push(q); else if (namesLikelyMatch(n, b)) ml.b.push(q);
        } else if (m.key === 'totals' && Number.isFinite(o.point)) {
          const side = String(o.name).toLowerCase();
          if (side !== 'over' && side !== 'under') continue;
          if (!totals.has(o.point)) totals.set(o.point, { point: o.point, over: [], under: [] });
          totals.get(o.point)[side].push(q);
        }
      }
    }
  }
  const best = (list) => list.sort((x, y) => y.american - x.american);
  return { feedId: e.id, a: best(ml.a), b: best(ml.b), totals: [...totals.values()].map((t) => ({ point: t.point, over: best(t.over), under: best(t.under) })).sort((x, y) => x.point - y.point) };
}

/* ---------------- breakdowns ---------------- */

const fmtAm = (n) => (n > 0 ? `+${n}` : String(n));
const daysBetween = (a, b) => Math.round(Math.abs(a - b) / 864e5);

function fighterFacts(f, side, now) {
  if (!f) return `${side}: no profile.`;
  const r = f.record ?? {}; const b = f.bio ?? {};
  const last = (f.history ?? []).slice(0, 3).map((h) => `${h.result === 'win' ? 'beat' : h.result === 'loss' ? 'lost to' : h.result} ${h.opponent?.name ?? '?'}${h.method ? ` by ${h.method}` : ''}${h.round ? ` R${h.round}` : ''}`).join('; ');
  const since = f.history?.[0]?.date ? `${daysBetween(now, f.history[0].date)} days since last fight` : 'no recent fight on record';
  const m = f.methods ?? {};
  return `${side}: ${f.name}, ${r.wins ?? '?'}-${r.losses ?? '?'}-${r.draws ?? 0}, last five ${(f.lastFive ?? []).map((x) => x[0].toUpperCase()).join('') || 'n/a'}; wins by KO ${m.wins?.ko ?? '?'}, sub ${m.wins?.sub ?? '?'}, dec ${m.wins?.dec ?? '?'}; losses by KO ${m.losses?.ko ?? '?'}, sub ${m.losses?.sub ?? '?'}, dec ${m.losses?.dec ?? '?'}; age ${b.age ?? '?'}, ${b.height ?? '?'}, reach ${b.reach ?? '?'}, ${b.stance ?? '?'}${b.style ? `, ${b.style}` : ''}${b.team ? `, ${b.team}` : ''}; ${since}; recent: ${last || 'none'}.`;
}

/** The model's JSON for a bout, or null when it sent anything else. */
export function parseUfcBreakdown(text, bout) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    // The model writes A and B as asked; the record keeps them lower case.
    const sideOf = (v) => { const t = String(v ?? '').trim().toLowerCase(); return t === 'a' || t === 'b' ? t : null; };
    const lean = sideOf(o.lean);
    const confidence = Math.max(1, Math.min(5, Math.round(Number(o.confidence))));
    if (!lean || !Number.isFinite(confidence)) return null;
    const s = o.straight ?? {};
    const market = s.market === 'totals' ? 'totals' : 'h2h';
    const straight = market === 'totals'
      ? { market, side: String(s.side).toLowerCase() === 'under' ? 'under' : 'over', point: Number.isFinite(Number(s.point)) ? Number(s.point) : null }
      : { market, fighter: sideOf(s.fighter) ?? lean };
    return { lean, confidence, straight, parlayPiece: Boolean(o.parlayPiece), summary: typeof o.summary === 'string' ? o.summary.trim().slice(0, 320) : '', reasons: Array.isArray(o.reasons) ? o.reasons.filter((r) => typeof r === 'string').map((r) => r.trim().slice(0, 160)).slice(0, 4) : [], leanName: lean === 'a' ? bout.a?.name : bout.b?.name };
  } catch { return null; }
}

/** One bout's breakdown, cached per pairing. */
export async function ufcBreakdown(env, event, bout, odds, now = Date.now(), { deps = {} } = {}) {
  const key = ufcBreakdownKey(bout);
  const cached = await env.POTD_KV.get(key).catch(() => null);
  if (cached) return JSON.parse(cached);
  const [fa, fb] = await Promise.all([deps.fighter ? deps.fighter(bout.a?.id) : getUfcFighter(env, bout.a?.id), deps.fighter ? deps.fighter(bout.b?.id) : getUfcFighter(env, bout.b?.id)]);
  const notice = (event.changes ?? []).filter((c) => c.boutId === bout.id && c.type === 'replaced').map((c) => c.detail).join('; ');
  const line = odds ? `Moneyline: ${bout.a?.name} ${odds.a[0] ? fmtAm(odds.a[0].american) : 'n/a'}, ${bout.b?.name} ${odds.b[0] ? fmtAm(odds.b[0].american) : 'n/a'}.${odds.totals.length ? ` Rounds total ${odds.totals.map((t) => `${t.point} (over ${t.over[0] ? fmtAm(t.over[0].american) : 'n/a'}, under ${t.under[0] ? fmtAm(t.under[0].american) : 'n/a'})`).join('; ')}.` : ' No rounds total posted.'}` : 'No odds posted yet.';
  const facts = [
    `${event.name}: ${bout.weightClass ?? ''}${bout.title ? ' title fight' : ''}, ${bout.rounds ?? 3} rounds, ${bout.segment === 'main' ? 'main card' : bout.segment}.`,
    fighterFacts(fa, 'A', now), fighterFacts(fb, 'B', now),
    notice ? `Card change: ${notice}.` : null, line,
  ].filter(Boolean).join('\n');
  const prompt = `You break down one UFC fight for a bettor. Use only the facts below and what you know of these fighters' styles in general; do not invent news.

${facts}

Pick the side you lean to (A or B), a confidence from 1 to 5 (5 only when the record, the matchup and the price all agree), the one straight bet you like most (the moneyline on A or B, or the rounds total over or under the posted number), and whether the moneyline is a sound parlay piece (a heavy favourite with little finish risk against). Reply with JSON only, no dashes in the text: {"lean":"A"|"B","confidence":1-5,"straight":{"market":"h2h","fighter":"A"|"B"} or {"market":"totals","side":"over"|"under","point":2.5},"parlayPiece":true|false,"summary":"<one sentence>","reasons":["<short point>","<short point>","<short point>"]}`;
  const text = deps.model ? await deps.model(prompt) : await callModel(prompt, env, { maxTokens: 500 });
  const parsed = parseUfcBreakdown(text, bout);
  const result = parsed ? { ...parsed, boutId: bout.id, at: now, model: true } : { boutId: bout.id, at: now, lean: null, confidence: 0, straight: null, parlayPiece: false, summary: 'The read was not available.', reasons: [], model: false };
  await env.POTD_KV.put(key, JSON.stringify(result), { expirationTtl: 3 * 86400 }).catch(() => {});
  return result;
}

/* ---------------- picks ---------------- */

/** The quote the breakdown's straight points at, best price among the listed books, or null. */
export function straightQuote(bout, breakdown, odds) {
  const s = breakdown?.straight; if (!s || !odds) return null;
  if (s.market === 'h2h') {
    const q = (s.fighter === 'b' ? odds.b : odds.a)[0];
    const f = s.fighter === 'b' ? bout.b : bout.a;
    return q ? { ...q, market: 'h2h', fighterId: f?.id ?? null, selection: `${f?.name} to win`, point: null, side: null } : null;
  }
  const t = odds.totals.find((x) => x.point === s.point) ?? odds.totals.find((x) => x.point === 2.5) ?? odds.totals[0];
  const q = t?.[s.side]?.[0];
  return q && t ? { ...q, market: 'totals', fighterId: null, selection: `${s.side === 'over' ? 'Over' : 'Under'} ${t.point} rounds`, point: t.point, side: s.side } : null;
}

const pickId = (eventId, bout, q) => `${eventId}:${bout.id}:${q.market}:${q.side ?? q.fighterId}`;

function pickRecord(event, bout, breakdown, q, now) {
  return {
    id: pickId(event.id, bout, q), type: 'straight', sportKey: UFC_SPORT, sportTitle: 'UFC', eventId: event.id, eventName: event.name, boutId: bout.id,
    bookId: q.bookId, book: q.book, bookUrl: bookUrl(q.bookId), link: q.link ?? null,
    american: q.american, decimal: Math.round(q.decimal * 10000) / 10000, units: TICKET_UNITS, commenceMs: bout.date ?? event.date, postedAt: now,
    legs: [{ id: `${bout.id}:${q.market}`, boutId: bout.id, selection: q.selection, market: q.market, fighterId: q.fighterId, point: q.point, side: q.side, american: q.american, link: q.link ?? null, a: bout.a?.name, b: bout.b?.name, weightClass: bout.weightClass, rounds: bout.rounds ?? 3, confidence: breakdown.confidence, note: breakdown.summary, result: null, actual: null }],
    status: 'pending', result: null, net: null, settledAt: null,
  };
}

/** Settle one pick from its bout's result: the moneyline on the winner, the rounds total on the finish time. */
export function settleUfcPick(pick, bout) {
  const leg = pick.legs[0]; const r = bout?.result;
  if (bout?.status === 'cancelled') return { result: 'void', net: 0, actual: 'off the card' };
  if (bout?.status !== 'final' || !r) return null;
  if (leg.market === 'h2h') {
    if (r.draw || !r.winnerId) return { result: 'void', net: 0, actual: 'draw or no contest' };
    const won = r.winnerId === leg.fighterId;
    return { result: won ? 'win' : 'loss', net: won ? Math.round((pick.decimal - 1) * pick.units * 100) / 100 : -pick.units, actual: `${r.winnerId === bout.a?.id ? bout.a?.name : bout.b?.name} by ${r.method ?? '?'}${r.round ? ` R${r.round}` : ''}` };
  }
  // The rounds total: a finish's elapsed time against the number; a decision is the distance.
  const rounds = leg.rounds ?? bout.rounds ?? 3;
  const isDecision = /dec/i.test(r.method ?? '') || !r.round;
  const elapsedMs = isDecision ? rounds * ROUND_MS : (r.round - 1) * ROUND_MS + (() => { const m = String(r.time ?? '').match(/^(\d+):(\d+)$/); return m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : 0; })();
  const lineMs = leg.point * ROUND_MS;
  if (elapsedMs === lineMs) return { result: 'push', net: 0, actual: `${(elapsedMs / ROUND_MS).toFixed(2)} rounds` };
  const over = elapsedMs > lineMs;
  const won = leg.side === 'over' ? over : !over;
  return { result: won ? 'win' : 'loss', net: won ? Math.round((pick.decimal - 1) * pick.units * 100) / 100 : -pick.units, actual: isDecision ? `went the distance (${rounds} rounds)` : `ended R${r.round} ${r.time ?? ''} (${(elapsedMs / ROUND_MS).toFixed(2)} rounds)` };
}

/** The lock: the first scheduled bout's start, else the event's. */
export const ufcLockMs = (event) => Math.min(...(event.bouts ?? []).filter((b) => b.status !== 'cancelled' && b.date).map((b) => b.date), event.date ?? Infinity);

/**
 * One pass for the card the tab shows: odds on cadence, a breakdown per
 * bout with odds, the picks drawn or refreshed before the lock, every
 * finished bout graded. Returns what it did.
 */
export async function runUfcTick(env, ctx, now = Date.now(), { deps = {} } = {}) {
  const index = deps.events ? await deps.events() : await getUfcEvents(env);
  const next = nextUfcEvent(index.events, now);
  if (!next) return { skipped: true, reason: 'no card' };
  const event = deps.event ? await deps.event(next.id) : await getUfcEvent(env, next.id);
  if (!event) return { skipped: true, reason: 'no card record' };
  const lock = ufcLockMs(event);
  const raw = await env.POTD_KV.get(ufcPicksKey(event.id)).catch(() => null);
  const record = raw ? JSON.parse(raw) : { version: UFC_RECORD_VERSION, eventId: event.id, eventName: event.name, eventDate: event.date, generatedAt: now, lockMs: lock, bets: [], passed: [], breakdowns: {}, oddsAt: null };
  const locked = now >= lock;
  let posted = 0; let graded = 0; const voided = [];
  if (!locked) {
    const odds = await fetchUfcOdds(env, ctx, lock, now, { deps });
    record.oddsAt = odds.at ?? record.oddsAt;
    const live = event.bouts.filter((b) => b.status === 'scheduled' && b.a?.id && b.b?.id);
    const byBout = new Map();
    for (const bout of live) {
      const bo = boutOdds(bout, odds.events);
      if (!bo || (!bo.a.length && !bo.b.length)) continue;
      const bd = await ufcBreakdown(env, event, bout, bo, now, { deps });
      byBout.set(bout.id, { bout, odds: bo, breakdown: bd });
      record.breakdowns[bout.id] = { lean: bd.lean, leanName: bd.leanName ?? null, confidence: bd.confidence, straight: bd.straight, parlayPiece: bd.parlayPiece, summary: bd.summary, reasons: bd.reasons, model: bd.model, bestA: bo.a[0] ?? null, bestB: bo.b[0] ?? null, quotesA: bo.a.slice(0, 8), quotesB: bo.b.slice(0, 8), totals: bo.totals.map((t) => ({ point: t.point, over: t.over[0] ?? null, under: t.under[0] ?? null })) };
    }
    // Existing picks: voided when the bout is gone or a fighter changed; otherwise the price follows while the same selection posts.
    for (const pick of record.bets) {
      if (pick.status !== 'pending') continue;
      const bout = event.bouts.find((b) => b.id === pick.boutId);
      const leg = pick.legs[0];
      const changed = !bout || bout.status === 'cancelled' || (leg.market === 'h2h' && bout.a?.id !== leg.fighterId && bout.b?.id !== leg.fighterId) || (bout.a?.name !== leg.a || bout.b?.name !== leg.b);
      if (changed) { pick.status = 'void'; pick.result = 'void'; pick.net = 0; pick.settledAt = now; pick.voidReason = !bout || bout.status === 'cancelled' ? 'the bout came off the card' : 'a fighter was replaced'; voided.push(pick); continue; }
      // The pick tracks what it was drawn on: the price follows only while the same book posts the same selection at the same number.
      const bo = byBout.get(bout.id)?.odds;
      const same = !bo ? null : leg.market === 'h2h'
        ? (leg.fighterId === bout.b?.id ? bo.b : bo.a).find((x) => x.bookId === pick.bookId) ?? null
        : bo.totals.find((t) => t.point === leg.point)?.[leg.side]?.find((x) => x.bookId === pick.bookId) ?? null;
      if (same) {
        if (same.american !== pick.american) { pick.american = same.american; pick.decimal = Math.round(same.decimal * 10000) / 10000; leg.american = same.american; pick.link = same.link ?? pick.link; pick.updatedAt = now; }
        if (pick.warning) { pick.warning = null; pick.updatedAt = now; }
      } else if (bo && leg.market === 'totals') {
        const posted = bo.totals.map((t) => t.point).filter((p) => p !== leg.point);
        const warning = posted.length ? `${pick.book} now posts ${posted.join(' and ')} rounds; the pick stays on the ${leg.point} it was drawn at and is not to be taken at the new number.` : `${pick.book} has pulled the rounds total; the pick stays on the ${leg.point} it was drawn at.`;
        if (pick.warning !== warning) { pick.warning = warning; pick.updatedAt = now; }
      }
    }
    // New picks: the strongest reads with a usable price, up to the cap, one per bout.
    const taken = new Set(record.bets.filter((b) => b.status === 'pending').map((b) => b.boutId));
    const open = UFC_MAX_PICKS - taken.size;
    const candidates = [...byBout.values()].filter(({ bout, breakdown }) => !taken.has(bout.id) && breakdown.confidence >= UFC_MIN_CONFIDENCE)
      .map((x) => ({ ...x, q: straightQuote(x.bout, x.breakdown, x.odds) })).filter((x) => x.q && inRange(x.q.american, STRAIGHT_RANGE))
      .sort((x, y) => y.breakdown.confidence - x.breakdown.confidence || y.q.american - x.q.american);
    record.passed = [...byBout.values()].filter(({ bout, breakdown }) => !taken.has(bout.id) && !candidates.some((c) => c.bout.id === bout.id)).map(({ bout, breakdown }) => ({ boutId: bout.id, selection: `${bout.a?.name} vs ${bout.b?.name}`, reason: breakdown.confidence < UFC_MIN_CONFIDENCE ? `confidence ${breakdown.confidence} of 5` : 'no usable price at your books' }));
    for (const c of candidates.slice(0, Math.max(0, open))) { record.bets.push(pickRecord(event, c.bout, c.breakdown, c.q, now)); posted++; }
    record.lockMs = lock;
  }
  // Grading: every pending pick whose bout is in.
  for (const pick of record.bets) {
    if (pick.status !== 'pending') continue;
    const bout = event.bouts.find((b) => b.id === pick.boutId);
    const settled = settleUfcPick(pick, bout);
    if (!settled) continue;
    pick.legs[0].result = settled.result; pick.legs[0].actual = settled.actual;
    pick.result = settled.result; pick.net = settled.net; pick.status = settled.result === 'void' ? 'void' : 'graded'; pick.settledAt = now; graded++;
  }
  record.checkedAt = now;
  record.locked = locked;
  record.final = event.status === 'final';
  await env.POTD_KV.put(ufcPicksKey(event.id), JSON.stringify(record), { expirationTtl: KV_TTL });
  const idxRaw = await env.POTD_KV.get(ufcPicksIndexKey).catch(() => null);
  const idx = idxRaw ? JSON.parse(idxRaw) : { cards: [] };
  if (!idx.cards.some((c) => c.id === event.id)) {
    idx.cards = [{ id: event.id, name: event.name, date: event.date }, ...idx.cards].slice(0, 40);
    await env.POTD_KV.put(ufcPicksIndexKey, JSON.stringify(idx), { expirationTtl: KV_TTL }).catch(() => {});
  }
  return { skipped: false, eventId: event.id, eventName: event.name, posted, graded, locked, picks: record.bets.length, voided };
}

/** The card's picks and the ledger across the last cards, for the tab. */
export async function getUfcPicks(env, now = Date.now(), { cards = 12 } = {}) {
  const index = await getUfcEvents(env);
  const next = nextUfcEvent(index.events, now);
  const idxRaw = await env.POTD_KV.get(ufcPicksIndexKey).catch(() => null);
  const listed = idxRaw ? JSON.parse(idxRaw).cards ?? [] : [];
  const sorted = [...listed].sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  const history = [];
  for (const e of sorted.slice(0, cards)) {
    const raw = await env.POTD_KV.get(ufcPicksKey(e.id)).catch(() => null);
    if (raw) { const r = JSON.parse(raw); if (r.version === UFC_RECORD_VERSION) history.push(r); }
  }
  const bets = history.flatMap((r) => r.bets ?? []);
  return { current: history.find((r) => r.eventId === next?.id) ?? null, history, record: betRecordOf(bets), nextEventId: next?.id ?? null };
}
