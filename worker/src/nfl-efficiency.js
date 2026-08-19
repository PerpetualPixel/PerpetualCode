/**
 * NFL team efficiency — EPA/play, offense and defense — from nflverse's
 * free, CC-BY-4.0 team-week release. This is the first real per-play
 * efficiency data anywhere in this app; ESPN's own APIs (context.js) carry
 * only records, last-5 results and injuries, none of which say anything
 * about HOW a team is winning or losing its games.
 *
 * WHAT THIS DOES AND DOES NOT COVER
 * ----------------------------------
 * nflverse's small pre-aggregated file (stats_team_week_{season}.csv, ~230KB
 * a season, verified directly — one row per team per game, no auth needed)
 * carries `passing_epa` and `rushing_epa` (summed per game) plus
 * `attempts`/`carries`, which is enough to compute a real offensive EPA/play.
 * It does NOT carry a success-rate field (EPA>0 per play) at all — that only
 * exists in the full play-by-play release, which runs ~19-20MB compressed a
 * season, too large to fetch and parse inside a Worker invocation's
 * CPU/time budget. Success rate therefore stays an honestly-reported gap
 * (see docs/take-or-fade.js's football evaluator) rather than something
 * faked from a file that doesn't contain it. Same for pass-rush/pass-block
 * win rate — that's proprietary NGS/PFF tracking data with no free source
 * anywhere, and stays named as missing rather than approximated.
 *
 * `receiving_epa` is deliberately NOT added into the offensive total: in
 * this file it's a distinct per-catch accounting (confirmed by inspecting
 * real rows — it does not equal passing_epa), not a second, independent
 * chunk of offense. Adding it would double-count the same passing plays.
 *
 * Defensive EPA/play allowed isn't a column either — it's derived here by
 * mirroring: a team's defensive EPA/play allowed in one game equals its
 * opponent's offensive EPA/play in that same game. That's not an
 * approximation of anything, it's exactly what "EPA allowed" means.
 *
 * Source: https://github.com/nflverse/nflverse-data (CC-BY-4.0), generated
 * by the nflfastR R package's calculate_stats(). Updates nightly-ish during
 * the season; this app refreshes weekly (see index.js's scheduled cron)
 * since a rolling multi-game window doesn't meaningfully move day to day.
 */

const KV_KEY = 'nfl:efficiency';
// Outlives a bye week (so a team's own numbers don't vanish from the board
// the one week they don't play) — a fresh weekly cron overwrites it anyway
// during the season.
const KV_TTL = 86400 * 10;
// Recent-form window: enough games to smooth out one outlier performance,
// short enough to actually track an in-season scheme or personnel change
// rather than blending it into a full-season average.
const ROLLING_GAMES = 8;

/** nflverse's 3-letter team codes -> the full names this app's odds feed and ESPN context use elsewhere. Verified against a live fetch of the 2025 file — all 32 present, no aliases needed. */
export const NFL_TEAM_BY_ABBR = {
  ARI: 'Arizona Cardinals', ATL: 'Atlanta Falcons', BAL: 'Baltimore Ravens', BUF: 'Buffalo Bills',
  CAR: 'Carolina Panthers', CHI: 'Chicago Bears', CIN: 'Cincinnati Bengals', CLE: 'Cleveland Browns',
  DAL: 'Dallas Cowboys', DEN: 'Denver Broncos', DET: 'Detroit Lions', GB: 'Green Bay Packers',
  HOU: 'Houston Texans', IND: 'Indianapolis Colts', JAX: 'Jacksonville Jaguars', KC: 'Kansas City Chiefs',
  LA: 'Los Angeles Rams', LAC: 'Los Angeles Chargers', LV: 'Las Vegas Raiders', MIA: 'Miami Dolphins',
  MIN: 'Minnesota Vikings', NE: 'New England Patriots', NO: 'New Orleans Saints', NYG: 'New York Giants',
  NYJ: 'New York Jets', PHI: 'Philadelphia Eagles', PIT: 'Pittsburgh Steelers', SEA: 'Seattle Seahawks',
  SF: 'San Francisco 49ers', TB: 'Tampa Bay Buccaneers', TEN: 'Tennessee Titans', WAS: 'Washington Commanders',
};

/**
 * The NFL season nflverse's release is keyed by (the START year — the
 * 2025-26 season's file is "2025"). Before the season kicks off in
 * September, the previous season's file is still the most recently
 * completed one worth reading rather than an empty current-year file.
 */
export function currentNflSeason(now = Date.now()) {
  const d = new Date(now);
  return d.getUTCMonth() >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; // Aug (7) onward = that year's season
}

/**
 * Parse the team-week CSV into flat per-team-per-game rows. Pure string
 * splitting rather than a CSV library: this specific export has no
 * comma-containing quoted fields (team/opponent are 2-3 letter codes,
 * everything else numeric), verified against a live sample.
 */
export function parseNflTeamWeekCsv(csvText) {
  const lines = String(csvText ?? '').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  const idx = (name) => header.indexOf(name);
  const iTeam = idx('team');
  const iOpp = idx('opponent_team');
  const iWeek = idx('week');
  const iPassEpa = idx('passing_epa');
  const iRushEpa = idx('rushing_epa');
  const iAtt = idx('attempts');
  const iCarries = idx('carries');
  if ([iTeam, iOpp, iWeek, iPassEpa, iRushEpa, iAtt, iCarries].some((i) => i < 0)) return [];

  // Number('') is 0, not NaN — an empty CSV cell must be rejected explicitly,
  // or a genuinely missing stat silently becomes a real zero in the average.
  const numOrNaN = (cell) => (cell === undefined || cell === '' ? NaN : Number(cell));

  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const team = cells[iTeam];
    const opponent = cells[iOpp];
    const week = numOrNaN(cells[iWeek]);
    const passEpa = numOrNaN(cells[iPassEpa]);
    const rushEpa = numOrNaN(cells[iRushEpa]);
    const att = numOrNaN(cells[iAtt]);
    const carries = numOrNaN(cells[iCarries]);
    const plays = att + carries;
    if (!team || !opponent || !Number.isFinite(week) || !Number.isFinite(passEpa)
      || !Number.isFinite(rushEpa) || !Number.isFinite(plays) || plays <= 0) continue;
    rows.push({ team, opponent, week, offEpa: passEpa + rushEpa, offPlays: plays });
  }
  return rows;
}

/**
 * Roll per-team offense (that team's own rows) and defense (its opponents'
 * rows in those same games, mirrored) into a rolling-window EPA/play.
 * Returns a plain object keyed by full team name — the same names the odds
 * feed and ESPN context already use — so nflEpaDifferential below never
 * needs a second abbreviation lookup.
 */
export function aggregateNflEfficiency(rows, { rollingGames = ROLLING_GAMES } = {}) {
  const byTeam = new Map();
  for (const r of rows ?? []) {
    if (!byTeam.has(r.team)) byTeam.set(r.team, []);
    byTeam.get(r.team).push(r);
  }

  const result = {};
  for (const [team, games] of byTeam) {
    const recentOff = games.slice().sort((a, b) => a.week - b.week).slice(-rollingGames);
    const offPlaysTotal = recentOff.reduce((s, g) => s + g.offPlays, 0);
    const offEpaPerPlay = offPlaysTotal > 0
      ? recentOff.reduce((s, g) => s + g.offEpa, 0) / offPlaysTotal
      : null;

    const defGames = recentOff
      .map((g) => byTeam.get(g.opponent)?.find((o) => o.week === g.week))
      .filter(Boolean);
    const defPlaysTotal = defGames.reduce((s, g) => s + g.offPlays, 0);
    const defEpaPerPlayAllowed = defPlaysTotal > 0
      ? defGames.reduce((s, g) => s + g.offEpa, 0) / defPlaysTotal
      : null;

    const name = NFL_TEAM_BY_ABBR[team] ?? team;
    result[name] = { offEpaPerPlay, defEpaPerPlayAllowed, games: recentOff.length };
  }
  return result;
}

/**
 * -1..1 differential for one matchup: how much better `teamName`'s offense
 * (against `opponentName`'s actual defense) is expected to perform than the
 * reverse. Positive favors `teamName`. Returns null when either side lacks
 * enough data — early in a season, or a team this file doesn't name.
 *
 * Scaled against ±EPA_SCALE per play: real NFL team-season offensive
 * EPA/play typically spans roughly -0.15 to +0.15, so ±0.35 leaves room for
 * a genuinely decisive mismatch to reach the outer band without a routine
 * one pinning at ±1 by default.
 */
const EPA_SCALE = 0.35;
export function nflEpaDifferential(efficiency, teamName, opponentName) {
  const me = efficiency?.[teamName];
  const them = efficiency?.[opponentName];
  if (!me || !them) return null;
  if (![me.offEpaPerPlay, me.defEpaPerPlayAllowed, them.offEpaPerPlay, them.defEpaPerPlayAllowed].every(Number.isFinite)) {
    return null;
  }
  // Each side's offense projected against the OTHER side's actual defense,
  // not each team's own season numbers in a vacuum: averaging a team's own
  // scoring rate with what the specific opponent typically allows is the
  // standard way to project one matchup (the same idea behind Pythagorean/
  // power-rating projections generally). Averaging matters here, not just
  // subtracting — myEdge/theirEdge computed as (off - opponent's def) and
  // then subtracted algebraically cancels to comparing each team's own
  // (offense + defense) net rating, discarding the opponent entirely; this
  // form keeps the actual cross-matchup term.
  const myProjected = (me.offEpaPerPlay + them.defEpaPerPlayAllowed) / 2;
  const theirProjected = (them.offEpaPerPlay + me.defEpaPerPlayAllowed) / 2;
  return Math.max(-1, Math.min(1, (myProjected - theirProjected) / (2 * EPA_SCALE)));
}

/** Fetch + parse + aggregate in one call. Returns null on any failure — an unreachable source is a cache-miss, not a crash. */
export async function fetchNflEfficiency({ season = currentNflSeason(), fetchFn = fetch } = {}) {
  const url = `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`;
  try {
    const res = await fetchFn(url, { redirect: 'follow' });
    if (!res.ok) return null;
    const rows = parseNflTeamWeekCsv(await res.text());
    if (!rows.length) return null;
    return { season, teams: aggregateNflEfficiency(rows), updatedAt: Date.now() };
  } catch {
    return null; // network failure — same honest degradation as an unreachable ESPN elsewhere in this app
  }
}

/** Refresh the cached efficiency snapshot. A failed fetch leaves the previous week's cache in place rather than clearing it — stale-but-real beats nothing. */
export async function refreshNflEfficiency(env, opts = {}) {
  const data = await fetchNflEfficiency(opts);
  if (!data) return null;
  await env.POTD_KV.put(KV_KEY, JSON.stringify(data), { expirationTtl: KV_TTL });
  return data;
}

export async function getNflEfficiency(env) {
  const raw = await env.POTD_KV.get(KV_KEY);
  return raw ? JSON.parse(raw) : null;
}
