/**
 * Match MMA fighters from The Odds API to their real event — sourced live
 * from ESPN's own MMA scoreboards rather than a hand-maintained list.
 *
 * This used to be a static, manually-updated fighter-to-event mapping
 * (worker/src/ufc-events-upcoming.js, "updated weekly") that went stale and
 * produced actively wrong results — e.g. it buried "Gamrot vs. Salkilld" as
 * one fight inside a different event's roster ("UFC Fight Night: Miller vs.
 * Goff") instead of recognizing it as its own separate card. ESPN's own
 * scoreboards (site.web.api.espn.com — the same host already proven reachable
 * from a Cloudflare Worker for MLB stats, unlike the 403-blocked
 * site.api.espn.com) carry the real, current event name and full fight card
 * for weeks out, so this is read live and cached instead of hand-kept.
 *
 * The Odds API's "mma_mixed_martial_arts" market blends multiple promotions
 * under one key with no promotion tag on the event, and each promotion has
 * its own separate ESPN scoreboard endpoint — a PFL fighter is never on
 * UFC's board or vice versa — so every promotion is fetched and merged into
 * one lookup index.
 *
 * Which promotions those are is discovered from ESPN rather than hardcoded.
 * A fixed `{ ufc, pfl }` pair shipped first, and every card from any other
 * promotion the odds feed carried (Bellator, ONE, Cage Warriors, LFA, RIZIN,
 * Invicta — the feed doesn't say which) had no source at all for its name
 * and displayed as a bare "Card - MM/DD". Hardcoding a longer list just
 * moves the staleness: ESPN adds and retires MMA league slugs, and a
 * promotion missing from a hand-kept list fails exactly the same silent way.
 * See discoverMmaLeagues.
 */

import { gradePick } from '../../docs/learning.js';

/**
 * Promotions proven live from a Cloudflare Worker, always queried regardless
 * of what discovery returns — so a discovery outage can never be worse than
 * the fixed pair this replaced.
 */
const SEED_MMA_LEAGUES = ['ufc', 'pfl'];
const scoreboardUrl = (league) => `https://site.web.api.espn.com/apis/site/v2/sports/mma/${league}/scoreboard`;

/**
 * Where ESPN's own MMA league list is read from. Both are best-effort and
 * merged: the header endpoint is on site.web.api.espn.com, the one host
 * already proven reachable from a Worker, and the core endpoint is the
 * canonical league index (broader, but a different host that may or may not
 * answer). A source that fails, 403s, or changes shape contributes nothing
 * and is not an error.
 */
const LEAGUE_DIRECTORIES = [
  {
    url: 'https://site.web.api.espn.com/apis/v2/scoreboard/header?sport=mma',
    // { sports: [{ leagues: [{ slug: 'ufc', ... }] }] }
    parse: (data) => (data?.sports ?? []).flatMap((s) => (s?.leagues ?? []).map((l) => l?.slug ?? l?.abbreviation)),
  },
  {
    url: 'https://sports.core.api.espn.com/v2/sports/mma/leagues?limit=100',
    // { items: [{ $ref: 'https://.../sports/mma/leagues/ufc?lang=en' }] } —
    // the slug is read straight out of the ref so the index costs one
    // request, not one per league.
    parse: (data) => (data?.items ?? []).map((item) => {
      const ref = typeof item === 'string' ? item : item?.$ref;
      return String(ref ?? '').match(/\/leagues\/([^/?#]+)/)?.[1] ?? null;
    }),
  },
];

/** A slug shaped like a real ESPN league path segment — anything else is a parse artifact, not a promotion. */
const LEAGUE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,23}$/;
/**
 * Ceiling on promotions queried per pass. Every league is one more outbound
 * request on a path that has already hit Cloudflare's per-invocation
 * subrequest limit once (see enrichMmaEvents in worker/src/odds.js), and a
 * directory that suddenly returns a hundred slugs must not be able to take
 * the whole slate down with it. Seeds are kept first, so a truncation can
 * only ever drop a promotion the fixed pair never covered anyway.
 */
const MAX_MMA_LEAGUES = 8;

const SCHEDULE_TTL = 3600 * 6; // a card can still be adjusted; not worth caching longer
const RESULTS_TTL = 300; // completed fights don't change, but this window also has to catch cards still airing
const RESULTS_LOOKBACK_DAYS = 3; // matches worker/src/odds.js's own fetchScores daysFrom=3 convention
const LEAGUES_TTL = 86400; // ESPN adds or retires an MMA promotion a few times a year, not a few times a day

/**
 * Folds accents before stripping non-alphanumerics (NFD-normalize, then drop
 * the resulting combining-diacritic codepoints) — matching worker/src/mma.js's
 * own `fold()` convention. Without this, a plain `[^a-z0-9 ]` strip on an
 * un-normalized string mangles an accented letter into nothing rather than
 * its base letter (e.g. "José" -> "jos" instead of "jose"), which broke real
 * matches against ESPN's own accented spellings — confirmed live: "Joel
 * Álvarez" (ESPN) vs "Joel Alvarez" (Odds API) silently failed to match
 * before this fix.
 */
export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The last space-separated token of a normalized name — the surname, for the common "First [Middle] Last" shape. */
function lastToken(normalized) {
  const parts = normalized.split(' ').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/**
 * Whether two normalized names plausibly refer to the same fighter. Odds API
 * and ESPN routinely disagree on a fighter's exact name string for the same
 * real person — confirmed live across a full week's UFC/PFL cards: a
 * nickname used as a first name ("Gigi" vs "Giovanna" Canuto), a missing or
 * extra middle name ("Billy Ray Goff" vs "Billy Goff", "Carlos Diego
 * Ferreira" vs "Diego Ferreira"), a shortened first name ("Josh" vs
 * "Joshua" Silveira), and a two-word surname one source concatenates and the
 * other doesn't ("DelValle" vs "del Valle") all showed up as real,
 * currently-scheduled fights that an exact-string match silently missed and
 * fell back to a generic "Card - MM/DD" grouping for. A shared surname (the
 * most stable part of a name across sources) or a squashed-whitespace
 * containment match catches all of the above without needing a fuzzy-string
 * library; the risk of a false positive (two different fighters on the same
 * card sharing a surname) is bounded by this only ever affecting which
 * event NAME a fight displays under, never any other data.
 */
function namesLikelyMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (lastToken(a) && lastToken(a) === lastToken(b)) return true;
  const squashedA = a.replace(/ /g, '');
  const squashedB = b.replace(/ /g, '');
  return squashedA.includes(squashedB) || squashedB.includes(squashedA);
}

function dateRangeParam(now) {
  const fmt = (d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  };
  const start = new Date(now);
  const end = new Date(now + 30 * 86400000);
  return `${fmt(start)}-${fmt(end)}`;
}

/** The mirror of dateRangeParam, looking backward instead of forward — for
 * results (recently completed fights) rather than the upcoming schedule. */
function lookbackDateRangeParam(now, daysBack) {
  const fmt = (d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  };
  const start = new Date(now - daysBack * 86400000);
  const end = new Date(now);
  return `${fmt(start)}-${fmt(end)}`;
}

async function cachedJson(url, ttl, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/ufc-events/${encodeURIComponent(url)}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`ESPN MMA scoreboard returned ${response.status}`);
  const body = await response.text();
  ctx.waitUntil(
    cache.put(cacheKey, new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
    })),
  );
  return JSON.parse(body);
}

function parseSchedule(data) {
  const events = data?.events ?? [];
  return events.map((e) => ({
    name: e.name,
    // ESPN's own start time for the event, used only for the same-day
    // fallback below — null (not NaN) when ESPN omits it, so a schedule
    // entry with no date never accidentally matches every fight.
    date: e.date ? Date.parse(e.date) : null,
    fights: (e.competitions ?? []).map((c) => {
      const [a, b] = c.competitors ?? [];
      return {
        a: normalizeName(a?.athlete?.displayName),
        b: normalizeName(b?.athlete?.displayName),
        // The competitor's own ESPN athlete id — same id space regardless of
        // which promotion's scoreboard it came from (confirmed live: a PFL
        // scoreboard competitor's id resolves fine through the UFC athlete
        // endpoint too). Carried alongside the normalized names so a caller
        // that already has this schedule fetched (resolveEspnAthleteId
        // below) never needs a second network round trip just to find an id
        // it already had in hand.
        aId: a?.id ?? null,
        bId: b?.id ?? null,
      };
    }),
  }));
}

/**
 * Every MMA promotion ESPN publishes a scoreboard for — the seeds plus
 * whatever its own league directories list, deduped, validated, and capped.
 *
 * This is what stops a non-UFC/PFL card from falling through to "Card -
 * MM/DD": the Odds API hands over two fighter names and a start time with no
 * promotion attached, so the only way to name the event is to have already
 * asked the promotion's own scoreboard about it. Cached for LEAGUES_TTL —
 * the list is near-static, and this runs on the same request path as the
 * schedule fetch it feeds.
 *
 * Never throws: a total discovery failure returns the seeds, which is
 * exactly the coverage this function replaced.
 */
export async function discoverMmaLeagues(ctx) {
  const settled = await Promise.allSettled(
    LEAGUE_DIRECTORIES.map(async ({ url, parse }) => parse(await cachedJson(url, LEAGUES_TTL, ctx))),
  );

  const leagues = [...SEED_MMA_LEAGUES];
  // Directory order is priority order, and it decides who survives the cap:
  // the header endpoint lists what ESPN's own site surfaces right now
  // (active promotions), while the core index also carries long-dead ones
  // no odds feed prices anymore. Within a directory the slugs are sorted, so
  // the same directory response always yields the same list — a card named
  // on one request must not be a bare date on the next.
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    const slugs = (result.value ?? [])
      .map((raw) => String(raw ?? '').trim().toLowerCase())
      .filter((slug) => LEAGUE_SLUG_PATTERN.test(slug));
    for (const slug of [...new Set(slugs)].sort()) {
      if (!leagues.includes(slug)) leagues.push(slug);
    }
  }
  return leagues.slice(0, MAX_MMA_LEAGUES);
}

/**
 * One scoreboard request per discovered promotion for the same date range,
 * settled independently — one promotion 404ing (a slug ESPN lists but has no
 * scoreboard for) or timing out never costs the others their cards.
 */
async function fetchAllScoreboards(dates, ttl, ctx) {
  const leagues = await discoverMmaLeagues(ctx);
  return Promise.allSettled(
    leagues.map((league) => cachedJson(`${scoreboardUrl(league)}?dates=${dates}`, ttl, ctx)),
  );
}

/**
 * Both fighters' ESPN athlete ids for one specific matchup, resolved
 * against an already-fetched schedule (see fetchMmaSchedule) — the same
 * namesLikelyMatch tolerance getUfcEventDetails uses for event-card
 * matching, reused here because it's the identical problem: the odds feed's
 * name and ESPN's own listed name for the same fight routinely differ in
 * exactly the same ways (a shortened first name, a missing middle name).
 *
 * Deliberately takes BOTH names and only accepts a fight where BOTH sides
 * plausibly match, not "the first fight anywhere on the 30-day schedule
 * with a same-surname fighter." A single-name version of this shipped
 * first and produced a confirmed live false positive: "Ty Miller" resolved
 * to "Juliana Miller" — a completely different fighter on an unrelated
 * card, matched purely on a shared surname with no cross-check that her
 * actual opponent had anything to do with the real fight being looked up.
 * Requiring the SAME fight's other side to also match (mirroring
 * getUfcEventDetails's own already-proven pattern, `namesLikelyMatch(f.a,
 * normA) && namesLikelyMatch(f.b, normB)`) closes that off: a same-surname
 * collision would need two different fighters sharing a surname WITHIN one
 * scheduled bout, which doesn't happen. Returns { aId: null, bId: null }
 * when no scheduled fight has both sides plausibly matching.
 */
export function resolveEspnAthleteIds(fighterA, fighterB, schedule) {
  const normA = normalizeName(fighterA);
  const normB = normalizeName(fighterB);
  if (!normA || !normB) return { aId: null, bId: null };

  for (const event of schedule) {
    for (const fight of event.fights) {
      if (namesLikelyMatch(fight.a, normA) && namesLikelyMatch(fight.b, normB)) {
        return { aId: fight.aId, bId: fight.bId };
      }
      if (namesLikelyMatch(fight.a, normB) && namesLikelyMatch(fight.b, normA)) {
        return { aId: fight.bId, bId: fight.aId };
      }
    }
  }
  return { aId: null, bId: null };
}

/**
 * Every upcoming MMA event ESPN has scheduled over the next 30 days, across
 * every promotion discoverMmaLeagues turns up, each with its real name and
 * the normalized fighter-pair for every fight on the card — built once per
 * cache window, not once per fight, since a single request per promotion
 * already covers the whole window. A promotion whose
 * fetch fails is simply left out of the merged schedule rather than failing
 * the whole lookup; only a total failure across every promotion falls
 * through to the caller's date-grouping fallback.
 */
export async function fetchMmaSchedule(ctx, now = Date.now()) {
  const results = await fetchAllScoreboards(dateRangeParam(now), SCHEDULE_TTL, ctx);

  const schedule = results.filter((r) => r.status === 'fulfilled').flatMap((r) => parseSchedule(r.value));
  if (schedule.length === 0 && results.every((r) => r.status === 'rejected')) {
    throw results[0].reason;
  }
  return schedule;
}

/**
 * Format a date from commenceMs for fallback grouping when ESPN can't be
 * reached at all (never used for a fighter ESPN simply hasn't matched —
 * only for a genuine fetch failure).
 */
function formatEventDate(commenceMs) {
  const date = new Date(commenceMs);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${month}/${day}`;
}

/**
 * Look up the real UFC/MMA event for one matchup, from ESPN's live schedule.
 * Falls back to date-based grouping only when the live fetch itself fails —
 * never falls back to a stale hardcoded guess.
 *
 * `schedule` is optional: pass an already-fetched schedule (see
 * `fetchMmaSchedule`) when matching many fights in the same request — a
 * whole event slate enriches its fights concurrently (`Promise.all`), and
 * without a shared schedule each fight would independently re-fetch both
 * ESPN scoreboards with no request coalescing, which is exactly what blew
 * through Cloudflare's per-invocation subrequest limit once a second
 * promotion (PFL) doubled the outbound calls. Omit it only for one-off
 * lookups outside that batch path.
 */
export async function getUfcEventDetails(fighterA, fighterB, commenceMs, ctx, schedule) {
  if (!fighterA || !fighterB) return null;

  const normA = normalizeName(fighterA);
  const normB = normalizeName(fighterB);

  let sched = schedule;
  if (sched === undefined) {
    try {
      sched = await fetchMmaSchedule(ctx);
    } catch {
      sched = [];
    }
  }

  for (const event of sched) {
    const matched = event.fights.some(
      (f) => (namesLikelyMatch(f.a, normA) && namesLikelyMatch(f.b, normB))
        || (namesLikelyMatch(f.a, normB) && namesLikelyMatch(f.b, normA)),
    );
    if (matched) return { event: event.name };
  }

  // Neither fighter matched any listed fight on any card — before falling
  // back to a generic date label, check whether exactly one scheduled
  // event's own start time falls within a card-length window of this
  // fight. A real card often has untelevised early-prelim bouts ESPN's
  // scoreboard API simply doesn't list as individual competitions —
  // confirmed live twice now: "Miles Johns vs Gianni Vazquez" 40 minutes
  // after UFC Fight Night: Gamrot vs Salkilld went live, and "Charles
  // Johnson vs Jose Ochoa" 5 hours after UFC 330's own listed start —
  // neither on UFC's nor PFL's schedule at all, yet both on cards with no
  // other UFC/PFL event anywhere nearby.
  //
  // This was first built as a same-UTC-calendar-day check and that's
  // exactly what missed the Ochoa fight: ESPN lists UFC 330's start as
  // 2026-08-15T21:00Z (evening US primetime), but the main card runs past
  // midnight UTC into 2026-08-16 — same real card, different UTC date. A
  // fixed time window anchored to the event's own start, not calendar-day
  // equality, is what actually matches "same card": no real UFC/PFL
  // promotion runs a single event's prelims-to-main-event span past 16
  // hours, and consecutive separate events are always at least a day or
  // two apart (confirmed against ESPN's own 30-day schedule), so a 16-hour
  // window can't accidentally straddle two different cards.
  //
  // Only applied when exactly one event's window contains this fight — a
  // same-day double-header between two promotions (rare, but not
  // impossible) would be ambiguous, and an ambiguous guess is worse than
  // the plain date label.
  if (commenceMs) {
    const CARD_WINDOW_MS = 16 * 3600000;
    const withinWindow = sched.filter(
      (event) => event.date != null && Math.abs(commenceMs - event.date) <= CARD_WINDOW_MS,
    );
    if (withinWindow.length === 1) return { event: withinWindow[0].name };
    return { event: `Card - ${formatEventDate(commenceMs)}` };
  }
  return null;
}

/**
 * Every completed fight from every discovered MMA promotion's scoreboard over the last
 * RESULTS_LOOKBACK_DAYS, each with both competitors' names and which one
 * won — a fallback grading source for MMA specifically. The Odds API's own
 * /scores endpoint routinely lags real fight results by hours for
 * untelevised early-prelim bouts (confirmed live: every fight on a finished
 * card still read completed:false hours after the card itself had aired,
 * PFL Charlotte's entire 12-fight card included) while ESPN's scoreboard
 * already carries the final result the moment the fight ends — this is what
 * actually lets a pending pick get graded the same night instead of sitting
 * pending indefinitely, waiting on a data source that may never post it for
 * a thinly-covered bout.
 */
export async function fetchMmaResults(ctx, now = Date.now()) {
  const dates = lookbackDateRangeParam(now, RESULTS_LOOKBACK_DAYS);
  const results = await fetchAllScoreboards(dates, RESULTS_TTL, ctx);

  const fights = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const event of r.value?.events ?? []) {
      for (const c of event.competitions ?? []) {
        if (!c.status?.type?.completed) continue;
        const [a, b] = c.competitors ?? [];
        const nameA = a?.athlete?.displayName;
        const nameB = b?.athlete?.displayName;
        if (!nameA || !nameB) continue;
        fights.push({
          a: normalizeName(nameA),
          b: normalizeName(nameB),
          aWon: a.winner === true,
          bWon: b.winner === true,
          // Real display names + finish method carried for the finished
          // card's "Gamrot by Decision" line. Null (never a guess) when
          // ESPN's own feed has no method for this fight either — see
          // mmaFinishMethod's own comment.
          displayA: nameA,
          displayB: nameB,
          method: mmaFinishMethod(c),
          // The round the fight ended in (ESPN's status.period) — what
          // grades "in round 1" and over/under-rounds straights. Null when
          // ESPN omits it; those straights then void rather than guess.
          round: Number.isFinite(Number(c.status?.period)) && Number(c.status.period) > 0
            ? Number(c.status.period)
            : null,
        });
      }
    }
  }
  return fights;
}

// ESPN's own label for a KO/TKO finish, confirmed against a live scoreboard
// (UFC 330, 2026-08-15) — read verbatim it looks like a typo, but three of
// three fights carrying this label also carried an explicit "Knockdown"
// entry elsewhere in the same competition's details array, so it is what
// it looks like it is, not noise. Normalized to the real name on the way
// out; the raw value is never shown to a user.
const ESPN_METHOD_ALIASES = { kotko: 'KO/TKO' };

/**
 * Finish method from an ESPN MMA competition — "KO/TKO", "Submission",
 * "Decision", etc. Confirmed live (UFC 330, 2026-08-15): there is no
 * `status.result` and no per-competitor `result` field on this feed at
 * all — an earlier version of this read both and always got null as a
 * result, silently. The real signal is one entry in the competition's own
 * `details` array (the same play-by-play list "Round Start"/"Takedown
 * Attempt"/etc. live in), text-prefixed "Unofficial Winner " — e.g.
 * "Unofficial Winner Submission", "Unofficial Winner Decision". Matched by
 * that prefix rather than a fixed `details` index or a numeric `type.id`:
 * position isn't reliable (confirmed on the same card — one fight's winner
 * entry sat at details[0], another's had no such entry anywhere in the
 * array at all), and new numeric ids are exactly the kind of thing ESPN
 * adds without notice. Two of the eight fights on the confirming card had
 * no "Unofficial Winner" entry at all — a genuine gap in ESPN's own
 * play-by-play, not a parsing miss — and null is the honest answer for
 * those, same as ESPN's own answer.
 */
export function mmaFinishMethod(competition) {
  const entry = (competition?.details ?? []).find((d) => /^unofficial winner\s+/i.test(d?.type?.text ?? ''));
  if (!entry) return null;
  const raw = entry.type.text.replace(/^unofficial winner\s+/i, '').trim();
  if (!raw) return null;
  return ESPN_METHOD_ALIASES[raw.toLowerCase()] ?? raw;
}

/**
 * A gradePick()-compatible synthetic scoreEvent for one MMA pick, built from
 * ESPN's completed-fight results (see fetchMmaResults) instead of The Odds
 * API's /scores. Winner gets score 1, loser gets score 0 — gradePick()'s own
 * h2h comparison (pickedScore > otherScore) resolves correctly off that
 * alone, no MMA-specific grading logic needed. A draw or no-contest has
 * neither side marked winner, which naturally becomes a 0-0 tie —
 * gradePick() already treats an exact score tie on h2h as a push and leaves
 * it pending, so a draw here correctly never gets forced into a win or a
 * loss. Returns null (never fabricates a result) when no ESPN fight matches
 * both names.
 */
/** The ESPN fight record matching one tracked bout's two names, else null — shared by grading fallback and display-detail attachment. */
export function findMmaFight(homeTeam, awayTeam, results) {
  const normHome = normalizeName(homeTeam);
  const normAway = normalizeName(awayTeam);
  return results.find(
    (f) => (namesLikelyMatch(f.a, normHome) && namesLikelyMatch(f.b, normAway))
      || (namesLikelyMatch(f.a, normAway) && namesLikelyMatch(f.b, normHome)),
  ) ?? null;
}

/**
 * A gradePick()-compatible synthetic scoreEvent for one MMA h2h pick, built
 * from ESPN's completed-fight results. h2h ONLY — gradeGeneric's h2h branch
 * just compares which side scored higher, so a plain win/loss flag (1 vs 0)
 * is all it needs. Do not reuse this for a totals (rounds) market: see
 * buildMmaRoundsScoreEvent below and gradeMmaPickWithFallback's own comment
 * for why a 1/0 win flag silently breaks that market instead of erroring.
 */
export function buildMmaScoreEvent(homeTeam, awayTeam, results) {
  const normHome = normalizeName(homeTeam);
  const normAway = normalizeName(awayTeam);

  const fight = findMmaFight(homeTeam, awayTeam, results);
  if (!fight) return null;

  const homeIsA = namesLikelyMatch(fight.a, normHome);
  const homeWon = homeIsA ? fight.aWon : fight.bWon;
  const awayWon = homeIsA ? fight.bWon : fight.aWon;

  return {
    completed: true,
    scores: [
      { name: homeTeam, score: homeWon ? 1 : 0 },
      { name: awayTeam, score: awayWon ? 1 : 0 },
    ],
  };
}

/**
 * The rounds-total counterpart to buildMmaScoreEvent above — a synthetic
 * scoreEvent whose homeScore+awayScore sums to the fight's own ending
 * round (fetchMmaResults' `round`, from ESPN's status.period), which is
 * what gradeGeneric's totals branch actually reads for an Over/Under
 * comparison against the pick's point. Which side carries the number
 * doesn't matter — gradeGeneric only ever reads the sum for a totals
 * market — so it's put entirely on the home side for simplicity. Null when
 * no fight matches, or when ESPN never carried a round for this one (a
 * push-or-guess is worse than staying pending — same "never fabricate"
 * rule every other ESPN-backed settlement in this app already follows).
 */
export function buildMmaRoundsScoreEvent(homeTeam, awayTeam, results) {
  const fight = findMmaFight(homeTeam, awayTeam, results);
  if (!fight || !Number.isFinite(fight.round) || fight.round <= 0) return null;
  return {
    completed: true,
    scores: [
      { name: homeTeam, score: fight.round },
      { name: awayTeam, score: 0 },
    ],
  };
}

/**
 * gradePick() with the ESPN fallback above layered on for MMA specifically —
 * tries the primary /scores-based scoreEvent first (works fine for every
 * non-MMA sport, and even most MMA fights once the Odds API eventually
 * catches up), and only reaches for ESPN's own completed-fight data when
 * that comes back empty. Shared by every grading pass (Full Slate, Pixel's
 * Picks, Play of the Day) rather than duplicated three times — a bug in the
 * fallback name-matching would otherwise need fixing in three places.
 * `results` is the array fetchMmaResults returns; pass an empty array (not
 * this whole function) for a non-MMA pick, so a pick from any other sport
 * takes the exact same single gradePick() call it always has.
 */
/** The finish-method bucket of a result or selection: 'ko' | 'sub' | 'dec' | null. */
function methodBucketOf(text) {
  const s = String(text ?? '').toLowerCase();
  if (/(ko|tko|knock)/.test(s)) return 'ko';
  if (/(sub|choke|tap|armbar|guillotine|kimura)/.test(s)) return 'sub';
  if (/(dec|cards|judges|points)/.test(s)) return 'dec';
  return null;
}

/**
 * Parse a capper-phrased straight selection ("Makhachev by submission in
 * round 4", "Fight does not go the distance", "Under 1.5 rounds", "Turner
 * inside the distance") into gradable terms. Null when nothing gradable can
 * be read — the pick then voids rather than being guessed at.
 */
export function parseMmaStraight(selection) {
  const s = String(selection ?? '').toLowerCase();
  if (!s.trim()) return null;
  const roundMatch = s.match(/round\s*(\d)(?:\s*(?:or|and|-)\s*(\d))?/);
  const rounds = roundMatch ? [Number(roundMatch[1]), roundMatch[2] ? Number(roundMatch[2]) : null].filter(Boolean) : null;
  const ouMatch = s.match(/\b(over|under)\s*(\d+(?:\.\d+)?)/);
  if (ouMatch) return { kind: 'rounds_total', side: ouMatch[1], point: Number(ouMatch[2]) };
  const method = methodBucketOf(s);
  const negDistance = /\b(does not|doesn t|doesn't|won t|won't|will not)\b.*\bdistance\b/.test(s)
    || /\binside the distance\b/.test(s) || (/\bfinish/.test(s) && !method);
  const distance = !negDistance && (/\bgoes? the distance\b/.test(s));
  return { kind: 'result', method, rounds, insideDistance: negDistance || null, goesDistance: distance || null };
}

/**
 * Grade an 'mma_straight' leg from ESPN's completed-fight record. Returns
 * { won } / { void: true, reason } / null (fight not found yet — stays
 * pending). Fighter-specific terms require the named fighter to have won;
 * method/round/distance terms each check the finish record, and any term
 * ESPN's data can't answer (no round, no method) voids the pick — a straight
 * is never guessed right or wrong.
 */
export function gradeMmaStraight(pick, results) {
  const fight = findMmaFight(pick.home, pick.away, results ?? []);
  if (!fight) return null;
  const terms = parseMmaStraight(pick.selection);
  // Void settles the stake with nothing won or lost, same as gradePick's
  // pushes — payout must be 0 here too, not the undefined a bare { void }
  // literal leaves behind (the tracker renders/sums whatever's here).
  const voided = (reason) => ({ void: true, reason, payout: 0 });
  if (!terms) return voided('unparseable straight selection');
  const finishedInside = fight.method != null ? methodBucketOf(fight.method) !== 'dec' : null;
  const detailBase = {
    winner: fight.aWon ? fight.displayA : fight.bWon ? fight.displayB : null,
    method: fight.method ?? null,
    round: fight.round ?? null,
  };
  // gradeMmaStraight settles outside gradePick() (the odds feed has no
  // market shaped like a capper straight), so it must compute payout itself
  // using the same math — a win pays (decimal - 1) * stake, a loss forfeits
  // the stake. Without this every winning straight priced its payout as
  // undefined, which the tracker then displayed and summed as $NaN.
  const done = (won) => ({
    won,
    detail: detailBase,
    payout: won ? (pick.decimal - 1) * pick.suggested_stake : -pick.suggested_stake,
  });

  if (terms.kind === 'rounds_total') {
    if (fight.round == null && finishedInside !== false) return voided('no finish round from ESPN');
    // A decision always goes past any posted rounds line; a finish in round
    // R means the fight ended before R.5, so Under X.5 wins iff R <= X.
    const wentOver = finishedInside === false || (fight.round != null && fight.round > terms.point);
    return done(terms.side === 'over' ? wentOver : !wentOver);
  }

  // Fighter-specific? The selection must name one of the two sides.
  const names = [[fight.a, fight.aWon], [fight.b, fight.bWon]];
  const sel = normalizeName(pick.selection);
  const named = names.find(([n]) => n && n.split(' ').some((t) => t.length > 3 && sel.includes(t)));
  if (named && !named[1]) return done(false); // their fighter lost — no term can save it
  if (!named && (terms.method || terms.rounds) && !terms.insideDistance && !terms.goesDistance) {
    // "by KO round 1" with no recognizable fighter — can't attribute; void.
    if (!terms.method && !terms.rounds) return voided('no gradable term');
  }

  if (terms.method) {
    if (fight.method == null) return voided('no finish method from ESPN');
    if (methodBucketOf(fight.method) !== terms.method) return done(false);
  }
  if (terms.rounds?.length) {
    if (fight.round == null) return voided('no finish round from ESPN');
    if (finishedInside === false) return done(false); // went to a decision
    if (!terms.rounds.includes(fight.round)) return done(false);
  }
  if (terms.insideDistance) {
    if (finishedInside == null) return voided('no finish method from ESPN');
    if (!finishedInside) return done(false);
  }
  if (terms.goesDistance) {
    if (finishedInside == null) return voided('no finish method from ESPN');
    if (finishedInside) return done(false);
  }
  if (!terms.method && !terms.rounds?.length && !terms.insideDistance && !terms.goesDistance) {
    // Plain fighter moneyline phrased as a straight ("Eric McConico").
    if (!named) return voided('selection names neither fighter');
  }
  return done(true);
}

export function gradeMmaPickWithFallback(pick, primaryScoreEvent, results) {
  // Straight legs (capper-priced props) grade purely from ESPN's fight
  // record — the odds feed has no market shaped like them.
  if (pick.marketKey === 'mma_straight') return gradeMmaStraight(pick, results);
  const outcome = (() => {
    const direct = gradePick(pick, primaryScoreEvent);
    if (direct) return direct;
    if (!results?.length) return null;
    // buildMmaScoreEvent's score is a plain win/loss flag (1 vs 0) — exactly
    // right for h2h (gradeGeneric compares which side scored higher), but
    // WRONG for a rounds total: gradeGeneric's totals branch reads
    // homeScore+awayScore, which a 1/0 win flag always sums to 0 or 1,
    // below any realistic rounds line — "Under" would always grade WON and
    // "Over" always LOST regardless of how long the fight actually went.
    // Confirmed live: Charles Johnson vs Eduardo Henrique (UFC 330) went to
    // Round 3 by submission, and the old path graded "Under 2.5" as a win.
    // buildMmaRoundsScoreEvent instead sums to the fight's real ending
    // round, so gradeGeneric's existing Over/Under/push math (already
    // correct, already tested) reads the actual fight length.
    const fallbackScoreEvent = pick.marketKey === 'totals'
      ? buildMmaRoundsScoreEvent(pick.home, pick.away, results)
      : buildMmaScoreEvent(pick.home, pick.away, results);
    return fallbackScoreEvent ? gradePick(pick, fallbackScoreEvent) : null;
  })();
  if (!outcome || outcome.void) return outcome;

  // Attach the winner's real name and finish method for the finished card's
  // "Gamrot by Decision" line — from ESPN's fight record when one matches,
  // regardless of which source did the grading (the Odds API path grades
  // fine but never carries a method). Purely additive display data: absent
  // ESPN coverage the outcome is exactly what it always was.
  const fight = findMmaFight(pick.home, pick.away, results ?? []);
  if (fight) {
    const winnerName = fight.aWon ? fight.displayA : fight.bWon ? fight.displayB : null;
    if (winnerName) {
      return { ...outcome, detail: { winner: winnerName, method: fight.method ?? null } };
    }
  }
  return outcome;
}
