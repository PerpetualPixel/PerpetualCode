/**
 * MLB team statistics, league rankings, situational splits, and recent
 * results with graded ATS/O-U — everything Full Slate's "View Stats" panel
 * needs, all from the ESPN hosts already proven reachable from a Cloudflare
 * Worker (see worker/src/context.js's own note: site.api.espn.com 403s every
 * Worker request; site.web.api.espn.com and cdn.espn.com don't).
 *
 * Unofficial, undocumented ESPN surface — not covered by any SLA, free to
 * change shape without notice. Every field below is read defensively; a
 * missing section degrades to null/empty rather than throwing, the same
 * convention worker/src/context.js and worker/src/mma.js already use.
 */

const ESPN_SITE = 'https://site.web.api.espn.com/apis/site/v2/sports/baseball/mlb';
const ESPN_CDN = 'https://cdn.espn.com/core/mlb';

const STATS_TTL = 3600 * 24;      // team season stats move once a day at most
const SCHEDULE_TTL = 3600 * 6;    // today's game can complete mid-cache-window
const STANDINGS_TTL = 3600 * 6;
const SETTLED_GAME_TTL = 3600 * 24 * 30; // a finished game's line/result never changes

async function cachedJson(url, ttl, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/mlb-stats/${encodeURIComponent(url)}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const body = await response.text();
    ctx.waitUntil(
      cache.put(cacheKey, new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
      })),
    );
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function statValue(stats, name) {
  const s = stats?.find((s) => s.name === name);
  return typeof s?.value === 'number' ? s.value : null;
}

/**
 * Real batting/pitching/fielding numbers for one team, in the shape the
 * client already renders (offense/defense). Returns null on any failure —
 * the caller falls back to "stats unavailable" rather than a crash.
 */
export async function fetchTeamStats(teamAbbr, ctx) {
  if (!teamAbbr) return null;
  const data = await cachedJson(`${ESPN_SITE}/teams/${teamAbbr.toLowerCase()}/statistics`, STATS_TTL, ctx);
  const categories = data?.results?.stats?.categories;
  if (!Array.isArray(categories)) return null;

  const batting = categories.find((c) => c.name === 'batting')?.stats;
  const pitching = categories.find((c) => c.name === 'pitching')?.stats;
  const fielding = categories.find((c) => c.name === 'fielding')?.stats;
  if (!batting && !pitching && !fielding) return null;

  return {
    teamAbbr,
    offense: {
      battingAvg: statValue(batting, 'avg'),
      obpSlugging: statValue(batting, 'OPS'),
      rbi: statValue(batting, 'RBIs'),
      strikeouts: statValue(batting, 'strikeouts'),
      runs: statValue(batting, 'runs'),
      stolenBases: statValue(batting, 'stolenBases'),
      doubles: statValue(batting, 'doubles'),
      hits: statValue(batting, 'hits'),
      triples: statValue(batting, 'triples'),
      walks: statValue(batting, 'walks'),
      homeRuns: statValue(batting, 'homeRuns'),
    },
    defense: {
      era: statValue(pitching, 'ERA'),
      whip: statValue(pitching, 'WHIP'),
      strikeoutsPitching: statValue(pitching, 'strikeouts'),
      fieldingPercentage: statValue(fielding, 'fieldingPct'),
      errors: statValue(fielding, 'errors'),
    },
  };
}

// Every team abbreviation ESPN's schedule/statistics endpoints recognize.
const ALL_MLB_ABBR = [
  'ari', 'atl', 'bal', 'bos', 'chc', 'chw', 'cin', 'cle', 'col', 'det',
  'hou', 'kc', 'laa', 'lad', 'mia', 'mil', 'min', 'nym', 'nyy', 'ath', // relocated for 2026; ESPN's slug is now "ath", not "oak" (confirmed live)
  'phi', 'pit', 'sd', 'sf', 'sea', 'stl', 'tb', 'tex', 'tor', 'wsh',
];

/**
 * Every stat this feature ranks, and which direction is "good" for it — a
 * fixed table, not inferred, so a rank is never accidentally backwards.
 */
const HIGHER_IS_BETTER = {
  battingAvg: true, obpSlugging: true, rbi: true, strikeouts: false, runs: true,
  stolenBases: true, doubles: true, hits: true, triples: true, walks: true, homeRuns: true,
  era: false, whip: false, strikeoutsPitching: true, fieldingPercentage: true, errors: false,
};

const LEAGUE_STATS_KV_KEY = 'mlb:league-stats:v1';
const LEAGUE_STATS_KV_TTL = 86400 * 2; // survives a missed cron tick

// Cloudflare Workers hard-cap total subrequests per invocation (confirmed
// live: fetching all 30 teams in this same request as the schedule/
// situational calls threw "Too many subrequests by single Worker
// invocation" — batching down the *concurrency* didn't help, since the cap
// is on the cumulative count for the whole invocation, not how many are in
// flight at once). All 30 teams can only be fetched from a request that
// isn't also doing anything else — so this now runs standalone, once a day,
// from scheduled() (see refreshMlbLeagueStats below), and the live request
// path just reads the one resulting KV blob — a single, cheap read, however
// many teams it holds.
export async function fetchLeagueStats(env) {
  const cached = await env.POTD_KV.get(LEAGUE_STATS_KV_KEY);
  if (!cached) return []; // no cron run yet since this deployed — ranks show as "—" until it does
  try {
    return JSON.parse(cached);
  } catch {
    return [];
  }
}

/**
 * The actual 30-team fetch, called once a day from scheduled() — batched at
 * 8 concurrent (defense in depth against Cloudflare's per-invocation
 * subrequest cap even though this runs with nothing else competing for that
 * budget) and written to KV as one blob, so the live request path never
 * does more than a single KV read for league-wide ranking data.
 */
export async function refreshMlbLeagueStats(env, ctx) {
  const teams = [];
  const batchSize = 8;
  for (let i = 0; i < ALL_MLB_ABBR.length; i += batchSize) {
    const batch = ALL_MLB_ABBR.slice(i, i + batchSize);
    const results = await Promise.all(batch.map((abbr) => fetchTeamStats(abbr, ctx)));
    teams.push(...results.filter(Boolean));
  }
  await env.POTD_KV.put(LEAGUE_STATS_KV_KEY, JSON.stringify(teams), { expirationTtl: LEAGUE_STATS_KV_TTL });
  return teams.length;
}

/** Real rank (1 = best) of `value` among `leagueValues`, or null if either is missing. */
export function rankAgainstLeague(value, leagueValues, higherIsBetter) {
  if (value == null || !Array.isArray(leagueValues) || !leagueValues.length) return null;
  const better = leagueValues.filter((v) => (higherIsBetter ? v > value : v < value)).length;
  return better + 1;
}

/** {value, rank} for every stat in `teamStats`, ranked against `leagueStats`. */
export function rankTeamStats(teamStats, leagueStats) {
  if (!teamStats) return null;
  const ranked = (section) => Object.fromEntries(
    Object.entries(teamStats[section]).map(([key, value]) => [
      key,
      {
        value,
        rank: rankAgainstLeague(
          value,
          leagueStats.map((t) => t[section][key]).filter((v) => v != null),
          HIGHER_IS_BETTER[key],
        ),
      },
    ]),
  );
  return { offense: ranked('offense'), defense: ranked('defense') };
}

/**
 * Season/last-10/home/away splits from the league standings page — real
 * ESPN fields, not a guess. No underdog/favorite split: nothing in ESPN's
 * standings (or anywhere else this app can reach) tracks a team's record
 * specifically in games it was favored vs. an underdog in, so that split
 * simply isn't offered rather than being faked.
 */
export async function fetchSituationalSplits(teamAbbr, ctx) {
  if (!teamAbbr) return null;
  const data = await cachedJson(`${ESPN_CDN}/standings?xhr=1`, STANDINGS_TTL, ctx);
  const groups = data?.content?.standings?.groups ?? [];
  const entry = groups
    .flatMap((g) => g.groups ?? [g])
    .flatMap((g) => g.standings?.entries ?? [])
    .find((e) => e.team?.abbreviation?.toLowerCase() === teamAbbr.toLowerCase());
  if (!entry) return null;

  const stat = (name) => entry.stats?.find((s) => s.name === name)?.displayValue ?? null;
  return {
    season: `${stat('wins') ?? '—'}-${stat('losses') ?? '—'}`,
    lastTen: stat('Last Ten Games'),
    home: stat('Home'),
    away: stat('Road'),
  };
}

/** ESPN's "o7"/"u7"/"-1.5" line strings to a plain number. */
export function parseLine(displayLine) {
  if (typeof displayLine !== 'string') return null;
  const n = parseFloat(displayLine.replace(/^[ou]/i, ''));
  return Number.isFinite(n) ? n : null;
}

/** 'W' | 'L' | 'push' | null for one team against one spread line. */
export function gradeAts(teamScore, oppScore, spreadLine) {
  if (spreadLine == null || teamScore == null || oppScore == null) return null;
  const margin = teamScore + spreadLine - oppScore;
  if (margin === 0) return 'push';
  return margin > 0 ? 'W' : 'L';
}

/** 'O' | 'U' | 'push' | null for the game total against one total line. */
export function gradeTotal(homeScore, awayScore, totalLine) {
  if (totalLine == null || homeScore == null || awayScore == null) return null;
  const total = homeScore + awayScore;
  if (total === totalLine) return 'push';
  return total > totalLine ? 'O' : 'U';
}

/**
 * The closing spread/total line for one game, from ESPN's own pickcenter —
 * structured home/away fields (pointSpread.home.close.line etc.), not the
 * ambiguous top-level "spread"/"details" shorthand, so there's no sign-
 * convention guesswork. Empty for a real fraction of games (a book simply
 * wasn't tracked for that game) — callers must treat that as "no line
 * available," never fall back to a guess.
 */
async function fetchGameLine(eventId, ctx) {
  const data = await cachedJson(`${ESPN_SITE}/summary?event=${eventId}`, SETTLED_GAME_TTL, ctx);
  const pc = data?.pickcenter?.[0];
  if (!pc?.pointSpread || !pc?.total) return null;
  return {
    homeSpread: parseLine(pc.pointSpread.home?.close?.line),
    awaySpread: parseLine(pc.pointSpread.away?.close?.line),
    total: parseLine(pc.total.over?.close?.line),
  };
}

/** One completed event, graded from teamAbbr's perspective — the shared row shape both fetchRecentSchedule and fetchHeadToHead return. */
async function gradeCompletedEvent(e, teamAbbr, ctx) {
  const comp = e.competitions[0];
  const home = comp.competitors.find((c) => c.homeAway === 'home');
  const away = comp.competitors.find((c) => c.homeAway === 'away');
  const isHome = home?.team?.abbreviation?.toLowerCase() === teamAbbr.toLowerCase();
  const mine = isHome ? home : away;
  const opponent = isHome ? away : home;
  const myScore = Number(mine?.score?.value ?? mine?.score);
  const oppScore = Number(opponent?.score?.value ?? opponent?.score);
  const homeScore = Number(home?.score?.value ?? home?.score);
  const awayScore = Number(away?.score?.value ?? away?.score);

  const line = await fetchGameLine(e.id, ctx);
  const mySpread = line ? (isHome ? line.homeSpread : line.awaySpread) : null;
  const atsResult = line ? gradeAts(myScore, oppScore, mySpread) : null;
  const ouResult = line ? gradeTotal(homeScore, awayScore, line.total) : null;

  return {
    date: e.date,
    opponent: opponent?.team?.displayName ?? 'Unknown',
    opponentAbbr: opponent?.team?.abbreviation ?? '',
    result: mine?.winner ? 'W' : 'L',
    score: `${myScore}-${oppScore}`,
    ats: atsResult && mySpread != null
      ? `${atsResult === 'push' ? 'Push' : atsResult} ${mySpread > 0 ? '+' : ''}${mySpread}`
      : null,
    ou: ouResult && line?.total != null
      ? `${ouResult === 'push' ? 'Push' : ouResult} ${line.total}`
      : null,
  };
}

/**
 * Last N completed games for one team, with real results and best-effort
 * graded ATS/O-U (null when ESPN never tracked a line for that specific
 * game — shown as "—" client-side, never guessed).
 */
export async function fetchRecentSchedule(teamAbbr, ctx, limit = 5) {
  if (!teamAbbr) return [];

  const data = await cachedJson(`${ESPN_SITE}/teams/${teamAbbr.toLowerCase()}/schedule`, SCHEDULE_TTL, ctx);
  const events = data?.events ?? [];

  const completed = events
    .filter((e) => e.competitions?.[0]?.status?.type?.completed)
    .slice(-limit)
    .reverse();

  return Promise.all(completed.map((e) => gradeCompletedEvent(e, teamAbbr, ctx)));
}

/**
 * Every completed meeting between two teams so far this season, graded the
 * same way as fetchRecentSchedule — scans teamAbbr's full season schedule
 * (not just the last 5) filtered to games against opponentAbbr. Can come
 * back empty if the two haven't played yet this season; that's a real
 * answer, not a failure.
 */
export async function fetchHeadToHead(teamAbbr, opponentAbbr, ctx) {
  if (!teamAbbr || !opponentAbbr) return [];

  const data = await cachedJson(`${ESPN_SITE}/teams/${teamAbbr.toLowerCase()}/schedule`, SCHEDULE_TTL, ctx);
  const events = data?.events ?? [];

  const meetings = events.filter((e) => {
    const comp = e.competitions?.[0];
    if (!comp?.status?.type?.completed) return false;
    return comp.competitors.some((c) => c.team?.abbreviation?.toLowerCase() === opponentAbbr.toLowerCase());
  }).reverse();

  return Promise.all(meetings.map((e) => gradeCompletedEvent(e, teamAbbr, ctx)));
}
