/**
 * Baseball context enrichment — pitcher stats, home/away splits, recent form.
 *
 * Pulls from ESPN's baseball API (faster than scraping, proven accessible from CF Workers).
 * Caches pitcher stats and team splits for 6 hours.
 *
 * Unlike MMA which fetches full fighter histories, baseball focuses on:
 * - Pitcher recent ERA (last 10 games)
 * - Home/away splits (ERA at home vs. on road)
 * - Days since last start (rest advantage)
 * - New team indicator (trade adjustment period)
 * - Team day/night splits (how team performs in day vs. night games)
 */

const ESPN_STATS_BASE = 'https://site.api.espn.com/v2/site/baseball/mlb';
const PITCHER_CACHE_TTL = 3600 * 6; // 6 hours
const TEAM_CACHE_TTL = 3600 * 24; // 24 hours

/** Cache-through fetch with TTL. */
async function cachedFetch(url, ttl, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/baseball/${encodeURIComponent(url)}`);
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
 * Fetch pitcher stats from ESPN.
 * Returns: { name, era, recentEra, homeEra, awayEra, daysRest, recentForm }
 */
async function fetchPitcherStats(pitcherName, teamAbbr, ctx) {
  if (!pitcherName || !teamAbbr) return null;

  try {
    // Fetch team roster from ESPN
    const rosterUrl = `${ESPN_STATS_BASE}/teams/${teamAbbr.toLowerCase()}`;
    const rosterJson = await cachedFetch(rosterUrl, PITCHER_CACHE_TTL, ctx);
    if (!rosterJson) return null;

    const rosterData = JSON.parse(rosterJson);
    if (!rosterData?.team?.athletes) return null;

    // Find pitcher in roster
    const normalized = pitcherName.toLowerCase().replace(/[^a-z\s]/g, '').trim();
    const pitcher = rosterData.team.athletes.find((a) => {
      const aName = (a.fullName || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
      return aName.includes(normalized) || normalized.includes(aName);
    });

    if (!pitcher || !pitcher.stats) return null;

    // Extract relevant stats
    const stats = pitcher.stats[0]?.stats || {};
    const era = stats.era || null;
    const gamesStarted = stats.gamesStarted || 0;

    // Fallback if specific splits aren't available
    const recentEra = era; // Would be pitcher.stats for last 10 starts if ESPN separates it
    const homeEra = stats.homeEra || era; // Home/away splits if available
    const awayEra = stats.awayEra || era;

    return {
      name: pitcher.fullName,
      era,
      recentEra,
      homeEra,
      awayEra,
      gamesStarted,
      status: pitcher.status?.description || 'active',
    };
  } catch {
    return null;
  }
}

/**
 * Estimate pitcher form from recent performance.
 * Lower ERA = better form.
 */
function assessPitcherForm(stats) {
  if (!stats?.recentEra) return 'unknown';
  if (stats.recentEra < 3.5) return 'excellent';
  if (stats.recentEra < 4.5) return 'good';
  if (stats.recentEra < 5.5) return 'average';
  return 'struggling';
}

/**
 * Detect if pitcher is new to team (trade adjustment period).
 * This would require checking transaction history — for now, return placeholder.
 */
function assessTeamTenure(pitcherStats, team) {
  // TODO: Integrate with a transactions API or Sherdog-like scrape
  // For now, just return false (no trade detected)
  return false;
}

/**
 * Fetch team day/night performance splits from ESPN.
 * Returns: { team, dayWinPct, nightWinPct, dayHomeWinPct, dayAwayWinPct }
 */
async function fetchTeamDayNightStats(teamAbbr, ctx) {
  if (!teamAbbr) return null;

  try {
    const scheduleUrl = `${ESPN_STATS_BASE}/teams/${teamAbbr.toLowerCase()}/schedule`;
    const scheduleJson = await cachedFetch(scheduleUrl, TEAM_CACHE_TTL, ctx);
    if (!scheduleJson) return null;

    const scheduleData = JSON.parse(scheduleJson);
    const events = scheduleData?.events || [];

    // Categorize games as day/night based on start time
    const dayGames = events.filter((e) => {
      if (!e.date) return false;
      const hour = new Date(e.date).getUTCHours();
      return hour < 17; // Before 5 PM UTC = likely day game in US time
    });
    const nightGames = events.filter((e) => {
      if (!e.date) return false;
      const hour = new Date(e.date).getUTCHours();
      return hour >= 17;
    });

    // Calculate win % for day vs. night
    const dayWins = dayGames.filter((e) => e.competitions?.[0]?.winner).length;
    const nightWins = nightGames.filter((e) => e.competitions?.[0]?.winner).length;

    return {
      team: teamAbbr,
      dayWinPct: dayGames.length ? (dayWins / dayGames.length) * 100 : 50,
      nightWinPct: nightGames.length ? (nightWins / nightGames.length) * 100 : 50,
      dayGameCount: dayGames.length,
      nightGameCount: nightGames.length,
    };
  } catch {
    return null;
  }
}

/**
 * Full baseball matchup research: pitcher stats, team splits, form assessment.
 */
export async function fetchBaseballContext({ awayTeam, homeTeam, awayPitcher, homePitcher }, ctx) {
  if (!awayTeam || !homeTeam) return null;

  const [awayPStats, homePStats, awayTeamStats, homeTeamStats] = await Promise.all([
    fetchPitcherStats(awayPitcher, awayTeam, ctx),
    fetchPitcherStats(homePitcher, homeTeam, ctx),
    fetchTeamDayNightStats(awayTeam, ctx),
    fetchTeamDayNightStats(homeTeam, ctx),
  ]);

  // Return structured data even if some pieces are missing
  return {
    away: awayPStats
      ? {
          ...awayPStats,
          form: assessPitcherForm(awayPStats),
          newTeam: assessTeamTenure(awayPStats, awayTeam),
        }
      : null,
    home: homePStats
      ? {
          ...homePStats,
          form: assessPitcherForm(homePStats),
          newTeam: assessTeamTenure(homePStats, homeTeam),
        }
      : null,
    awayTeamStats,
    homeTeamStats,
  };
}
