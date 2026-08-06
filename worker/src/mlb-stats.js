/**
 * MLB team statistics and league rankings.
 * Fetches offensive, defensive, and situational stats for team comparison.
 * Compares each stat to league average and calculates ranking percentile.
 */

const ESPN_STATS_BASE = 'https://site.api.espn.com/v2/site/baseball/mlb';
const STATS_CACHE_TTL = 3600 * 24; // 24 hours

async function cachedFetch(url, ttl, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/mlb-stats/${encodeURIComponent(url)}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit.text();

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;

    const body = await response.text();
    ctx.waitUntil(
      cache.put(
        cacheKey,
        new Response(body, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
        }),
      ),
    );
    return body;
  } catch {
    return null;
  }
}

/**
 * Fetch comprehensive team stats from ESPN.
 * Returns offensive, defensive, and situational metrics.
 */
export async function fetchTeamStats(teamAbbr, ctx) {
  if (!teamAbbr) return null;

  try {
    const url = `${ESPN_STATS_BASE}/teams/${teamAbbr.toLowerCase()}`;
    const json = await cachedFetch(url, STATS_CACHE_TTL, ctx);
    if (!json) return null;

    const data = JSON.parse(json);
    const team = data?.team;
    if (!team) return null;

    // Extract offensive stats
    const offenseStats = {
      battingAvg: getStatValue(team, 'battingAverage'),
      obpSlugging: getStatValue(team, 'onBasePlusSlugging'),
      rbi: getStatValue(team, 'rbi'),
      strikeouts: getStatValue(team, 'strikeOuts'),
      runs: getStatValue(team, 'runs'),
      stolenBases: getStatValue(team, 'stolenBases'),
      doubles: getStatValue(team, 'doubles'),
      hits: getStatValue(team, 'hits'),
      triples: getStatValue(team, 'triples'),
      walks: getStatValue(team, 'walks'),
      homeRuns: getStatValue(team, 'homeRuns'),
    };

    // Extract defensive stats
    const defenseStats = {
      era: getStatValue(team, 'era'), // Pitching ERA
      whip: getStatValue(team, 'whip'), // Walks + Hits per IP
      strikeoutsPitching: getStatValue(team, 'strikeOutsPitching'),
      fieldingPercentage: getStatValue(team, 'fieldingPercentage'),
      errors: getStatValue(team, 'errors'),
    };

    return {
      teamName: team.name || teamAbbr,
      teamAbbr,
      record: team.record ? `${team.record.wins}-${team.record.losses}` : null,
      offense: offenseStats,
      defense: defenseStats,
      lastUpdated: Date.now(),
    };
  } catch {
    return null;
  }
}

function getStatValue(team, statKey) {
  // Navigate team stats object to find the value
  if (!team?.stats) return null;
  const stat = team.stats.find((s) => s.name === statKey);
  return stat?.value ?? null;
}

/**
 * Calculate league rankings for a stat.
 * Returns { rank, total, percentile, color } where color is 'good' or 'bad'.
 */
export function calculateRanking(teamValue, leagueStats) {
  if (!teamValue || !leagueStats) return null;

  const { values, average, total } = leagueStats;
  if (!values || !Array.isArray(values)) return null;

  // Count how many teams are better
  const betterCount = values.filter((v) => v > teamValue).length;
  const rank = betterCount + 1;
  const percentile = ((total - rank) / total) * 100;

  // Higher is better for most stats (batting avg, runs, etc.)
  // But lower is better for ERA, strikeouts (given up)
  const isBetterWhenHigher = ['battingAvg', 'runs', 'hits', 'rbi', 'walks', 'homeRuns'].includes(
    leagueStats.statName,
  );

  const color =
    (isBetterWhenHigher && teamValue > average) || (!isBetterWhenHigher && teamValue < average)
      ? 'green'
      : 'red';

  return {
    rank,
    total,
    percentile: Math.round(percentile),
    color,
  };
}

/**
 * Fetch recent schedule for a team (last 5 games).
 */
export async function fetchRecentSchedule(teamAbbr, ctx, limit = 5) {
  if (!teamAbbr) return [];

  try {
    const url = `${ESPN_STATS_BASE}/teams/${teamAbbr.toLowerCase()}/schedule`;
    const json = await cachedFetch(url, STATS_CACHE_TTL, ctx);
    if (!json) return [];

    const data = JSON.parse(json);
    const events = data?.events || [];

    // Get last N completed games
    const completed = events
      .filter((e) => e.status?.type?.completed)
      .slice(-limit)
      .reverse();

    return completed.map((e) => {
      const comp = e.competitions?.[0];
      const isHome = comp?.competitors?.[0]?.homeAway === 'home';
      const opponent = isHome ? comp?.competitors?.[1] : comp?.competitors?.[0];
      const teamComp = isHome ? comp?.competitors?.[0] : comp?.competitors?.[1];

      return {
        date: e.date,
        opponent: opponent?.team?.name || 'Unknown',
        opponentAbbr: opponent?.team?.abbreviation || '',
        result: teamComp?.winner ? 'W' : 'L',
        score: `${teamComp?.score || 0}-${opponent?.score || 0}`,
        ats: comp?.spread?.awayTeamSpread?.displayValue || null,
        ou: comp?.leaders?.[0]?.displayValue || null,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Format team stats for UI display.
 * Groups stats by category and applies rankings.
 */
export function formatStatsForDisplay(teamStats, leagueRankings) {
  if (!teamStats) return null;

  const categories = {
    offense: [
      { key: 'battingAvg', label: 'Batting Avg', value: teamStats.offense?.battingAvg },
      {
        key: 'obpSlugging',
        label: 'On Base Plus Slugging %',
        value: teamStats.offense?.obpSlugging,
      },
      { key: 'rbi', label: 'RBI', value: teamStats.offense?.rbi },
      { key: 'strikeouts', label: 'Total Strikeouts', value: teamStats.offense?.strikeouts },
      { key: 'runs', label: 'Total Runs', value: teamStats.offense?.runs },
      { key: 'stolenBases', label: 'Stolen Bases', value: teamStats.offense?.stolenBases },
      { key: 'doubles', label: 'Doubles', value: teamStats.offense?.doubles },
      { key: 'hits', label: 'Hits', value: teamStats.offense?.hits },
      { key: 'triples', label: 'Triples', value: teamStats.offense?.triples },
      { key: 'walks', label: 'Walks', value: teamStats.offense?.walks },
      { key: 'homeRuns', label: 'Home Runs', value: teamStats.offense?.homeRuns },
    ],
    defense: [
      { key: 'era', label: 'ERA', value: teamStats.defense?.era },
      { key: 'whip', label: 'WHIP', value: teamStats.defense?.whip },
      {
        key: 'strikeoutsPitching',
        label: 'Strikeouts',
        value: teamStats.defense?.strikeoutsPitching,
      },
      {
        key: 'fieldingPercentage',
        label: 'Fielding %',
        value: teamStats.defense?.fieldingPercentage,
      },
      { key: 'errors', label: 'Errors', value: teamStats.defense?.errors },
    ],
  };

  return categories;
}
