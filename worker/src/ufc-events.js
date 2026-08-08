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
 * (UFC and PFL both post fights under it), and each promotion has its own
 * separate ESPN scoreboard endpoint — a PFL fighter is never on UFC's board
 * or vice versa — so both are fetched and merged into one lookup index.
 */

import { gradePick } from '../../docs/learning.js';

const ESPN_MMA_SCOREBOARDS = {
  ufc: 'https://site.web.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard',
  pfl: 'https://site.web.api.espn.com/apis/site/v2/sports/mma/pfl/scoreboard',
};
const SCHEDULE_TTL = 3600 * 6; // a card can still be adjusted; not worth caching longer
const RESULTS_TTL = 300; // completed fights don't change, but this window also has to catch cards still airing
const RESULTS_LOOKBACK_DAYS = 3; // matches worker/src/odds.js's own fetchScores daysFrom=3 convention

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
function normalizeName(name) {
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
 * Every upcoming UFC + PFL event ESPN has scheduled over the next 30 days,
 * each with its real name and the normalized fighter-pair for every fight on
 * the card — built once per cache window, not once per fight, since a single
 * request per promotion already covers the whole window. A promotion whose
 * fetch fails is simply left out of the merged schedule rather than failing
 * the whole lookup; only a total failure across every promotion falls
 * through to the caller's date-grouping fallback.
 */
export async function fetchMmaSchedule(ctx, now = Date.now()) {
  const dates = dateRangeParam(now);
  const results = await Promise.allSettled(
    Object.values(ESPN_MMA_SCOREBOARDS).map((base) => cachedJson(`${base}?dates=${dates}`, SCHEDULE_TTL, ctx)),
  );

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
 * Every completed fight from ESPN's UFC+PFL scoreboards over the last
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
  const results = await Promise.allSettled(
    Object.values(ESPN_MMA_SCOREBOARDS).map((base) => cachedJson(`${base}?dates=${dates}`, RESULTS_TTL, ctx)),
  );

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
        });
      }
    }
  }
  return fights;
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
export function buildMmaScoreEvent(homeTeam, awayTeam, results) {
  const normHome = normalizeName(homeTeam);
  const normAway = normalizeName(awayTeam);

  const fight = results.find(
    (f) => (namesLikelyMatch(f.a, normHome) && namesLikelyMatch(f.b, normAway))
      || (namesLikelyMatch(f.a, normAway) && namesLikelyMatch(f.b, normHome)),
  );
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
export function gradeMmaPickWithFallback(pick, primaryScoreEvent, results) {
  const direct = gradePick(pick, primaryScoreEvent);
  if (direct) return direct;
  if (!results?.length) return null;
  const fallbackScoreEvent = buildMmaScoreEvent(pick.home, pick.away, results);
  return fallbackScoreEvent ? gradePick(pick, fallbackScoreEvent) : null;
}
