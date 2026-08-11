/**
 * MMA capper-consensus signal — the MMA_Engine picks feed turned into the
 * same bounded -1..1 qualitative number scoreCandidate() already accepts
 * (see docs/qualitative.js for the tennis/team equivalents).
 *
 * The feed (https://perpetualpixel.github.io/MMA_Engine/picks.json) is the
 * trust-weighted consensus of tracked YouTube cappers, rebuilt by
 * MMA_Engine's weekly run. Each entry names a fight, a market, the consensus
 * selection, and a 0-10 `strength` that already blends how one-sided the
 * cappers are with how much trust-weight actually backs them — so this
 * module doesn't re-derive any of that, it just matches a feed entry to an
 * odds-board candidate and signs the strength: positive when the candidate
 * IS the consensus side, negative when it's the opposite corner of a fight
 * the cappers called the other way.
 *
 * Matching is by surname because the two sources spell fighters differently
 * (auto-captions truncate — "Makhache" for "Makhachev" — and books
 * romanize differently), so exact-string equality would silently match
 * nothing. Same contract as qualitative.js: pure functions, null when
 * there's no real data, never a fabricated neutral.
 */

import { clamp, scoreCandidate } from './engine.js';

export const CAPPER_CONSENSUS_URL =
  'https://perpetualpixel.github.io/MMA_Engine/picks.json';

/**
 * How many score points a full-strength consensus moves an MMA candidate —
 * deliberately NOT the generic ±8 QUALITATIVE.MAX_SWING the tennis/team form
 * signals use. Those enrich a price-first pick; for MMA the cappers ARE the
 * handicapping model (this app applies no fighter-quality scoring of its own),
 * so the consensus has to be able to decide WHICH market is the fight's pick
 * — a strong 8/10 consensus moneyline must outscore a rounds total that
 * merely has cleaner price liquidity. At ±25, a strong consensus (≥7.5/10)
 * swings ≥19 points — decisive across any realistic same-fight score gap —
 * while a weak lean stays a nudge and an opposed candidate is pushed well
 * off the board. The engine still does what only it can do: price the
 * consensus side across every book and grade the value of taking it.
 */
export const MMA_CONSENSUS_SWING = 25;

/**
 * Re-grade one candidate under a -1..1 consensus signal: the engine's own
 * price score first (unchanged fields: ev, kelly, consensusProb, …), then the
 * MMA swing applied on top, outside scoreCandidate()'s ±8 qualitative clamp.
 * The one shared path for this math — docs/app.js (live board) and
 * worker/src/tracking.js + potd.js (locked picks) all rescore through here,
 * so the browser and the server can never grade the same fight differently.
 */
export function consensusRescore(candidate, signal, { now = Date.now() } = {}) {
  const base = scoreCandidate(candidate, { now });
  return { ...base, score: clamp(base.score + MMA_CONSENSUS_SWING * signal, 0, 100) };
}

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function surnameOf(name) {
  const tokens = normalizeName(name).split(' ');
  return tokens[tokens.length - 1] ?? '';
}

/**
 * Surname match tolerant of truncation: exact, or one is a prefix of the
 * other with at least 4 shared characters ("makhache"/"makhachev",
 * "stoltzfu"/"stoltzfus"). Short surnames must match exactly — a 3-letter
 * prefix match would conflate genuinely different fighters.
 */
export function surnamesMatch(a, b) {
  const sa = surnameOf(a);
  const sb = surnameOf(b);
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  if (Math.min(sa.length, sb.length) < 4) return false;
  return sa.startsWith(sb) || sb.startsWith(sa);
}

/** Whether a feed entry's fight string names the candidate's two fighters. */
function fightMatches(pick, candidate) {
  const sides = String(pick.fight ?? '').split(/\s+vs\.?\s+/i);
  if (sides.length !== 2) return false;
  const [a, b] = sides;
  return (
    (surnamesMatch(candidate.home, a) && surnamesMatch(candidate.away, b)) ||
    (surnamesMatch(candidate.home, b) && surnamesMatch(candidate.away, a))
  );
}

/**
 * Every feed entry for a candidate's fight, whatever the market. Both of the
 * candidate's fighters must match the two sides of the feed entry's fight
 * string — matching the selection alone would let a common surname attach
 * one event's consensus to a different fight.
 */
export function findFightPicks(feed, candidate) {
  return (feed?.picks ?? []).filter((pick) => fightMatches(pick, candidate));
}

/** The feed's moneyline entry for a candidate's fight, or null. */
export function findConsensusPick(feed, candidate) {
  return findFightPicks(feed, candidate).find((p) => p.market === 'moneyline') ?? null;
}

/**
 * Which side of a rounds total an over_under feed selection is calling, or
 * null when the phrasing resolves to neither. Cappers rarely quote the exact
 * book line — the common phrasings are "fight does not go the distance"
 * (an early finish: Under) and "goes the distance"/"to a decision" (Over) —
 * so this reads direction first and only pins a specific number when the
 * selection actually names one ("Under 2.5"). The negated phrasings are
 * checked before the bare "distance" ones, since "does not go the distance"
 * contains "go the distance".
 */
export function totalsSideOf(selection) {
  const text = normalizeName(selection);
  if (!text) return null;
  const pointMatch = String(selection ?? '').match(/(\d+(?:\.\d+)?)/);
  const point = pointMatch ? Number(pointMatch[1]) : null;
  if (/\bunder\b/.test(text)) return { side: 'Under', point };
  if (/\bover\b/.test(text)) return { side: 'Over', point };
  if (/\b(does not|doesn t|won t|will not)\b.*\bdistance\b/.test(text)) return { side: 'Under', point: null };
  if (/\binside the distance\b/.test(text) || /\bfinish\b/.test(text)) return { side: 'Under', point: null };
  if (/\bdistance\b/.test(text) || /\bdecision\b/.test(text)) return { side: 'Over', point: null };
  return null;
}

/**
 * The -1..1 signal for one MMA candidate, or null when the feed has no
 * matching entry for its fight+market or the candidate's side can't be
 * resolved. `aligned` says whether the candidate IS the consensus side; the
 * magnitude is the feed's own strength on a 0-1 scale either way.
 *
 * Two markets carry a signal: moneylines (h2h ↔ the feed's moneyline entry,
 * matched by fighter surname) and rounds totals (totals ↔ the feed's
 * over_under entry, matched by direction — see totalsSideOf). Everything
 * else (spreads, props) returns null: the feed has no entry shaped like it.
 */
export function capperConsensusSignal(feed, candidate) {
  if (candidate.marketKey === 'h2h') {
    const pick = findConsensusPick(feed, candidate);
    if (!pick) return null;

    const aligned = surnamesMatch(candidate.outcomeName, pick.selection);
    const opponent =
      candidate.outcomeName === candidate.home ? candidate.away : candidate.home;
    // The consensus selection must be one of the two fighters — if it matches
    // neither (a bad parse upstream), say nothing rather than guess a side.
    if (!aligned && !surnamesMatch(opponent, pick.selection)) return null;

    const magnitude = clamp((pick.strength ?? 0) / 10, 0, 1);
    return { signal: aligned ? magnitude : -magnitude, aligned, pick };
  }

  if (candidate.marketKey === 'totals') {
    const pick = findFightPicks(feed, candidate).find((p) => p.market === 'over_under') ?? null;
    if (!pick) return null;
    const call = totalsSideOf(pick.selection);
    if (!call) return null;
    // A consensus quoting a specific number only speaks to that exact line;
    // a directional call ("doesn't go the distance") speaks to any of the
    // fight's posted totals.
    if (call.point != null && candidate.point != null && call.point !== candidate.point) return null;

    const aligned = candidate.outcomeName === call.side;
    const magnitude = clamp((pick.strength ?? 0) / 10, 0, 1);
    return { signal: aligned ? magnitude : -magnitude, aligned, pick };
  }

  return null;
}

/**
 * The feed entry flattened into the shape the UI renders.
 *
 * `scored` is the honest part: a fighter-consensus can only move the grade of
 * a bet that HAS a fighter side, so an h2h candidate gets scored: true while
 * a rounds total or spread on the same fight gets scored: false — the
 * consensus is real context for that fight either way, but claiming it
 * changed a totals grade would be a lie. `aligned` is null in that case too,
 * since a total is neither with nor against the cappers' pick.
 */
export function consensusRecord(pick, feed, { aligned = null, signal = null, scored = false } = {}) {
  return {
    selection: pick.selection,
    marketLabel: pick.market_label ?? null,
    consensusPct: pick.consensus_pct,
    strength: pick.strength,
    tier: pick.tier,
    pickCount: pick.pick_count,
    // The backing cappers' own reasoning for this selection, verbatim from
    // the feed (MMA_Engine exports them trust-ordered) — [] on a feed built
    // before comments existed.
    comments: pick.comments ?? [],
    aligned,
    signal,
    scored,
    generatedAt: feed?.generated_at ?? null,
  };
}

/**
 * Every capper comment across ALL of a fight's feed entries — moneyline,
 * method of victory, rounds — labelled with which market and selection each
 * comment was arguing for. The drawer's "What the cappers said" section
 * shows the fight's full reasoning, not just the one entry whose swing
 * happened to touch the open market; a capper's method-of-victory logic is
 * exactly the context someone weighing the moneyline wants. Deduped by
 * capper+comment: discovery can attach the same video's reasoning to more
 * than one entry.
 */
export function fightConsensusComments(feed, candidate) {
  const seen = new Set();
  const out = [];
  for (const pick of findFightPicks(feed, candidate)) {
    for (const c of pick.comments ?? []) {
      const key = `${c.capper}|${c.comment}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        capper: c.capper,
        comment: c.comment,
        confidence: c.confidence ?? null,
        marketLabel: pick.market_label ?? pick.market ?? '',
        selection: pick.selection,
      });
    }
  }
  return out;
}

/**
 * The consensus for a candidate's FIGHT, whatever market it is — the drawer
 * needs this because Full Slate's "More info" opens on the best-scoring
 * candidate of the three markets, which for MMA is usually a rounds total,
 * not the moneyline the swing attached to. Null when the feed has no entry.
 */
export function fightConsensusRecord(feed, candidate) {
  const pick = findConsensusPick(feed, candidate);
  return pick ? consensusRecord(pick, feed) : null;
}

/**
 * Re-score every MMA candidate the feed speaks to (moneylines and rounds
 * totals — see capperConsensusSignal), attaching what was found as
 * `capperConsensus` so the UI can show its work. Every other candidate
 * passes through untouched — same "enrichment is a bonus" posture as
 * app.js's refreshQualitativeSignals(). Returns a new array; never mutates
 * the input candidates.
 */
export function applyCapperConsensus(candidates, feed, { now = Date.now() } = {}) {
  if (!feed?.picks?.length) return candidates;
  return candidates.map((c) => {
    if (c.sportKey !== 'mma_mixed_martial_arts') return c;
    const match = capperConsensusSignal(feed, c);
    if (!match) return c;
    const rescored = {
      ...c,
      capperConsensus: consensusRecord(match.pick, feed, {
        aligned: match.aligned,
        signal: match.signal,
        scored: true,
      }),
    };
    return Object.assign(rescored, consensusRescore(rescored, match.signal, { now }));
  });
}

let feedCache = null;
let feedFetchedAt = 0;
export const FEED_TTL_MS = 60 * 1000;

/**
 * The last feed successfully fetched, or null before the first one lands.
 * Synchronous on purpose: the stats drawer renders its first paint without
 * awaiting anything, and a fight's consensus should appear in that paint or
 * not at all rather than popping in a moment later.
 */
export function cachedConsensusFeed() {
  return feedCache;
}

/**
 * Fetch the picks feed, cached for a minute.
 *
 * The feed only changes when MMA_Engine's weekly run pushes, but the whole
 * point of a push is that the board reflects it right away — so the cache is
 * short and every actual request is cache-busted (unique `?t=` plus
 * `cache: 'no-store'`). Without that, GitHub Pages' own CDN and the browser
 * HTTP cache would both keep serving the pre-push body for minutes after
 * weekly.bat finished, which reads as "the run didn't work".
 *
 * `force` skips the in-memory TTL for a caller that already knows it wants
 * fresh bytes (the poller below). Returns the last good feed — or null if
 * there has never been one — on any failure: the price-only score always
 * stands on its own.
 */
export async function fetchCapperConsensus(
  url = CAPPER_CONSENSUS_URL,
  { now = Date.now(), force = false } = {},
) {
  if (!force && feedCache && now - feedFetchedAt < FEED_TTL_MS) return feedCache;
  const busted = `${url}${url.includes('?') ? '&' : '?'}t=${now}`;
  try {
    const res = await fetch(busted, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return feedCache;
    const feed = await res.json();
    if (!Array.isArray(feed?.picks)) return feedCache;
    feedCache = feed;
    feedFetchedAt = now;
    return feed;
  } catch {
    return feedCache;
  }
}
