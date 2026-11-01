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
import { callModel, STRAIGHT_RANGE, PARLAY_RANGE, PARLAY_TARGET, betRecordOf, TICKET_UNITS } from './trend-picks.js';
import { bookIdFor, SPORTSBOOKS, americanToDecimal } from '../../docs/engine.js';

export const UFC_SPORT = 'mma_mixed_martial_arts';
/** The books a UFC ticket can sit at: the sportsbooks on the Pixel's Picks list (PrizePicks carries no MMA in the feed). */
export const UFC_BOOKS = ['fanduel', 'draftkings', 'caesars', 'hardrock', 'bet365', 'fanatics', 'betmgm'];
const UFC_FEED_BOOKS = 'fanduel,draftkings,williamhill_us,hardrockbet,bet365,fanatics,betmgm';
export const UFC_MAX_PICKS = 6;
/** A parlay piece: a bout the breakdown calls a sound piece at confidence 4 or better; two or three ride together at one book nearest +100. */
export const UFC_PARLAY_LEGS = [2, 3];
export const UFC_MIN_CONFIDENCE = 4;
export const UFC_RECORD_VERSION = 1;
const ROUND_MS = 5 * 60e3;
const KV_TTL = 60 * 86400;

export const ufcOddsKey = 'ufc:odds';
export const ufcPicksKey = (eventId) => `ufc:picks:${eventId}`;
/** Every card with a picks record, newest first, so the ledger outlives the runner's two-month card window. */
export const ufcPicksIndexKey = 'ufc:picks:index';
/** Per pairing and per engine run: a new consensus re-reads the bout. */
export const ufcBreakdownKey = (bout, engineStamp = '') => `ufc:breakdown:v3:${bout.id}:${bout.a?.id ?? '-'}-${bout.b?.id ?? '-'}:${engineStamp}`;
export const ufcEngineKey = 'ufc:engine';
export const MMA_ENGINE_URL = 'https://perpetualpixel.github.io/MMA_Engine/picks.json';
export const MMA_ENGINE_PAGE = 'https://perpetualpixel.github.io/MMA_Engine/';
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
    // Moneylines only (2026-11-01 direction: picks are the moneyline, the
    // method of victory and the double chance; no rounds totals). The feed
    // carries no method markets for MMA, so those price off the engine's
    // quote when it has one and otherwise post unpriced.
    url.searchParams.set('markets', 'h2h');
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
 * Which fighter an outcome names: the exact name first, then the looser
 * match, and nothing when both sides fit (two fighters sharing a surname,
 * Yana Santos against Luana Santos, would otherwise both land on one side).
 */
export function matchSide(n, a, b) {
  if (!n) return null;
  if (n === a && n !== b) return 'a';
  if (n === b && n !== a) return 'b';
  const la = namesLikelyMatch(n, a); const lb = namesLikelyMatch(n, b);
  if (la && !lb) return 'a';
  if (lb && !la) return 'b';
  if (!la && !lb) return null;
  const overlap = (x) => n.split(' ').filter((t) => x.split(' ').includes(t)).length;
  const oa = overlap(a); const ob = overlap(b);
  return oa > ob ? 'a' : ob > oa ? 'b' : null;
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
          const side = matchSide(normalizeName(o.name), a, b);
          if (side === 'a') ml.a.push(q); else if (side === 'b') ml.b.push(q);
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

/* ---------------- the MMA engine ---------------- */

/**
 * The MMA Engine's picks feed (the trust-weighted consensus of tracked
 * cappers, rebuilt by its weekly run): read from KV while the last read
 * is under half an hour old, else fetched cache-busted and written.
 */
export async function fetchMmaEngine(env, now = Date.now(), { deps = {} } = {}) {
  const raw = await env.POTD_KV.get(ufcEngineKey).catch(() => null);
  const stored = raw ? JSON.parse(raw) : null;
  if (stored && now - (stored.at ?? 0) < 30 * 60e3) return stored;
  let feed = null;
  try {
    feed = deps.engine ? await deps.engine() : await fetch(`${MMA_ENGINE_URL}?t=${now}`, { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null));
  } catch { feed = null; }
  if (!Array.isArray(feed?.picks)) return stored ?? { at: null, generatedAt: null, event: null, picks: [] };
  const record = { at: now, generatedAt: feed.generated_at ?? null, event: feed.event?.name ?? null, totals: feed.totals ?? null, picks: feed.picks.map((p) => ({ fightId: p.fight_id, fight: p.fight, market: p.market, marketLabel: p.market_label, selection: p.selection, consensusPct: p.consensus_pct, strength: p.strength, tier: p.tier, pickCount: p.pick_count, avgConfidence: p.avg_confidence, suggestedUnits: p.suggested_units, cardStatus: p.card_status ?? null, quotedOdds: p.quoted_odds ?? null, value: p.value ?? null, comments: (p.comments ?? []).slice(0, 6) })) };
  await env.POTD_KV.put(ufcEngineKey, JSON.stringify(record), { expirationTtl: 7 * 86400 }).catch(() => {});
  return record;
}

const surname = (n) => normalizeName(n).split(' ').filter(Boolean).at(-1) ?? '';
const surnamesAlike = (x, y) => Boolean(x && y) && (x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x))));

/**
 * The engine's read of one bout: the moneyline consensus and the method
 * calls, each with which side it names. A feed fight matches a bout when
 * its two surnames are the bout's two, either way round; the side comes
 * from the whole name, so two fighters sharing a surname each get theirs.
 */
export function engineForBout(bout, feed) {
  const a = normalizeName(bout.a?.name); const b = normalizeName(bout.b?.name);
  const sa = surname(bout.a?.name); const sb = surname(bout.b?.name);
  if (!sa || !sb) return null;
  const mine = (feed?.picks ?? []).filter((p) => {
    const sides = String(p.fight ?? '').split(/\s+vs\.?\s+/i).map(surname);
    if (sides.length !== 2) return false;
    return (surnamesAlike(sides[0], sa) && surnamesAlike(sides[1], sb)) || (surnamesAlike(sides[0], sb) && surnamesAlike(sides[1], sa));
  });
  if (!mine.length) return null;
  const sideOf = (selection) => { const n = normalizeName(String(selection ?? '').replace(/\s+by\s+.*$/i, '')); const exact = matchSide(n, a, b); if (exact) return exact; const sn = surname(n); return surnamesAlike(sn, sa) && !surnamesAlike(sn, sb) ? 'a' : surnamesAlike(sn, sb) && !surnamesAlike(sn, sa) ? 'b' : null; };
  const shape = (p) => ({ selection: p.selection, side: sideOf(p.selection), method: /\sby\s/i.test(String(p.selection ?? '')) ? methodClass(String(p.selection).replace(/^.*\sby\s+/i, '')) : null, consensusPct: p.consensusPct, strength: p.strength, tier: p.tier, pickCount: p.pickCount, suggestedUnits: p.suggestedUnits, quotedOdds: Number.isFinite(Number(p.quotedOdds)) ? Number(p.quotedOdds) : null, comments: p.comments ?? [] });
  const ml = mine.find((p) => p.market === 'moneyline');
  return { moneyline: ml ? shape(ml) : null, methods: mine.filter((p) => p.market === 'method_of_victory').map(shape), cancelled: mine.some((p) => p.cardStatus === 'cancelled') };
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
    const fighter = sideOf(s.fighter) ?? lean;
    let straight = { market: 'h2h', fighter };
    if (s.market === 'method' && methodClass(s.method)) straight = { market: 'method', fighter, methods: [methodClass(s.method)] };
    else if (s.market === 'double') {
      const methods = [...new Set((Array.isArray(s.methods) ? s.methods : []).map(methodClass).filter(Boolean))];
      if (methods.length === 2) straight = { market: 'double', fighter, methods: methods.sort() };
    }
    return { lean, confidence, straight, parlayPiece: Boolean(o.parlayPiece), summary: typeof o.summary === 'string' ? o.summary.trim().slice(0, 320) : '', reasons: Array.isArray(o.reasons) ? o.reasons.filter((r) => typeof r === 'string').map((r) => r.trim().slice(0, 160)).slice(0, 4) : [], leanName: lean === 'a' ? bout.a?.name : bout.b?.name };
  } catch { return null; }
}

/** One bout's breakdown, cached per pairing. */
export async function ufcBreakdown(env, event, bout, odds, now = Date.now(), { deps = {}, engine = null, engineStamp = '' } = {}) {
  const key = ufcBreakdownKey(bout, engineStamp);
  const cached = await env.POTD_KV.get(key).catch(() => null);
  if (cached) return JSON.parse(cached);
  const [fa, fb] = await Promise.all([deps.fighter ? deps.fighter(bout.a?.id) : getUfcFighter(env, bout.a?.id), deps.fighter ? deps.fighter(bout.b?.id) : getUfcFighter(env, bout.b?.id)]);
  const notice = (event.changes ?? []).filter((c) => c.boutId === bout.id && c.type === 'replaced').map((c) => c.detail).join('; ');
  const line = odds ? `Moneyline: ${bout.a?.name} ${odds.a[0] ? fmtAm(odds.a[0].american) : 'n/a'}, ${bout.b?.name} ${odds.b[0] ? fmtAm(odds.b[0].american) : 'n/a'}.` : 'No odds posted yet.';
  const facts = [
    `${event.name}: ${bout.weightClass ?? ''}${bout.title ? ' title fight' : ''}, ${bout.rounds ?? 3} rounds, ${bout.segment === 'main' ? 'main card' : bout.segment}.`,
    fighterFacts(fa, 'A', now), fighterFacts(fb, 'B', now),
    notice ? `Card change: ${notice}.` : null, line,
    engine?.moneyline ? `Capper consensus (the MMA Engine, ${engine.moneyline.pickCount} picks): ${engine.moneyline.consensusPct}% back ${engine.moneyline.selection}, strength ${engine.moneyline.strength} of 10, ${engine.moneyline.tier}.${engine.methods.length ? ` Method calls: ${engine.methods.map((m) => `${m.selection} (${m.consensusPct}%, ${m.tier})`).join('; ')}.` : ''}` : 'No capper consensus on this bout.',
  ].filter(Boolean).join('\n');
  const prompt = `You break down one UFC fight for a bettor. Use only the facts below and what you know of these fighters' styles in general; do not invent news. The capper consensus is one input, not the answer: agree with it when the record and the price back it, say so when they do not.

${facts}

Pick the side you lean to (A or B), a confidence from 1 to 5 (5 only when the record, the matchup and the price all agree), the one straight bet you like most, and whether the moneyline is a sound parlay piece (a heavy favourite with little finish risk against). The straight is one of three: the moneyline on A or B ("h2h"); the method of victory ("method": the fighter and one of ko, sub or dec, only when his record and the matchup point at one way of winning); or the double chance ("double": the fighter and the two of the three methods he is likeliest to win by, for instance ko and sub for a finisher who rarely sees the cards). Reply with JSON only, no dashes in the text: {"lean":"A"|"B","confidence":1-5,"straight":{"market":"h2h","fighter":"A"|"B"} or {"market":"method","fighter":"A"|"B","method":"ko"|"sub"|"dec"} or {"market":"double","fighter":"A"|"B","methods":["ko","sub"]},"parlayPiece":true|false,"summary":"<one sentence>","reasons":["<short point>","<short point>","<short point>"]}`;
  const text = deps.model ? await deps.model(prompt) : await callModel(prompt, env, { maxTokens: 500 });
  const parsed = parseUfcBreakdown(text, bout);
  const result = parsed ? { ...parsed, boutId: bout.id, at: now, model: true } : { boutId: bout.id, at: now, lean: null, confidence: 0, straight: null, parlayPiece: false, summary: 'The read was not available.', reasons: [], model: false };
  await env.POTD_KV.put(key, JSON.stringify(result), { expirationTtl: 3 * 86400 }).catch(() => {});
  return result;
}

/* ---------------- picks ---------------- */

/** A result's way of winning as the markets class it: ko (KO/TKO), sub, dec, or null for anything else (a DQ, a no contest). */
export function methodClass(method) {
  const m = String(method ?? '').toLowerCase();
  if (/\b(ko|tko|knock)/.test(m)) return 'ko';
  if (/sub/.test(m)) return 'sub';
  if (/dec|unanimous|split|majority|points/.test(m)) return 'dec';
  return null;
}
export const METHOD_LABEL = { ko: 'KO/TKO', sub: 'Submission', dec: 'Decision' };
const methodsText = (methods) => (methods ?? []).map((m) => METHOD_LABEL[m] ?? m).join(' or ');

/**
 * The quote the breakdown's straight points at: the moneyline at its best
 * listed price; a method of victory or double chance on the fighter, priced
 * off the engine's quote when a capper gave one for that method, else
 * unpriced (the feed carries no method markets for MMA). Null when the
 * side has no moneyline, which is the sign the bout has no odds yet.
 */
export function straightQuote(bout, breakdown, odds, engine = null) {
  const s = breakdown?.straight; if (!s || !odds) return null;
  const f = s.fighter === 'b' ? bout.b : bout.a;
  const ml = (s.fighter === 'b' ? odds.b : odds.a)[0];
  if (s.market === 'h2h') return ml ? { ...ml, market: 'h2h', fighterId: f?.id ?? null, selection: `${f?.name} to win`, point: null, side: null, methods: null } : null;
  if (!ml || !(s.methods ?? []).length) return null;
  const quoted = s.market === 'method' ? (engine?.methods ?? []).find((m) => m.side === s.fighter && m.method === s.methods[0] && Number.isFinite(m.quotedOdds)) : null;
  const american = quoted ? quoted.quotedOdds : null;
  return { market: s.market, fighterId: f?.id ?? null, selection: `${f?.name} by ${methodsText(s.methods)}`, methods: s.methods, point: null, side: null, american, decimal: american == null ? null : americanToDecimal(american), bookId: null, book: quoted ? 'engine quote' : null, link: null };
}

const pickId = (eventId, bout, q) => `${eventId}:${bout.id}:${q.market}:${q.side ?? q.fighterId}`;
const toAmerican = (decimal) => (decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1)));

/**
 * The parlay pieces into tickets: the bouts the breakdown calls a sound
 * piece at confidence 4 or better, each at its lean's moneyline, combined
 * two or three at a time at one book where every piece is priced, the
 * ticket nearest +100 inside PARLAY_RANGE first, no bout on two tickets,
 * up to `open` tickets. A piece already on a straight is skipped.
 */
export function buildUfcParlays(pieces, { open = UFC_MAX_PICKS } = {}) {
  const legsOf = (p) => (p.breakdown.lean === 'b' ? p.odds.b : p.odds.a).map((q) => ({ ...q, bout: p.bout, breakdown: p.breakdown, fighterId: p.breakdown.lean === 'b' ? p.bout.b?.id : p.bout.a?.id, name: p.breakdown.lean === 'b' ? p.bout.b?.name : p.bout.a?.name }));
  const byBook = new Map();
  for (const p of pieces) for (const q of legsOf(p)) { if (!byBook.has(q.bookId)) byBook.set(q.bookId, new Map()); const m = byBook.get(q.bookId); if (!m.has(p.bout.id)) m.set(p.bout.id, q); }
  const combos = [];
  for (const [bookId, legs] of byBook) {
    const list = [...legs.values()];
    for (const n of UFC_PARLAY_LEGS) {
      const pick = (start, chosen) => {
        if (chosen.length === n) { const dec = chosen.reduce((d, l) => d * l.decimal, 1); const am = toAmerican(dec); if (inRange(am, PARLAY_RANGE)) combos.push({ bookId, legs: chosen, decimal: dec, american: am, gap: Math.abs(am - PARLAY_TARGET) }); return; }
        for (let i = start; i < list.length; i++) pick(i + 1, [...chosen, list[i]]);
      };
      pick(0, []);
    }
  }
  combos.sort((x, y) => x.gap - y.gap || y.legs.length - x.legs.length);
  const used = new Set(); const out = [];
  for (const c of combos) {
    if (out.length >= open) break;
    if (c.legs.some((l) => used.has(l.bout.id))) continue;
    c.legs.forEach((l) => used.add(l.bout.id));
    out.push(c);
  }
  return out;
}

function parlayRecord(event, combo, now) {
  const legs = combo.legs.map((l) => ({ id: `${l.bout.id}:h2h`, boutId: l.bout.id, selection: `${l.name} to win`, market: 'h2h', fighterId: l.fighterId, point: null, side: null, american: l.american, decimal: Math.round(l.decimal * 10000) / 10000, link: l.link ?? null, a: l.bout.a?.name, b: l.bout.b?.name, weightClass: l.bout.weightClass, rounds: l.bout.rounds ?? 3, confidence: l.breakdown.confidence, note: l.breakdown.summary, result: null, actual: null }));
  return {
    id: `${event.id}:parlay:${legs.map((l) => l.boutId).join('+')}`, type: 'parlay', sportKey: UFC_SPORT, sportTitle: 'UFC', eventId: event.id, eventName: event.name, boutId: legs[0].boutId, boutIds: legs.map((l) => l.boutId),
    bookId: combo.bookId, book: bookName(combo.bookId), bookUrl: bookUrl(combo.bookId), link: null,
    american: combo.american, decimal: Math.round(combo.decimal * 10000) / 10000, units: TICKET_UNITS, commenceMs: Math.min(...combo.legs.map((l) => l.bout.date ?? event.date)), postedAt: now,
    legs, status: 'pending', result: null, net: null, settledAt: null,
  };
}

function pickRecord(event, bout, breakdown, q, now) {
  const priced = Number.isFinite(q.american);
  return {
    id: pickId(event.id, bout, q), type: 'straight', sportKey: UFC_SPORT, sportTitle: 'UFC', eventId: event.id, eventName: event.name, boutId: bout.id,
    bookId: q.bookId ?? null, book: q.bookId ? q.book : (q.book ?? 'any book'), bookUrl: q.bookId ? bookUrl(q.bookId) : null, link: q.link ?? null,
    american: priced ? q.american : null, decimal: priced ? Math.round(q.decimal * 10000) / 10000 : null, priced, units: TICKET_UNITS, commenceMs: bout.date ?? event.date, postedAt: now,
    legs: [{ id: `${bout.id}:${q.market}`, boutId: bout.id, selection: q.selection, market: q.market, fighterId: q.fighterId, methods: q.methods ?? null, point: q.point ?? null, side: q.side ?? null, american: priced ? q.american : null, link: q.link ?? null, a: bout.a?.name, b: bout.b?.name, weightClass: bout.weightClass, rounds: bout.rounds ?? 3, confidence: breakdown.confidence, note: breakdown.summary, result: null, actual: null }],
    status: 'pending', result: null, net: null, settledAt: null, warning: null,
  };
}

/** Settle one leg from its bout's result: the moneyline on the winner, the rounds total on the finish time; null while the bout is not in. */
export function settleUfcLeg(leg, bout) {
  const r = bout?.result;
  if (bout?.status === 'cancelled') return { result: 'void', actual: 'off the card' };
  if (bout?.status !== 'final' || !r) return null;
  const actual = `${r.winnerId === bout.a?.id ? bout.a?.name : bout.b?.name} by ${r.method ?? '?'}${r.round ? ` R${r.round}` : ''}`;
  if (leg.market === 'h2h') {
    if (r.draw || !r.winnerId) return { result: 'void', actual: 'draw or no contest' };
    return { result: r.winnerId === leg.fighterId ? 'win' : 'loss', actual };
  }
  if (leg.market === 'method' || leg.market === 'double') {
    // The fighter, and the way he won among the methods on the ticket; a DQ or a no contest is not a method the market settles.
    if (r.draw || !r.winnerId) return { result: 'void', actual: 'draw or no contest' };
    if (r.winnerId !== leg.fighterId) return { result: 'loss', actual };
    const cls = methodClass(r.method);
    if (!cls) return { result: 'void', actual: `${actual} (not a method the market settles)` };
    return { result: (leg.methods ?? []).includes(cls) ? 'win' : 'loss', actual };
  }
  // The rounds total: a finish's elapsed time against the number; a decision is the distance.
  const rounds = leg.rounds ?? bout.rounds ?? 3;
  const isDecision = /dec/i.test(r.method ?? '') || !r.round;
  const elapsedMs = isDecision ? rounds * ROUND_MS : (r.round - 1) * ROUND_MS + (() => { const m = String(r.time ?? '').match(/^(\d+):(\d+)$/); return m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : 0; })();
  const lineMs = leg.point * ROUND_MS;
  if (elapsedMs === lineMs) return { result: 'push', actual: `${(elapsedMs / ROUND_MS).toFixed(2)} rounds` };
  const over = elapsedMs > lineMs;
  const won = leg.side === 'over' ? over : !over;
  return { result: won ? 'win' : 'loss', actual: isDecision ? `went the distance (${rounds} rounds)` : `ended R${r.round} ${r.time ?? ''} (${(elapsedMs / ROUND_MS).toFixed(2)} rounds)` };
}

/**
 * Settle a ticket from its legs, the way a book does: a lost leg loses
 * it, a pushed or voided leg drops out and it pays at the legs left, no
 * legs left is a void. Null while any leg is unsettled.
 */
export function settleUfcTicket(pick) {
  const legs = pick.legs ?? [];
  if (legs.some((l) => l.result == null)) return null;
  const units = pick.units ?? 1;
  // A leg with no price (a method the feed does not quote) settles by result alone: the ticket's units are not known either way.
  const unpriced = legs.some((l) => l.result !== 'void' && !Number.isFinite(l.decimal) && !Number.isFinite(l.american));
  if (legs.some((l) => l.result === 'loss')) return { result: 'loss', net: unpriced ? null : -units };
  const live = legs.filter((l) => l.result === 'win');
  if (!live.length) return { result: legs.every((l) => l.result === 'void') ? 'void' : 'push', net: 0 };
  if (unpriced) return { result: 'win', net: null };
  const decimal = live.reduce((d, l) => d * (l.decimal ?? americanToDecimal(l.american)), 1);
  return { result: 'win', net: Math.round((decimal - 1) * units * 100) / 100 };
}

/** A straight, settled from its one leg (kept for the tests and the grading path). */
export function settleUfcPick(pick, bout) {
  const leg = settleUfcLeg(pick.legs[0], bout);
  if (!leg) return null;
  const t = settleUfcTicket({ ...pick, legs: [{ ...pick.legs[0], result: leg.result, decimal: pick.decimal }] });
  return { ...t, actual: leg.actual };
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
    const engineFeed = await fetchMmaEngine(env, now, { deps });
    const engineStamp = engineFeed.generatedAt ? String(engineFeed.generatedAt).replace(/[^0-9]/g, '').slice(0, 12) : '';
    record.engine = { generatedAt: engineFeed.generatedAt, event: engineFeed.event, totals: engineFeed.totals ?? null, page: MMA_ENGINE_PAGE, picks: engineFeed.picks.filter((p) => p.tier !== 'pass').map((p) => ({ fight: p.fight, market: p.market, selection: p.selection, consensusPct: p.consensusPct, strength: p.strength, tier: p.tier, pickCount: p.pickCount, suggestedUnits: p.suggestedUnits })) };
    const live = event.bouts.filter((b) => b.status === 'scheduled' && b.a?.id && b.b?.id);
    const byBout = new Map();
    for (const bout of live) {
      const bo = boutOdds(bout, odds.events);
      if (!bo || (!bo.a.length && !bo.b.length)) continue;
      const engine = engineForBout(bout, engineFeed);
      const bd = await ufcBreakdown(env, event, bout, bo, now, { deps, engine, engineStamp });
      byBout.set(bout.id, { bout, odds: bo, breakdown: bd, engine });
      record.breakdowns[bout.id] = { engine, boutDate: bout.date ?? event.date, a: bout.a?.name ?? null, b: bout.b?.name ?? null, aId: bout.a?.id ?? null, bId: bout.b?.id ?? null, weightClass: bout.weightClass ?? null, segment: bout.segment, lean: bd.lean, leanName: bd.leanName ?? null, confidence: bd.confidence, straight: bd.straight, parlayPiece: bd.parlayPiece, summary: bd.summary, reasons: bd.reasons, model: bd.model, bestA: bo.a[0] ?? null, bestB: bo.b[0] ?? null, quotesA: bo.a.slice(0, 8), quotesB: bo.b.slice(0, 8), totals: bo.totals.map((t) => ({ point: t.point, over: t.over[0] ?? null, under: t.under[0] ?? null })) };
    }
    // Existing picks: voided when the bout is gone or a fighter changed; otherwise the price follows while the same selection posts.
    for (const pick of record.bets) {
      if (pick.status !== 'pending') continue;
      let touched = false;
      for (const leg of pick.legs) {
        if (leg.result != null) continue;
        const bout = event.bouts.find((b) => b.id === leg.boutId);
        const changed = !bout || bout.status === 'cancelled' || (leg.fighterId && bout.a?.id !== leg.fighterId && bout.b?.id !== leg.fighterId) || (bout.a?.name !== leg.a || bout.b?.name !== leg.b);
        if (changed) {
          // A straight voids; a parlay leg drops out and the ticket pays at the legs left.
          leg.result = 'void'; leg.actual = !bout || bout.status === 'cancelled' ? 'the bout came off the card' : 'a fighter was replaced'; touched = true;
          continue;
        }
        // The pick tracks what it was drawn on: the price follows only while the same book posts the same selection at the same number.
        const bo = byBout.get(bout.id)?.odds;
        const same = !bo ? null : leg.market === 'h2h'
          ? (leg.fighterId === bout.b?.id ? bo.b : bo.a).find((x) => x.bookId === pick.bookId) ?? null
          : leg.market === 'totals' ? bo.totals.find((t) => t.point === leg.point)?.[leg.side]?.find((x) => x.bookId === pick.bookId) ?? null : null;
        if (same) {
          if (same.american !== leg.american) { leg.american = same.american; leg.decimal = Math.round(same.decimal * 10000) / 10000; leg.link = same.link ?? leg.link; touched = true; }
          if (leg.warning) { leg.warning = null; touched = true; }
        } else if (bo && leg.market === 'totals') {
          const posted = bo.totals.map((t) => t.point).filter((p) => p !== leg.point);
          const warning = posted.length ? `${pick.book} now posts ${posted.join(' and ')} rounds; the pick stays on the ${leg.point} it was drawn at and is not to be taken at the new number.` : `${pick.book} has pulled the rounds total; the pick stays on the ${leg.point} it was drawn at.`;
          if (leg.warning !== warning) { leg.warning = warning; touched = true; }
        }
      }
      if (!touched) continue;
      pick.updatedAt = now;
      const live = pick.legs.filter((l) => l.result == null);
      if (!live.length) { pick.status = 'void'; pick.result = 'void'; pick.net = 0; pick.settledAt = now; pick.voidReason = pick.legs[0].actual; voided.push(pick); continue; }
      if (pick.type === 'parlay' && live.length < pick.legs.length) voided.push({ ...pick, voidReason: `${pick.legs.filter((l) => l.result === 'void').map((l) => l.selection).join(', ')}: ${pick.legs.find((l) => l.result === 'void')?.actual}; the ticket rides on ${live.map((l) => l.selection).join(' + ')}` });
      if (live.every((l) => Number.isFinite(l.decimal) || Number.isFinite(l.american))) {
        const decimal = live.reduce((d, l) => d * (l.decimal ?? americanToDecimal(l.american)), 1);
        pick.decimal = Math.round(decimal * 10000) / 10000; pick.american = toAmerican(decimal);
      }
      pick.warning = pick.legs.map((l) => l.warning).filter(Boolean).join(' ') || null;
      if (pick.type === 'straight') pick.link = pick.legs[0].link ?? pick.link;
    }
    // New picks: the strongest reads with a usable price, up to the cap, one per bout.
    const taken = new Set(record.bets.filter((b) => b.status === 'pending').map((b) => b.boutId));
    const open = UFC_MAX_PICKS - taken.size;
    // A moneyline inside the straight range, or a method or double chance (priced off the engine's quote, or unpriced).
    const candidates = [...byBout.values()].filter(({ bout, breakdown }) => !taken.has(bout.id) && breakdown.confidence >= UFC_MIN_CONFIDENCE)
      .map((x) => ({ ...x, q: straightQuote(x.bout, x.breakdown, x.odds, x.engine) })).filter((x) => x.q && (x.q.american == null || inRange(x.q.american, STRAIGHT_RANGE)))
      .sort((x, y) => y.breakdown.confidence - x.breakdown.confidence || (y.q.american ?? -9999) - (x.q.american ?? -9999));
    record.passed = [...byBout.values()].filter(({ bout, breakdown }) => !taken.has(bout.id) && !candidates.some((c) => c.bout.id === bout.id)).map(({ bout, breakdown }) => ({ boutId: bout.id, selection: `${bout.a?.name} vs ${bout.b?.name}`, reason: breakdown.confidence < UFC_MIN_CONFIDENCE ? `confidence ${breakdown.confidence} of 5` : 'no usable price at your books' }));
    for (const c of candidates.slice(0, Math.max(0, open))) { record.bets.push(pickRecord(event, c.bout, c.breakdown, c.q, now)); posted++; }
    // Then the parlay pieces, at whatever room is left under the cap.
    const onTicket = new Set(record.bets.filter((b) => b.status === 'pending').flatMap((b) => b.boutIds ?? [b.boutId]));
    const pieces = [...byBout.values()].filter(({ bout, breakdown }) => !onTicket.has(bout.id) && breakdown.parlayPiece && breakdown.confidence >= UFC_MIN_CONFIDENCE && breakdown.lean);
    const room = UFC_MAX_PICKS - record.bets.filter((b) => b.status === 'pending').length;
    for (const combo of buildUfcParlays(pieces, { open: Math.max(0, room) })) { record.bets.push(parlayRecord(event, combo, now)); posted++; }
    record.lockMs = lock;
  }
  // Grading: every pending pick whose bout is in.
  for (const pick of record.bets) {
    if (pick.status !== 'pending') continue;
    for (const leg of pick.legs) {
      if (leg.result != null) continue;
      const s = settleUfcLeg(leg, event.bouts.find((b) => b.id === leg.boutId));
      if (s) { leg.result = s.result; leg.actual = s.actual; }
    }
    const settled = settleUfcTicket({ ...pick, legs: pick.legs.map((l) => ({ ...l, decimal: l.decimal ?? (pick.type === 'straight' ? pick.decimal : (Number.isFinite(l.american) ? americanToDecimal(l.american) : null)) })) });
    if (!settled) continue;
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
