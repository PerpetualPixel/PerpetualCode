/**
 * Tennis settlement from ESPN's own scoreboards — the source that actually
 * has tennis results.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * The Odds API's /scores endpoint does not settle tennis. Not "lags," not
 * "sometimes misses" — never posts one. Confirmed live against a full day's
 * WTA card (tennis_wta_cincinnati_open, Aug 13): all 16 events came back
 * `completed: false, scores: null, last_update: null`, including matches
 * that had finished many hours earlier. Both existing settlement paths hang
 * off that flag:
 *
 *   - docs/learning.js's gradePick returns null on `!scoreEvent.completed`.
 *   - worker/src/tennis-results.js's metered RapidAPI rescue is itself gated
 *     behind the same `if (!scoreEvent?.completed) return null` (line 112),
 *     on the reasonable-sounding but, for tennis, never-satisfied premise
 *     that the free source confirms the match is over before we spend a
 *     metered call finding out how it ended.
 *
 * So tennis picks were not "waiting to be graded." They were stranded: no
 * code path in the system could ever settle one, and ~29 of them sat pending
 * on a single day with nothing on any timer that would resolve them.
 *
 * ESPN's scoreboard carries the complete result — final set scores, per-set
 * winner flags, retirements and walkovers distinguished by their own status,
 * and a plain-language match note — for free, unmetered, on the same
 * site.web.api.espn.com host worker/src/ufc-events.js and
 * worker/src/mlb-stats.js already fetch from a deployed Worker. This module
 * turns that into the exact `{ completed, scores: [{ name, score }] }` shape
 * gradePick already reads, so the settlement math itself is unchanged and
 * unduplicated: ESPN supplies the sets, docs/learning.js's gradeTennis
 * decides the bet (including its existing retirement and walkover rules).
 *
 * ── Deliberate conservatism ──────────────────────────────────────────────
 * The one unacceptable failure here is attributing another match's result to
 * a pick. Every ambiguity resolves to `null` — leave the pick pending, which
 * is exactly where it already was — rather than to a guess:
 *   - Doubles is excluded entirely (see matchesForTour): a roster's combined
 *     "A / B" display name substring-matches either member's singles name,
 *     which would silently settle a singles bet off a doubles result.
 *   - A name pair matching more than one completed match returns null
 *     instead of taking the first.
 *   - A tour mismatch is never crossed: a tennis_wta_* pick only ever reads
 *     WTA competitions.
 */

import { gradePick, UNSETTLEABLE_TENNIS_GAME_MARKET } from '../../docs/learning.js';
import { gradeTennisGameMarket } from '../../docs/tennis-results.js';
import { tourOf, isTennisKey } from '../../docs/tennis-tiers.js';
import { settleTennisGameMarket } from './tennis-results.js';

const ESPN_TENNIS_SCOREBOARDS = {
  atp: 'https://site.web.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard',
  wta: 'https://site.web.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard',
};

// Short enough that a match finishing mid-window still grades on the next
// 15-minute tick rather than the one after it; long enough that the grading
// pass isn't re-fetching the same draw every run.
const RESULTS_TTL = 300;

// A tennis scoreboard request returns the WHOLE draw of every tournament
// active on that date — confirmed live: `?dates=20260813` came back with
// Cincinnati's full 131-competition men's singles draw, results from Aug 11
// included. So the lookback doesn't need to cover every day a match might
// have been played, only enough days that a tournament which ENDED recently
// is still returned by at least one of the requested dates.
const RESULTS_LOOKBACK_DAYS = 2;

/** YYYYMMDD in UTC, the form ESPN's `dates` query parameter takes. */
function espnDateParam(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Same accent-folding normalization worker/src/ufc-events.js uses on fighter
 * names, and for the same reason: the odds feed and ESPN routinely spell the
 * same person differently, and an un-normalized `[^a-z0-9 ]` strip turns an
 * accented letter into nothing instead of its base letter ("Muchová" ->
 * "muchov" rather than "muchova").
 */
function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lastToken(normalized) {
  const parts = normalized.split(' ').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/**
 * Whether two normalized player names plausibly name the same person.
 *
 * Tennis adds a failure mode MMA's matcher never had to handle: the two
 * sources disagree on NAME ORDER, not just spelling. ESPN lists the same
 * Chinese and Japanese players surname-first that the odds feed lists
 * surname-last — "Zhu Lin" vs "Lin Zhu" is one real, currently-drawn player,
 * and neither a surname comparison (zhu vs lin) nor a squashed-substring
 * check catches it. Comparing the two names as unordered token SETS does,
 * and costs nothing for names that already agree on order.
 *
 * The looser fallbacks (shared surname, squashed containment) carry a real
 * collision risk in tennis, where shared surnames are common — matchesForTour
 * callers bound that by requiring BOTH sides of the same competition to
 * match and by refusing a name pair that matches more than one match.
 */
function namesLikelyMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;

  const tokensA = a.split(' ').filter(Boolean).sort().join(' ');
  const tokensB = b.split(' ').filter(Boolean).sort().join(' ');
  if (tokensA === tokensB) return true;

  if (lastToken(a) && lastToken(a) === lastToken(b)) return true;

  const squashedA = a.replace(/ /g, '');
  const squashedB = b.replace(/ /g, '');
  return squashedA.includes(squashedB) || squashedB.includes(squashedA);
}

/** A competitor's single-player display name, or null for a doubles roster. */
function singlesName(competitor) {
  if (competitor?.roster) return null; // doubles pairing — never a singles opponent
  return competitor?.athlete?.displayName ?? null;
}

/**
 * Sets won by each side, from ESPN's per-set `winner` flags.
 *
 * The flags are the authoritative reading, and they're what makes
 * retirements settle correctly: a match noted "6-4 2-3 ret" carries a winner
 * flag on the first set only, so it counts 1-0 — which is exactly what
 * docs/learning.js's gradeTennis needs to award the bet to the player who
 * was ahead on completed sets, rather than voiding a match that had a real
 * result.
 *
 * When a completed match carries no per-set flags at all (ESPN omits
 * linescores entirely on some walkovers, and has been inconsistent enough
 * elsewhere to be worth guarding), the counts stay 0-0 and gradeTennis
 * applies its own walkover rule. Nothing here invents a set score.
 */
function setsWon(competitors) {
  return competitors.map((c) => (c.linescores ?? []).filter((ls) => ls?.winner === true).length);
}

/** "6-3, 7-6" from both sides' linescores, oriented to the first competitor. Null when the sets aren't there. */
function setScoreLine(first, second) {
  const a = first?.linescores ?? [];
  const b = second?.linescores ?? [];
  if (!a.length || a.length !== b.length) return null;
  const sets = a.map((ls, i) => {
    const av = ls?.value;
    const bv = b[i]?.value;
    if (!Number.isFinite(Number(av)) || !Number.isFinite(Number(bv))) return null;
    return `${av}-${bv}`;
  });
  return sets.every(Boolean) ? sets.join(', ') : null;
}

/**
 * Every completed SINGLES match ESPN has for one tour over the lookback
 * window, flattened out of its groupings/competitions nesting.
 *
 * A tour's scoreboard nests as events (tournaments) -> groupings (mens-singles,
 * womens-doubles, ...) -> competitions (individual matches). The grouping
 * slug is what identifies doubles; `competition.type.slug` carries the same
 * thing per-match and both are checked, since a shape that reads the draw
 * type from only one place is one ESPN reshuffle away from silently letting
 * doubles back in.
 */
function parseTourResults(payloads, tour) {
  const matches = [];
  for (const data of payloads) {
    for (const event of data?.events ?? []) {
      const groupings = event.groupings?.length
        ? event.groupings
        : [{ grouping: { slug: '' }, competitions: event.competitions ?? [] }];
      for (const g of groupings) {
        if (/doubles/i.test(String(g?.grouping?.slug ?? ''))) continue;
        for (const c of g.competitions ?? []) {
          if (/doubles/i.test(String(c?.type?.slug ?? ''))) continue;
          if (!c.status?.type?.completed) continue;
          const [first, second] = c.competitors ?? [];
          const nameA = singlesName(first);
          const nameB = singlesName(second);
          if (!nameA || !nameB) continue;
          const [setsA, setsB] = setsWon([first, second]);
          matches.push({
            tour,
            a: normalizeName(nameA),
            b: normalizeName(nameB),
            displayA: nameA,
            displayB: nameB,
            setsA,
            setsB,
            aWon: first.winner === true,
            bWon: second.winner === true,
            // 'STATUS_FINAL' | 'STATUS_RETIRED' | 'STATUS_WALKOVER' — carried
            // for diagnostics; the settlement itself reads the set counts,
            // since gradeTennis already derives retirement/walkover from them.
            statusName: c.status?.type?.name ?? null,
            setScoreAB: setScoreLine(first, second),
            note: (c.notes ?? []).find((n) => n?.text)?.text ?? null,
            eventName: event.name ?? null,
          });
        }
      }
    }
  }
  return matches;
}

async function cachedJson(url, ttl, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/tennis-espn/${encodeURIComponent(url)}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });
  if (!response.ok) return null;

  const body = await response.text();
  ctx.waitUntil(
    cache.put(cacheKey, new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
    })),
  );
  try { return JSON.parse(body); } catch { return null; }
}

/**
 * Completed singles results for both tours over the lookback window, ready
 * to hand to gradeTennisPickWithEspn. Fetched once per grading pass rather
 * than once per pick — one request covers a whole tournament draw — and any
 * request that fails is simply left out rather than failing the batch, the
 * same "shorter card, never a wrong one" convention every other ESPN-backed
 * feature here follows.
 */
export async function fetchTennisResults(ctx, now = Date.now(), { tours = ['atp', 'wta'] } = {}) {
  const dates = Array.from({ length: RESULTS_LOOKBACK_DAYS }, (_, i) => espnDateParam(now - i * 86400000));
  const requests = [];
  for (const tour of tours) {
    const base = ESPN_TENNIS_SCOREBOARDS[tour];
    if (!base) continue;
    for (const date of dates) {
      requests.push({ tour, promise: cachedJson(`${base}?dates=${date}`, RESULTS_TTL, ctx) });
    }
  }
  const settled = await Promise.allSettled(requests.map((r) => r.promise));

  const byTour = new Map();
  settled.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value) return;
    const { tour } = requests[i];
    if (!byTour.has(tour)) byTour.set(tour, []);
    byTour.get(tour).push(r.value);
  });

  const matches = [];
  for (const [tour, payloads] of byTour) matches.push(...parseTourResults(payloads, tour));

  // The same tournament draw comes back under every date requested, so the
  // same match is parsed once per date. Deduped on the player pair rather
  // than a competition id so a genuine ESPN id reshuffle can't reintroduce
  // duplicates that would then read as the ambiguity guard's "two matches."
  const seen = new Set();
  return matches.filter((m) => {
    const key = `${m.tour}|${[m.a, m.b].sort().join('|')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The single ESPN match for one pick's two players, or null.
 *
 * Null on no match AND on more than one match. The second case is the point:
 * the loose name comparisons above (shared surname especially) can plausibly
 * hit two different matches in a large draw, and a pick left pending is
 * recoverable while a pick settled off the wrong match is not.
 */
export function findTennisMatch(pick, results) {
  const tour = tourOf(pick?.sportKey);
  const normHome = normalizeName(pick?.home);
  const normAway = normalizeName(pick?.away);
  if (!tour || !normHome || !normAway) return null;

  const hits = (results ?? []).filter(
    (m) => m.tour === tour
      && ((namesLikelyMatch(m.a, normHome) && namesLikelyMatch(m.b, normAway))
        || (namesLikelyMatch(m.a, normAway) && namesLikelyMatch(m.b, normHome))),
  );
  return hits.length === 1 ? hits[0] : null;
}

/**
 * A gradePick()-compatible synthetic scoreEvent for one tennis pick, built
 * from ESPN's completed singles results — the same trick
 * worker/src/ufc-events.js's buildMmaScoreEvent plays for MMA, and for the
 * same reason: the settlement rules already exist and are already tested, so
 * the only thing missing was numbers to feed them.
 *
 * Scores are SETS WON, which is exactly what gradeTennis reads and what the
 * Odds API would have carried had it ever posted tennis at all. A walkover
 * arrives as 0-0 and a retirement as (say) 1-0, and gradeTennis's own
 * existing rules take it from there. Returns null when no single ESPN match
 * corresponds to this pick.
 */
export function buildTennisScoreEvent(pick, results) {
  const match = findTennisMatch(pick, results);
  if (!match) return null;

  const homeIsA = namesLikelyMatch(match.a, normalizeName(pick.home));
  return {
    completed: true,
    scores: [
      { name: pick.home, score: homeIsA ? match.setsA : match.setsB },
      { name: pick.away, score: homeIsA ? match.setsB : match.setsA },
    ],
  };
}

/**
 * ESPN's per-set GAMES score, in the `{ participantNames, score, status }`
 * shape docs/tennis-results.js's gradeTennisGameMarket already reads.
 *
 * This is what makes a tennis spread or total settleable at all. Those
 * markets are priced in games (confirmed against the live catalogue: a
 * spread ladder running -6.5 through 6.5 in half-game steps, totals of
 * 17.5-23.5 — no set line looks like that), while the only score any feed
 * gave us was sets, so gradeTennis voided every one of them as "priced in
 * games but scored in sets." A full WTA day put eight such picks on the
 * board and voided all eight. ESPN's `linescores[].value` IS the games
 * count per set, so the answer was one field away the whole time.
 *
 * The grading math is not reimplemented here — gradeTennisGameMarket was
 * written for the metered source and is already tested against real
 * scorelines, including the exact-number push cases the whole-number rungs
 * of that ladder make possible.
 *
 * STATUS_FINAL only. A retirement has no fixed final games total from any
 * source (the match simply stopped), and a walkover has none at all, so
 * both keep voiding — which is what books do with them too.
 *
 * `participantNames` is handed back in ESPN's own column order using the
 * PICK's spelling of each name, not ESPN's. gradeTennisGameMarket orients
 * itself with matchHomeIndex, which compares names by strict equality — so
 * feeding it ESPN's spelling would silently fail to orient exactly the
 * cases this module's fuzzy matcher exists to handle ("Zhu Lin" vs "Lin
 * Zhu"). The orientation is already decided, once, by that matcher.
 */
export function buildTennisGameResult(pick, match) {
  if (!match || match.statusName !== 'STATUS_FINAL' || !match.setScoreAB) return null;
  const homeIsA = namesLikelyMatch(match.a, normalizeName(pick.home));
  return {
    participantNames: homeIsA ? [pick.home, pick.away] : [pick.away, pick.home],
    score: match.setScoreAB,
    status: 'Ended',
  };
}

/**
 * Whether a pick was voided ONLY because no games-level score existed, and
 * so deserves another look now that one does.
 *
 * Grading passes include these alongside genuinely pending picks, which is
 * what repairs a board that was already settled under the old rule — the
 * alternative being a manual sweep that has to be remembered and run once
 * per affected day. Narrow on purpose: it matches one exact void reason on
 * one sport, and never a manual retraction (worker/src/retraction.js), whose
 * whole point is that it stays pulled.
 */
export function isRegradableTennisVoid(pick) {
  return pick?.status === 'void'
    && isTennisKey(pick?.sportKey)
    && !pick?.retracted
    && pick?.result?.voidReason === UNSETTLEABLE_TENNIS_GAME_MARKET;
}

/** Whether an outcome is the same unsettleable void the pick already carries — i.e. nothing changed and there's nothing to rewrite. */
export function isNoOpTennisRegrade(pick, outcome) {
  return isRegradableTennisVoid(pick)
    && Boolean(outcome?.void)
    && outcome.reason === pick.result?.voidReason;
}

/** The `{ setScore, winner }` display detail docs/app.js already renders for a settled tennis pick. */
function tennisDetail(match) {
  if (!match) return null;
  const winner = match.aWon ? match.displayA : match.bWon ? match.displayB : null;
  if (!winner) return null;
  // setScoreAB is oriented A-first; flip it when B won so the line reads from
  // the winner's side, matching how a scoreline is normally written.
  const setScore = match.setScoreAB && match.bWon
    ? match.setScoreAB.split(', ').map((s) => s.split('-').reverse().join('-')).join(', ')
    : match.setScoreAB;
  return setScore ? { setScore, winner } : { winner };
}

/**
 * Settle one tennis pick, ESPN first.
 *
 * Shared by all three grading passes (Full Slate, Pixel's Picks, Play of the
 * Day) rather than written out three times, for the reason
 * gradeMmaPickWithFallback is: a name-matching or precedence bug fixed in
 * one copy and not the others is the exact failure this codebase keeps
 * paying for.
 *
 * Precedence is ESPN over the odds feed, not the fallback ordering MMA uses.
 * That's deliberate: for MMA the odds feed does eventually post results and
 * ESPN only covers the lag, whereas for tennis the odds feed has never
 * posted one, so trying it first is a guaranteed null on every pick. When
 * ESPN has no match the odds event is still tried, so the day the provider
 * starts carrying tennis nothing here has to change to benefit from it.
 *
 * The metered RapidAPI source (worker/src/tennis-results.js) keeps its exact
 * existing role for TIER_1 spreads/totals — it's the only source that can
 * give a GAMES count, which sets alone can't settle — except that it now
 * receives a scoreEvent whose `completed` flag is actually true, so its
 * budget checks and its retirement-rescue logic can run at all for the first
 * time.
 */
export async function gradeTennisPickWithEspn(pick, primaryScoreEvent, results, env, ctx, now = Date.now(), { secondarySource = null } = {}) {
  const match = findTennisMatch(pick, results);
  const espnScoreEvent = buildTennisScoreEvent(pick, results);
  const scoreEvent = espnScoreEvent ?? primaryScoreEvent;

  const settle = secondarySource ?? settleTennisGameMarket;
  // ESPN's own games score first: it settles spreads/totals for free, for
  // every tier, with no daily budget — so the metered source is only
  // reached now when ESPN has no match for the pick at all.
  const espnGames = gradeTennisGameMarket(pick, buildTennisGameResult(pick, match));
  const outcome = espnGames
    ?? (await settle(pick, scoreEvent, env, ctx, now))
    ?? gradePick(pick, scoreEvent, now);
  if (!outcome || outcome.void) return outcome;

  // Purely additive display data, and only when the grading source didn't
  // already supply its own richer detail (the metered source carries a real
  // games-level scoreline; ESPN's is sets).
  const detail = outcome.detail ?? tennisDetail(match);
  return detail ? { ...outcome, detail } : outcome;
}
