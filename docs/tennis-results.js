/**
 * Tennis settlement via a second, set-level data source — games-level
 * (spreads/totals) plus a rescue path for h2h.
 *
 * Pure functions only — no DOM, no network — same boundary as every other
 * docs/ module. The impure piece (the metered RapidAPI call, the daily
 * budget guard) lives in worker/src/tennis-results.js and hands this module
 * already-fetched, plain data.
 *
 * ── Why this exists (spreads/totals) ──────────────────────────────────────
 * docs/learning.js's gradeTennis voids every tennis spreads/totals pick
 * outright: the Odds API prices those markets in GAMES (a −4.5 handicap, a
 * 21.5 total) but its own /scores endpoint only ever reports SETS (0/1/2),
 * so there's no games-level result to settle against. A second provider
 * (confirmed live, see the conversation that added this) returns a
 * `score` field like `"7-6,6-1"` — actual games per set — which is exactly
 * the missing number. gradeTennisGameMarket turns that string into a real
 * settlement when it's available, and returns null (never a guess) the
 * moment anything about it doesn't line up.
 *
 * ── Why this also exists (h2h) ────────────────────────────────────────────
 * h2h isn't unsettleable by the free source the way spreads/totals are —
 * most h2h picks grade fine on their own. But the free /scores feed can
 * mark a match completed:true while never posting real set data at all:
 * confirmed live, one TIER_1 ATP match sat at 0-0, completed:true, for 7+
 * hours after commence. docs/learning.js's gradeTennis reads "0 sets played"
 * as a walkover and voids the pick permanently — wrong, when the match
 * actually had a real, decisive winner the free feed just never reported.
 * gradeTennisMatchWinner derives the set-by-set winner from the exact same
 * per-set games score gradeTennisGameMarket already parses (games won in a
 * set implies who won that set), so no separate data need be fetched.
 *
 * ── Why this only ever supplements, never replaces, the free grader ──────
 * The second source is rate-limited to 50 requests/day on the free tier
 * (see worker/src/tennis-results.js's own budget guard, and its
 * settleTennisGameMarket which only spends a call on h2h when the free
 * source couldn't decide it in the first place — not on every match).
 * Every failure mode here — a name that doesn't confidently match, a score
 * string that doesn't parse, budget exhaustion — returns null so the caller
 * falls back to docs/learning.js's existing, already-correct void. This
 * module is strictly additive: it can turn some voids into real grades, but
 * it can never turn a real grade into a wrong one, because a null here
 * changes nothing about the existing behavior.
 */

/** Case/punctuation/diacritic-insensitive name compare — same technique as docs/mlb-props.js's normalizeName. */
function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * "7-6,6-1" -> [[7,6],[6,1]] — games won by [participant1, participant2] in
 * each set, in the order the API lists them. Tolerates a trailing tiebreak
 * annotation some providers append, e.g. "7-6(4)" is still a 7-6 set; the
 * point total inside the parens isn't a games count and is discarded.
 *
 * Returns null for anything that doesn't cleanly parse as a comma-separated
 * list of "N-N" pairs — a retirement's final set is sometimes reported as
 * just a lone leading number or omitted entirely, and guessing at that
 * shape would be exactly the kind of fabricated result this exists to
 * avoid causing.
 */
export function parseSetScore(scoreString) {
  const sets = String(scoreString ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!sets.length) return null;

  const parsed = [];
  for (const set of sets) {
    const m = set.match(/^(\d+)-(\d+)(?:\(\d+\))?$/);
    if (!m) return null;
    parsed.push([Number(m[1]), Number(m[2])]);
  }
  return parsed;
}

/**
 * Which side of the result API's response (0 or 1) corresponds to the
 * tracked pick's own `home`, by normalized name — independent of URL
 * argument order, since the API's own participant order in its response
 * isn't guaranteed to match the order names were passed in the request.
 * Returns null if neither side confidently matches, or both do (a same-
 * surname edge case) — either way, not safe to attribute games to a side.
 */
export function matchHomeIndex(pick, participantNames) {
  const home = normalizeName(pick?.home);
  const matches = (participantNames ?? []).map((n) => normalizeName(n) === home);
  const homeCount = matches.filter(Boolean).length;
  if (homeCount !== 1) return null;
  return matches.indexOf(true);
}

function voidResult(reason) {
  return { void: true, reason, payout: 0 };
}

/**
 * Settle a tennis spreads/totals pick from the second source's raw result.
 *
 * `apiResult`: `{ participantNames: [name0, name1], score: "7-6,6-1",
 * status }` — already extracted from the provider's response shape by
 * worker/src/tennis-results.js, so this stays pure and independently
 * testable against that one small, stable shape rather than the provider's
 * full response.
 *
 * Returns `{won,payout}` | `{void,reason,payout}` | `null` — null means
 * "couldn't get a trustworthy answer from this source," which tells the
 * caller to fall back to docs/learning.js's gradePick rather than to treat
 * this as a settled result of any kind.
 */
export function gradeTennisGameMarket(pick, apiResult) {
  if (pick?.marketKey !== 'spreads' && pick?.marketKey !== 'totals') return null;
  if (apiResult?.status !== 'Ended') return null; // not a clean, final result by this source's own account

  const sets = parseSetScore(apiResult?.score);
  if (!sets) return null;

  const homeIdx = matchHomeIndex(pick, apiResult?.participantNames);
  if (homeIdx == null) return null;
  const awayIdx = homeIdx === 0 ? 1 : 0;

  const homeGames = sets.reduce((sum, set) => sum + set[homeIdx], 0);
  const awayGames = sets.reduce((sum, set) => sum + set[awayIdx], 0);

  const pickedIsHome = pick.outcomeName === pick.home;
  const pickedGames = pickedIsHome ? homeGames : awayGames;
  const otherGames = pickedIsHome ? awayGames : homeGames;
  const point = pick.point ?? 0;

  let won;
  if (pick.marketKey === 'totals') {
    const total = homeGames + awayGames;
    if (total === point) return voidResult('push — total games landed exactly on the number');
    won = pick.outcomeName === 'Over' ? total > point : total < point;
  } else {
    const margin = pickedGames + point - otherGames;
    if (margin === 0) return voidResult('push — game margin landed exactly on the spread');
    won = margin > 0;
  }

  const payout = won ? (pick.decimal - 1) * pick.suggested_stake : -pick.suggested_stake;
  return { won, payout };
}

/**
 * Settle a tennis h2h (match-winner) pick from the second source's raw
 * result — the rescue path described at the top of this file. Derives the
 * set-by-set winner from the same per-set games score gradeTennisGameMarket
 * parses (whoever won more games in a set won that set), then counts sets:
 * best-of-3 or best-of-5, the first to reach a strict majority of played
 * sets is the match winner.
 *
 * Returns `{won,payout}` | `null` — never a void: a status:'Ended' result
 * from this source with a parseable score and a confident name match always
 * has a decisive winner (there's no push in a match-winner bet), so
 * anything short of that just isn't a trustworthy answer and falls back to
 * docs/learning.js's gradePick, same as gradeTennisGameMarket's null case.
 */
export function gradeTennisMatchWinner(pick, apiResult) {
  if (pick?.marketKey !== 'h2h') return null;
  if (apiResult?.status !== 'Ended') return null; // not a clean, final result by this source's own account

  const sets = parseSetScore(apiResult?.score);
  if (!sets || !sets.length) return null;

  const homeIdx = matchHomeIndex(pick, apiResult?.participantNames);
  if (homeIdx == null) return null;
  const awayIdx = homeIdx === 0 ? 1 : 0;

  const homeSets = sets.filter((set) => set[homeIdx] > set[awayIdx]).length;
  const awaySets = sets.filter((set) => set[awayIdx] > set[homeIdx]).length;
  if (homeSets === awaySets) return null; // shouldn't happen for a genuinely 'Ended' match — not safe to guess

  const pickedIsHome = pick.outcomeName === pick.home;
  const won = pickedIsHome ? homeSets > awaySets : awaySets > homeSets;
  const payout = won ? (pick.decimal - 1) * pick.suggested_stake : -pick.suggested_stake;
  return { won, payout };
}
