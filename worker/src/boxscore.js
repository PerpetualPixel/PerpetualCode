/**
 * Box scores for the Full Slate's live and finished cards — per-inning runs
 * plus R/H/E for MLB, per-quarter points for NFL/NCAAF/WNBA/NBA — read from
 * the same cdn.espn.com scoreboard host and event-matching logic
 * worker/src/context.js already uses (imported, not duplicated: attributing
 * the wrong game's box score to a card is this feature's one fabrication
 * failure mode, so the confidence-scored matcher must be THE matcher).
 *
 * In-progress games are served too, carrying `status` ('in'/'post' plus
 * ESPN's own "Top 5th" wording): the odds feed's /scores gives a running
 * total and nothing else, so the inning a live game is in — and the innings
 * its runs came in — are only knowable from here.
 *
 * Free — never touches the odds feed. Returns { box: null } whenever the
 * fixture can't be matched with confidence or the game hasn't started on
 * ESPN's side — the card then simply keeps its existing score line, the
 * same "shorter card, never a wrong one" convention every other ESPN-backed
 * feature here follows.
 *
 * Sports without a per-period source deliberately aren't here: NHL has no
 * scoreboard page at all on the reachable ESPN host (see context.js's
 * LEAGUE_PATHS note), soccer's final score already comes from /scores, and
 * tennis/MMA detail rides on the tracked pick's own settlement record
 * (worker/src/tennis-results.js / ufc-events.js) instead.
 */
import { cachedJson, findEvent } from './context.js';

const ESPN_CDN = 'https://cdn.espn.com/core';
// Fallback scoreboard host. site.web.api.espn.com is NOT the blocked
// site.api.espn.com (see context.js's header) — worker/src/mlb-stats.js has
// been fetching it from this same deployed worker all along, so it's a
// proven-reachable second chance when the cdn page is missing or reshapes.
// Its scoreboard returns { events: [...] } directly, the same inner shape
// findEvent already reads — no separate extraction needed.
const ESPN_SITE = 'https://site.web.api.espn.com/apis/site/v2/sports';

// Which sports have a period-by-period scoreboard worth serving, and how
// their linescore/totals fields read. MLB's "score" is runs; the football/
// basketball sports' is points. NBA/NCAAB ride along for free the day
// they're wired into the slate — same paths context.js already lists.
// `path` is cdn.espn.com/core's slug; `sitePath` is the fallback host's.
const BOX_LEAGUES = {
  baseball_mlb: { path: 'mlb', sitePath: 'baseball/mlb', kind: 'innings', periods: 9 },
  americanfootball_nfl: { path: 'nfl', sitePath: 'football/nfl', kind: 'quarters', periods: 4 },
  americanfootball_ncaaf: { path: 'college-football', sitePath: 'football/college-football', kind: 'quarters', periods: 4 },
  basketball_wnba: { path: 'wnba', sitePath: 'basketball/wnba', kind: 'quarters', periods: 4 },
  basketball_nba: { path: 'nba', sitePath: 'basketball/nba', kind: 'quarters', periods: 4 },
};

export const hasBoxScore = (sportKey) => Boolean(BOX_LEAGUES[sportKey]);

// Live lines change every half-inning, so the scoreboard is cached for a
// minute rather than five — the slate polls on the same 60s cadence, and one
// scoreboard request serves every card in a league, so this is one free ESPN
// call per league per minute, not one per game.
const SCOREBOARD_TTL = 60;

/** One competitor's stat by name from ESPN's statistics array, else null. */
function statOf(competitor, name) {
  const entry = (competitor?.statistics ?? []).find((s) => s.name === name);
  const value = entry ? Number(entry.displayValue ?? entry.value) : NaN;
  return Number.isFinite(value) ? value : null;
}

function sideFrom(competitor, { kind, periods }) {
  const team = competitor?.team ?? {};
  const linescores = (competitor?.linescores ?? []).map((l) => {
    const v = Number(l?.displayValue ?? l?.value);
    return Number.isFinite(v) ? v : null;
  });
  // Pad a rain-shortened or not-fully-reported line out to the standard
  // period count with nulls (rendered as em dashes) rather than truncating
  // extra-innings/OT periods, which are real and stay.
  while (linescores.length < periods) linescores.push(null);

  const total = Number(competitor?.score);
  return {
    abbr: team.abbreviation ?? null,
    name: team.displayName ?? null,
    record: (competitor?.records ?? []).find((r) => r.type === 'total')?.summary ?? null,
    winner: competitor?.winner === true,
    linescores,
    total: Number.isFinite(total) ? total : null,
    // R/H/E for baseball; hits/errors are top-level competitor fields on
    // ESPN's MLB scoreboard, with the statistics array as fallback. Null
    // (not 0) when absent — a missing number is not a zero.
    ...(kind === 'innings'
      ? {
          hits: Number.isFinite(Number(competitor?.hits)) ? Number(competitor.hits) : statOf(competitor, 'hits'),
          errors: Number.isFinite(Number(competitor?.errors)) ? Number(competitor.errors) : statOf(competitor, 'errors'),
        }
      : {}),
  };
}

/**
 * Where the game stands, in ESPN's own words. `detail` is the string ESPN
 * shows ("Top 5th", "Bot 9th", "End 3rd", "Final") — passed through verbatim
 * rather than reconstructed from `period` + a half-inning guess, since only
 * ESPN knows whether a half is mid-inning, ended, or in a delay.
 *
 * Read from the competition's status first, falling back to the event's:
 * ESPN populates one or the other depending on league and page, and the
 * competition-only read is exactly why finished MLB grids rendered while
 * other cases returned nothing.
 */
function statusFrom(competition, event) {
  const status = competition?.status ?? event?.status ?? {};
  const type = status.type ?? {};
  const period = Number(status.period);
  return {
    // 'pre' | 'in' | 'post' on ESPN's scoreboard payloads.
    state: typeof type.state === 'string' ? type.state : null,
    completed: type.completed === true,
    detail: type.shortDetail ?? type.detail ?? type.description ?? null,
    period: Number.isFinite(period) && period > 0 ? period : null,
  };
}

/**
 * Pure extraction from an already-fetched scoreboard — split from
 * fetchBoxScore so the matching/extraction logic is unit-testable against
 * a fixed scoreboard shape without a network. Null when the fixture can't
 * be confidently matched or hasn't started.
 *
 * In-progress games are included: a live linescore is the whole point of the
 * grid on a live card (which inning it's in, and which innings the runs came
 * in). Callers distinguish the two via `status.completed` — the returned
 * shape is otherwise identical, with unplayed periods padded as nulls.
 *
 * Returns { box, reason } rather than a bare box-or-null: every null used to
 * be indistinguishable from every other null, which made "no grid anywhere"
 * undiagnosable from the outside. The reason rides the /boxscore response,
 * so opening the URL in a browser now says WHICH gate refused —
 * 'unmatched' | 'not_started' | 'ok'.
 */
export function boxFromScoreboard(scoreboard, { home, away, league }) {
  const found = findEvent(scoreboard, home, away);
  if (!found) return { box: null, reason: 'unmatched' };

  const { event, competition, homeSide, awaySide } = found;
  const status = statusFrom(competition, event);
  // Serve anything that has visibly started; refuse only a game with no line
  // to show. Requiring status.type.state === 'in' here was the live bug: the
  // finished path passed on completed:true while live games needed a field
  // ESPN doesn't reliably place where it was being read — so finished grids
  // rendered and live cards got nothing, silently. The gate now rests on
  // signals that can't disagree between the two paths: an explicit
  // pre-game state refuses; a completed flag, an in/post state, or actual
  // linescore entries (ESPN only writes those once play starts) serve.
  const hasLine = [homeSide, awaySide].some((c) => (c?.linescores ?? []).length > 0);
  const started = status.completed || status.state === 'in' || status.state === 'post' || hasLine;
  if (status.state === 'pre' || !started) return { box: null, reason: 'not_started' };

  const venue = competition?.venue ?? {};
  const venueLine = [venue.fullName, venue.address?.city, venue.address?.state]
    .filter(Boolean)
    .join(' – ') || null;

  return {
    box: {
      kind: league.kind,
      periods: league.periods,
      startTime: event?.date ?? null,
      venue: venueLine,
      status,
      home: sideFrom(homeSide, league),
      away: sideFrom(awaySide, league),
    },
    reason: 'ok',
  };
}

/**
 * The box for one fixture, live or final, matched by the same odds-feed team
 * names the slate card already has. Returns { box, reason, source }; box is
 * null when the sport has no box source, no scoreboard could be fetched, the
 * fixture can't be confidently matched, or the game hasn't started.
 *
 * `date` (YYYYMMDD, the game's own ET date, sent by the client) matters more
 * than it looks: without it, ESPN serves the CURRENT day's scoreboard only,
 * so every finished game silently lost its grid at the next ET midnight —
 * yesterday's fixtures simply aren't on today's page to be matched. Dated
 * requests keep past finals servable. Invalid/absent dates fall back to the
 * undated (today) page rather than failing.
 */
export async function fetchBoxScore({ sportKey, home, away, date }, ctx) {
  const league = BOX_LEAGUES[sportKey];
  if (!league || !home || !away) return { box: null, reason: 'bad_request', source: null };
  const day = /^\d{8}$/.test(String(date ?? '')) ? String(date) : null;

  // Primary: the cdn host context.js already uses. Fallback: the site host
  // mlb-stats.js already uses — reachable from Workers, same events shape —
  // so a cdn blockage or page reshape degrades to a second fetch, not to
  // every card on the slate silently losing its grid.
  const cdnPage = await cachedJson(
    `${ESPN_CDN}/${league.path}/scoreboard?xhr=1${day ? `&date=${day}` : ''}`,
    SCOREBOARD_TTL, ctx,
  );
  let scoreboard = cdnPage?.content?.sbData ?? null;
  let source = 'cdn';
  if (!Array.isArray(scoreboard?.events)) {
    const sitePage = await cachedJson(
      `${ESPN_SITE}/${league.sitePath}/scoreboard${day ? `?dates=${day}` : ''}`,
      SCOREBOARD_TTL, ctx,
    );
    scoreboard = Array.isArray(sitePage?.events) ? sitePage : null;
    source = scoreboard ? 'site' : null;
  }
  if (!scoreboard) return { box: null, reason: 'no_scoreboard', source: null };

  return { ...boxFromScoreboard(scoreboard, { home, away, league }), source };
}
