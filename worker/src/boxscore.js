/**
 * Finished-game box scores for the Full Slate's finished cards — per-inning
 * runs plus R/H/E for MLB, per-quarter points for NFL/NCAAF/WNBA/NBA — read
 * from the same cdn.espn.com scoreboard host and event-matching logic
 * worker/src/context.js already uses (imported, not duplicated: attributing
 * the wrong game's box score to a card is this feature's one fabrication
 * failure mode, so the confidence-scored matcher must be THE matcher).
 *
 * Free — never touches the odds feed. Returns { box: null } whenever the
 * fixture can't be matched with confidence or the game isn't completed on
 * ESPN's side yet — the card then simply keeps its existing final-score
 * line, the same "shorter card, never a wrong one" convention every other
 * ESPN-backed feature here follows.
 *
 * Sports without a per-period source deliberately aren't here: NHL has no
 * scoreboard page at all on the reachable ESPN host (see context.js's
 * LEAGUE_PATHS note), soccer's final score already comes from /scores, and
 * tennis/MMA detail rides on the tracked pick's own settlement record
 * (worker/src/tennis-results.js / ufc-events.js) instead.
 */
import { cachedJson, findEvent } from './context.js';

const ESPN_CDN = 'https://cdn.espn.com/core';

// Which sports have a period-by-period scoreboard worth serving, and how
// their linescore/totals fields read. MLB's "score" is runs; the football/
// basketball sports' is points. NBA/NCAAB ride along for free the day
// they're wired into the slate — same paths context.js already lists.
const BOX_LEAGUES = {
  baseball_mlb: { path: 'mlb', kind: 'innings', periods: 9 },
  americanfootball_nfl: { path: 'nfl', kind: 'quarters', periods: 4 },
  americanfootball_ncaaf: { path: 'college-football', kind: 'quarters', periods: 4 },
  basketball_wnba: { path: 'wnba', kind: 'quarters', periods: 4 },
  basketball_nba: { path: 'nba', kind: 'quarters', periods: 4 },
};

export const hasBoxScore = (sportKey) => Boolean(BOX_LEAGUES[sportKey]);

const SCOREBOARD_TTL = 300; // finished games don't change; live ones fill in

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
 * Pure extraction from an already-fetched scoreboard — split from
 * fetchBoxScore so the matching/extraction logic is unit-testable against
 * a fixed scoreboard shape without a network. Null when the fixture can't
 * be confidently matched or isn't completed on ESPN's side.
 */
export function boxFromScoreboard(scoreboard, { home, away, league }) {
  const found = findEvent(scoreboard, home, away);
  if (!found) return null;

  const { event, competition, homeSide, awaySide } = found;
  if (!competition?.status?.type?.completed) return null;

  const venue = competition?.venue ?? {};
  const venueLine = [venue.fullName, venue.address?.city, venue.address?.state]
    .filter(Boolean)
    .join(' – ') || null;

  return {
    kind: league.kind,
    periods: league.periods,
    startTime: event?.date ?? null,
    venue: venueLine,
    home: sideFrom(homeSide, league),
    away: sideFrom(awaySide, league),
  };
}

/**
 * The finished-game box for one fixture, matched by the same odds-feed team
 * names the slate card already has. Null when the sport has no box source,
 * the fixture can't be confidently matched, or ESPN doesn't show it
 * completed yet.
 */
export async function fetchBoxScore({ sportKey, home, away }, ctx) {
  const league = BOX_LEAGUES[sportKey];
  if (!league || !home || !away) return null;

  const page = await cachedJson(`${ESPN_CDN}/${league.path}/scoreboard?xhr=1`, SCOREBOARD_TTL, ctx);
  const scoreboard = page?.content?.sbData ?? null;
  return boxFromScoreboard(scoreboard, { home, away, league });
}
