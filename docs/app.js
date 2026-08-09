/**
 * Pixel Pick — UI layer.
 *
 * Responsibilities kept deliberately thin: fetch the odds pool, hand it to the
 * engine, render what comes back, and persist history. All betting logic lives
 * in engine.js so it can be tested without a browser.
 */

// Enforce custom domain — redirect old GitHub URL to perpetualpicks.com
if (!window.location.hostname.includes('perpetualpicks.com')) {
  window.location.href = 'https://perpetualpicks.com' + window.location.pathname + window.location.search;
}

import { CONFIG } from './config.js';
import { DEMO_EVENTS } from './demo.js';
import { teamLogoUrl } from './team-logos.js';
import { BUILD_INFO } from './version.js';
import { summarizePicks, gradePick } from './learning.js';
import {
  RULES,
  SPORTSBOOKS,
  analyze,
  topPicks,
  explain,
  explainExtensive,
  formatAmerican,
  confidenceColor,
  bookOffers,
  bookIdFor,
  impliedProb,
  americanToDecimal,
  suggestedParlayStake,
  suggestedStake,
  scoreCandidate,
} from './engine.js';
import {
  tennisQualitativeSignal,
  teamQualitativeSignal,
  supportsQualitativeSignal,
} from './qualitative.js';
import {
  buildInsights,
  insightTexts,
  insightsByTier,
  isTennis,
  isMma,
  resolveMmaFighters,
  isUfcDebut,
  finishSummary,
  vulnerabilitySummary,
  fighterActivityByYear,
  fighterRoundsEnded,
  dataReliability,
  commonOpponents,
  tennisSurfaceFilters,
  tennisRecentForm,
  tennisHeadToHead,
} from './insights.js';

const BANKROLL_KEY = 'pixelpick.bankroll.v1';
const SLATE_LEAGUE_KEY = 'pixelpick.slateLeague.v2';
const PIXEL_SORT_KEY = 'pixelpick.sort.v1';
const DAY_FILTER_KEY = 'pixelpick.dayFilter.v1';
// The Tracking Dashboard's user-dragged width in px, or null for its default
// (fills the viewport). Only ever set by actually dragging the resize
// handle — there's no other UI that writes to this.
const LEARNING_PANEL_WIDTH_KEY = 'pixelpick.learningPanelWidth.v1';
const LEARNING_PANEL_MIN_WIDTH = 320;
// 1-2% of bankroll per unit is the standard range a flat-staking bettor
// works from; 2% is the more conservative, more commonly cited end of it —
// used here as the default recommendation when the user hasn't set their own.
const RECOMMENDED_UNIT_PCT = 0.02;

/**
 * The leagues the app always keeps loaded. Tennis has no single sport
 * key — the Odds API keys it per tournament (tennis_atp_canadian_open this
 * week, something else next) — so ATP/WTA start with an empty key list and
 * get populated from the catalogue once it loads (see populateTennisGroups).
 * Everything else already has one stable key.
 */
const LEAGUE_GROUPS = [
  { id: 'mlb', label: 'MLB', keys: ['baseball_mlb'] },
  { id: 'nfl', label: 'NFL', keys: ['americanfootball_nfl'] },
  { id: 'ncaa', label: 'NCAA', keys: ['americanfootball_ncaaf'] },
  { id: 'atp', label: 'ATP', keys: [] },
  { id: 'wta', label: 'WTA', keys: [] },
  { id: 'wnba', label: 'WNBA', keys: ['basketball_wnba'] },
  { id: 'mma', label: 'MMA', keys: ['mma_mixed_martial_arts'] },
  { id: 'mls', label: 'MLS', keys: ['soccer_usa_mls'] },
  // offSeason:true here only affects THIS client-side Full Slate browsing
  // tab (refreshAllLeagues() skips the key, renderFullSlate() shows "coming
  // soon" instead of fetching) — unlike NBA/NCAAB below, NHL is still
  // tracked year-round server-side (FIXED_SPORT_KEYS in worker/src/
  // tracking.js, and the NHL Shots on Goal prop pipeline), and that side is
  // untouched: it already finds zero games during the off-season and
  // correctly does nothing, at negligible cost, by the same "0 games -> 0
  // picks, no error" handling every sport gets. This flag just stops the
  // dashboard tab itself from looking "live" when there's nothing to show.
  // Flip back once the season starts.
  { id: 'nhl', label: 'NHL', keys: ['icehockey_nhl'], offSeason: true },
  // Placeholders only — both leagues are off-season AND have never been
  // wired into server-side tracking at all (unlike NHL above). offSeason:true
  // keeps refreshAllLeagues() from fetching either key at all (see that
  // function) and renderFullSlate() from attempting any live score/pick
  // refresh for them, so onboarding these now costs zero real requests.
  // Flip this off (and give NCAAB its own Power-4-style conference filter,
  // mirroring docs/ncaaf-conferences.js) once each season actually starts.
  { id: 'nba', label: 'NBA', keys: ['basketball_nba'], offSeason: true },
  { id: 'ncaab', label: 'NCAAB', keys: ['basketball_ncaab'], offSeason: true },
];
const LEAGUE_GROUP_BY_ID = new Map(LEAGUE_GROUPS.map((g) => [g.id, g]));

/** One glyph per league group, for the glowing quick-select token row (renderSlateLeagueOptions) — purely decorative, the underlying select is still the source of truth. */
const LEAGUE_ICONS = {
  mlb: '⚾', nfl: '🏈', ncaa: '🎓', atp: '🎾', wta: '🎾',
  wnba: '🏀', mma: '🥊', mls: '⚽', nhl: '🏒', nba: '🏀', ncaab: '🎓',
};

/** Fill ATP/WTA's key lists from whatever tennis tournaments are currently live in the catalogue. */
function populateTennisGroups() {
  const atp = LEAGUE_GROUP_BY_ID.get('atp');
  const wta = LEAGUE_GROUP_BY_ID.get('wta');
  atp.keys = state.catalogue.filter((s) => s.key.startsWith('tennis_atp_')).map((s) => s.key);
  wta.keys = state.catalogue.filter((s) => s.key.startsWith('tennis_wta_')).map((s) => s.key);
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function isMmaSportKey(sportKey) {
  return LEAGUE_GROUP_BY_ID.get('mma').keys.includes(sportKey);
}

/** YYYY-MM-DD in America/New_York for a given instant — string comparison
 * sidesteps DST-offset math entirely (the same convention this app's own
 * worker-side etDate() already uses server-side), the only reliable way to
 * determine "which ET calendar day" without a full timezone-aware date
 * library. */
function etDateString(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** A plain Date for the ET calendar day 'today' or 'tomorrow' falls on —
 * used only to render the "Tomorrow (Aug 9)" toggle label in the viewer's
 * own locale. The actual Today/Tomorrow filtering (withinDayFilter) never
 * uses this; it compares ET calendar-date strings directly. */
function etDayLabelDate(which) {
  const targetMs = Date.now() + (which === 'tomorrow' ? ONE_DAY_MS : 0);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(targetMs).map((p) => [p.type, p.value]));
  return new Date(+parts.year, +parts.month - 1, +parts.day);
}

/**
 * Whether a game belongs on the board under the current Today/Tomorrow
 * toggle, compared by real ET calendar date — not the viewer's own local
 * timezone, and not a millisecond range that would need DST-offset math to
 * get right. "Today" means the same thing for every user regardless of
 * where they're browsing from, matching every other ET-day boundary this
 * app already uses server-side.
 *
 * MMA is the one exception: cards are announced and sell tickets weeks out,
 * so it keeps its own longer horizon rather than being scoped to a single
 * day like every other league — but only for a fight that hasn't happened
 * yet. `isFinished` narrows that: a finished fight has no ambiguity about
 * which day it belongs to, so it still respects Today/Tomorrow once it's
 * over (otherwise a many-day-old completed fight, still returned by
 * /scores' several-day lookback, would leak into "today's" Finished tab
 * indefinitely).
 *
 * Tennis used to get this same exemption, unconditionally — a single round
 * routinely spans two calendar days, and the reasoning was that hiding
 * "tomorrow's" half of a round that's really one contiguous slate was worse
 * than showing it under the wrong toggle. In practice that meant Today and
 * Tomorrow showed the exact same full set of tennis matches regardless of
 * which was selected, defeating the point of the toggle entirely. Removed
 * per explicit request: Today now genuinely means today's matches, Tomorrow
 * means tomorrow's. A next-round matchup not yet drawn simply isn't in the
 * odds feed yet — there's no "TBD" placeholder to manufacture for it, the
 * same honest "no data yet" this app already prefers everywhere else over
 * guessing.
 */
function withinDayFilter(commenceMs, sportKey, isFinished = false) {
  if (!isFinished && isMmaSportKey(sportKey)) return true;
  const targetMs = Date.now() + (state.dayFilter === 'tomorrow' ? ONE_DAY_MS : 0);
  return etDateString(commenceMs) === etDateString(targetMs);
}

/**
 * A tracked pick's raw sport key (e.g. 'tennis_wta_canadian_open',
 * 'baseball_mlb') mapped to its League Group label ('WTA', 'MLB') for the
 * tracker's sport filter. Pattern-matches tennis rather than checking the
 * live ATP/WTA group's keys — those rotate to a new tournament every week,
 * so a historical pick's key is often no longer in the current group.
 */
function sportGroupLabel(sportKey) {
  if (sportKey.startsWith('tennis_atp_')) return 'ATP';
  if (sportKey.startsWith('tennis_wta_')) return 'WTA';
  const group = LEAGUE_GROUPS.find((g) => g.keys.includes(sportKey));
  return group ? group.label : sportKey;
}

function renderDayToggle() {
  const tomorrowDate = etDayLabelDate('tomorrow');
  el.tomorrowDateLabel.textContent = `(${tomorrowDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })})`;
  el.dayFilterToday.classList.toggle('is-active', state.dayFilter === 'today');
  el.dayFilterToday.setAttribute('aria-pressed', String(state.dayFilter === 'today'));
  el.dayFilterTomorrow.classList.toggle('is-active', state.dayFilter === 'tomorrow');
  el.dayFilterTomorrow.setAttribute('aria-pressed', String(state.dayFilter === 'tomorrow'));
}

function setDayFilter(which) {
  if (state.dayFilter === which) return;
  state.dayFilter = which;
  saveJSON(DAY_FILTER_KEY, which);
  renderDayToggle();
  renderSlateLeagueOptions();
  if (state.candidates.length) {
    renderFullSlate();
    // Pixel's Picks is a fixed daily set locked server-side (see
    // loadPixelPicks()) — it doesn't have a Today/Tomorrow of its own to
    // re-rank into, so switching the toggle doesn't touch it.
    refreshQualitativeSignals(); // fire-and-forget — re-enriches the newly-visible day
  }
}

function renderSlateStateToggle() {
  el.slateStateUpcoming.classList.toggle('is-active', state.slateGameFilter === 'upcoming');
  el.slateStateUpcoming.setAttribute('aria-pressed', String(state.slateGameFilter === 'upcoming'));
  el.slateStateFinished.classList.toggle('is-active', state.slateGameFilter === 'finished');
  el.slateStateFinished.setAttribute('aria-pressed', String(state.slateGameFilter === 'finished'));
}

function setSlateGameFilter(which) {
  if (state.slateGameFilter === which) return;
  state.slateGameFilter = which;
  renderSlateStateToggle();
  if (state.candidates.length || state.rawEvents.length) renderFullSlate();
}

// MLB team name to abbreviation mapping
const MLB_ABBR_MAP = {
  'Los Angeles Angels': 'LAA',
  'Baltimore Orioles': 'BAL',
  'Boston Red Sox': 'BOS',
  'New York Yankees': 'NYY',
  'Tampa Bay Rays': 'TB',
  'Toronto Blue Jays': 'TOR',
  'Chicago White Sox': 'CHW', // ESPN's own slug, not the common "CWS" abbreviation — confirmed live (cws -> 400, chw -> 200)
  'Cleveland Guardians': 'CLE',
  'Detroit Tigers': 'DET',
  'Kansas City Royals': 'KC',
  'Minnesota Twins': 'MIN',
  'Houston Astros': 'HOU',
  'Los Angeles Dodgers': 'LAD',
  'Oakland Athletics': 'ATH', // relocated for the 2026 season; ESPN's own slug moved from "oak" to "ath" (confirmed live: oak -> 400, ath -> 200)
  'Athletics': 'ATH', // some odds feeds already dropped the city name post-relocation
  'Seattle Mariners': 'SEA',
  'Arizona Diamondbacks': 'ARI',
  'Colorado Rockies': 'COL',
  'San Diego Padres': 'SD',
  'San Francisco Giants': 'SF',
  'Atlanta Braves': 'ATL',
  'Miami Marlins': 'MIA',
  'New York Mets': 'NYM',
  'Philadelphia Phillies': 'PHI',
  'Washington Nationals': 'WSH',
  'Chicago Cubs': 'CHC',
  'Cincinnati Reds': 'CIN',
  'Milwaukee Brewers': 'MIL',
  'Pittsburgh Pirates': 'PIT',
  'St. Louis Cardinals': 'STL',
};

function getTeamAbbr(teamName) {
  if (!teamName) return 'UNKNOWN';
  // Try direct map first
  if (MLB_ABBR_MAP[teamName]) return MLB_ABBR_MAP[teamName];
  // If already an abbreviation (2-3 chars), return as is
  if (teamName.length <= 3) return teamName.toUpperCase();
  // Extract from team name (last 3 chars or last word)
  return teamName.split(' ').pop().slice(0, 3).toUpperCase();
}

// MLB Stats display — labels shown for each stat key, in display order.
// Direction (higher/lower is better) is decided server-side (see
// worker/src/mlb-stats.js's HIGHER_IS_BETTER); the client just renders
// whatever rank the server already computed against the real league.
const MLB_OFFENSE_LABELS = {
  battingAvg: 'Batting Avg', obpSlugging: 'OBP+SLG%', rbi: 'RBI', strikeouts: 'Strikeouts',
  runs: 'Runs', stolenBases: 'Stolen Bases', doubles: 'Doubles', hits: 'Hits',
  triples: 'Triples', walks: 'Walks', homeRuns: 'Home Runs',
};
const MLB_DEFENSE_LABELS = {
  era: 'ERA', whip: 'WHIP', strikeoutsPitching: 'Strikeouts', fieldingPercentage: 'Fielding %', errors: 'Errors',
};
const MLB_THREE_DECIMAL_STATS = new Set(['battingAvg', 'obpSlugging', 'fieldingPercentage']);
const MLB_TWO_DECIMAL_STATS = new Set(['era', 'whip']);

function formatMlbStatValue(key, value) {
  if (value == null) return '—';
  if (MLB_THREE_DECIMAL_STATS.has(key)) return value.toFixed(3);
  if (MLB_TWO_DECIMAL_STATS.has(key)) return value.toFixed(2);
  return Math.round(value).toLocaleString();
}

function ordinal(n) {
  if (n == null) return '—';
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** The panel's currently-loaded data, so the Offense/Defense and schedule tabs can re-render without re-fetching. Reset each time showTeamStats() opens a new matchup. */
let currentMlbStats = null;

// MLB Stats display — fetches both teams' real ESPN-backed stats via the
// worker, opens the panel with a loading state, and shows a clear error
// rather than doing nothing if the fetch fails (the original bug report).
async function showTeamStats(awayTeam, homeTeam, awayAbbr, homeAbbr) {
  const awayAbbrev = awayAbbr ? getTeamAbbr(awayAbbr) : getTeamAbbr(awayTeam);
  const homeAbbrev = homeAbbr ? getTeamAbbr(homeAbbr) : getTeamAbbr(homeTeam);

  el.statsTitle.textContent = `${awayTeam} @ ${homeTeam}`;
  el.statsBody.innerHTML = `<p class="empty">Loading stats…</p>`;
  el.statsPanel.hidden = false;
  el.scrim.hidden = false;

  if (!CONFIG.WORKER_URL) {
    el.statsBody.innerHTML = `<p class="empty">Team stats aren't available in demo mode.</p>`;
    return;
  }

  try {
    // Each call also sends the opponent so the worker can resolve the
    // specific upcoming matchup and return both teams' starting pitcher —
    // cheap either way (same schedule fetch h2h would need), so it's sent
    // on this initial load rather than gated behind another tab click.
    const fetchTeam = (abbr, opponentAbbr) => {
      const url = new URL('/mlb-stats', CONFIG.WORKER_URL);
      url.searchParams.set('team', abbr);
      url.searchParams.set('opponent', opponentAbbr);
      return fetch(url, { headers: { Accept: 'application/json' } }).then((r) => {
        if (!r.ok) throw new Error(`mlb-stats returned ${r.status}`);
        return r.json();
      });
    };
    const [awayData, homeData] = await Promise.all([
      fetchTeam(awayAbbrev, homeAbbrev),
      fetchTeam(homeAbbrev, awayAbbrev),
    ]);

    currentMlbStats = {
      awayTeam, homeTeam, awayAbbrev, homeAbbrev, awayData, homeData,
      category: 'offense', scheduleTab: 'away', headToHead: undefined,
      startingPitchers: awayData.startingPitchers ?? homeData.startingPitchers ?? null,
      pitcherOutings: {},
    };
    renderMlbStatsPanel();
  } catch {
    el.statsBody.innerHTML = `<p class="empty">Couldn't load stats for this matchup right now.</p>`;
  }
}

function renderMlbStatsPanel() {
  const d = currentMlbStats;
  if (!d) return;
  el.statsBody.innerHTML = `
    <div class="stats-matchup"><h3>${esc(d.awayTeam)} @ ${esc(d.homeTeam)}</h3></div>
    ${d.startingPitchers && (d.startingPitchers.away || d.startingPitchers.home) ? `
    <div class="stats-section">
      <h4>Starting Pitchers</h4>
      ${renderMlbStartingPitchers(d)}
    </div>` : ''}
    <div class="stats-section">
      <h4>Situational Results</h4>
      ${renderMlbSituational(d)}
    </div>
    <div class="stats-section">
      <h4>Team Stats</h4>
      ${renderMlbTeamStats(d)}
    </div>
    <div class="stats-section">
      <h4>Recent Schedule</h4>
      ${renderMlbScheduleSection(d)}
    </div>
  `;
}

const MLB_PITCHER_STAT_LABELS = { era: 'ERA', whip: 'WHIP', ip: 'IP', hits: 'H', strikeouts: 'K', walks: 'BB' };
const MLB_PITCHER_TWO_DECIMAL_STATS = new Set(['era', 'whip']);

function formatPitcherStat(key, value) {
  if (value == null) return '—';
  if (MLB_PITCHER_TWO_DECIMAL_STATS.has(key)) return value.toFixed(2);
  return String(value);
}

/**
 * Both teams' confirmed/probable starter, side by side — a side with nothing
 * announced yet ("TBD") is simply omitted rather than showing an empty card,
 * same convention as every other data gap in this panel.
 */
function renderMlbStartingPitchers(d) {
  const pitchers = [
    { side: 'away', pitcher: d.startingPitchers.away },
    { side: 'home', pitcher: d.startingPitchers.home },
  ];

  const pitcherCard = (side, pitcher) => {
    if (!pitcher) return `<div class="stats-team"><p class="empty">TBD</p></div>`;
    const record = pitcher.wins != null && pitcher.losses != null ? `${pitcher.wins}-${pitcher.losses}` : '—';
    const expanded = d.pitcherOutings[pitcher.playerId] !== undefined;
    return `
      <div class="stats-team pitcher-card">
        <div class="team-header">
          <span class="team-name">${esc(pitcher.name)}</span>
          <span class="pitcher-meta">${record}${pitcher.jersey ? `, #${esc(pitcher.jersey)}` : ''}${pitcher.throws ? ` · ${esc(pitcher.throws)}HP` : ''}</span>
        </div>
        ${Object.entries(MLB_PITCHER_STAT_LABELS).map(([key, label]) => `
          <div class="stat-row">
            <span class="stat-label">${label}</span>
            <span class="stat-value">${esc(formatPitcherStat(key, pitcher[key]))}</span>
          </div>`).join('')}
        <button type="button" class="pitcher-outings-toggle" data-pitcher-outings="${side}" data-player-id="${esc(pitcher.playerId)}">
          ${expanded ? 'Hide' : 'Show'} Past 5 Outings
        </button>
      </div>`;
  };

  // Outings render full-width below both cards, not nested in the half-width
  // side-by-side grid — a 7-column per-outing line needs the room, and the
  // reference layout shows it as its own drop-down panel too.
  const expandedOutings = pitchers
    .filter(({ pitcher }) => pitcher && d.pitcherOutings[pitcher.playerId] !== undefined)
    .map(({ pitcher }) => `
      <div class="pitcher-outings-block">
        <h5>${esc(pitcher.name)}: Past 5 Outings</h5>
        ${renderMlbPitcherOutings(d.pitcherOutings[pitcher.playerId])}
      </div>`)
    .join('');

  return `
    <div class="stats-grid">
      ${pitcherCard('away', d.startingPitchers.away)}
      <div class="stats-divider"></div>
      ${pitcherCard('home', d.startingPitchers.home)}
    </div>
    ${expandedOutings}`;
}

function renderMlbPitcherOutings(outings) {
  if (outings === null) return `<p class="empty">Loading…</p>`;
  if (!outings.length) return `<p class="empty">No recent outings found.</p>`;
  return `<div class="schedule-table pitcher-outings">
    ${outings.map((o) => `
      <div class="schedule-row">
        <span class="schedule-game">${esc(o.atVs)} ${esc(o.opponent)}</span>
        <span class="schedule-result ${o.result === 'W' ? 'win' : 'loss'}">${o.result ? esc(o.result) : ''} ${o.score ? esc(o.score) : ''}</span>
        <span class="stat-value">${o.ip != null ? `${esc(String(o.ip))} IP` : '—'}</span>
        <span class="stat-value">${o.earnedRuns != null ? `${esc(String(o.earnedRuns))} ER` : '—'}</span>
        <span class="stat-value">${o.strikeouts != null ? `${esc(String(o.strikeouts))} K` : '—'}</span>
      </div>
    `).join('')}
  </div>`;
}

/** Season/Last 10/venue-split rows — no Underdog/Favorite split, since no data source tracks a team's record by whether it was favored. */
function renderMlbSituational(d) {
  const away = d.awayData.situational;
  const home = d.homeData.situational;
  if (!away && !home) return `<p class="empty">Situational data unavailable.</p>`;

  const row = (label, value) => `
    <div class="stat-row">
      <span class="stat-label">${esc(label)}</span>
      <span class="stat-value">${value ? esc(value) : '—'}</span>
    </div>`;

  return `
    <div class="stats-grid">
      <div class="stats-team">
        <div class="team-header"><span class="team-name">${esc(d.awayAbbrev)}</span></div>
        ${row('Season', away?.season)}
        ${row('Last 10', away?.lastTen)}
        ${row('Away', away?.away)}
      </div>
      <div class="stats-divider"></div>
      <div class="stats-team">
        <div class="team-header"><span class="team-name">${esc(d.homeAbbrev)}</span></div>
        ${row('Season', home?.season)}
        ${row('Last 10', home?.lastTen)}
        ${row('Home', home?.home)}
      </div>
    </div>`;
}

function renderMlbTeamStats(d) {
  const category = d.category;
  const labels = category === 'offense' ? MLB_OFFENSE_LABELS : MLB_DEFENSE_LABELS;

  const statRows = (stats) => {
    if (!stats) return `<p class="empty">Stats unavailable</p>`;
    return Object.entries(labels).map(([key, label]) => {
      const entry = stats[key];
      const rankClass = entry?.rank == null ? '' : entry.rank <= 15 ? 'good' : 'bad';
      return `
        <div class="stat-row">
          <span class="stat-rank ${rankClass}">${ordinal(entry?.rank)}</span>
          <span class="stat-label">${esc(label)}</span>
          <span class="stat-value">${formatMlbStatValue(key, entry?.value)}</span>
        </div>`;
    }).join('');
  };

  return `
    <div class="stats-tabs">
      <button type="button" class="stats-tab ${category === 'offense' ? 'is-active' : ''}" data-mlb-category="offense">Offense</button>
      <button type="button" class="stats-tab ${category === 'defense' ? 'is-active' : ''}" data-mlb-category="defense">Defense</button>
    </div>
    <div class="stats-grid">
      <div class="stats-team">
        <div class="team-header"><span class="team-name">${esc(d.awayTeam)}</span></div>
        ${statRows(d.awayData.teamStats?.[category])}
      </div>
      <div class="stats-divider"></div>
      <div class="stats-team">
        <div class="team-header"><span class="team-name">${esc(d.homeTeam)}</span></div>
        ${statRows(d.homeData.teamStats?.[category])}
      </div>
    </div>`;
}

function renderMlbScheduleSection(d) {
  const tab = d.scheduleTab;
  let body;
  if (tab === 'h2h') {
    body = d.headToHead === undefined
      ? `<p class="empty">Loading head-to-head…</p>`
      : renderMlbSchedule(d.headToHead);
  } else if (tab === 'home') {
    body = renderMlbSchedule(d.homeData.recentSchedule);
  } else {
    body = renderMlbSchedule(d.awayData.recentSchedule);
  }

  return `
    <div class="stats-tabs">
      <button type="button" class="stats-tab ${tab === 'away' ? 'is-active' : ''}" data-mlb-schedule-tab="away">${esc(d.awayTeam)}</button>
      <button type="button" class="stats-tab ${tab === 'h2h' ? 'is-active' : ''}" data-mlb-schedule-tab="h2h">Head-to-Head</button>
      <button type="button" class="stats-tab ${tab === 'home' ? 'is-active' : ''}" data-mlb-schedule-tab="home">${esc(d.homeTeam)}</button>
    </div>
    <div class="schedule-content">${body}</div>`;
}

function renderMlbSchedule(games) {
  if (!games || games.length === 0) return '<p class="empty">No games found.</p>';

  const resultClass = (text, winPrefix, lossPrefix) =>
    text?.startsWith(winPrefix) ? 'win' : text?.startsWith(lossPrefix) ? 'loss' : '';

  return `<div class="schedule-table">
    ${games.map((g) => `
      <div class="schedule-row">
        <span class="schedule-game">${esc(g.opponent)}</span>
        <span class="schedule-result ${g.result === 'W' ? 'win' : 'loss'}">${esc(g.result)} ${esc(g.score)}</span>
        <span class="schedule-ats ${resultClass(g.ats, 'W', 'L')}">${g.ats ? esc(g.ats) : '—'}</span>
        <span class="schedule-ou ${resultClass(g.ou, 'O', 'U')}">${g.ou ? esc(g.ou) : '—'}</span>
      </div>
    `).join('')}
  </div>`;
}

const el = {
  status: document.getElementById('status'),
  picks: document.getElementById('picks'),
  pixelSortRow: document.getElementById('pixelSortRow'),
  pixelSort: document.getElementById('pixelSort'),
  scrim: document.getElementById('scrim'),
  logoutBtn: document.getElementById('logoutBtn'),
  bankrollToggle: document.getElementById('bankrollToggle'),
  bankrollPanel: document.getElementById('bankrollPanel'),
  bankrollClose: document.getElementById('bankrollClose'),
  bankrollAmount: document.getElementById('bankrollAmount'),
  bankrollUnit: document.getElementById('bankrollUnit'),
  bankrollUnitHint: document.getElementById('bankrollUnitHint'),
  bankrollShowDollars: document.getElementById('bankrollShowDollars'),
  bankrollShowUnits: document.getElementById('bankrollShowUnits'),
  bankrollSubmit: document.getElementById('bankrollSubmit'),
  bankrollSubmitHint: document.getElementById('bankrollSubmitHint'),
  ownerKeyInput: document.getElementById('ownerKeyInput'),
  ownerKeyConnect: document.getElementById('ownerKeyConnect'),
  ownerKeyForget: document.getElementById('ownerKeyForget'),
  ownerKeyStatus: document.getElementById('ownerKeyStatus'),
  guideToggle: document.getElementById('guideToggle'),
  guidePanel: document.getElementById('guidePanel'),
  guideClose: document.getElementById('guideClose'),
  aboutToggle: document.getElementById('aboutToggle'),
  aboutPanel: document.getElementById('aboutPanel'),
  aboutClose: document.getElementById('aboutClose'),
  aboutVersion: document.getElementById('aboutVersion'),
  statsDrawer: document.getElementById('statsDrawer'),
  statsDrawerTitle: document.getElementById('statsDrawerTitle'),
  statsDrawerClose: document.getElementById('statsDrawerClose'),
  statsDrawerBody: document.getElementById('statsDrawerBody'),
  dayFilterBar: document.getElementById('dayFilterBar'),
  dayFilterToday: document.getElementById('dayFilterToday'),
  dayFilterTomorrow: document.getElementById('dayFilterTomorrow'),
  tomorrowDateLabel: document.getElementById('tomorrowDateLabel'),
  tabSlate: document.getElementById('tabSlate'),
  slateView: document.getElementById('slateView'),
  slateStatus: document.getElementById('slateStatus'),
  slateLeagueSelect: document.getElementById('slateLeagueSelect'),
  slateLeagueTokens: document.getElementById('slateLeagueTokens'),
  slateLoad: document.getElementById('slateLoad'),
  slateStateUpcoming: document.getElementById('slateStateUpcoming'),
  slateStateFinished: document.getElementById('slateStateFinished'),
  slateEventRow: document.getElementById('slateEventRow'),
  slateEventLabel: document.getElementById('slateEventLabel'),
  slateEventSelect: document.getElementById('slateEventSelect'),
  slateSortSelect: document.getElementById('slateSortSelect'),
  slateBody: document.getElementById('slateBody'),
  statsPanel: document.getElementById('statsPanel'),
  statsClose: document.getElementById('statsClose'),
  statsTitle: document.getElementById('statsTitle'),
  statsBody: document.getElementById('statsBody'),
  tabBoard: document.getElementById('tabBoard'),
  tabPotd: document.getElementById('tabPotd'),
  boardView: document.getElementById('boardView'),
  potdView: document.getElementById('potdView'),
  potdBody: document.getElementById('potdBody'),
  learningPanel: document.getElementById('learningPanel'),
  learningPanelResize: document.getElementById('learningPanelResize'),
  learningPanelClose: document.getElementById('learningPanelClose'),
  trackerRefreshBtn: document.getElementById('trackerRefreshBtn'),
  trackerTabs: document.getElementById('trackerTabs'),
  top5TotalPicks: document.getElementById('top5TotalPicks'),
  top5GradedPicks: document.getElementById('top5GradedPicks'),
  top5WinRate: document.getElementById('top5WinRate'),
  top5Roi: document.getElementById('top5Roi'),
  top5NetProfit: document.getElementById('top5NetProfit'),
  top5AvgClv: document.getElementById('top5AvgClv'),
  top5DailyHistory: document.getElementById('top5DailyHistory'),
  trackerSportFilter: document.getElementById('trackerSportFilter'),
  trackerViewTabs: document.getElementById('trackerViewTabs'),
  trackerCalendarView: document.getElementById('trackerCalendarView'),
  trackerCalPrev: document.getElementById('trackerCalPrev'),
  trackerCalNext: document.getElementById('trackerCalNext'),
  trackerCalMonthLabel: document.getElementById('trackerCalMonthLabel'),
  trackerCalendarWeekdays: document.getElementById('trackerCalendarWeekdays'),
  trackerCalendarGrid: document.getElementById('trackerCalendarGrid'),
  trackerCalendarDayDetail: document.getElementById('trackerCalendarDayDetail'),
  trackerGraphView: document.getElementById('trackerGraphView'),
  trackerGraphBucketTabs: document.getElementById('trackerGraphBucketTabs'),
  trackerGraphSvgWrap: document.getElementById('trackerGraphSvgWrap'),
  calibrationReport: document.getElementById('calibrationReport'),
  dailyLearnWeights: document.getElementById('dailyLearnWeights'),
  dailyLearnLog: document.getElementById('dailyLearnLog'),
  mlbPropsSummary: document.getElementById('mlbPropsSummary'),
  mlbPropsList: document.getElementById('mlbPropsList'),
  nflPropsSummary: document.getElementById('nflPropsSummary'),
  nflPropsList: document.getElementById('nflPropsList'),
  wnbaPropsSummary: document.getElementById('wnbaPropsSummary'),
  wnbaPropsList: document.getElementById('wnbaPropsList'),
  nhlPropsSummary: document.getElementById('nhlPropsSummary'),
  nhlPropsList: document.getElementById('nhlPropsList'),
  algoHealthConfig: document.getElementById('algoHealthConfig'),
  algoHealthPaused: document.getElementById('algoHealthPaused'),
  algoHealthLog: document.getElementById('algoHealthLog'),
  algoHealthResetBtn: document.getElementById('algoHealthResetBtn'),
};

const state = {
  candidates: [],
  // Raw, un-graded events straight from the odds feed — every game the
  // selected leagues returned, including ones where no market ever cleared
  // MIN_BOOKS and so never became a candidate. The Full Slate tab reads from
  // this (plus state.candidates for pricing) specifically so a thin market
  // still shows the game with a "—", rather than the game silently vanishing
  // because analyze() had nothing gradeable to say about it.
  rawEvents: [],
  fetchedAt: 0,
  isDemo: false,
  // The requestable catalogue, from the worker's free /sports endpoint.
  catalogue: [],
  // Which calendar day Full Slate and Pixel Picks both pull from — 'today'
  // or 'tomorrow'. Shared globally rather than per-tab: it's one "which day
  // am I looking at" question, not two. MMA ignores this
  // entirely (see withinDayFilter/isMmaSportKey) since cards are announced
  // and worth showing weeks ahead of a single day toggle.
  dayFilter: ['today', 'tomorrow'].includes(loadJSON(DAY_FILTER_KEY, 'today'))
    ? loadJSON(DAY_FILTER_KEY, 'today')
    : 'today',
  // Which of the three server-side trackers the Tracking Dashboard's
  // Full Slate / Pixel's Picks / Play of the Day toggle currently shows —
  // Calibration & Audit and Algorithm Health stay Pixel's-Picks-scoped
  // regardless of this (see renderTrackerSection's own comment).
  activeTracker: 'top5',
  // All three trackers' full history, fetched once per dashboard open and
  // re-rendered from on toggle — not re-fetched per click.
  trackerPicks: { fullslate: [], top5: [], potd: [] },
  // List/Calendar/Graph — which of the three views renders the currently
  // active tracker's picks below the metric cards.
  trackerView: 'list',
  // 'all' or a raw sportKey (the exact key stored on each pick record) — a
  // raw key rather than a League Group id since a pick's own sportKey is
  // what's actually on the record; sportGroupLabel() maps it to a display
  // label for the filter's own option text.
  trackerSportFilter: 'all',
  // First-of-month timestamp for whichever month the calendar view is
  // currently showing — defaults to the current month, navigable independent
  // of which tracker/sport is selected (switching tracker doesn't reset it).
  trackerCalendarMonth: (() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  })(),
  // Which day (YYYY-MM-DD) is expanded in the calendar view's detail panel,
  // if any — cleared whenever it clicks a day with no data left to show.
  trackerCalendarSelectedDate: null,
  // 'day' | 'week' | 'month' — the graph view's own time-bucket granularity.
  trackerGraphBucket: 'day',
  // Today's server-side tracked Top 5 pick ids (see worker/src/tracking.js),
  // Full Slate's live/final game state — eventId -> the raw /scores event
  // for it (has `completed` and `scores`). Refreshed at most once a minute
  // per sport-group (see refreshSlateScores) rather than on every render.
  slateScores: new Map(),
  slateScoresFetchedAt: new Map(), // group.id -> last fetch time, so switching leagues never gets throttled by an unrelated sport's recent fetch
  // The server's own Full Slate tracked pick per game (see
  // worker/src/full-slate-tracking.js) — eventId -> pick record. This is
  // the authoritative record of "what did the algorithm actually pick and
  // did it win," the same data the Tracking Dashboard's Full Slate tab
  // shows, so a finished game's card and its tracked history entry are
  // never two different answers. It also covers the gap live re-derivation
  // can't: the odds feed drops a game's prices the moment it's decided, so
  // a just-finished game often has no live candidate left to compute a pick
  // from at all — the tracked record survives that.
  slateTrackedPicks: new Map(),
  slateTrackedPicksFetchedAt: 0,
  // Full Slate's Upcoming/Live/Finished toggle — defaults to Upcoming each
  // fresh load rather than persisting, since "what's live right now" isn't
  // something you'd want stuck from a prior session.
  slateGameFilter: 'upcoming',
  // Last-known UFC/PFL card name per MMA eventId, captured while the fight
  // still has live odds (see buildSlateGames). A fight's market disappears
  // from the odds feed the instant it starts — not just once it's finished
  // — so without this, an in-progress fight that hasn't been graded yet
  // would forget which card it belongs to the moment it goes live. Never
  // cleared: a card name never changes once known, and this is keyed by
  // eventId so it can't collide across fights.
  mmaEventCache: new Map(),
  // Research caches. Both are free to fetch — ESPN and a static archive — so
  // they never touch the odds credit budget.
  tennis: new Map(),   // 'atp' | 'wta' -> parsed archive
  context: new Map(),  // eventId -> normalised ESPN bundle, or null when unmatched
  tennisAltSpreads: new Map(), // eventId -> raw alternate-spread event, or null when unfetched/unmatched
  // Pixel Picks' sharp standard: fixed, not user-adjustable. A pick outside
  // this range or below this grade can still appear (topPicks always hands
  // back 8), but flagged as outside the standard rather than silently shown
  // as a lock.
  oddsMin: CONFIG.ODDS_MIN_DEFAULT,
  oddsMax: CONFIG.ODDS_MAX_DEFAULT,
  minScore: CONFIG.MIN_SCORE_DEFAULT,
  // Bankroll and unit size. Persisted server-side (see loadSettings/
  // saveSettings) with this localStorage copy as the offline/unauthenticated
  // fallback, so it survives a cleared browser or a switch to another device.
  // Only used to turn a stake's %-of-bankroll figure into a dollar amount or
  // unit count. amount/unit of 0 means "unset"; unset amount falls back to
  // showing the plain percentage everywhere a stake is displayed. `confirmed`
  // gates that conversion on having actually pressed Submit — typing a number
  // into the field alone shouldn't start changing what every "why" panel
  // recommends.
  bankroll: loadJSON(BANKROLL_KEY, { amount: 0, unit: 0, displayMode: 'dollars', confirmed: false }),
  // Which league group the Full Slate tab is currently showing — one of
  // LEAGUE_GROUPS' ids, not a raw sport key. Re-validated on boot since a
  // saved value could predate this grouping scheme.
  slateLeague: (() => {
    const saved = loadJSON(SLATE_LEAGUE_KEY, null);
    return LEAGUE_GROUP_BY_ID.has(saved) ? saved : null;
  })(),
  // Which tournament/card within the current group is filtered to, or 'all'.
  // Not persisted — a saved event id is only meaningful for one specific
  // night's slate, not future sessions. Shared by MMA cards and tennis
  // tournaments, whichever group is active.
  slateEvent: 'all',
  // The last slate Pixel Picks generated, kept around so changing the sort
  // order just re-renders the same picks instead of re-rolling the board.
  lastPixelSlate: null,
  pixelSort: loadJSON(PIXEL_SORT_KEY, 'confidence'),
  // Track when odds were last refreshed (timestamp ms) to rate-limit refreshes
  slateRefreshTime: 0,
};

// A bankroll saved before `confirmed` existed had no opinion on it — treat an
// already-set amount from a returning user as already confirmed, rather than
// silently withholding dollar figures they'd already configured.
if (state.bankroll.confirmed === undefined) {
  state.bankroll.confirmed = state.bankroll.amount > 0;
}

/* ---------------------------------------------------------------- */
/* Storage                                                           */
/* ---------------------------------------------------------------- */

function loadJSON(key, fallback) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null');
    return raw ?? fallback;
  } catch {
    // Corrupt or unavailable storage shouldn't take the app down.
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private browsing / quota — preferences just won't persist. */
  }
}

/* ---------------------------------------------------------------- */
/* Auth                                                              */
/* ---------------------------------------------------------------- */

function getToken() {
  return localStorage.getItem('pp_auth_token');
}

function signOut() {
  if (!confirm('Are you sure you want to sign out?')) return;
  localStorage.removeItem('pp_auth_token');
  localStorage.removeItem('pp_auth_user');
  window.location.href = 'https://perpetualpicks.com/login.html';
}

/** Returns false when the page is being redirected to sign-in. Page access
 * always requires a token, independent of CONFIG.REQUIRE_AUTH (which only
 * gates the /odds worker endpoint, a separate concern). */
function checkAuth() {
  if (getToken()) return true;
  window.location.href = 'https://perpetualpicks.com/login.html';
  return false;
}

/* ---------------------------------------------------------------- */
/* Formatting                                                        */
/* ---------------------------------------------------------------- */

const dateFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit',
});

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric', minute: '2-digit',
});

function relativeTime(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/** Escape anything that came from the API before it touches innerHTML. */
function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ---------------------------------------------------------------- */
/* Filters                                                           */
/* ---------------------------------------------------------------- */

/**
 * The league catalogue, from the worker's /sports proxy. The Odds API bills
 * nothing for this, so populating the picker on page load is free — unlike the
 * odds themselves, which is the whole reason the picker exists.
 */
async function loadCatalogue() {
  if (!CONFIG.WORKER_URL) {
    // Demo mode: offer whatever leagues the bundled fixtures contain.
    state.catalogue = [...new Set(DEMO_EVENTS.map((e) => e.sport_key))].map((key) => ({
      key,
      title: DEMO_EVENTS.find((e) => e.sport_key === key)?.sport_title ?? key,
    }));
    populateTennisGroups();
    renderSlateLeagueOptions();
    return;
  }

  try {
    const response = await fetch(new URL('/sports', CONFIG.WORKER_URL), {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`sports catalogue returned ${response.status}`);
    const data = await response.json();
    state.catalogue = data.sports ?? [];
  } catch {
    // A missing catalogue shouldn't block the app — the fixed league groups
    // still render, just without tennis's dynamic tournament keys until the
    // catalogue comes back.
    state.catalogue = [];
  }
  populateTennisGroups();
  renderSlateLeagueOptions();
}

/* ---------------------------------------------------------------- */
/* Data                                                              */
/* ---------------------------------------------------------------- */

/**
 * Fetch every key in every league group and merge the results into
 * state.rawEvents/state.candidates (fetchSingleLeague dedupes by event id).
 * This is the app's one and only fetch orchestration now — Full Slate and
 * Pixel Picks both read from the same always-loaded pool rather
 * than each pulling their own subset, which is what used to make Pixel
 * Picks' Generate silently blow away whatever Full Slate had loaded.
 */
async function refreshAllLeagues() {
  if (!CONFIG.WORKER_URL) {
    state.rawEvents = DEMO_EVENTS;
    state.candidates = analyze(DEMO_EVENTS);
    state.isDemo = true;
    state.fetchedAt = Date.now();
    return;
  }

  populateTennisGroups();
  // offSeason groups (NBA/NCAAB placeholders — see LEAGUE_GROUPS) are
  // deliberately excluded here: no live fetch for either until someone
  // flips that flag off once the season actually starts.
  const allKeys = [...new Set(LEAGUE_GROUPS.filter((g) => !g.offSeason).flatMap((g) => g.keys))];
  const results = await Promise.allSettled(allKeys.map((key) => fetchSingleLeague(key)));
  const failed = results.filter((r) => r.status === 'rejected').length;

  state.isDemo = false;
  state.fetchedAt = Date.now();

  if (failed) {
    setStatus(`Loaded ${allKeys.length - failed}/${allKeys.length} leagues, some odds may be missing`, 'error');
  } else {
    setStatus(`${state.rawEvents.length} games loaded across ${allKeys.length} leagues`);
  }
}

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = `status ${kind}`;
}

/* ---------------------------------------------------------------- */
/* Rendering                                                         */
/* ---------------------------------------------------------------- */

/* ---------------------------------------------------------------- */
/* Research                                                          */
/* ---------------------------------------------------------------- */

// Legs in render order, so each rendered "why" list can be found again once its
// research resolves. Reset on every full render.
const renderedLegs = [];

/**
 * Tennis history archive for a tour. Static asset, built by
 * scripts/build-tennis-data.mjs — ESPN carries nothing usable for tennis.
 * The in-flight promise is cached so two tennis picks don't fetch it twice.
 */
function tennisArchive(sportKey) {
  const tour = /wta/i.test(sportKey) ? 'wta' : 'atp';
  if (!state.tennis.has(tour)) {
    state.tennis.set(
      tour,
      fetch(`data/tennis-${tour}.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    );
  }
  return state.tennis.get(tour);
}

/** ESPN-derived context for one fixture, via the worker. Free — no credits. */
function eventContext(leg) {
  if (!state.context.has(leg.eventId)) {
    if (!CONFIG.WORKER_URL) {
      state.context.set(leg.eventId, Promise.resolve(null));
    } else {
      const url = new URL('/context', CONFIG.WORKER_URL);
      url.searchParams.set('sport', leg.sportKey);
      url.searchParams.set('home', leg.home);
      url.searchParams.set('away', leg.away);
      state.context.set(
        leg.eventId,
        fetch(url, { headers: { Accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => d?.context ?? null)
          .catch(() => null),
      );
    }
  }
  return state.context.get(leg.eventId);
}

/**
 * National Weather Service forecast for one NFL/MLB venue at game time, via
 * the worker. Free — no odds credits — and null for every other sport, a
 * domed venue, an unlisted venue, or a game further out than NWS forecasts
 * reach, same "nothing to say, not an error" contract as eventContext.
 */
function weatherFor(leg) {
  const key = `weather:${leg.eventId}`;
  if (!state.context.has(key)) {
    if (!CONFIG.WORKER_URL) {
      state.context.set(key, Promise.resolve(null));
    } else {
      const url = new URL('/weather', CONFIG.WORKER_URL);
      url.searchParams.set('sport', leg.sportKey);
      url.searchParams.set('home', leg.home);
      url.searchParams.set('commenceMs', String(leg.commenceMs));
      state.context.set(
        key,
        fetch(url, { headers: { Accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => d?.weather ?? null)
          .catch(() => null),
      );
    }
  }
  return state.context.get(key);
}

/**
 * ESPN/Sherdog-derived fighter research for one MMA matchup, via the
 * worker. Free — no odds credits — and cached by event id in
 * state.context, so calling this again for a game already fetched (or
 * still in flight) is a no-op that just returns the same promise —
 * exactly what lets prefetchMmaContext below kick these off ahead of any
 * click with no risk of double-fetching once the user actually opens one.
 */
function mmaContextFor(leg) {
  const key = `mma:${leg.eventId}`;
  if (!state.context.has(key)) {
    if (!CONFIG.WORKER_URL) {
      state.context.set(key, Promise.resolve(null));
    } else {
      const url = new URL('/mma-context', CONFIG.WORKER_URL);
      url.searchParams.set('a', leg.home);
      url.searchParams.set('b', leg.away);
      state.context.set(
        key,
        fetch(url, { headers: { Accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => d?.context ?? null)
          .catch(() => null),
      );
    }
  }
  return state.context.get(key);
}

/**
 * Kicks off mmaContextFor AND matchupAnalysisFor for every MMA game
 * currently on the board, in the background, well before any user clicks
 * "More Info" — the whole point is that by the time they do, both fetches
 * (or their now-cached results) are already sitting in state.context, so
 * the drawer opens instantly instead of waiting on a multi-second live
 * Sherdog/ESPN research fetch plus a separate AI-written analysis call.
 * The analysis call is the slower of the two in practice (confirmed live:
 * a cold open-to-painted-content time over 6 seconds, dominated by this,
 * not the research fetch alone) — prefetching only mmaContextFor and
 * leaving this one out would have missed most of the actual wait. Uses
 * bestCandidateForGame, the exact same candidate a real "More Info" click
 * resolves to (see slateGameHtml's click handler), so the prefetched
 * analysis cache key always matches what gets requested for real. Called
 * from renderFullSlate whenever the MMA tab is showing.
 *
 * Deliberately throttled rather than firing all of them at once — a card
 * can have 50+ fights, and a burst of 100+ simultaneous requests (two per
 * fight) hits the worker (and Sherdog/ESPN/Anthropic behind it) all in the
 * same instant for no real benefit over spreading them out a little;
 * nobody clicks "More Info" faster than a small pool of requests can
 * drain. Both target functions' own state.context cache means calling this
 * again after a filter/sort change or a periodic re-render (see
 * renderFullSlate's own refreshSlateScores callback) never re-fetches a
 * game already fetched or in flight.
 */
const MMA_PREFETCH_CONCURRENCY = 4;
function prefetchMmaContext(games) {
  const queue = [...games];
  const worker = async () => {
    while (queue.length) {
      const game = queue.shift();
      const best = bestCandidateForGame(game);
      await Promise.all([
        mmaContextFor(game),
        best ? matchupAnalysisFor(best) : Promise.resolve(),
      ]);
    }
  };
  for (let i = 0; i < MMA_PREFETCH_CONCURRENCY; i++) worker();
}

/**
 * The AI-written matchup analysis for one game, via the worker — one per
 * game per ET calendar day, cached there, shared across every market/leg on
 * that event (see worker/src/analysis.js). Null whenever the feature isn't
 * available for any reason (no ANTHROPIC_API_KEY configured, no research
 * context for this event, or the model call itself failed) — the caller
 * falls back to the existing quantitative price case in that case, never
 * shows a broken section.
 */
function matchupAnalysisFor(leg) {
  // Keyed per pick (eventId + outcomeName), not just per game — the model
  // now writes its case around a specific given pick (see
  // worker/src/analysis.js), so a game's h2h favorite and its underdog
  // can't share one cached write-up written for the other side.
  const key = `analysis:${leg.eventId}:${leg.outcomeName}`;
  if (!state.context.has(key)) {
    if (!CONFIG.WORKER_URL) {
      state.context.set(key, Promise.resolve(null));
    } else {
      const url = new URL('/analysis', CONFIG.WORKER_URL);
      url.searchParams.set('eventId', leg.eventId);
      url.searchParams.set('sportKey', leg.sportKey);
      url.searchParams.set('sportTitle', leg.sportTitle ?? leg.sportKey);
      url.searchParams.set('home', leg.home);
      url.searchParams.set('away', leg.away);
      url.searchParams.set('outcomeName', leg.outcomeName);
      state.context.set(
        key,
        fetch(url, { headers: { Accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => d?.analysis ?? null)
          .catch(() => null),
      );
    }
  }
  return state.context.get(key);
}

// buildInsights() returns bullets tagged { tier, text } for callers that want
// to group them (Play of the Day's tiered write-up); the compact card just
// wants the flat text list it's always shown, tier stripped.
async function insightsFor(leg) {
  if (isTennis(leg.sportKey)) {
    return insightTexts(buildInsights(leg, { tennisData: await tennisArchive(leg.sportKey) }));
  }
  if (isMma(leg.sportKey)) {
    return insightTexts(buildInsights(leg, { mmaContext: await mmaContextFor(leg) }));
  }
  const [context, weather] = await Promise.all([eventContext(leg), weatherFor(leg)]);
  return insightTexts(buildInsights(leg, { context, weather }));
}

/**
 * Fill in the research bullets once they arrive. Runs after the cards are
 * already on screen: the price bullet is available immediately and the rest
 * appears when the lookups land, so a slow ESPN call never delays a pick.
 */
async function hydrateInsights(container = el.picks) {
  await Promise.all(
    renderedLegs.map(async (leg, slot) => {
      const list = container.querySelector(`[data-insights="${slot}"]`);
      if (!list) return;

      let lines = [];
      try {
        lines = await insightsFor(leg);
      } catch {
        /* Research is a bonus; the price bullet stands on its own. */
      }

      list.querySelector('.why-pending')?.remove();
      if (lines.length) {
        list.insertAdjacentHTML(
          'beforeend',
          lines.map((line) => `<li>${esc(line)}</li>`).join(''),
        );
      }
    }),
  );
}

/**
 * Suggested stake as a %-of-bankroll string, or null when there's no real
 * edge to size — quarter-Kelly against the pick's own no-vig consensus,
 * capped (see engine.js's KELLY.MAX_STAKE) against one bet ever eating too
 * much of a bankroll regardless of what the raw formula says.
 */
/** The recommended unit size — 2% of bankroll — used whenever the user
 * hasn't set their own. Returns 0 when there's no bankroll to base it on. */
function recommendedUnit() {
  return state.bankroll.amount > 0 ? state.bankroll.amount * RECOMMENDED_UNIT_PCT : 0;
}

/** The unit size actually in effect: the user's own if they've set one,
 * otherwise the recommendation. */
function effectiveUnit() {
  return state.bankroll.unit > 0 ? state.bankroll.unit : recommendedUnit();
}

/**
 * A stake fraction (0–1) as display text, or a { needsBankroll: true }
 * marker when there's no bankroll to size against. A raw "X% of bankroll"
 * figure with no bankroll amount behind it is nearly meaningless (it read
 * as a flat "0.0%" for most real edges, since the underlying dollar/percent
 * split only makes sense once there's an actual number to split) — the
 * marker lets callers render a direct path to fixing that (see
 * stakeLineHtml) instead of a confusing near-zero percentage. Once a
 * bankroll is set and confirmed, this converts to a real dollar amount or,
 * if a unit size is also available (set or recommended), a unit count in
 * the user's chosen display mode.
 */
function formatStakeLine(stake) {
  if (stake <= 0) return null;

  // A dollar/unit figure only appears once the user has actually pressed
  // Submit on the Bankroll panel — typing a number into the field shouldn't,
  // by itself, start changing what every "why" panel recommends betting.
  if (!(state.bankroll.amount > 0) || !state.bankroll.confirmed) {
    return { needsBankroll: true };
  }

  const pct = `${(stake * 100).toFixed(1)}%`;
  const dollars = state.bankroll.amount * stake;
  const unit = effectiveUnit();
  const dollarsText = `$${dollars.toFixed(2)}`;
  const unitsText = unit > 0 ? `${(dollars / unit).toFixed(2)}u` : null;

  const primary = state.bankroll.displayMode === 'units' && unitsText ? unitsText : dollarsText;
  return { needsBankroll: false, text: `Suggested stake: ${primary} (${pct} · ¼-Kelly)` };
}

/**
 * The one place every "why"/pick card turns a stake fraction into markup —
 * a plain escaped stake line once a bankroll is set, or a clickable
 * "Bankroll not set" button before that (opens the Bankroll panel directly
 * via setBankrollOpen — see the delegated click listener on document.body)
 * instead of a bare, confusing percentage with nothing to be a percent of.
 */
function stakeLineHtml(stake, className = 'stake-line') {
  const result = formatStakeLine(stake);
  if (!result) return '';
  if (result.needsBankroll) {
    return `<div class="${className}"><button type="button" class="stake-bankroll-cta" data-bankroll-cta>Bankroll not set</button></div>`;
  }
  return `<div class="${className}">${esc(result.text)}</div>`;
}

function stakeLine(pick) {
  const stake = suggestedParlayStake(pick.legs, americanToDecimal(pick.american));
  return stakeLineHtml(stake);
}

/** Same stake line, for a single raw candidate rather than an assembled pick. */
function singleStakeLine(candidate) {
  return stakeLineHtml(suggestedStake(candidate));
}

function renderConfidence(pick) {
  const color = confidenceColor(pick.score, state.minScore);
  const stake = stakeLine(pick);
  // percentile is only meaningful against the live pool topPicks() itself
  // ranked against — Pixel's Picks is a locked, server-
  // picked set with no "board" of its own left to compare against by the
  // time it's rendered, so this line is omitted rather than showing a
  // meaningless "beats 0%".
  const beatsLine = pick.percentile != null
    ? `<span>Beats ${Math.round(pick.percentile)}% of the board</span>`
    : '';

  return `
    <div class="confidence" style="--conf:${color}">
      <div class="conf-track">
        <span class="conf-fill" style="width:${Math.round(pick.score)}%"></span>
      </div>
      <div class="conf-label">
        <span>Confidence <span class="conf-score">${Math.round(pick.score)}</span>/100</span>
        ${beatsLine}
      </div>
      ${stake}
    </div>`;
}

/**
 * One button per registered sportsbook. A book with no quote on this exact
 * line is rendered but disabled — knowing FanDuel isn't offering it is
 * information.
 */
function renderBooks(leg) {
  const offers = bookOffers(leg);

  const buttons = Object.keys(SPORTSBOOKS)
    .map((id) => {
      const meta = SPORTSBOOKS[id];
      const offer = offers.get(id);

      if (!offer) {
        return `
          <span class="book-btn is-off" aria-disabled="true"
                title="${esc(meta.name)} isn't pricing this line">
            <span>${esc(meta.name)}</span>
            <span class="book-price">—</span>
          </span>`;
      }

      // Deep links only exist on The Odds API's paid tiers; otherwise this is
      // the book's front door and the user finds the line themselves.
      const href = offer.link ?? meta.url;
      const best = offer.american === leg.american;

      return `
        <a class="book-btn" style="--book:${esc(meta.color)}"
           href="${esc(href)}" target="_blank" rel="noopener">
          <span>${esc(meta.name)}</span>
          <span class="book-price">${esc(formatAmerican(offer.american))}</span>
          ${best ? '<span class="book-best">best</span>' : ''}
        </a>`;
    })
    .join('');

  return `<div class="books">${buttons}</div>`;
}

function renderLeg(leg, index, isCombo) {
  const whyId = `why-${leg.id.replace(/[^a-z0-9]/gi, '')}-${index}`;
  const detailId = `detail-${leg.id.replace(/[^a-z0-9]/gi, '')}-${index}`;
  const items = explain(leg).map((line) => `<li>${esc(line)}</li>`).join('');
  // Legs are numbered as they render so hydrateInsights can find each list
  // without having to escape bet ids into a CSS selector.
  const slot = renderedLegs.push(leg) - 1;

  return `
    <div class="leg">
      ${isCombo ? `<p class="chip">Leg ${index + 1}</p>` : ''}

      <button type="button" class="leg-banner" aria-expanded="false" aria-controls="${detailId}">
        <span class="leg-banner-text">
          <p class="leg-selection">${esc(leg.selection)}</p>
          <p class="leg-matchup">${esc(leg.away)} @ ${esc(leg.home)} · ${esc(leg.marketLabel)}</p>
        </span>
        <span class="leg-banner-chevron" aria-hidden="true"></span>
      </button>

      <div class="leg-detail" id="${detailId}" hidden>
        <dl class="meta">
          <div>
            <dt>When</dt>
            <dd>${esc(dateFmt.format(new Date(leg.commenceMs)))}</dd>
          </div>
          <div>
            <dt>Where</dt>
            <dd>Home: ${esc(leg.home)}</dd>
          </div>
          <div>
            <dt>Odds</dt>
            <dd><span class="book">${esc(formatAmerican(leg.american))}</span>
                at ${esc(leg.book)}</dd>
          </div>
          <div>
            <dt>Line seen</dt>
            <dd>${esc(relativeTime(leg.updatedMs))}</dd>
          </div>
        </dl>

        <div class="leg-foot">
          <button class="why-btn" aria-expanded="false" aria-controls="${whyId}"
                  aria-label="Why this pick is sharp">?</button>
          <span class="grade">fair ${esc(formatAmerican(leg.fairAmerican))} ·
            ${leg.bookCount} books</span>
          <button class="stats-btn" data-more-stats="${slot}" type="button">More Stats</button>
        </div>

        <div class="why" id="${whyId}" hidden>
          <h4>Why this is sharp</h4>
          <ul data-insights="${slot}">
            ${items}
            <li class="why-pending">Pulling form, head-to-head and injuries…</li>
          </ul>
        </div>

        ${renderBooks(leg)}
      </div>
    </div>`;
}

function renderPick(pick) {
  if (pick.degraded) return renderDegradedPick(pick);

  const isCombo = pick.type === 'combo';
  const lead = pick.legs[0];
  const sport = lead.sportTitle ?? lead.sportKey;
  const flagged = pick.meetsStandard === false;

  return `
    <article class="pick ${flagged ? 'is-outside-standard' : ''}">
      <div class="pick-head">
        <span class="pick-head-left">
          <span class="chip"><strong>${esc(sport)}</strong> ·
            ${isCombo ? '2-leg combo' : 'Straight bet'}</span>
        </span>
        <span class="price">${esc(formatAmerican(pick.american))}</span>
      </div>

      ${flagged ? `<div class="pick-flag">⚠ Outside standard criteria: ${esc(pick.flagReason)}</div>` : ''}

      ${renderConfidence(pick)}

      ${isCombo ? `<p class="pair-note">${esc(pick.pairReason)}</p>` : ''}

      ${pick.legs.map((leg, i) => renderLeg(leg, i, isCombo)).join('')}
    </article>`;
}

/**
 * A locked Pixel's Picks pick whose game has already started or finished
 * (or whose market otherwise fell off the live board) — no live candidate
 * left to match by id, so there's no fresh book table or "why" panel to
 * show. Renders from the stored tracked record alone: selection, price at
 * lock time, and result status. Mirrors Full Slate's own finished-game
 * treatment (score/result shown, no live market grid) rather than inventing
 * a new visual language.
 */
function renderDegradedPick(pick) {
  const record = pick.record;
  const flagged = pick.meetsStandard === false;
  const resultClass = record.status === 'won' ? 'win' : record.status === 'lost' ? 'loss' : '';
  const statusLabel = record.status === 'won' ? 'Won'
    : record.status === 'lost' ? 'Lost'
    : record.commenceMs <= Date.now() ? 'Live / Final' : 'Locked';

  return `
    <article class="pick ${flagged ? 'is-outside-standard' : ''}">
      <div class="pick-head">
        <span class="pick-head-left">
          <span class="chip"><strong>Straight bet</strong></span>
        </span>
        <span class="price">${esc(formatAmerican(pick.american))}</span>
      </div>

      ${flagged ? `<div class="pick-flag">⚠ Outside standard criteria: ${esc(record.flagReason)}</div>` : ''}

      <div class="confidence" style="--conf:${confidenceColor(pick.score, state.minScore)}">
        <div class="conf-track"><span class="conf-fill" style="width:${Math.round(pick.score)}%"></span></div>
        <div class="conf-label"><span>Confidence <span class="conf-score">${Math.round(pick.score)}</span>/100</span></div>
      </div>

      <p class="leg-selection">${esc(record.selection)}</p>
      <p class="leg-matchup">${esc(record.away)} @ ${esc(record.home)} ·
        <span class="schedule-result ${resultClass}">${esc(statusLabel)}</span></p>
    </article>`;
}

function renderSlate(slate) {
  renderedLegs.length = 0;

  if (!slate.picks.length) {
    el.picks.innerHTML = `<p class="empty">No locks clear the sharp standard right
      now, check back closer to game time, or see everything on Full Slate.</p>`;
    return;
  }
  el.picks.innerHTML = slate.picks.map(renderPick).join('');
  hydrateInsights();
}

/**
 * Shared side-panel open/close for Bankroll and Guide — they slide from the
 * same edge and share one scrim, so only one can be open at a time. Opening
 * one closes whichever else was open rather than stacking.
 */
let openAside = null; // { panel, toggle } or null

function setAsideOpen(panel, toggle, open, { onOpen, focusEl, scrim = true } = {}) {
  if (open && openAside && openAside.panel !== panel) {
    openAside.panel.hidden = true;
    openAside.toggle.setAttribute('aria-expanded', 'false');
  }
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  // The scrim is a full-viewport overlay (position: fixed, inset: 0), not
  // just a backdrop behind the panel's own width — with it shown, it sits
  // above the rest of the page at a higher z-index than everything except
  // the panel itself, silently swallowing clicks anywhere on screen. Fine
  // for a true modal (Bankroll/Guide/About/Tracking), wrong for the More
  // Stats drawer: clicking a different Full Slate market cell while the
  // drawer is already open is the expected way to browse it, not a mistake
  // to block. scrim: false (passed by setStatsDrawerOpen) keeps the rest of
  // the page fully clickable while that drawer is open.
  el.scrim.hidden = !(open && scrim);
  openAside = open ? { panel, toggle } : null;
  if (open) {
    onOpen?.();
    focusEl?.focus();
  }
}

function setBankrollOpen(open) {
  setAsideOpen(el.bankrollPanel, el.bankrollToggle, open, {
    onOpen: renderBankrollPanel,
    focusEl: el.bankrollClose,
  });
}

function setGuideOpen(open) {
  setAsideOpen(el.guidePanel, el.guideToggle, open, { focusEl: el.guideClose });
}

const aboutBuildFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

function renderAboutPanel() {
  let when = 'unknown';
  if (BUILD_INFO.builtAt) {
    const built = new Date(BUILD_INFO.builtAt);
    if (!Number.isNaN(built.getTime())) {
      // Format in America/New_York timezone (EDT in summer, EST in winter)
      const estTime = new Date(built.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const parts = new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/New_York',
      }).formatToParts(built);

      const formatted = parts.map(p => p.value).join('');
      const tz = built.toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).split(' ').pop();
      when = `${formatted} ${tz}`;
    }
  }
  el.aboutVersion.textContent = `Version ${BUILD_INFO.version} · ${when}`;
  el.aboutVersion.title = `commit ${BUILD_INFO.commit}`;
}

function setAboutOpen(open) {
  setAsideOpen(el.aboutPanel, el.aboutToggle, open, { onOpen: renderAboutPanel, focusEl: el.aboutClose });
}

/* ---------------------------------------------------------------- */
/* More Stats drawer                                                 */
/* ---------------------------------------------------------------- */

// setAsideOpen expects one fixed toggle button to sync aria-expanded with;
// the stats drawer is opened from a different button on every leg rendered,
// so there's no single element that relationship applies to. A no-op stand-in
// keeps this drawer in the same "one aside open at a time, shared scrim"
// system as History/Bankroll/Guide without touching any real button's ARIA
// state incorrectly.
const statsDrawerToggleStub = { setAttribute() {} };

function setStatsDrawerOpen(open) {
  setAsideOpen(el.statsDrawer, statsDrawerToggleStub, open, { focusEl: el.statsDrawerClose, scrim: false });
}

/** Every book's price on this exact line, sorted best to worst, with the
 * implied probability that price carries — the same quotes already backing
 * the book buttons on the compact card, just as a full table instead of a
 * greyed-out/highlighted row of pills. */
function renderPriceTable(leg) {
  if (!leg.quotes?.length) return '';
  const sorted = [...leg.quotes].sort((a, b) => b.decimal - a.decimal);
  const rows = sorted.map((q, i) => {
    // Only books in the SPORTSBOOKS registry get a homepage link — an
    // unlisted book (one The Odds API prices but this app doesn't have a
    // registry entry for) still shows its price, just as plain text.
    const registryUrl = SPORTSBOOKS[bookIdFor(q.bookKey)]?.url;
    const bookCell = registryUrl
      ? `<a href="${esc(registryUrl)}" target="_blank" rel="noopener noreferrer">${esc(q.book)}</a>`
      : esc(q.book);
    return `
    <tr class="${i === 0 ? 'is-best' : ''}">
      <td>${bookCell}</td>
      <td>${esc(formatAmerican(q.american))}</td>
      <td>${(impliedProb(q.american) * 100).toFixed(1)}%</td>
    </tr>`;
  }).join('');

  return `
    <div class="stats-section">
      <h3>Every Book on This Line</h3>
      <div class="stats-table-scroll">
        <table class="stats-table">
          <thead><tr><th>Book</th><th>Price</th><th>Implied</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

/** Small stat pills for whatever weather fields are actually present — never
 * a fabricated placeholder for the fields that aren't (see weatherFor()). */
function renderWeatherPills(weather) {
  if (!weather) return '';
  const pills = [];
  if (weather.temperatureF != null) pills.push(`${weather.temperatureF}°F`);
  if (weather.shortForecast) pills.push(weather.shortForecast);
  if (weather.windSpeed) {
    pills.push(`Wind ${weather.windSpeed}${weather.windDirection ? ` ${weather.windDirection}` : ''}`);
  }
  if (weather.precipChance != null) pills.push(`${weather.precipChance}% precip`);
  if (!pills.length && weather.roof !== 'retractable') return '';

  const chips = pills.map((p) => `<span class="stat-pill">${esc(p)}</span>`).join('');
  const roofPill = weather.roof === 'retractable'
    ? `<span class="stat-pill is-warn">Retractable roof, status unknown</span>`
    : '';
  return `<div class="stats-pills">${chips}${roofPill}</div>`;
}

/** The tiered research bullets (same tags Play of the Day groups by),
 * presented as separate labelled sections instead of one flat list. */
function renderStatsResearch(bullets) {
  const personnel = insightsByTier(bullets, 'personnel');
  const supporting = insightsByTier(bullets, 'supporting');
  const environmental = [
    ...insightsByTier(bullets, 'environmental'),
    ...insightsByTier(bullets, 'situational'),
  ];

  const section = (title, items) => (items.length ? `
    <div class="stats-section">
      <h3>${esc(title)}</h3>
      <ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    </div>` : '');

  return [
    section('Primary Personnel & Direct Matchup', personnel),
    section('Supporting Cast & Availability', supporting),
    section('Environmental & Situational Notes', environmental),
  ].join('');
}

/** Physical-attribute pills for one fighter, from Sherdog's bio box — only
 * the fields that actually parsed; reach and stance are frequently absent
 * on Sherdog and are simply not shown rather than guessed at. */
function renderMmaBio(fighter) {
  const b = fighter?.bio;
  const ufcB = fighter?.ufc?.bio;
  if (!b && !ufcB) return '';
  const parts = [];
  if (b?.age != null) parts.push(`${b.age} yrs`);
  else if (ufcB?.age) parts.push(`${ufcB.age} yrs`);
  if (b?.height) parts.push(b.height);
  if (b?.weight) parts.push(b.weight);
  if (b?.reach) parts.push(`${b.reach} reach`);
  if (b?.stance) parts.push(b.stance);
  if (b?.weightClass) parts.push(b.weightClass);
  // ufc.com fields only fill gaps Sherdog's own bio left — never override a
  // Sherdog value that's already there, just cover what's missing.
  if (!b?.reach && ufcB?.reach) parts.push(`${ufcB.reach}" reach (UFC.com)`);
  if (ufcB?.trainsAt && !b?.association) parts.push(ufcB.trainsAt);
  return parts.length ? `<div class="stats-pills">${parts.map((p) => `<span class="stat-pill">${esc(p)}</span>`).join('')}</div>` : '';
}

const MMA_STREAK_LABEL = { win: 'Win', loss: 'Loss', draw: 'Draw', nc: 'NC' };

function mmaDetailRow(label, value) {
  return `<div class="learning-table-row mma-detail-row"><div class="label">${esc(label)}</div><div class="stat">${esc(value)}</div></div>`;
}

/**
 * Nickname, current streak, nationality, and location, from Sherdog's own
 * profile header (worker/src/mma.js). Sherdog carries exactly one location
 * field per fighter, not a separate birthplace-vs-training-camp split, so
 * it's labeled "Based In" here rather than asserting a distinction the
 * source data doesn't actually make.
 */
function renderMmaFighterDetails(fighter) {
  if (!fighter) return '';
  const rows = [];
  if (fighter.nickname) rows.push(mmaDetailRow('Nickname', `"${fighter.nickname}"`));
  if (fighter.record) {
    const r = fighter.record;
    rows.push(mmaDetailRow('Pro MMA Record', `${r.wins}-${r.losses}${r.draws ? `-${r.draws}` : ''}`));
  }
  if (fighter.streak) {
    const label = MMA_STREAK_LABEL[fighter.streak.result] ?? fighter.streak.result;
    rows.push(mmaDetailRow('Current Streak', `${fighter.streak.count} ${label}${fighter.streak.count === 1 ? '' : 's'}`));
  }
  if (fighter.nationality) rows.push(mmaDetailRow('Nationality', fighter.nationality));
  if (fighter.location) rows.push(mmaDetailRow('Based In', fighter.location));
  if (!rows.length) return '';
  return `<p class="stats-fighter-label">${esc(fighter.name)}</p><div class="learning-table">${rows.join('')}</div>`;
}

// How many of a fighter's most recent fights get an opponent's
// record-at-the-time shown — matches worker/src/mma.js's own
// OPPONENT_RECORD_LOOKBACK; fights beyond this still show in the table,
// just without that one column filled in, since fetching a whole career's
// worth of opponent profiles isn't worth the extra cost for older fights.
const MMA_OPPONENT_RECORD_LOOKBACK = 10;

/**
 * Full professional bout history — every completed fight Sherdog has on
 * file, opponent, opponent's OWN record as of that specific fight (not
 * their current record, which would misrepresent an old win over a then-green
 * prospect who's since built a long career), method, event, and date.
 */
function renderMmaProfessionalBouts(fighter) {
  if (!fighter?.history?.length) return '';
  const rows = fighter.history.map((f) => {
    const badge = { win: 'W', loss: 'L', draw: 'D', nc: 'NC' }[f.result] ?? '?';
    const badgeClass = f.result === 'win' ? 'is-win' : f.result === 'loss' ? 'is-loss' : '';
    const oppRecord = f.opponentRecordAtTime
      ? `${f.opponentRecordAtTime.wins}-${f.opponentRecordAtTime.losses}${f.opponentRecordAtTime.draws ? `-${f.opponentRecordAtTime.draws}` : ''}`
      : '—';
    return `
      <tr>
        <td><span class="form-badge ${badgeClass}">${esc(badge)}</span></td>
        <td>${esc(f.opponent ?? '—')}</td>
        <td>${esc(oppRecord)}</td>
        <td>${esc(f.method ?? '—')}</td>
        <td>${esc(f.event ?? '—')}</td>
        <td>${esc(f.date ?? '—')}</td>
      </tr>`;
  }).join('');

  return `
    <p class="stats-fighter-label">${esc(fighter.name)}</p>
    <div class="stats-table-scroll">
      <table class="stats-table">
        <thead><tr><th></th><th>Opponent</th><th>Opp. Record*</th><th>Method</th><th>Event</th><th>Date</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="stats-source-note">*Opponent's record as of that fight, shown for the most recent ${MMA_OPPONENT_RECORD_LOOKBACK} bouts.</p>`;
}

/* ------------------------------------------------------------------ */
/* Tennis breakdown                                                     */
/* ------------------------------------------------------------------ */

// The archive plus both player names for whichever tennis drawer is
// currently open — read by the surface-filter click handler below, since
// clicking a filter re-renders just the filter body, not the whole drawer.
let tennisBreakdownState = null;

function tennisFormTable(form) {
  if (!form.length) return `<p class="empty-inline">No matches for this filter.</p>`;
  const rows = form.map((m) => `
    <tr>
      <td>${esc(m.dateLabel)}</td>
      <td>${esc(m.opponent ?? '—')}</td>
      <td>${esc(m.round ?? '—')}</td>
      <td>${esc(m.surface ?? '—')}${m.retired ? ' <span class="stat-pill is-warn">ret.</span>' : ''}</td>
      <td><span class="form-badge ${m.result === 'W' ? 'is-win' : 'is-loss'}">${m.result}</span></td>
    </tr>`).join('');
  return `
    <div class="stats-table-scroll">
      <table class="stats-table">
        <thead><tr><th>Date</th><th>Opponent</th><th>Round</th><th>Surface</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function tennisH2hTable(h2h) {
  if (!h2h) return '';
  if (!h2h.meetings.length) return `<p class="empty-inline">No meetings between these two on this filter.</p>`;
  const rows = h2h.meetings.map((m) => `
    <tr>
      <td>${esc(m.dateLabel)}</td>
      <td>${esc(m.round ?? '—')}</td>
      <td>${esc(m.surface ?? '—')}</td>
      <td>${esc(m.winner)}</td>
    </tr>`).join('');
  return `
    <p class="stats-fighter-label">${esc(h2h.aName)} ${h2h.aWins} – ${h2h.bWins} ${esc(h2h.bName)}</p>
    <div class="stats-table-scroll">
      <table class="stats-table">
        <thead><tr><th>Date</th><th>Round</th><th>Surface</th><th>Winner</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderTennisFilterBody(filter) {
  const { data, away, home } = tennisBreakdownState;
  const formAway = tennisRecentForm(data, away, { filter, limit: 8 });
  const formHome = tennisRecentForm(data, home, { filter, limit: 8 });
  const h2h = tennisHeadToHead(data, away, home, { filter });

  const formHtml = [
    formAway.length ? `<p class="stats-fighter-label">${esc(away)}: Recent Form</p>${tennisFormTable(formAway)}` : '',
    formHome.length ? `<p class="stats-fighter-label">${esc(home)}: Recent Form</p>${tennisFormTable(formHome)}` : '',
  ].filter(Boolean).join('');

  if (!formHtml && !h2h?.meetings.length) {
    return `<p class="empty-inline">No archived matches for either player on this filter.</p>`;
  }

  return `
    ${formHtml}
    <p class="stats-fighter-label">Head-to-Head</p>
    ${tennisH2hTable(h2h)}`;
}

/**
 * Recent form and head-to-head, filterable by surface — built entirely from
 * the tennis-data.co.uk archive already bundled with this app (no live
 * fetch, no new source). Surface filter options are generated from what this
 * specific archive actually contains (see tennisSurfaceFilters), so a tour
 * with no indoor hard-court events simply doesn't offer that button rather
 * than offering one that always comes back empty.
 */
function renderTennisBreakdown(data, away, home) {
  if (!data?.matches?.length) return '';
  tennisBreakdownState = { data, away, home };

  const filters = tennisSurfaceFilters(data);
  const filterButtons = filters.map((f, i) => `
    <button type="button" class="surface-btn ${i === 0 ? 'is-active' : ''}" data-surface-key="${esc(f.key)}">${esc(f.label)}</button>`).join('');

  return `
    <div class="stats-section tennis-breakdown">
      <h3>Recent Form &amp; Head-to-Head <span class="stats-source">via tennis-data.co.uk</span></h3>
      <div class="surface-filters">${filterButtons}</div>
      <div id="tennisFilterBody">${renderTennisFilterBody(filters[0])}</div>
    </div>`;
}

/**
 * Head-to-head fighter photos — ufc.com's official photo first (sharper,
 * more current) when the fighter has a UFC.com profile, Sherdog's own photo
 * otherwise. A fighter with neither just gets an initial in a plain circle —
 * never a stock/placeholder image standing in for a real one.
 */
function renderMmaPhotos(me, opponent) {
  const initials = (name) => esc((name ?? '?').trim().charAt(0).toUpperCase());
  const photoOf = (fighter) => fighter?.ufc?.photo ?? fighter?.photo ?? null;
  // mma-photo-a/-b carry the same red/blue fighter-A/fighter-B convention
  // every compareRow-based section below uses, so the photo border and name
  // color are the one visual key the whole drawer's color-coding hangs off.
  const side = (fighter, sideClass) => fighter ? `
    <div class="mma-photo-side ${sideClass}">
      <div class="mma-badge-slot">${isUfcDebut(fighter) ? `<span class="mma-ufc-debut-badge">UFC Debut</span>` : ''}</div>
      ${photoOf(fighter)
        ? `<img class="mma-photo" src="${esc(photoOf(fighter))}" alt="${esc(fighter.name)}" loading="lazy"
             onerror="this.outerHTML='<span class=&quot;mma-photo mma-photo-fallback&quot;>${initials(fighter.name)}</span>'">`
        : `<span class="mma-photo mma-photo-fallback">${initials(fighter.name)}</span>`}
      <p class="mma-photo-name">${esc(fighter.name)}</p>
    </div>` : '';

  if (!photoOf(me) && !photoOf(opponent)) return '';
  return `
    <div class="mma-photo-row">
      ${side(me, 'mma-photo-a')}
      ${opponent ? '<span class="mma-photo-vs">VS</span>' : ''}
      ${side(opponent, 'mma-photo-b')}
    </div>`;
}

/**
 * Overall record plus a last-five-fights strip — five small circles, newest
 * first, green "W" for a win and red "L" for a loss (amber for a draw/no
 * contest, since those aren't "W or L" either). Renders under the fighter
 * photos whether or not a photo actually loaded for either side, since the
 * record itself comes from Sherdog (worker/src/mma.js) independently of
 * whether either fighter has a photo on file.
 */
function lastFiveCircles(history) {
  const RESULT = {
    win: { label: 'W', cls: 'is-win' },
    loss: { label: 'L', cls: 'is-loss' },
    draw: { label: 'D', cls: 'is-draw' },
    nc: { label: 'NC', cls: 'is-draw' },
  };
  const recent = (history ?? []).slice(0, 5);
  if (!recent.length) return '';
  return recent
    .map((f) => {
      const r = RESULT[f.result] ?? { label: '?', cls: 'is-draw' };
      return `<span class="mma-form-circle ${r.cls}" title="${esc(f.opponent ? `vs ${f.opponent}` : '')}">${r.label}</span>`;
    })
    .join('');
}

function renderMmaRecordStrip(fighter) {
  if (!fighter) return '';
  const r = fighter.record;
  const recordStr = r ? `${r.wins}-${r.losses}${r.draws ? `-${r.draws}` : ''}` : null;
  const circles = lastFiveCircles(fighter.history);
  if (!recordStr && !circles) return '';
  return `
    <div class="mma-record-strip">
      <p class="mma-record-name">${esc(fighter.name)}</p>
      ${recordStr ? `<p class="mma-record-overall">${esc(recordStr)} <span class="mma-record-caption">overall</span></p>` : ''}
      ${circles ? `<div class="mma-form-circles">${circles}<span class="mma-record-caption">last 5</span></div>` : ''}
    </div>`;
}

/**
 * The UFC.com-style tabbed matchup comparison — Matchup Stats / Win By /
 * Significant Strikes / Grappling, each fighter's number on its own side of
 * a shared label, matching the layout of ufc.com's own pre-fight comparison
 * widget. Needs both fighters resolved (a comparison against nobody isn't
 * one); a side missing a given stat shows "—" rather than a guessed value,
 * same honesty policy as the rest of this drawer.
 */
function compareSplit(aVal, bVal) {
  const a = typeof aVal === 'number' ? aVal : 0;
  const b = typeof bVal === 'number' ? bVal : 0;
  const total = a + b;
  if (total <= 0) return [0, 0];
  return [Math.round((a / total) * 100), Math.round((b / total) * 100)];
}

function compareRow(label, aVal, bVal, unit = '') {
  const fmt = (v) => (v == null ? '—' : `${v}${unit}`);
  const [aPct, bPct] = compareSplit(aVal, bVal);
  return `
    <div class="compare-row">
      <div class="compare-values">
        <span class="compare-val compare-val-a">${esc(fmt(aVal))}</span>
        <span class="compare-label">${esc(label)}</span>
        <span class="compare-val compare-val-b">${esc(fmt(bVal))}</span>
      </div>
      <div class="compare-bar">
        <span class="compare-bar-a" style="width:${aPct}%"></span>
        <span class="compare-bar-b" style="width:${bPct}%"></span>
      </div>
    </div>`;
}

function textCompareRow(label, aVal, bVal) {
  return `
    <div class="compare-row compare-row-text">
      <span class="compare-val compare-val-a">${esc(aVal ?? '—')}</span>
      <span class="compare-label">${esc(label)}</span>
      <span class="compare-val compare-val-b">${esc(bVal ?? '—')}</span>
    </div>`;
}

/** Red/blue name header (fighter A / fighter B, the same pairing every
 * compareRow below uses) — shared by every dual-fighter section in the MMA
 * breakdown so "which color is whose" only has to be learned once per
 * drawer. Omitted when there's no resolved opponent to pair against. */
function mmaCompareHeader(me, opponent) {
  if (!opponent) return '';
  return `
    <div class="compare-header">
      <span class="compare-fighter-a">${esc(me.name)}</span>
      <span class="compare-fighter-b">${esc(opponent.name)}</span>
    </div>`;
}

/**
 * A titled group of compareRow()s — the condensed, color-coded replacement
 * for what used to be two separate stacked per-fighter bar lists (one green
 * block for `me`, a second green block for `opponent`, each repeating the
 * fighter's name). One row per metric instead, `me` always red (fighter A)
 * and `opponent` always blue (fighter B), matching the same pairing
 * renderUfcStatComparison's Matchup Comparison tabs already use — so the
 * whole drawer reads by one consistent color convention rather than each
 * section inventing its own. `pairs` is `[label, meVal, oppVal, unit?]`;
 * a still-real fighter with no opponent resolved just shows red bars with
 * the b-side reading "—" (compareRow's own existing missing-data handling),
 * rather than this needing a separate single-fighter layout to maintain.
 */
function mmaCompareSection(title, me, opponent, pairs, sourceLabel = null) {
  if (!pairs.length) return '';
  const rows = pairs.map(([label, a, b, unit]) => compareRow(label, a, b, unit)).join('');
  const heading = sourceLabel
    ? `${esc(title)} <span class="stats-source">${esc(sourceLabel)}</span>`
    : esc(title);
  return `<div class="stats-section mma-compare"><h3>${heading}</h3>${mmaCompareHeader(me, opponent)}${rows}</div>`;
}

const LAST_FIGHT_LABEL = { win: 'Win', loss: 'Loss', draw: 'Draw', nc: 'NC' };

function fighterCountry(fighter) {
  const pob = fighter?.ufc?.bio?.placeOfBirth;
  if (!pob) return null;
  const parts = pob.split(',').map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function mmaMatchupStatsTab(me, opponent) {
  const recordOf = (f) => (f?.record ? `${f.record.wins}-${f.record.losses}${f.record.draws ? `-${f.record.draws}` : ''}` : null);
  const lastFightOf = (f) => LAST_FIGHT_LABEL[f?.history?.[0]?.result] ?? null;
  return [
    textCompareRow('Record', recordOf(me), recordOf(opponent)),
    textCompareRow('Last Fight', lastFightOf(me), lastFightOf(opponent)),
    textCompareRow('Country', fighterCountry(me), fighterCountry(opponent)),
  ].join('');
}

function mmaWinByTab(me, opponent) {
  const pctFor = (f, label) => f?.ufc?.winMethod?.find((w) => w.label === label)?.pct ?? null;
  return [
    compareRow('KO/TKO', pctFor(me, 'KO/TKO'), pctFor(opponent, 'KO/TKO'), '%'),
    compareRow('Submission', pctFor(me, 'SUB'), pctFor(opponent, 'SUB'), '%'),
    compareRow('Decision', pctFor(me, 'DEC'), pctFor(opponent, 'DEC'), '%'),
  ].join('');
}

function mmaStrikesTab(me, opponent) {
  return [
    compareRow('Landed Per Min', me?.ufc?.sigStrikeLandedPerMin, opponent?.ufc?.sigStrikeLandedPerMin),
    compareRow('Significant Strikes', me?.ufc?.strikingAccuracy, opponent?.ufc?.strikingAccuracy, '%'),
    compareRow('Absorbed Per Min', me?.ufc?.sigStrikeAbsorbedPerMin, opponent?.ufc?.sigStrikeAbsorbedPerMin),
  ].join('');
}

function mmaGrapplingTab(me, opponent) {
  return [
    compareRow('Takedown Avg', me?.ufc?.takedownAvgPer15Min, opponent?.ufc?.takedownAvgPer15Min),
    compareRow('Takedown Accuracy', me?.ufc?.takedownAccuracy, opponent?.ufc?.takedownAccuracy, '%'),
    compareRow('Takedown Defense', me?.ufc?.takedownDefense, opponent?.ufc?.takedownDefense, '%'),
  ].join('');
}

const MMA_COMPARE_TABS = [
  { key: 'matchup', label: 'Matchup Stats', build: mmaMatchupStatsTab },
  { key: 'winby', label: 'Win By', build: mmaWinByTab },
  { key: 'strikes', label: 'Significant Strikes', build: mmaStrikesTab },
  { key: 'grappling', label: 'Grappling', build: mmaGrapplingTab },
];

// The two fighters for whichever MMA drawer is currently open — read by the
// tab-switch click handler below, since clicking a tab re-renders just the
// tab body, not the whole drawer. Same pattern as tennisBreakdownState.
let mmaCompareState = null;

function renderUfcStatComparison(me, opponent) {
  if (!me || !opponent) return '';
  const hasSherdog = me.record || opponent.record || me.history?.length || opponent.history?.length;
  const hasUfc = me.ufc || opponent.ufc;
  if (!hasSherdog && !hasUfc) return '';

  mmaCompareState = { me, opponent };
  const tabButtons = MMA_COMPARE_TABS
    .map((t, i) => `<button type="button" class="compare-tab-btn ${i === 0 ? 'is-active' : ''}" data-mma-compare-tab="${esc(t.key)}">${esc(t.label)}</button>`)
    .join('');

  return `
    <div class="stats-section mma-compare">
      <h3>Matchup Comparison <span class="stats-source">via UFC.com</span></h3>
      ${mmaCompareHeader(me, opponent)}
      <div class="compare-tabs">${tabButtons}</div>
      <div id="mmaCompareBody">${MMA_COMPARE_TABS[0].build(me, opponent)}</div>
    </div>`;
}

/**
 * The MMA Fantasy-style breakdown: photos, physical attributes, career rate
 * stats, data reliability, method-of-victory/defeat bars, round-ended
 * distribution, activity by year, and common opponents. Sherdog
 * (worker/src/mma.js) supplies cross-promotion history and bio; ufc.com
 * (worker/src/ufc.js) supplies career rate stats — striking/takedown
 * accuracy and significant-strike-by-position — for whichever fighters have
 * actually competed in the UFC. UFCStats.com would have been the more
 * obvious source for those exact numbers, but serves a JS anti-bot
 * "checking your browser" challenge to every request this app's Cloudflare
 * Worker makes to it (confirmed live, and confirmed it isn't Worker-
 * specific — a plain curl from an ordinary machine gets the identical
 * challenge). ufc.com's own athlete pages carry the same core numbers with
 * no such wall.
 */
function renderMmaMoneylines(leg) {
  if (!leg || !leg.quotes?.length) return '';
  // Show the best moneyline price available across all books
  const sorted = [...leg.quotes].sort((a, b) => b.decimal - a.decimal);
  const bestQuote = sorted[0];
  if (!bestQuote) return '';

  const bestBooks = {};
  for (const q of leg.quotes) {
    if (!bestBooks[q.american] || q.decimal > bestBooks[q.american].decimal) {
      bestBooks[q.american] = q;
    }
  }
  const uniquePrices = Object.values(bestBooks).sort((a, b) => b.decimal - a.decimal).slice(0, 3);

  return `
    <div class="stats-section">
      <h3>Moneyline (${esc(leg.away)} vs ${esc(leg.home)})</h3>
      <div class="stats-pills">
        ${uniquePrices.map((q) => `<span class="stat-pill">${esc(q.book)}: ${esc(formatAmerican(q.american))} (${(impliedProb(q.american) * 100).toFixed(1)}%)</span>`).join('')}
      </div>
    </div>`;
}

function renderMmaBreakdown(mmaContext, subjectName, leg = null) {
  const { me, opponent } = resolveMmaFighters(mmaContext, subjectName);
  if (!me) return '';

  const sections = [];

  const photos = renderMmaPhotos(me, opponent);
  if (photos) sections.push(photos);

  // Moneylines section — always shown when odds are available
  const moneylineHtml = leg ? renderMmaMoneylines(leg) : '';
  if (moneylineHtml) sections.push(moneylineHtml);

  // Record + last-five-fights strip — always shown when the data's there,
  // regardless of whether a photo actually rendered above for either side.
  const recordStrip = [renderMmaRecordStrip(me), opponent ? renderMmaRecordStrip(opponent) : '']
    .filter(Boolean)
    .join('');
  if (recordStrip) sections.push(`<div class="stats-section mma-record-section">${recordStrip}</div>`);

  const compareHtml = opponent ? renderUfcStatComparison(me, opponent) : '';
  if (compareHtml) sections.push(compareHtml);

  const bioMe = renderMmaBio(me);
  const bioOpp = opponent ? renderMmaBio(opponent) : '';
  if (bioMe || bioOpp) {
    sections.push(`
      <div class="stats-section">
        <h3>Physical Attributes</h3>
        ${bioMe ? `<p class="stats-fighter-label">${esc(me.name)}</p>${bioMe}` : ''}
        ${bioOpp ? `<p class="stats-fighter-label">${esc(opponent.name)}</p>${bioOpp}` : ''}
      </div>`);
  }

  const detailsMe = renderMmaFighterDetails(me);
  const detailsOpp = opponent ? renderMmaFighterDetails(opponent) : '';
  if (detailsMe || detailsOpp) {
    sections.push(`
      <div class="stats-section">
        <h3>Fighter Details</h3>
        ${detailsMe}${detailsOpp}
      </div>`);
  }

  // Career rate stats (striking/takedown accuracy, significant-strike-by-
  // position), from ufc.com's own athlete page — only ever populated for a
  // fighter who's actually competed in the UFC. Matched by position label
  // across both fighters (a PFL-only fighter's positions may not line up
  // one-to-one with a UFC veteran's), same union approach Rounds/Activity
  // below use for their own fighter-specific category lists.
  const posLabels = [...new Set([
    ...(me.ufc?.strikePosition ?? []).map((p) => p.label),
    ...(opponent?.ufc?.strikePosition ?? []).map((p) => p.label),
  ])];
  const careerPairs = [];
  if (me.ufc?.strikingAccuracy != null || opponent?.ufc?.strikingAccuracy != null) {
    careerPairs.push(['Striking Acc.', me.ufc?.strikingAccuracy ?? 0, opponent?.ufc?.strikingAccuracy ?? 0, '%']);
  }
  if (me.ufc?.takedownAccuracy != null || opponent?.ufc?.takedownAccuracy != null) {
    careerPairs.push(['Takedown Acc.', me.ufc?.takedownAccuracy ?? 0, opponent?.ufc?.takedownAccuracy ?? 0, '%']);
  }
  for (const label of posLabels) {
    careerPairs.push([
      `Str. ${label}`,
      (me.ufc?.strikePosition ?? []).find((p) => p.label === label)?.pct ?? 0,
      (opponent?.ufc?.strikePosition ?? []).find((p) => p.label === label)?.pct ?? 0,
      '%',
    ]);
  }
  const careerHtml = mmaCompareSection('Career Stats', me, opponent, careerPairs, 'via UFC.com');
  if (careerHtml) sections.push(careerHtml);

  const relPills = [`<span class="stat-pill">${esc(me.name)}: ${dataReliability(me.history)} (${me.history?.length ?? 0} fights on file)</span>`];
  if (opponent) {
    relPills.push(`<span class="stat-pill">${esc(opponent.name)}: ${dataReliability(opponent.history)} (${opponent.history?.length ?? 0} fights on file)</span>`);
  }
  sections.push(`<div class="stats-section"><h3>Data Reliability</h3><div class="stats-pills">${relPills.join('')}</div></div>`);

  const boutsMe = renderMmaProfessionalBouts(me);
  const boutsOpp = opponent ? renderMmaProfessionalBouts(opponent) : '';
  if (boutsMe || boutsOpp) {
    sections.push(`
      <div class="stats-section">
        <h3>Professional Bouts</h3>
        ${boutsMe}${boutsOpp}
      </div>`);
  }

  // Method of Victory/Defeat, Fights End By Round, and Activity by Year all
  // used to render as two separate stacked green blocks (one per fighter,
  // each repeating "Fighter Name: Section Title"). Condensed to one row per
  // metric via mmaCompareSection instead — same red/blue fighter-A/B
  // convention as the photos and Matchup Comparison above, half the vertical
  // space, and "whose bar is whose" no longer requires re-reading a label.
  const finMe = finishSummary(me);
  const finOpp = opponent ? finishSummary(opponent) : null;
  const victoryHtml = mmaCompareSection('Method of Victory', me, opponent, (finMe || finOpp) ? [
    ['KO/TKO', finMe?.knockout ?? 0, finOpp?.knockout ?? 0],
    ['Submission', finMe?.submission ?? 0, finOpp?.submission ?? 0],
    ['Decision', finMe?.decision ?? 0, finOpp?.decision ?? 0],
  ] : []);
  if (victoryHtml) sections.push(victoryHtml);

  const vulnMe = vulnerabilitySummary(me);
  const vulnOpp = opponent ? vulnerabilitySummary(opponent) : null;
  const defeatHtml = mmaCompareSection('Method of Defeat', me, opponent, (vulnMe || vulnOpp) ? [
    ['KO/TKO', vulnMe?.koLosses ?? 0, vulnOpp?.koLosses ?? 0],
    ['Submission', vulnMe?.subLosses ?? 0, vulnOpp?.subLosses ?? 0],
    ['Decision/Other', vulnMe ? vulnMe.losses - vulnMe.koLosses - vulnMe.subLosses : 0, vulnOpp ? vulnOpp.losses - vulnOpp.koLosses - vulnOpp.subLosses : 0],
  ] : []);
  if (defeatHtml) sections.push(defeatHtml);

  // Rounds/years are fighter-specific category lists that don't necessarily
  // line up (a 5-round main event fighter vs. a prelim fighter who's never
  // seen round 4) — unioned and sorted so every round/year either fighter
  // ever hit gets one shared row, rather than each fighter listing only its
  // own categories the way the old stacked-block layout did.
  const roundsMe = fighterRoundsEnded(me.history).rounds;
  const roundsOpp = opponent ? fighterRoundsEnded(opponent.history).rounds : [];
  const roundNumbers = [...new Set([...roundsMe.map((r) => r.round), ...roundsOpp.map((r) => r.round)])].sort((a, b) => a - b);
  const roundsHtml = mmaCompareSection('Fights End By Round', me, opponent, roundNumbers.map((rnd) => [
    `Round ${rnd}`,
    roundsMe.find((r) => r.round === rnd)?.count ?? 0,
    roundsOpp.find((r) => r.round === rnd)?.count ?? 0,
  ]));
  if (roundsHtml) sections.push(roundsHtml);

  const yearsMe = fighterActivityByYear(me.history);
  const yearsOpp = opponent ? fighterActivityByYear(opponent.history) : [];
  const years = [...new Set([...yearsMe.map((y) => y.year), ...yearsOpp.map((y) => y.year)])].sort((a, b) => a - b);
  const activityHtml = mmaCompareSection('Activity by Year', me, opponent, years.map((yr) => [
    String(yr),
    yearsMe.find((y) => y.year === yr)?.count ?? 0,
    yearsOpp.find((y) => y.year === yr)?.count ?? 0,
  ]));
  if (activityHtml) sections.push(activityHtml);

  if (opponent) {
    const shared = commonOpponents(me, opponent);
    if (shared.length) {
      const rows = shared.map((s) => `
        <tr>
          <td>${esc(s.opponent)}</td>
          <td>${esc(s.a.result)}${s.a.method ? ` · ${esc(s.a.method)}` : ''}</td>
          <td>${esc(s.b.result)}${s.b.method ? ` · ${esc(s.b.method)}` : ''}</td>
        </tr>`).join('');
      sections.push(`
        <div class="stats-section">
          <h3>Common Opponents</h3>
          <div class="stats-table-scroll">
            <table class="stats-table">
              <thead><tr><th>Opponent</th><th>${esc(me.name)}</th><th>${esc(opponent.name)}</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`);
    }
  }

  return sections.join('');
}

/**
 * Open the More Stats drawer for one leg: paint the bet itself (selection,
 * price, suggested stake) and the full book-by-book price table immediately,
 * then — unless oddsOnly is set — fill in the slower research sections once
 * they resolve. Reuses the exact same cached fetches (tennisArchive/
 * mmaContextFor/eventContext/weatherFor) the compact card's "why" panel
 * already triggers — opening this for a leg whose "why" panel is already
 * open costs no extra network call.
 *
 * oddsOnly (used by Full Slate's market cells — see the data-slate-cell
 * click handler below) skips all of that entirely: no analysis, no research,
 * no network calls beyond what's already in `leg`. Just the bet and the
 * book table for that exact selection, nothing else. "More Info" (fullscreen)
 * and Pixel's Picks' own "why" drawer (data-more-stats) don't pass this —
 * they're the deliberate deep-dive entry points and keep full research.
 */
async function openStatsDrawer(leg, opposite = null, { fullscreen = false, oddsOnly = false } = {}) {
  el.statsDrawer.classList.toggle('is-fullscreen', fullscreen);
  el.statsDrawerTitle.textContent = leg.selection;
  setStatsDrawerOpen(true);

  const awayLogo = teamLogoUrl(leg.sportKey, leg.away);
  const homeLogo = teamLogoUrl(leg.sportKey, leg.home);
  const metaHtml = `<p class="stats-meta">` +
    `<strong>` +
    `${awayLogo ? `<img class="stats-meta-logo" src="${esc(awayLogo)}" alt="" loading="lazy">` : ''}${esc(leg.away)} @ ` +
    `${homeLogo ? `<img class="stats-meta-logo" src="${esc(homeLogo)}" alt="" loading="lazy">` : ''}${esc(leg.home)}` +
    `</strong> · ${esc(leg.marketLabel)} · ` +
    `${esc(dateFmt.format(new Date(leg.commenceMs)))}</p>`;
  const mainPlayHtml = `
    <div class="main-play-callout">
      <div class="main-play-label">Main Play</div>
      <div class="main-play-selection">${esc(leg.selection)} <span class="main-play-price">${esc(formatAmerican(leg.american))}</span></div>
      ${stakeLineHtml(suggestedStake(leg), 'main-play-stake')}
    </div>`;

  // Fast initial paint: the bet itself (selection, price, suggested stake)
  // and every book's price on this exact line render immediately, with no
  // wait on the network calls below — a market-cell click is "what can I
  // bet, and where," and that shouldn't sit behind an AI writeup or a
  // weather lookup. For oddsOnly this is the entire drawer; otherwise the
  // slower research sections stream in on top of it once they resolve — see
  // the final innerHTML replace below.
  el.statsDrawerBody.innerHTML = metaHtml + mainPlayHtml + renderPriceTable(leg);
  if (oddsOnly) return;

  const stake = singleStakeLine(leg);

  let bullets = [];
  let weather = null;
  let mmaBreakdownHtml = '';
  let mmaSubjectName = null;
  let tennisBreakdownHtml = '';
  let analysisText = null;
  let victoryMethods = null;
  let quickTake = null;
  let devilsAdvocate = null;
  try {
    const analysisPromise = matchupAnalysisFor(leg);
    if (isTennis(leg.sportKey)) {
      const tennisData = await tennisArchive(leg.sportKey);
      bullets = buildInsights(leg, { tennisData });
      tennisBreakdownHtml = renderTennisBreakdown(tennisData, leg.away, leg.home);
    } else if (isMma(leg.sportKey)) {
      const mmaContext = await mmaContextFor(leg);
      bullets = buildInsights(leg, { mmaContext });
      mmaSubjectName = leg.selection.replace(/ to win$/i, '').trim();
      mmaBreakdownHtml = renderMmaBreakdown(mmaContext, mmaSubjectName, leg);
    } else {
      const [context, w] = await Promise.all([eventContext(leg), weatherFor(leg)]);
      weather = w;
      bullets = buildInsights(leg, { context, weather });
    }
    const analysis = await analysisPromise;
    // The worker always returns a JSON envelope now — {analysis, quickTake,
    // devilsAdvocate, victoryMethods?} — the model is told which side this
    // app already picked (see worker/src/analysis.js) and asked to build
    // the case for it, so there's no independent "favoredSide" left to
    // disagree with the pick shown here.
    if (analysis) {
      try {
        const parsed = JSON.parse(analysis);
        analysisText = parsed.analysis ?? analysis;
        quickTake = Array.isArray(parsed.quickTake) ? parsed.quickTake : null;
        devilsAdvocate = Array.isArray(parsed.devilsAdvocate) ? parsed.devilsAdvocate : null;
        if (isMma(leg.sportKey) && parsed.victoryMethods) victoryMethods = parsed.victoryMethods;
      } catch {
        analysisText = analysis;
      }
    }
  } catch {
    /* Research is a bonus; the price case and book table still stand alone. */
  }

  const methodLabel = { SUB: 'Submission', TKO: 'TKO/KO', DEC: 'Decision' };
  const victoryList = (entries) =>
    (entries ?? [])
      .map((v) => `<li><strong>${esc(methodLabel[v.method] ?? v.method)}</strong>${v.percentage != null ? ` (${v.percentage}%)` : ''}: ${esc(v.reasoning)}</li>`)
      .join('');
  const victoryMethodsHtml = victoryMethods
    ? `
      <div class="stats-section victory-methods">
        <h4>Expected Methods of Victory</h4>
        <div class="victory-fighters">
          <div class="victory-fighter">
            <div class="fighter-name">${esc(leg.away)}</div>
            <ul class="victory-list">${victoryList(victoryMethods[leg.away])}</ul>
          </div>
          <div class="victory-fighter">
            <div class="fighter-name">${esc(leg.home)}</div>
            <ul class="victory-list">${victoryList(victoryMethods[leg.home])}</ul>
          </div>
        </div>
      </div>`
    : '';

  // TL;DR bullets above the prose — the scannable "why this pick" summary
  // for whichever side favoredSide names, before the deep-dive underneath.
  const quickTakeHtml = quickTake?.length
    ? `<ul class="quick-take-list">${quickTake.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
    : '';

  // MMA gets no qualitative/form scoring at all (see docs/app.js's
  // refreshQualitativeSignals(), which explicitly skips MMA) — every MMA
  // pick, underdog or favorite, is chosen purely on the price math below.
  // The AI analysis is barred from ever mentioning price (worker/src/
  // analysis.js's prompt rules), so if it replaced the price case the way it
  // does for other sports, an MMA underdog pick would show a thin
  // fighter-facts paragraph with no visible link to the actual reason it was
  // picked. So for MMA specifically, both sections always render — the AI's
  // fighter-facts read (when available) plus the real "why," never one
  // instead of the other.
  const stakeHtml = stake;
  const isUnderdogPick = typeof leg.american === 'number' && leg.american > 0;
  const mmaMarketNote = isMma(leg.sportKey) && isUnderdogPick
    ? `MMA picks are chosen on this price math alone. This app applies no fighter-quality or form scoring to MMA (the research below is for context, not scoring). An underdog pick like this one means the market itself disagrees with the favorite's price; it isn't a projection that this fighter is actually better.`
    : null;

  const analysisSectionHtml = analysisText
    ? `
      <div class="stats-section">
        <h3>Matchup Analysis</h3>
        ${quickTakeHtml}
        <p class="analysis-text">${esc(analysisText)}</p>
        ${victoryMethodsHtml}
        ${isMma(leg.sportKey) ? '' : stakeHtml}
      </div>`
    : '';

  const marketCaseSectionHtml = `
    <div class="stats-section">
      <h3>The Market &amp; Price Case</h3>
      ${mmaMarketNote ? `<p class="market-note">${esc(mmaMarketNote)}</p>` : ''}
      <ul>${explainExtensive(leg).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      ${stakeHtml}
    </div>`;

  // The AI-written matchup analysis replaces the quantitative price case
  // entirely when it's available (see worker/src/analysis.js) — falls back
  // to the existing no-vig/EV read whenever it isn't. MMA is the one
  // exception: both always render, per the note above.
  const priceHtml = isMma(leg.sportKey)
    ? analysisSectionHtml + marketCaseSectionHtml
    : (analysisText ? analysisSectionHtml : marketCaseSectionHtml);

  // Genuine risk to THIS pick, not a case for the other side — the model is
  // told which side the app already picked (worker/src/analysis.js) and
  // asked to be honest about how it could still lose. AI-only: no
  // deterministic fallback, same as quickTake/analysisText above, since
  // there's no quantitative "weakness in our own pick" bullet list to fall
  // back to (explainExtensive only argues a side's own case, never against it).
  const devilQuickTakeHtml = devilsAdvocate?.length
    ? `<ul class="quick-take-list">${devilsAdvocate.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
    : '';
  const devilHtml = devilQuickTakeHtml
    ? `
      <div class="stats-section devil-advocate">
        <h3>Devil's Advocate</h3>
        ${devilQuickTakeHtml}
      </div>`
    : '';

  // The drawer may have been closed (or reopened for a different leg) while
  // these fetches were in flight — never paint a stale result over whatever
  // the user is looking at now.
  if (el.statsDrawer.hidden || el.statsDrawerTitle.textContent !== leg.selection) return;

  // MMA is the one sport where the fighter-research panel can legitimately
  // come back completely empty (renderMmaBreakdown returns '' when Sherdog
  // has no confidently-matched profile for this fighter) — every other
  // section on the card (price, book table, market case) still renders
  // regardless, so a silent gap here reads as broken rather than as the
  // genuine "no data on file yet" case it usually is (a UFC debut/new
  // signee, or a name-variant Sherdog's own search never surfaced). Say so
  // explicitly instead of leaving the space blank with no explanation.
  const mmaNoDataHtml = isMma(leg.sportKey) && !mmaBreakdownHtml
    ? `<div class="stats-section mma-no-data">` +
      `<p>No fighter research on file for ${esc(mmaSubjectName ?? leg.selection)} yet — either they're new enough ` +
      `that Sherdog has nothing indexed, or their name didn't match between sources. The price case above still stands on its own.</p>` +
      `</div>`
    : '';

  // The bet itself — Main Play plus every book's price on this exact line —
  // stays pinned at the top, exactly matching the fast initial paint above
  // (same metaHtml + mainPlayHtml + renderPriceTable(leg) trio), so nothing
  // reflows or gets pushed down once research resolves. That research
  // (matchup analysis, Devil's Advocate, MMA/tennis breakdown, form bullets)
  // is real value, but it's supplementary reading, not what someone clicking
  // a market cell is primarily asking for — "what can I bet, and where."
  // Previously this all rendered ABOVE the price table, so once the AI
  // writeup and research finished loading, the actual sportsbook odds ended
  // up buried at the bottom of a long scroll behind a wall of prose.
  el.statsDrawerBody.innerHTML =
    metaHtml +
    mainPlayHtml +
    renderPriceTable(leg) +
    renderWeatherPills(weather) +
    priceHtml +
    devilHtml +
    mmaBreakdownHtml +
    mmaNoDataHtml +
    tennisBreakdownHtml +
    renderStatsResearch(bullets);
}

/**
 * The other side of this exact market (same game, same market key, different
 * outcome) from whatever's currently in the candidate pool — the same
 * matching Full Slate's devil's-advocate cells use, generalized so any pick
 * card's own "More Stats" gets the opposing case too, not just Full Slate.
 * Null when the market only ever had one side qualify (or a 3+-way market —
 * picking a single "opposite" out of several isn't well-defined, so this
 * deliberately says nothing rather than arbitrarily naming one).
 */
function findOpposite(leg) {
  const sameMarket = state.candidates.filter(
    (c) => c.eventId === leg.eventId && c.marketKey === leg.marketKey && c.id !== leg.id,
  );
  return sameMarket.length === 1 ? sameMarket[0] : null;
}

document.body.addEventListener('click', (event) => {
  const button = event.target.closest('[data-more-stats]');
  if (!button) return;
  const leg = renderedLegs[Number(button.dataset.moreStats)];
  if (leg) openStatsDrawer(leg, findOpposite(leg));
});

// A "Bankroll not set" stake line (see stakeLineHtml) can appear inside any
// pick card or the stats drawer — one delegated
// listener on the body, same pattern as the other data-attribute buttons
// here, covers all of them without needing a handler wired per container.
// Jumps straight to the real Bankroll panel rather than just explaining
// where it is, since setBankrollOpen already puts the user exactly where
// they'd need to go next anyway.
document.body.addEventListener('click', (event) => {
  const button = event.target.closest('[data-bankroll-cta]');
  if (!button) return;
  setBankrollOpen(true);
});

document.body.addEventListener('click', (event) => {
  const button = event.target.closest('[data-surface-key]');
  if (!button || !tennisBreakdownState) return;
  const filters = tennisSurfaceFilters(tennisBreakdownState.data);
  const filter = filters.find((f) => f.key === button.dataset.surfaceKey);
  if (!filter) return;

  button.parentElement.querySelectorAll('.surface-btn').forEach((b) => b.classList.toggle('is-active', b === button));
  const body = document.getElementById('tennisFilterBody');
  if (body) body.innerHTML = renderTennisFilterBody(filter);
});

document.body.addEventListener('click', (event) => {
  const button = event.target.closest('[data-mma-compare-tab]');
  if (!button || !mmaCompareState) return;
  const tab = MMA_COMPARE_TABS.find((t) => t.key === button.dataset.mmaCompareTab);
  if (!tab) return;

  button.parentElement.querySelectorAll('.compare-tab-btn').forEach((b) => b.classList.toggle('is-active', b === button));
  const body = document.getElementById('mmaCompareBody');
  if (body) body.innerHTML = tab.build(mmaCompareState.me, mmaCompareState.opponent);
});

el.statsDrawerClose.addEventListener('click', () => setStatsDrawerOpen(false));

/* ---------------------------------------------------------------- */
/* Durable settings sync                                             */
/* ---------------------------------------------------------------- */

/**
 * Bankroll/unit size used to live only in localStorage, so they died with a
 * cleared cache and never followed the user to another device. They're now
 * mirrored to the worker (see worker/src/settings.js), with localStorage
 * kept as the offline/not-connected fallback — the local copy is always
 * written, so nothing regresses when sync is unavailable.
 *
 * Identity is a single owner passphrase for now, held in localStorage and
 * sent as X-Owner-Key. That's a deliberate interim: it's XSS-exposed the
 * same way any browser-held token is, and it doesn't scale past one person.
 * When real per-user accounts land, this key becomes a session token and
 * settingsHeaders() is the only thing here that has to change.
 */
const OWNER_KEY_STORAGE = 'pixelpick.ownerKey.v1';

function ownerKey() {
  return loadJSON(OWNER_KEY_STORAGE, '') || '';
}

function settingsHeaders() {
  const key = ownerKey();
  return key ? { 'X-Owner-Key': key } : null;
}

/**
 * Pull settings from the server and adopt them, if a key is configured.
 * Server wins over the local copy: it's the record that survived whatever
 * cleared this browser, and it's what another device already agreed on.
 * Any failure leaves the local copy untouched rather than blanking a real
 * bankroll over a transient network error.
 */
async function loadSettings() {
  const headers = settingsHeaders();
  if (!headers || !CONFIG.WORKER_URL) return { ok: false, reason: 'not-connected' };
  try {
    const res = await fetch(new URL('/settings', CONFIG.WORKER_URL), { headers });
    if (!res.ok) return { ok: false, reason: res.status === 401 ? 'bad-key' : 'unavailable' };
    const { settings } = await res.json();
    if (settings?.bankroll) {
      state.bankroll = { ...state.bankroll, ...settings.bankroll };
      saveJSON(BANKROLL_KEY, state.bankroll); // keep the offline copy in step
    }
    return { ok: true, hadRecord: Boolean(settings) };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

// Coalesces the burst of persistBankroll() calls a single Submit produces
// (amount, unit, confirmed, and displayMode can all change at once) into one
// PUT, and keeps a fast typist from firing a request per keystroke.
let settingsPushTimer = null;
let lastPushFailed = false;

function pushSettingsSoon() {
  const headers = settingsHeaders();
  if (!headers || !CONFIG.WORKER_URL) return;
  clearTimeout(settingsPushTimer);
  settingsPushTimer = setTimeout(async () => {
    try {
      const res = await fetch(new URL('/settings', CONFIG.WORKER_URL), {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bankroll: state.bankroll }),
      });
      lastPushFailed = !res.ok;
    } catch {
      lastPushFailed = true; // local copy already saved; surfaced in the panel
    }
    renderOwnerKeyStatus();
  }, 600);
}

function renderOwnerKeyStatus(override) {
  if (!el.ownerKeyStatus) return;
  if (override) {
    el.ownerKeyStatus.textContent = override;
    return;
  }
  if (!ownerKey()) {
    el.ownerKeyStatus.textContent = 'Not connected — saved on this device only.';
    return;
  }
  el.ownerKeyStatus.textContent = lastPushFailed
    ? 'Connected, but the last save didn\'t reach the server. Still saved locally.'
    : 'Connected — changes sync automatically.';
}

function persistBankroll() {
  saveJSON(BANKROLL_KEY, state.bankroll); // always, so sync is never load-bearing
  pushSettingsSoon();
}

function renderBankrollPanel() {
  el.bankrollAmount.value = state.bankroll.amount > 0 ? state.bankroll.amount : '';
  el.bankrollUnit.value = state.bankroll.unit > 0 ? state.bankroll.unit : '';

  const rec = recommendedUnit();
  el.bankrollUnitHint.textContent = rec > 0
    ? `Recommended: $${rec.toFixed(2)} (2% of bankroll)`
    : 'Set a bankroll above to see a recommended unit size.';

  el.bankrollShowDollars.classList.toggle('is-active', state.bankroll.displayMode !== 'units');
  el.bankrollShowUnits.classList.toggle('is-active', state.bankroll.displayMode === 'units');

  el.bankrollSubmitHint.textContent = state.bankroll.confirmed && state.bankroll.amount > 0
    ? 'Applied. Every "why" panel now shows a real $ or unit amount.'
    : 'Tap Submit to start seeing suggested stakes in real $ or units, not just %.';

  renderOwnerKeyStatus();
}

/* ---------------------------------------------------------------- */
/* Events                                                            */
/* ---------------------------------------------------------------- */

/**
 * Lazily add tennis alternate-spread candidates to the pool — a wider ladder
 * of game-handicap points than the featured board carries, NOT a sets-won
 * market (The Odds API doesn't have one for tennis; see the worker's
 * fetchTennisAltSpread for how that was confirmed).
 *
 * The Odds API doesn't carry this market on the featured board pull at all —
 * confirmed by direct probe, it only exists on a per-event endpoint billed a
 * real credit per match. Fetching it for every tennis match on the tour would
 * be dozens of credits per Generate tap; instead this ranks the tennis
 * matches already on the board by their best existing score and only fetches
 * the top CONFIG.TENNIS_ALT_SPREAD_LIMIT of them — the ones already
 * interesting enough that a better-priced alternate line on the same match is
 * worth the credit.
 *
 * Cached client-side by eventId so repeat taps within a session, and repeat
 * appearances of the same match across taps, never re-fetch — the worker
 * itself caches each event for an hour on top of that.
 */
async function enrichTennisAltSpreads() {
  if (!CONFIG.WORKER_URL) return; // demo mode has no live event ids to query

  const bestScoreByEvent = new Map(); // eventId -> { sportKey, score }
  for (const c of state.candidates) {
    if (!isTennis(c.sportKey)) continue;
    const prev = bestScoreByEvent.get(c.eventId);
    if (!prev || c.score > prev.score) {
      bestScoreByEvent.set(c.eventId, { sportKey: c.sportKey, score: c.score });
    }
  }
  if (!bestScoreByEvent.size) return;

  const ranked = [...bestScoreByEvent.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, CONFIG.TENNIS_ALT_SPREAD_LIMIT);

  const events = await Promise.all(
    ranked.map(async ([eventId, { sportKey }]) => {
      if (state.tennisAltSpreads.has(eventId)) return state.tennisAltSpreads.get(eventId);

      const url = new URL('/tennis-alt-spread', CONFIG.WORKER_URL);
      url.searchParams.set('sport', sportKey);
      url.searchParams.set('eventId', eventId);

      const event = await fetch(url, { headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.event ?? null)
        .catch(() => null);

      state.tennisAltSpreads.set(eventId, event);
      return event;
    }),
  );

  const fresh = events.filter(Boolean);
  if (!fresh.length) return;

  const extra = analyze(fresh);
  const existingIds = new Set(state.candidates.map((c) => c.id));
  for (const c of extra) {
    if (!existingIds.has(c.id)) state.candidates.push(c);
  }
}

// Bumped on every refreshQualitativeSignals() call — lets a slow run started
// before the user switched days/leagues detect it's been superseded and
// discard its own results rather than overwriting a newer run's.
let qualitativeRunToken = 0;

/**
 * Deterministic, rule-based enrichment: recomputes .score for every eligible
 * candidate using recent form / head-to-head / injuries already fetched for
 * the research bullets (tennisArchive/eventContext) — see docs/qualitative.js.
 * Never a new LLM call, never blocks first paint — fire-and-forget, re-renders
 * itself once done. MMA (Sherdog scraping, unproven at bulk scale) and totals
 * (no team/player side to attach a signal to) are skipped; those candidates
 * keep their price-only score exactly as before this function existed.
 */
async function refreshQualitativeSignals() {
  const token = ++qualitativeRunToken;
  const targets = dayFilteredCandidates().filter(
    (c) => supportsQualitativeSignal(c.marketKey) && !isMmaSportKey(c.sportKey),
  );
  if (!targets.length) return;

  await Promise.allSettled(targets.map(async (c) => {
    let signal = null;
    try {
      if (isTennis(c.sportKey)) {
        const data = await tennisArchive(c.sportKey);
        const opponent = c.outcomeName === c.home ? c.away : c.home;
        signal = data ? tennisQualitativeSignal(data, c.outcomeName, opponent) : null;
      } else {
        const context = await eventContext(c);
        signal = teamQualitativeSignal(context, c.outcomeName);
      }
    } catch {
      /* enrichment is a bonus; the price score stands on its own */
    }
    if (token !== qualitativeRunToken) return; // a newer run has already started
    Object.assign(c, scoreCandidate(c, { now: Date.now(), qualitative: signal ?? 0 }));
  }));

  if (token !== qualitativeRunToken) return; // superseded while awaiting — skip the render too
  renderFullSlate();
  // Pixel's Picks itself is locked server-side now (see loadPixelPicks()) —
  // this enrichment can't change which picks those are or their score, only
  // re-render in case a live-matched leg's other displayed fields shifted.
  renderPixelPicksBoard();
}

/* ---------------------------------------------------------------- */
/* Full Slate                                                        */
/* ---------------------------------------------------------------- */

// One entry per rendered slate cell that has a real candidate behind it, so a
// click can look up both that candidate and its market-mate (the "other
// side", for devil's advocate) without re-deriving either from the DOM.
// Reset on every full render — same pattern as renderedLegs above.
const renderedSlateCells = [];

// One entry per rendered game, for the full-screen "More Info" button — reset
// alongside renderedSlateCells on every full render.
const renderedSlateGames = [];

/**
 * These sports' candidates, grouped by event and split into the two sides of
 * each market. Built from state.rawEvents rather than state.candidates alone,
 * so a game where every market stayed too thin to grade (fewer than
 * RULES.MIN_BOOKS quoting it) still shows up on the slate — just with a dash
 * instead of a price — rather than silently vanishing.
 *
 * Takes an array of raw sport keys (a league group can cover several — every
 * ATP tournament currently running, say) rather than one. Nothing filters on
 * commence time itself: the odds feed stops returning an event the moment no
 * book is pricing it any more (typically immediately once it's finished), so
 * those are backfilled below from whatever /scores data is already cached —
 * that's the only reason a finished game still shows up here at all.
 */
function buildSlateGames(sportKeys) {
  const keys = new Set(Array.isArray(sportKeys) ? sportKeys : [sportKeys]);
  const byEvent = new Map();
  for (const c of state.candidates) {
    if (!keys.has(c.sportKey)) continue;
    if (!byEvent.has(c.eventId)) byEvent.set(c.eventId, []);
    byEvent.get(c.eventId).push(c);
  }

  const pairFor = (cands, marketKey, event) => {
    const inMarket = cands.filter((c) => c.marketKey === marketKey);
    if (marketKey === 'totals') {
      return {
        away: inMarket.find((c) => /^over$/i.test(c.outcomeName)) ?? null,
        home: inMarket.find((c) => /^under$/i.test(c.outcomeName)) ?? null,
      };
    }
    return {
      away: inMarket.find((c) => c.outcomeName === event.away_team) ?? null,
      home: inMarket.find((c) => c.outcomeName === event.home_team) ?? null,
    };
  };

  const oddsGames = (state.rawEvents ?? [])
    .filter((e) => keys.has(e.sport_key))
    .map((event) => {
      const commenceMs = new Date(event.commence_time).getTime();
      const cands = byEvent.get(event.id) ?? [];
      // Remember this fight's card while it's still priced — its market
      // (and this enrichment along with it) disappears from the odds feed
      // the moment it starts, well before /scores can confirm it's
      // finished, so this is the only chance to capture it.
      if (event.ufc_event) state.mmaEventCache.set(event.id, event.ufc_event);
      return {
        eventId: event.id,
        sportKey: event.sport_key,
        home: event.home_team,
        away: event.away_team,
        commenceMs,
        h2h: pairFor(cands, 'h2h', event),
        spreads: pairFor(cands, 'spreads', event),
        totals: pairFor(cands, 'totals', event),
        ufc_event: event.ufc_event,
      };
    });

  // The odds feed drops an event the instant no book is pricing it any
  // more — for MMA that's typically right when the fight starts, long
  // before it's finished, so it's often gone from state.rawEvents while
  // still live. Backfill those from whatever scores are already cached
  // (state.slateScores, populated by refreshSlateScores) as market-less
  // games — no spread/total/ML, since the book pulled them — so a live or
  // finished game still shows up with its score instead of vanishing.
  // The session cache (populated moments ago from a still-priced fight) is
  // preferred when both exist, but the tracked pick's own ufc_event — set
  // at 2am ET generation time and persisted server-side (see
  // worker/src/tracking.js's pickRecordFrom) — is what makes a fight's
  // real card recoverable even in a session that never saw it priced at
  // all, e.g. a fresh page load mid-event.
  const mmaCardFor = (eventId) => state.mmaEventCache.get(eventId) ?? state.slateTrackedPicks.get(eventId)?.ufc_event;

  const oddsEventIds = new Set(oddsGames.map((g) => g.eventId));
  const orphanGames = [];
  for (const scoreEvent of state.slateScores.values()) {
    if (!keys.has(scoreEvent.sport_key) || oddsEventIds.has(scoreEvent.id)) continue;
    orphanGames.push({
      eventId: scoreEvent.id,
      sportKey: scoreEvent.sport_key,
      home: scoreEvent.home_team,
      away: scoreEvent.away_team,
      commenceMs: new Date(scoreEvent.commence_time).getTime(),
      h2h: { away: null, home: null },
      spreads: { away: null, home: null },
      totals: { away: null, home: null },
      // Recover the card name from the cache above rather than hardcoding
      // it lost — this is what keeps a fight grouped under its real UFC
      // card once it goes live, instead of falling to UNKNOWN_MMA_CARD.
      ufc_event: mmaCardFor(scoreEvent.id),
    });
  }

  // The Odds API's /scores has no coverage at all for some MMA bouts —
  // confirmed live: several early-prelim fights on a currently-airing card
  // never appeared in /scores in any form, not even as "not completed," so
  // the orphan backfill above had nothing to recover them from. The
  // server's own Full Slate tracker grades every fight it ever tracked
  // using ESPN as a fallback (see worker/src/ufc-events.js's
  // fetchMmaResults/gradeMmaPickWithFallback), independent of whatever the
  // Odds API's /scores does or doesn't carry — so state.slateTrackedPicks
  // (from /full-slate-history) already has the true result for these fights
  // well before /scores ever would. This tier only fires for an event
  // neither of the above already covered.
  const coveredEventIds = new Set([...oddsEventIds, ...orphanGames.map((g) => g.eventId)]);
  const trackedOnlyGames = [];
  for (const pick of state.slateTrackedPicks.values()) {
    if (!keys.has(pick.sportKey) || coveredEventIds.has(pick.eventId)) continue;
    trackedOnlyGames.push({
      eventId: pick.eventId,
      sportKey: pick.sportKey,
      home: pick.home,
      away: pick.away,
      commenceMs: pick.commenceMs,
      h2h: { away: null, home: null },
      spreads: { away: null, home: null },
      totals: { away: null, home: null },
      ufc_event: mmaCardFor(pick.eventId),
    });
  }

  return oddsGames.concat(orphanGames, trackedOnlyGames)
    .filter((g) => {
      if (!Number.isFinite(g.commenceMs)) return false;
      const isFinished = isGameFinished(g.eventId);
      return withinDayFilter(g.commenceMs, g.sportKey, isFinished);
    })
    .sort((a, b) => a.commenceMs - b.commenceMs);
}

/** Raw per-team score lookup from a /scores event, same pattern as worker/src/tracking.js's own gradePick() uses. */
function slateScoreFor(scoreEvent, teamName) {
  if (!scoreEvent?.scores) return null;
  const entry = scoreEvent.scores.find((s) => s.name === teamName);
  const value = entry ? Number(entry.score) : NaN;
  return Number.isFinite(value) ? value : null;
}

/**
 * Whether an eventId is finished, from either data source that can say so:
 * the Odds API's /scores (completed:true) or the server's own tracked Full
 * Slate pick once graded (won/lost — see worker/src/full-slate-tracking.js).
 * The tracked pick is checked too, not just /scores, because it's graded
 * via an ESPN fallback for MMA that covers fights /scores has no record of
 * at all (see buildSlateGames' trackedOnlyGames tier) — a pick can only
 * ever reach won/lost once the fight has actually concluded, so treating
 * that as authoritative here can't misclassify a still-live fight.
 */
function isGameFinished(eventId) {
  if (state.slateScores.get(eventId)?.completed === true) return true;
  const status = state.slateTrackedPicks.get(eventId)?.status;
  return status === 'won' || status === 'lost';
}

/** 'upcoming' | 'live' | 'finished' for a game, from whatever /scores and tracked-pick data is currently cached. */
function slateGameState(game) {
  if (isGameFinished(game.eventId)) return 'finished';
  if (game.commenceMs <= Date.now()) return 'live';
  return 'upcoming';
}

/**
 * Whether the game's own recommended side (bestCandidateForGame — the same
 * one More Info opens on) won, once the game is finished — reuses the exact
 * same gradePick() the tracker itself grades picks with, so "did the pick
 * win" here and "did a tracked pick win" elsewhere are never two different
 * answers to the same question. Returns null for an upcoming/live game, a
 * game with no recommended side, or a push (a push isn't a win or a loss).
 */
function slateGameOutcome(game, rec) {
  if (!rec || slateGameState(game) !== 'finished') return null;
  const scoreEvent = state.slateScores.get(game.eventId);
  const outcome = gradePick(
    { home: game.home, away: game.away, outcomeName: rec.outcomeName, point: rec.point, marketKey: rec.marketKey, decimal: rec.decimal, suggested_stake: 1 },
    scoreEvent,
  );
  return outcome ? (outcome.void ? 'void' : outcome.won ? 'won' : 'lost') : null;
}

/**
 * Scores for whatever's on the currently-viewed league's board — cached
 * client-side for a minute (the server itself caches these 5 minutes) so
 * paging through sort/event filters on the same league doesn't refetch.
 * Fire-and-forget from renderFullSlate; a stale/empty cache just means
 * every game still renders as 'upcoming' until this resolves.
 */
async function refreshSlateScores(group) {
  if (!CONFIG.WORKER_URL || !group.keys.length) return false;
  const lastFetch = state.slateScoresFetchedAt.get(group.id) ?? 0;
  if (Date.now() - lastFetch < 60000) return false;
  state.slateScoresFetchedAt.set(group.id, Date.now());
  try {
    const url = new URL('/scores', CONFIG.WORKER_URL);
    url.searchParams.set('sports', group.keys.join(','));
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return false;
    const data = await res.json();
    for (const scoreEvent of data.events ?? []) {
      state.slateScores.set(scoreEvent.id, scoreEvent);
    }
    return true;
  } catch {
    return false; // scores are an enhancement; the price grid still works without them
  }
}

/**
 * The server's own tracked Full Slate pick per game (worker/src/
 * full-slate-tracking.js), keyed by eventId — global rather than
 * per-league since it's one small request either way. Refreshed at most
 * once a minute, same throttle as refreshSlateScores. Only the last two
 * ET days are requested: a game shown on the board is always today's (or,
 * for MMA, within the next week and not yet tracked anyway), so this only
 * ever needs to cover "finished a few minutes ago, might straddle
 * midnight ET."
 */
async function refreshSlateTrackedPicks() {
  if (!CONFIG.WORKER_URL) return false;
  if (Date.now() - state.slateTrackedPicksFetchedAt < 60000) return false;
  state.slateTrackedPicksFetchedAt = Date.now();
  try {
    const url = new URL('/full-slate-history', CONFIG.WORKER_URL);
    url.searchParams.set('days', '2');
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return false;
    const data = await res.json();
    for (const pick of data.picks ?? []) {
      state.slateTrackedPicks.set(pick.eventId, pick);
    }
    return true;
  } catch {
    return false; // tracked picks are an enhancement; live re-derivation still covers most games
  }
}

/**
 * One market cell. A real candidate renders as a clickable price, ringed
 * with a highlight when it grades higher than its market-mate (or when it's
 * the only side priced at all — nothing to compare against, but still the
 * only actionable side). A market with no qualifying price on this side
 * renders a plain dash rather than making the whole game disappear.
 */
function slateCell(cand, opposite, { totalLabel, suppressRec = false, isRec = false } = {}) {
  if (!cand) return `<span class="slate-cell is-empty">—</span>`;

  // Once a game is live or finished, the recommended-side glow stops
  // meaning anything — it was a pregame read, not a live one — so it's
  // suppressed rather than left pointing at a bet that's already decided.
  const recommended = !suppressRec && isRec;
  const idx = renderedSlateCells.push({ cand, opposite }) - 1;
  const label = totalLabel ? `${totalLabel}${formatAmerican(cand.american)}` : formatAmerican(cand.american);

  return `
    <button type="button" class="slate-cell ${recommended ? 'is-rec' : ''}"
            data-slate-cell="${idx}" title="${esc(cand.selection)}">${esc(label)}</button>`;
}

function slateTeamRow(game, side, { gameState, scoreEvent, recommendedId, hideMarkets = false }) {
  const isAway = side === 'away';
  const team = isAway ? game.away : game.home;
  const spread = isAway ? game.spreads.away : game.spreads.home;
  const oppSpread = isAway ? game.spreads.home : game.spreads.away;
  const total = isAway ? game.totals.away : game.totals.home;
  const oppTotal = isAway ? game.totals.home : game.totals.away;
  const h2h = isAway ? game.h2h.away : game.h2h.home;
  const oppH2h = isAway ? game.h2h.home : game.h2h.away;
  // Convention: Over renders on the away row, Under on the home row — a
  // total isn't really "owned" by either team, this just keeps one row per
  // team without a third, teamless row for it.
  const totalLabel = total ? `${isAway ? 'o' : 'u'}${total.point ?? ''} ` : null;
  // The moneyline candidate's own no-vig consensus probability doubles as a
  // plain "chance to win" — the same number the algorithm's edge grading is
  // already built from, just read as a probability instead of a price —
  // only useful pregame, so it's swapped for the actual score once the game
  // has started.
  const winPct = h2h && gameState === 'upcoming' ? `${Math.round(h2h.consensusProb * 100)}%` : null;
  const logo = teamLogoUrl(game.sportKey, team);
  const suppressRec = gameState !== 'upcoming';
  const score = gameState === 'upcoming' ? null : slateScoreFor(scoreEvent, team);

  return `
    <div class="slate-team-row ${hideMarkets ? 'no-markets' : ''}">
      <span class="slate-team">
        ${logo ? `<img class="slate-logo" src="${esc(logo)}" alt="" loading="lazy">` : ''}
        ${esc(team)}${winPct ? ` <span class="slate-team-pct">${winPct}</span>` : ''}
        ${score != null ? ` <span class="slate-team-score">${score}</span>` : ''}
      </span>
      ${hideMarkets ? '' : `
      ${slateCell(spread, oppSpread, { suppressRec, isRec: spread && spread.id === recommendedId })}
      ${slateCell(total, oppTotal, { totalLabel, suppressRec, isRec: total && total.id === recommendedId })}
      ${slateCell(h2h, oppH2h, { suppressRec, isRec: h2h && h2h.id === recommendedId })}
      `}
    </div>`;
}

/**
 * The single highest-graded side across every market on this game — the
 * subject of the game's "More Info" analysis card. Prefers a candidate
 * inside Pixel Picks' own sharp band (-250/+250): raw score alone can let
 * an extreme long shot win this comparison (a thin "consensus" built from
 * as few as 2 other books, per RULES.MIN_BOOKS, is noisy, and a single
 * soft/stale outlier price can make a real 9%-to-win moneyline look like
 * value that isn't there) — and however defensible the EV math, a 9%
 * shot is never what a reasonable person would call "the pick" for a
 * whole game. Falls back to whatever's least extreme if nothing on this
 * game actually clears the band, so More Info still has something to show.
 */
function bestCandidateForGame(game) {
  const all = [
    game.h2h.away, game.h2h.home,
    game.spreads.away, game.spreads.home,
    game.totals.away, game.totals.home,
  ].filter(Boolean);
  if (!all.length) return null;

  const inBand = all.filter((c) => c.american >= CONFIG.ODDS_MIN_DEFAULT && c.american <= CONFIG.ODDS_MAX_DEFAULT);
  const pool = inBand.length ? inBand : all;
  return pool.reduce((best, c) => (c.score > best.score ? c : best));
}

/** The market-mate of a candidate already known to belong to this game. */
function opponentOf(game, cand) {
  for (const market of [game.h2h, game.spreads, game.totals]) {
    if (market.away === cand) return market.home;
    if (market.home === cand) return market.away;
  }
  return null;
}

function slateGameHtml(game) {
  const idx = renderedSlateGames.push(game) - 1;
  const rec = bestCandidateForGame(game);
  const hasAnyPrice = rec != null;
  const isMlb = game.sportKey === 'baseball_mlb';

  const gameState = slateGameState(game);
  const scoreEvent = state.slateScores.get(game.eventId);
  // The odds feed drops a game's prices the moment it's decided, so a
  // just-finished game is often "orphaned" (see buildSlateGames) with no
  // live candidate left to name a pick from at all. The server's own
  // tracked Full Slate pick (worker/src/full-slate-tracking.js) survives
  // that — and once it's graded, it's the same record the Tracking
  // Dashboard shows, so it's preferred over a live recompute even when one
  // is still available, so this card and that history entry never disagree.
  const trackedPick = state.slateTrackedPicks.get(game.eventId) ?? null;
  const trackedOutcome = trackedPick?.status === 'won' ? 'won' : trackedPick?.status === 'lost' ? 'lost' : null;
  const outcome = trackedOutcome ?? slateGameOutcome(game, rec); // 'won' | 'lost' | null — only set once finished
  const mainPlaySelection = trackedPick?.selection ?? rec?.selection ?? null;
  const isFinished = gameState === 'finished';
  // The market grid only means anything pregame — once a game is live the
  // prices are stale and the algorithm's read was a pregame one, so it's
  // dropped for live games exactly like it already was for finished ones.
  const hideMarkets = gameState !== 'upcoming';
  const rowProps = { gameState, scoreEvent, recommendedId: rec?.id ?? null, hideMarkets };

  const cardClass = [
    'slate-game',
    gameState === 'live' ? 'is-live' : '',
    outcome ? `pick-${outcome}` : '', // pick-won -> green border, pick-lost -> red border
  ].filter(Boolean).join(' ');

  // "More Info"/"View Stats" only makes sense pregame or live — once a game
  // is finished, the game state itself (score + Final) is the whole story,
  // and the button that would open it is dropped rather than left pointing
  // at a decision that's already made.
  const showInfoButton = hasAnyPrice && gameState !== 'finished';
  const infoButtonHtml = !showInfoButton ? '' : isMlb
    ? `<button type="button" class="more-info-btn" data-show-mlb-stats="${idx}">View Stats</button>`
    : `<button type="button" class="more-info-btn" data-more-info="${idx}">More Info</button>`;

  const timeHtml = isFinished
    ? `<span class="slate-final">Final</span>`
    : gameState === 'live'
      ? `<span class="slate-live-badge">● Live</span>`
      : `<span>${esc(dateFmt.format(new Date(game.commenceMs)))}</span>`;

  // Once a game is live or finished, the per-market price grid no longer
  // means anything — replaced by a single line naming the algorithm's Main
  // play (the same candidate the card's green/red border is graded from
  // once finished). Only a finished game ever has an outcome to tag —
  // slateGameOutcome() returns null for a live game, so the Won/Lost badge
  // simply never appears until there's an actual result to show.
  const mainPlayHtml = hideMarkets && mainPlaySelection
    ? `<div class="slate-main-play">
        <span class="slate-main-play-label">Main play</span>
        <span class="slate-main-play-selection">${esc(mainPlaySelection)}</span>
        ${outcome ? `<span class="slate-main-play-outcome is-${outcome}">${outcome === 'won' ? '✅ Won' : '❌ Lost'}</span>` : ''}
      </div>`
    : '';

  return `
    <article class="${cardClass}" ${isMlb ? `data-game-index="${idx}"` : ''}>
      <div class="slate-game-time">
        ${timeHtml}
        ${infoButtonHtml}
      </div>
      ${hideMarkets ? '' : `
      <div class="slate-header-row">
        <span></span><span>Spread</span><span>O/U</span><span>ML</span>
      </div>`}
      ${slateTeamRow(game, 'away', rowProps)}
      ${slateTeamRow(game, 'home', rowProps)}
      ${mainPlayHtml}
    </article>`;
}

/** Every real sport key currently loaded into state.rawEvents. */
function loadedSportKeys() {
  return new Set((state.rawEvents ?? []).map((e) => e.sport_key));
}

/** Games within the current day filter (today/tomorrow, MMA exempt) across a league group's raw keys. */
function groupGameCount(group) {
  const keys = new Set(group.keys);
  return (state.rawEvents ?? []).filter((e) => {
    if (!keys.has(e.sport_key)) return false;
    const commenceMs = new Date(e.commence_time).getTime();
    return Number.isFinite(commenceMs) && withinDayFilter(commenceMs, e.sport_key);
  }).length;
}

/**
 * The fixed league groups, each with its live game count — except NBA/
 * NCAAB, which show "off-season" instead (see LEAGUE_GROUPS' offSeason
 * flag): those two are never fetched at all, so a live count would always
 * read 0 regardless of the real season state. Every other group is always
 * "loaded" in the sense that refreshAllLeagues() already asked for it on
 * boot — a count of 0 for one of those just means nothing's on the board
 * right now (MMA between fight weeks, say), not that it needs fetching.
 */
function renderSlateLeagueOptions() {
  el.slateLeagueSelect.disabled = false;
  if (!state.slateLeague) state.slateLeague = LEAGUE_GROUPS[0].id;

  el.slateLeagueSelect.innerHTML = LEAGUE_GROUPS
    .map((group) => {
      let label;
      if (group.offSeason) {
        label = `${group.label}: off-season`;
      } else {
        const count = groupGameCount(group);
        label = `${group.label}: ${count} game${count === 1 ? '' : 's'}`;
      }
      return `<option value="${esc(group.id)}" ${group.id === state.slateLeague ? 'selected' : ''}>${esc(label)}</option>`;
    })
    .join('');

  if (el.slateLeagueTokens) {
    el.slateLeagueTokens.innerHTML = LEAGUE_GROUPS
      .map((group) => `
        <button type="button" class="league-token ${group.id === state.slateLeague ? 'is-active' : ''} ${group.offSeason ? 'is-off-season' : ''}"
                data-league-token="${esc(group.id)}" title="${esc(group.label)}" aria-label="${esc(group.label)}">
          <span class="league-token-icon" aria-hidden="true">${LEAGUE_ICONS[group.id] ?? '●'}</span>
        </button>`)
      .join('');
  }
}

/**
 * Filter MMA games to only those with known event metadata and upcoming
 * dates. Deliberately does NOT require a graded moneyline candidate — a
 * fight with fewer than RULES.MIN_BOOKS quoting it (a real, common state
 * for a card early in the week, or a thin promotion like PFL) still has a
 * real event and belongs on the card list, same as how buildSlateGames
 * already shows a thin market with a dash instead of hiding the game
 * everywhere else in the app. Confirmed live: this silently dropped every
 * PFL Charlotte fight from the event dropdown (only 2 books were quoting
 * it, below the 3-book candidate floor) even though the fights themselves
 * were real and upcoming.
 */
/** Fallback card name for a live or finished fight whose odds-feed
 * enrichment (see buildSlateGames' orphan backfill) is gone along with its
 * markets and wasn't recovered from state.mmaEventCache either (typically
 * because the app never saw it while it was still pregame and priced, e.g.
 * a fresh page load mid-event) — still worth showing, just not attached to
 * a named card. */
const UNKNOWN_MMA_CARD = 'Other Fights';

function filterMmaGames(games) {
  const now = Date.now();
  const oneWeekMs = 9 * 24 * 60 * 60 * 1000;

  return games.filter((game) => {
    // A fight that has already started — live or finished — is real
    // regardless of whether its card enrichment survived losing its
    // market. Gating this on 'finished' alone (the old behavior) meant an
    // in-progress fight that hadn't been graded yet, or one /scores never
    // reliably reports on (early prelims are the common case), vanished
    // from the board entirely: not upcoming, not live, not finished.
    // Confirmed live: two prelim fights on a currently-airing card were
    // simply gone from every filter once their markets dropped.
    if (game.commenceMs <= now) return true;

    // Must have event enrichment (live ESPN lookup or fallback date-based)
    if (!game.ufc_event?.event) return false;

    // Should be within about a week out — no lower bound, so a card that's
    // started stays visible instead of vanishing mid-event.
    if (game.commenceMs > now + oneWeekMs) return false;

    return true;
  });
}

/**
 * Group MMA bouts into cards by UFC event name. Only includes UFC/PFL events
 * with moneyline markets coming up soon.
 */
function mmaClusters(games) {
  // Filter to only UFC/PFL events with markets, coming soon
  const filtered = filterMmaGames(games);
  if (!filtered.length) return [];

  // Group by UFC event name
  const byEvent = new Map();
  for (const game of filtered) {
    const eventKey = game.ufc_event?.event ?? UNKNOWN_MMA_CARD;
    if (!byEvent.has(eventKey)) byEvent.set(eventKey, []);
    byEvent.get(eventKey).push(game);
  }

  return [...byEvent.entries()]
    .map(([eventKey, cardGames]) => {
      const label = cardGames.length > 1
        ? `${eventKey}: ${cardGames.length} fights`
        : eventKey;
      return { eventKey, games: cardGames, label };
    })
    .sort((a, b) => {
      // Sort by first game's commence time
      const aTime = a.games[0]?.commenceMs ?? 0;
      const bTime = b.games[0]?.commenceMs ?? 0;
      return aTime - bTime;
    });
}

/**
 * Group tennis matches by tournament — each ATP/WTA sport key from the Odds
 * API already is one tournament (this week's Canadian Open, say), so the
 * "event" here is just that key, labelled from the catalogue's own title.
 */
function tennisClusters(games) {
  const byKey = new Map();
  for (const game of games) {
    if (!byKey.has(game.sportKey)) byKey.set(game.sportKey, []);
    byKey.get(game.sportKey).push(game);
  }

  return [...byKey.entries()]
    .map(([eventKey, matches]) => {
      const title = state.catalogue.find((s) => s.key === eventKey)?.title ?? eventKey;
      const label = `${title}: ${matches.length} match${matches.length === 1 ? '' : 'es'}`;
      return { eventKey, games: matches, label, title };
    })
    .sort((a, b) => {
      const aTime = a.games[0]?.commenceMs ?? 0;
      const bTime = b.games[0]?.commenceMs ?? 0;
      return aTime - bTime;
    });
}

/** MMA clusters by UFC card, tennis clusters by tournament, everyone else has no sub-event. */
function eventClustersFor(groupId, games) {
  if (groupId === 'mma') return mmaClusters(games);
  if (groupId === 'atp' || groupId === 'wta') return tennisClusters(games);
  return [];
}

function renderFullSlate() {
  renderedSlateCells.length = 0;
  renderedSlateGames.length = 0;

  const group = LEAGUE_GROUP_BY_ID.get(state.slateLeague) ?? LEAGUE_GROUPS[0];

  // NBA/NCAAB are onboarded as placeholders only (see LEAGUE_GROUPS) — no
  // live fetch happens for either, in-season or not, until someone
  // explicitly wires them into refreshAllLeagues()'s fetch list. Short-
  // circuit before any of the refresh calls below so selecting the tab
  // never triggers a request for a league that isn't actually tracked yet.
  if (group.offSeason) {
    el.slateBody.innerHTML = `<p class="empty">${esc(group.label)} is coming soon — tracking starts once the season is underway.</p>`;
    el.slateEventRow.hidden = true;
    return;
  }

  // Fire-and-forget: renders now with whatever's already cached (nothing on
  // first load), then repaints once fresh scores land — but only if the
  // user is still looking at this same league by the time they do, so a
  // slow response can't overwrite a board they've since navigated away from.
  refreshSlateScores(group).then((updated) => {
    if (updated && (LEAGUE_GROUP_BY_ID.get(state.slateLeague) ?? LEAGUE_GROUPS[0]) === group) {
      renderFullSlate();
    }
  });
  refreshSlateTrackedPicks().then((updated) => {
    if (updated && (LEAGUE_GROUP_BY_ID.get(state.slateLeague) ?? LEAGUE_GROUPS[0]) === group) {
      renderFullSlate();
    }
  });

  const allGames = buildSlateGames(group.keys);

  if (!allGames.length) {
    el.slateBody.innerHTML = `<p class="empty">Nothing on the board for ${esc(group.label)} right now. Check back closer to game time.</p>`;
    el.slateEventRow.hidden = true;
    return;
  }

  let games = allGames;
  const clusters = eventClustersFor(group.id, allGames);
  const eventLabel = group.id === 'mma' ? 'Card' : 'Event';
  el.slateEventLabel && (el.slateEventLabel.textContent = eventLabel);

  if (clusters.length >= 2) {
    const totalGames = clusters.reduce((sum, c) => sum + c.games.length, 0);
    const allLabel = group.id === 'mma' ? `All cards: ${totalGames} fights` : `All of ${group.label}: ${totalGames} matches`;
    const options = [`<option value="all">${esc(allLabel)}</option>`]
      .concat(clusters.map((c) => {
        const value = c.eventKey;
        return `<option value="${esc(value)}" ${value === state.slateEvent ? 'selected' : ''}>${esc(c.label)}</option>`;
      }));
    el.slateEventSelect.innerHTML = options.join('');
    el.slateEventRow.hidden = false;

    if (state.slateEvent !== 'all') {
      const match = clusters.find((c) => c.eventKey === state.slateEvent);
      games = match ? match.games : [];
    } else {
      games = clusters.flatMap((c) => c.games);
    }
  } else if (clusters.length === 1) {
    games = clusters[0].games;
    el.slateEventRow.hidden = true;
  } else {
    // No sub-event grouping for this league (or nothing clustered) — show everything.
    el.slateEventRow.hidden = true;
  }

  // Upcoming/Finished toggle — applied after event/card selection so
  // switching it never reshuffles the tournament/card dropdown itself. A
  // live game stays under "Upcoming" (its card already swaps in a Live
  // badge + score in place of the pregame time/markets) rather than needing
  // its own tab — only a truly finished game moves out.
  games = games.filter((g) => (state.slateGameFilter === 'finished') === (slateGameState(g) === 'finished'));

  // Pre-fetch fighter research for every MMA game now on the board, ahead
  // of any "More Info" click — see prefetchMmaContext's own comment. No-op
  // for every other league (mmaContextFor is MMA-specific).
  if (group.id === 'mma' && games.length) {
    prefetchMmaContext(games);
  }

  // Get sort preference (default to chronological)
  const sortMode = el.slateSortSelect?.value || 'time';

  // Sort games based on selected mode
  if (sortMode === 'confidence') {
    // Sort by home team moneyline odds (as confidence proxy)
    games = games.sort((a, b) => {
      const aConfidence = a.h2h?.home?.score ?? 50;
      const bConfidence = b.h2h?.home?.score ?? 50;
      return bConfidence - aConfidence; // High to low
    });
  } else if (sortMode === 'both') {
    // Sort by event time first, then by confidence within each event
    games = games.sort((a, b) => {
      if (a.ufc_event?.event !== b.ufc_event?.event) {
        return a.commenceMs - b.commenceMs;
      }
      const aConfidence = a.h2h?.home?.score ?? 50;
      const bConfidence = b.h2h?.home?.score ?? 50;
      return bConfidence - aConfidence;
    });
  } else {
    // Chronological (default)
    games = games.sort((a, b) => a.commenceMs - b.commenceMs);
  }

  // Render chronological slate view
  if (games.length) {
    let currentEvent = null;
    let html = '';

    for (const game of games) {
      let eventName;
      if (group.id === 'mma') {
        eventName = game.ufc_event?.event ?? UNKNOWN_MMA_CARD;
      } else if (group.id === 'atp' || group.id === 'wta') {
        eventName = state.catalogue.find((s) => s.key === game.sportKey)?.title ?? group.label;
      } else {
        eventName = group.label;
      }

      // Add event header when event changes
      if (eventName !== currentEvent) {
        if (currentEvent !== null) {
          html += '</div>'; // Close previous event section
        }
        html += `<div class="slate-event-section"><h3 class="slate-event-header">${esc(eventName)}</h3>`;
        currentEvent = eventName;
      }

      html += slateGameHtml(game);
    }

    if (currentEvent !== null) {
      html += '</div>'; // Close last event section
    }

    el.slateBody.innerHTML = html;
  } else {
    const emptyMsg = state.slateGameFilter !== 'upcoming'
      ? `No ${state.slateGameFilter} games for ${group.label} right now.`
      : group.id === 'mma'
        ? 'No upcoming UFC/PFL events with moneyline markets. Check back soon!'
        : `Nothing on the board for ${group.label} right now.`;
    el.slateBody.innerHTML = `<p class="empty">${esc(emptyMsg)}</p>`;
  }
}

/**
 * One league's odds, merged into state.rawEvents/state.candidates (dedup by
 * id — safe to call repeatedly, including for a key already loaded). The
 * building block refreshAllLeagues() uses to load everything on boot, and
 * that Full Slate's manual refresh re-runs for just the currently viewed
 * group.
 */
async function fetchSingleLeague(sportKey) {
  if (!CONFIG.WORKER_URL) return; // demo mode ships every demo league already loaded

  const url = new URL('/odds', CONFIG.WORKER_URL);
  url.searchParams.set('sports', sportKey);
  const headers = { Accept: 'application/json' };
  const token = getToken();
  if (CONFIG.REQUIRE_AUTH && token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (CONFIG.REQUIRE_AUTH && response.status === 401) {
    signOut();
    return;
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error ?? `Odds proxy returned ${response.status}`);
  }

  const data = await response.json();
  const existingEventIds = new Set(state.rawEvents.map((e) => e.id));
  for (const event of data.events) {
    if (!existingEventIds.has(event.id)) state.rawEvents.push(event);
  }
  const existingCandidateIds = new Set(state.candidates.map((c) => c.id));
  for (const c of analyze(data.events)) {
    if (!existingCandidateIds.has(c.id)) state.candidates.push(c);
  }
}

/**
 * Full Slate's own refresh — re-fetches every raw key behind the currently
 * viewed league group (the worker's 15-minute cache means this is free if
 * nothing's changed upstream since the last pull, so there's no separate
 * client-side throttle beyond disabling the button mid-fetch).
 */
async function loadSlate() {
  const group = LEAGUE_GROUP_BY_ID.get(state.slateLeague) ?? LEAGUE_GROUPS[0];
  el.slateLoad.disabled = true;
  el.slateBody.innerHTML = `<p class="empty">Refreshing ${esc(group.label)}…</p>`;
  try {
    populateTennisGroups();
    await Promise.all(group.keys.map((key) => fetchSingleLeague(key)));
    state.slateRefreshTime = Date.now();
    renderSlateLeagueOptions();
    renderFullSlate();
    refreshQualitativeSignals(); // fire-and-forget — enriches any newly-arrived games
  } catch (error) {
    el.slateBody.innerHTML = `<p class="empty">Couldn't reach the odds feed. ${esc(error.message)}</p>`;
  } finally {
    el.slateLoad.disabled = false;
  }
}

/**
 * Re-order an already-generated slate for display. topPicks() itself always
 * returns confidence-descending — everything else here is a pure display
 * re-sort of that same set, never a re-roll of which picks qualified.
 */
function sortPicks(picks, mode) {
  const sorted = [...picks];
  const earliest = (pick) => Math.min(...pick.legs.map((leg) => leg.commenceMs));
  if (mode === 'odds-asc') sorted.sort((a, b) => a.american - b.american);
  else if (mode === 'odds-desc') sorted.sort((a, b) => b.american - a.american);
  else if (mode === 'chrono') sorted.sort((a, b) => earliest(a) - earliest(b));
  else sorted.sort((a, b) => b.score - a.score); // 'confidence', the default
  return sorted;
}

/** state.candidates narrowed to the current Today/Tomorrow window (MMA exempt — see withinDayFilter). */
function dayFilteredCandidates() {
  return state.candidates.filter((c) => withinDayFilter(c.commenceMs, c.sportKey));
}

/**
 * Turn one stored, locked Pixel's Picks record into a displayable pick.
 * Looks for a live candidate still in state.candidates matching the same id
 * (the same eventId+market+outcome+point scheme both the client and the
 * worker's own topPicks() call produce) — when found, the pick renders with
 * the full live price/book table/why panel exactly like any other card;
 * when not (the game's started, or the market's fallen off the board), it
 * degrades to a simpler card built from the stored record alone (see
 * renderDegradedPick). Either way the SELECTION and RANK are exactly what
 * the server locked in at 2am ET — only supplementary display data (current
 * price, book comparison) can ever differ from that.
 */
function pixelPickFromRecord(record) {
  const live = state.candidates.find((c) => c.id === record.pickId);
  if (live) {
    return {
      type: 'single',
      legs: [live],
      american: live.american,
      score: record.score,
      percentile: null,
      meetsStandard: record.meetsStandard,
      flagReason: record.flagReason,
    };
  }
  return {
    type: 'single',
    degraded: true,
    record,
    legs: [{ commenceMs: record.commenceMs }],
    american: record.american,
    score: record.score,
    meetsStandard: record.meetsStandard,
    flagReason: record.flagReason,
  };
}

/** Re-render the board from whatever's currently in pixelPicksRecords — no re-fetch, so the Sort control and a bankroll change can both call this directly. */
function renderPixelPicksBoard() {
  const picks = pixelPicksRecords.map(pixelPickFromRecord);
  state.lastPixelSlate = { picks, poolSize: picks.length };
  el.pixelSortRow.hidden = !picks.length;
  renderSlate({ picks: sortPicks(picks, state.pixelSort), poolSize: picks.length });
}

let pixelPicksRecords = [];

/**
 * Pixel's Picks: the worker's own locked, server-generated set for today
 * (2am ET — see worker/src/tracking.js's runTop5Batch), fetched once and
 * rendered here rather than recomputed client-side against a drifting
 * board. The same 5 (or more, on a day the sharp standard pads out with
 * flagged picks) show no matter how many times the page is reloaded or how
 * the market has moved since 2am. The manual Sort control still re-orders
 * for display — it never changes which picks these are.
 */
async function loadPixelPicks() {
  if (!CONFIG.WORKER_URL) {
    el.picks.innerHTML = `<p class="empty">Pixel's Picks needs the odds worker. Set WORKER_URL in config.js.</p>`;
    el.pixelSortRow.hidden = true;
    return;
  }

  try {
    await enrichTennisAltSpreads();
    const url = new URL('/top5', CONFIG.WORKER_URL);
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await res.json();
    pixelPicksRecords = data.picks ?? [];
  } catch (error) {
    el.picks.innerHTML = `<p class="empty">Couldn't reach the odds feed.
      ${esc(error.message)}</p>`;
    el.pixelSortRow.hidden = true;
    return;
  }

  renderPixelPicksBoard();
}

// A delegated listener per container covers every "?" button inside it,
// including re-rendered ones.
function toggleWhyPanel(event) {
  const button = event.target.closest('.why-btn');
  if (!button) return;
  const panel = document.getElementById(button.getAttribute('aria-controls'));
  const open = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!open));
  panel.hidden = open;
}

/**
 * A leg renders collapsed to its banner (selection + matchup) by default —
 * the full price/why/books breakdown was pushing a whole Pixel
 * Picks board past a single screen. Tapping the banner reveals it.
 */
function toggleLegBanner(event) {
  const button = event.target.closest('.leg-banner');
  if (!button) return;
  const detail = document.getElementById(button.getAttribute('aria-controls'));
  const open = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!open));
  detail.hidden = open;
}

// Delegated listener on the Board's picks list, the one container that
// renders a "?" why-button via renderLeg.
el.picks.addEventListener('click', toggleWhyPanel);
el.picks.addEventListener('click', toggleLegBanner);

el.dayFilterToday.addEventListener('click', () => setDayFilter('today'));
el.dayFilterTomorrow.addEventListener('click', () => setDayFilter('tomorrow'));

el.slateStateUpcoming.addEventListener('click', () => setSlateGameFilter('upcoming'));
el.slateStateFinished.addEventListener('click', () => setSlateGameFilter('finished'));

el.slateLoad.addEventListener('click', loadSlate);
el.slateLeagueSelect.addEventListener('change', () => {
  state.slateLeague = el.slateLeagueSelect.value || null;
  state.slateEvent = 'all'; // a card filter from the old league means nothing for a new one
  saveJSON(SLATE_LEAGUE_KEY, state.slateLeague);
  // Re-render the token row too, so its active-glow token switches in step
  // with the select — found live: without this, the just-clicked token kept
  // showing whichever league was active before, until some later unrelated
  // refresh happened to redraw the row.
  renderSlateLeagueOptions();
  renderFullSlate();
});
// The glowing icon tokens are a second way to trigger the exact same
// selection — set the select's value and dispatch a real 'change' so the
// listener above is the only place that ever runs the actual state update,
// rather than duplicating it here.
el.slateLeagueTokens?.addEventListener('click', (event) => {
  const token = event.target.closest('[data-league-token]');
  if (!token) return;
  el.slateLeagueSelect.value = token.dataset.leagueToken;
  el.slateLeagueSelect.dispatchEvent(new Event('change'));
});
el.slateEventSelect.addEventListener('change', () => {
  state.slateEvent = el.slateEventSelect.value;
  renderFullSlate();
});
el.slateSortSelect?.addEventListener('change', () => {
  renderFullSlate();
});
el.slateBody.addEventListener('click', (event) => {
  const mlbStats = event.target.closest('[data-show-mlb-stats]');
  if (mlbStats) {
    const game = renderedSlateGames[Number(mlbStats.dataset.showMlbStats)];
    if (game) {
      showTeamStats(game.away, game.home);
    }
    return;
  }

  const moreInfo = event.target.closest('[data-more-info]');
  if (moreInfo) {
    const game = renderedSlateGames[Number(moreInfo.dataset.moreInfo)];
    const best = game ? bestCandidateForGame(game) : null;
    if (best) openStatsDrawer(best, opponentOf(game, best), { fullscreen: true });
    return;
  }

  const button = event.target.closest('[data-slate-cell]');
  if (!button) return;
  const entry = renderedSlateCells[Number(button.dataset.slateCell)];
  if (entry) openStatsDrawer(entry.cand, entry.opposite, { oddsOnly: true });
});

el.statsBody.addEventListener('click', async (event) => {
  const categoryBtn = event.target.closest('[data-mlb-category]');
  if (categoryBtn && currentMlbStats) {
    currentMlbStats.category = categoryBtn.dataset.mlbCategory;
    renderMlbStatsPanel();
    return;
  }

  const scheduleTabBtn = event.target.closest('[data-mlb-schedule-tab]');
  if (scheduleTabBtn && currentMlbStats) {
    const tab = scheduleTabBtn.dataset.mlbScheduleTab;
    currentMlbStats.scheduleTab = tab;
    if (tab === 'h2h' && currentMlbStats.headToHead === undefined) {
      renderMlbStatsPanel(); // shows the "Loading head-to-head…" state immediately
      const d = currentMlbStats;
      try {
        const url = new URL('/mlb-stats', CONFIG.WORKER_URL);
        url.searchParams.set('team', d.awayAbbrev);
        url.searchParams.set('opponent', d.homeAbbrev);
        url.searchParams.set('h2h', '1');
        const data = await fetch(url, { headers: { Accept: 'application/json' } }).then((r) => r.json());
        d.headToHead = data.headToHead ?? [];
      } catch {
        d.headToHead = [];
      }
      // Only re-render if the panel is still open on this same matchup —
      // the user could have closed it or opened a different game while this awaited.
      if (currentMlbStats === d) renderMlbStatsPanel();
      return;
    }
    renderMlbStatsPanel();
    return;
  }

  const outingsBtn = event.target.closest('[data-pitcher-outings]');
  if (outingsBtn && currentMlbStats) {
    const d = currentMlbStats;
    const playerId = outingsBtn.dataset.playerId;
    if (d.pitcherOutings[playerId] !== undefined) {
      // Already loaded (or currently loading) — toggling again just hides it.
      delete d.pitcherOutings[playerId];
      renderMlbStatsPanel();
      return;
    }
    d.pitcherOutings[playerId] = null; // marks "loading" so a second click can't double-fetch
    renderMlbStatsPanel();
    try {
      const url = new URL('/mlb-pitcher-outings', CONFIG.WORKER_URL);
      url.searchParams.set('player', playerId);
      const data = await fetch(url, { headers: { Accept: 'application/json' } }).then((r) => r.json());
      d.pitcherOutings[playerId] = data.outings ?? [];
    } catch {
      d.pitcherOutings[playerId] = [];
    }
    if (currentMlbStats === d) renderMlbStatsPanel();
  }
});

el.bankrollToggle.addEventListener('click', () => setBankrollOpen(el.bankrollPanel.hidden));
el.bankrollClose.addEventListener('click', () => setBankrollOpen(false));

el.guideToggle.addEventListener('click', () => setGuideOpen(el.guidePanel.hidden));
el.guideClose.addEventListener('click', () => setGuideOpen(false));

el.aboutToggle.addEventListener('click', () => setAboutOpen(el.aboutPanel.hidden));
el.aboutClose.addEventListener('click', () => setAboutOpen(false));

el.learningPanelClose.addEventListener('click', () => {
  el.learningPanel.hidden = true;
  el.scrim.hidden = true;
});

el.trackerRefreshBtn?.addEventListener('click', async () => {
  el.trackerRefreshBtn.disabled = true;
  el.trackerRefreshBtn.style.opacity = '0.5';
  try {
    await loadTrackerHistories();
  } finally {
    el.trackerRefreshBtn.disabled = false;
    el.trackerRefreshBtn.style.opacity = '1';
  }
});

const learningToggle = document.getElementById('learningToggle');
if (learningToggle) {
  learningToggle.addEventListener('click', () => openLearningDashboard());
}

el.trackerTabs?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-tracker]');
  if (!btn) return;
  // All three trackers' history is already fetched (loadTrackerHistories,
  // called once per dashboard open) — switching tabs re-renders from that
  // cache, no re-fetch needed.
  state.activeTracker = btn.dataset.tracker;
  renderTrackerSection();
});

el.trackerSportFilter?.addEventListener('change', () => {
  state.trackerSportFilter = el.trackerSportFilter.value;
  // A day selected under one sport filter almost never has data under
  // another — clearing avoids the detail panel silently showing a stale
  // day's picks the filter no longer agrees are there.
  state.trackerCalendarSelectedDate = null;
  renderTrackerSection();
});

el.trackerViewTabs?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-tracker-view]');
  if (!btn) return;
  state.trackerView = btn.dataset.trackerView;
  renderTrackerSection();
});

el.trackerGraphBucketTabs?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-graph-bucket]');
  if (!btn) return;
  state.trackerGraphBucket = btn.dataset.graphBucket;
  renderTrackerSection();
});

el.trackerCalPrev?.addEventListener('click', () => {
  const d = new Date(state.trackerCalendarMonth);
  state.trackerCalendarMonth = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
  renderTrackerSection();
});

el.trackerCalNext?.addEventListener('click', () => {
  const d = new Date(state.trackerCalendarMonth);
  state.trackerCalendarMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  renderTrackerSection();
});

el.trackerCalendarGrid?.addEventListener('click', (event) => {
  const cell = event.target.closest('[data-cal-date]');
  if (!cell) return;
  const clicked = cell.dataset.calDate;
  state.trackerCalendarSelectedDate = state.trackerCalendarSelectedDate === clicked ? null : clicked;
  renderTrackerSection();
});

el.scrim.addEventListener('click', () => {
  if (openAside) setAsideOpen(openAside.panel, openAside.toggle, false);
  el.statsPanel.hidden = true;
  el.scrim.hidden = true;
});

el.statsClose?.addEventListener('click', () => {
  el.statsPanel.hidden = true;
  el.scrim.hidden = true;
});

el.pixelSort.addEventListener('change', () => {
  state.pixelSort = el.pixelSort.value;
  saveJSON(PIXEL_SORT_KEY, state.pixelSort);
  if (state.lastPixelSlate) {
    renderSlate({ ...state.lastPixelSlate, picks: sortPicks(state.lastPixelSlate.picks, state.pixelSort) });
  }
});

el.logoutBtn.addEventListener('click', signOut);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (openAside) setAsideOpen(openAside.panel, openAside.toggle, false);
});


/**
 * Re-renders whatever's already on screen with fresh "Suggested stake"
 * text — cheap (no re-fetch, no re-rank, just reflects the current
 * state.bankroll into already-rendered cards) — needed because Pixel's
 * Picks generates once automatically rather than on a Generate click the
 * user would naturally press again after setting their bankroll.
 */
function refreshStakeDisplays() {
  if (state.lastPixelSlate) {
    renderSlate({ ...state.lastPixelSlate, picks: sortPicks(state.lastPixelSlate.picks, state.pixelSort) });
  }
}

el.bankrollAmount.addEventListener('change', () => {
  state.bankroll.amount = Math.max(0, Number(el.bankrollAmount.value) || 0);
  persistBankroll();
  renderBankrollPanel();
});

el.bankrollUnit.addEventListener('change', () => {
  state.bankroll.unit = Math.max(0, Number(el.bankrollUnit.value) || 0);
  persistBankroll();
  renderBankrollPanel();
});

el.bankrollSubmit.addEventListener('click', () => {
  // Read the fields directly rather than relying on their 'change' events
  // having already fired — a value typed and then Submit clicked without
  // ever blurring the field should still be picked up.
  state.bankroll.amount = Math.max(0, Number(el.bankrollAmount.value) || 0);
  state.bankroll.unit = Math.max(0, Number(el.bankrollUnit.value) || 0);
  state.bankroll.confirmed = true;
  // Setting a unit size is a clear signal the user thinks in units — show
  // every "Suggested stake" as a recommended unit count by default rather
  // than making them separately discover the Units toggle.
  if (state.bankroll.unit > 0) state.bankroll.displayMode = 'units';
  persistBankroll();
  renderBankrollPanel();
  refreshStakeDisplays();
});

el.bankrollShowDollars.addEventListener('click', () => {
  state.bankroll.displayMode = 'dollars';
  persistBankroll();
  renderBankrollPanel();
  refreshStakeDisplays();
});

el.bankrollShowUnits.addEventListener('click', () => {
  state.bankroll.displayMode = 'units';
  persistBankroll();
  renderBankrollPanel();
  refreshStakeDisplays();
});

el.ownerKeyConnect.addEventListener('click', async () => {
  const key = el.ownerKeyInput.value.trim();
  if (!key) {
    renderOwnerKeyStatus('Enter your owner passphrase first.');
    return;
  }
  saveJSON(OWNER_KEY_STORAGE, key);
  renderOwnerKeyStatus('Connecting…');

  const result = await loadSettings();
  if (!result.ok) {
    // A bad key is kept out of storage entirely rather than left to fail on
    // every future save — otherwise the panel would read "connected" while
    // nothing ever syncs.
    saveJSON(OWNER_KEY_STORAGE, '');
    renderOwnerKeyStatus(
      result.reason === 'bad-key'
        ? 'That key was rejected. Bankroll is still saved on this device.'
        : 'Couldn\'t reach the server. Bankroll is still saved on this device.',
    );
    return;
  }

  el.ownerKeyInput.value = '';
  lastPushFailed = false;
  // Nothing stored server-side yet on a first connect — push this device's
  // current values up so the two sides agree immediately rather than after
  // the next unrelated edit.
  if (!result.hadRecord) pushSettingsSoon();
  renderBankrollPanel();
  refreshStakeDisplays();
  renderOwnerKeyStatus(result.hadRecord ? 'Connected — loaded your saved bankroll.' : 'Connected — this device\'s bankroll is now synced.');
});

el.ownerKeyForget.addEventListener('click', () => {
  saveJSON(OWNER_KEY_STORAGE, '');
  el.ownerKeyInput.value = '';
  lastPushFailed = false;
  // Deliberately leaves state.bankroll and its localStorage copy alone —
  // disconnecting shouldn't wipe the numbers off the device you're on.
  renderOwnerKeyStatus('Disconnected — still saved on this device.');
});

/* ---------------------------------------------------------------- */
/* Play of the Day                                                   */
/* ---------------------------------------------------------------- */

const potdDateTimeFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit',
});

/**
 * A PoTD-specific confidence bar rather than reusing renderConfidence — that
 * one's "Beats N% of the board" claim is relative to whatever pool a regular
 * Generate tap pulled, which has no meaning for a single daily editorial
 * pick with no board of its own to compare against.
 */
function renderPotdConfidence(score, stake) {
  const color = confidenceColor(score, RULES.MIN_SCORE);
  const stakeText = stakeLineHtml(stake);
  return `
    <div class="confidence" style="--conf:${color}">
      <div class="conf-track">
        <span class="conf-fill" style="width:${Math.round(score)}%"></span>
      </div>
      <div class="conf-label">
        <span>Confidence <span class="conf-score">${Math.round(score)}</span>/100</span>
      </div>
      ${stakeText}
    </div>`;
}

function renderPotdSection(section) {
  return `
    <div class="potd-section">
      <h3>${esc(section.title)}</h3>
      <ul>${section.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
    </div>`;
}

/**
 * The sharp-bettor-voiced write-up (worker/src/analysis.js's
 * getOrGenerateAnalysis, { isPotd: true }) — at least 5 reason bullets plus
 * flowing prose, on why this is today's single featured pick, not just the
 * price/market case the quantitative sections below already cover. Absent
 * entirely (not an empty section) whenever the feature isn't available (no
 * ANTHROPIC_API_KEY, a failed model call) — Play of the Day still has its
 * full quantitative write-up either way.
 */
function renderPotdSharpTake(writeup) {
  if (!writeup.analysis && !writeup.reasons?.length) return '';
  const reasonsHtml = writeup.reasons?.length
    ? `<ul class="quick-take-list">${writeup.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
    : '';
  return `
    <div class="potd-section potd-sharp-take">
      <h3>Why This Is Today's Play <span class="stats-source">Sharp analysis</span></h3>
      ${reasonsHtml}
      ${writeup.analysis ? `<p class="analysis-text">${esc(writeup.analysis)}</p>` : ''}
    </div>`;
}

/** Genuine risk to the pick itself, from the same sharp write-up — see renderPotdSharpTake. Same absent-when-unavailable behavior. */
function renderPotdDevilsAdvocate(writeup) {
  if (!writeup.devilsAdvocate?.length) return '';
  return `
    <div class="potd-section devil-advocate">
      <h3>Devil's Advocate</h3>
      <ul class="quick-take-list">${writeup.devilsAdvocate.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    </div>`;
}

/**
 * Every registered sportsbook's own price on this exact line — reuses
 * renderBooks/bookOffers (docs/app.js's own MMA/Full Slate pick cards
 * already render this identical table from the same candidate.quotes
 * shape) rather than a POTD-specific rebuild, so "where's the best price"
 * looks and behaves the same everywhere in the app.
 */
function renderPotdBooks(writeup) {
  if (!writeup.quotes?.length) return '';
  return `
    <div class="potd-section">
      <h3>Best Price Across Sportsbooks</h3>
      ${renderBooks(writeup)}
    </div>`;
}

/** The single Play of the Day card. */
function renderPotdCard(writeup, generatedAt, stale) {
  const staleNote = stale
    ? `<p class="potd-stale">Today's pick hasn't posted yet. Showing yesterday's.</p>`
    : '';
  return `
    <article class="potd-card">
      <div class="potd-head">
        <span class="chip"><strong>${esc(writeup.sportTitle)}</strong> · ${esc(writeup.marketLabel)}</span>
        <span class="price">${esc(writeup.price)}</span>
      </div>
      ${staleNote}
      <h2 class="potd-headline">${esc(writeup.headline)}</h2>
      <p class="potd-matchup">
        ${esc(writeup.matchup)} · ${esc(potdDateTimeFmt.format(new Date(writeup.commenceMs)))}
      </p>
      ${renderPotdConfidence(writeup.score, writeup.stake)}
      ${renderPotdBooks(writeup)}
      ${renderPotdSharpTake(writeup)}
      ${writeup.sections.map(renderPotdSection).join('')}
      ${renderPotdDevilsAdvocate(writeup)}
      <p class="potd-meta">
        Best price at ${esc(writeup.book)} · posted ${esc(potdDateTimeFmt.format(new Date(generatedAt)))}
      </p>
    </article>`;
}

function renderPotd(potd) {
  if (!potd) {
    el.potdBody.innerHTML = `<p class="empty">
      Nothing posted yet today. Play of the Day goes up once daily, around
      2am ET. Check back soon.</p>`;
    return;
  }

  const { writeup, generatedAt, stale } = potd;
  el.potdBody.innerHTML = renderPotdCard(writeup, generatedAt, stale);
}

let potdLoaded = false;
async function loadPotd({ force = false } = {}) {
  if (potdLoaded && !force) return;
  potdLoaded = true;

  if (!CONFIG.WORKER_URL) {
    el.potdBody.innerHTML = `<p class="empty">
      Play of the Day needs the odds worker. Set WORKER_URL in config.js.</p>`;
    return;
  }

  el.potdBody.innerHTML = `<p class="empty">Loading…</p>`;
  try {
    const res = await fetch(new URL('/potd', CONFIG.WORKER_URL), { headers: { Accept: 'application/json' } });
    const data = await res.json();
    renderPotd(data.potd ?? null);
  } catch {
    potdLoaded = false; // a network hiccup shouldn't permanently give up
    el.potdBody.innerHTML = `<p class="empty">Couldn't reach the odds feed.</p>`;
  }
}

function setActiveTab(tab) {
  const views = { slate: el.slateView, board: el.boardView, potd: el.potdView };
  const tabs = { slate: el.tabSlate, board: el.tabBoard, potd: el.tabPotd };

  for (const [name, view] of Object.entries(views)) {
    const active = name === tab;
    view.hidden = !active;
    tabs[name].classList.toggle('is-active', active);
    tabs[name].setAttribute('aria-selected', String(active));
  }

  // The day toggle applies to Full Slate only — Play of the Day and
  // Pixel's Picks are both fixed daily sets locked server-side, with no
  // Today/Tomorrow of their own to choose.
  el.dayFilterBar.hidden = tab === 'potd' || tab === 'board';

  if (tab === 'potd') loadPotd();
  // Re-render from whatever's already loaded rather than re-fetching —
  // everything loads once at boot (refreshAllLeagues), so switching tabs is
  // never itself a billed call.
  if (tab === 'slate') {
    renderSlateLeagueOptions();
    if (state.candidates.length) renderFullSlate();
  }
}

el.tabSlate.addEventListener('click', () => setActiveTab('slate'));
el.tabBoard.addEventListener('click', () => setActiveTab('board'));
el.tabPotd.addEventListener('click', () => setActiveTab('potd'));

/* ---------------------------------------------------------------- */
/* Tracking Dashboard                                                */
/* ---------------------------------------------------------------- */

function formatSignedMoney(amount) {
  const sign = amount > 0 ? '+' : amount < 0 ? '−' : '';
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

function formatSignedPct(pct) {
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Every pick the worker's own 2am batch has ever tracked, across every day still in KV (up to 90). */
async function fetchTop5History() {
  if (!CONFIG.WORKER_URL) return [];
  try {
    const url = new URL('/top5-history', CONFIG.WORKER_URL);
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    return data.picks ?? [];
  } catch {
    return [];
  }
}

/** CLV%, positive means the price beat the close. */
function top5ClvPct(pick) {
  if (!pick.clv) return null;
  return (impliedProb(pick.clv.closeAmerican) - impliedProb(pick.clv.openAmerican)) * 100;
}

/**
 * A pick actually cleared the sharp standard, vs. a guaranteeCount()
 * fallback padding out a thin day's board (see docs/engine.js's topPicks()
 * and worker/src/tracking.js's runTop5Batch). Flagged picks are tracked
 * (win/loss still recorded) but must never count toward the performance
 * metrics — undefined counts as true (Play of the Day has no padding
 * concept at all, so its records simply never carry this field).
 */
function meetsTrackingStandard(pick) {
  return pick.meetsStandard !== false;
}

/** Groups server-tracked picks by their own stored dateKey (not a pickId prefix — these ids are raw candidate ids, not date-prefixed like the client's). Every pick counts toward its day's own record/ROI/net, flagged or not — flagged ones still show the "⚠ flagged" badge in the row for transparency, they just aren't excluded from the math (see renderTrackerSection's own comment on why). */
function groupTop5ByDay(picks) {
  const byDay = new Map();
  for (const p of picks) {
    if (!byDay.has(p.dateKey)) byDay.set(p.dateKey, []);
    byDay.get(p.dateKey).push(p);
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, dayPicks]) => ({
      date,
      picks: dayPicks,
      ...summarizePicks(dayPicks),
    }));
}

/** Sets a metric card's text and colors it via the same .positive/.negative
 * convention renderTop5DayBlock's own day-roi/day-net already use — null
 * (nothing graded yet) stays the neutral em-dash with no color. */
function setTrendMetric(node, value, formatFn) {
  node.textContent = value != null ? formatFn(value) : '—';
  node.classList.toggle('positive', value != null && value > 0);
  node.classList.toggle('negative', value != null && value < 0);
}

function renderTop5DayBlock(day, open = false) {
  const dateLabel = new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
  const record = `${day.wins}-${day.losses}` + (day.pending ? ` · ${day.pending} pending` : '');
  const trendClass = day.net > 0 ? 'positive' : day.net < 0 ? 'negative' : '';

  const rows = day.picks.map((p) => {
    const statusClass = p.status === 'won' ? 'status-won' : p.status === 'lost' ? 'status-lost' : 'status-pending';
    const statusLabel = p.status === 'won' ? 'WIN' : p.status === 'lost' ? 'LOSS' : 'PENDING';
    const payoutLabel = p.result ? formatSignedMoney(p.result.payout) : '—';
    const flagged = !meetsTrackingStandard(p);
    return `
      <div class="day-pick-row ${statusClass}">
        <span class="pick-matchup">${esc(p.away)} @ ${esc(p.home)}${flagged ? ' <span class="pick-flag-inline" title="Outside standard criteria: a thin-day fallback pick, still counted in every total">⚠ flagged</span>' : ''}</span>
        <span class="pick-side">${esc(p.selection)}</span>
        <span class="pick-status">${statusLabel}</span>
        <span class="pick-payout">${esc(payoutLabel)}</span>
      </div>`;
  }).join('');

  return `
    <details class="day-block" ${open ? 'open' : ''}>
      <summary>
        <span class="day-date">${esc(dateLabel)}</span>
        <span class="day-record">${esc(record)}</span>
        <span class="day-roi ${trendClass}">${day.graded ? esc(formatSignedPct(day.roi)) : '—'}</span>
        <span class="day-net ${trendClass}">${day.graded ? esc(formatSignedMoney(day.net)) : '—'}</span>
      </summary>
      <div class="day-picks">${rows}</div>
    </details>`;
}

/** Every Play of the Day pick the worker has ever tracked (see worker/src/potd.js's getPotdHistory), up to 90 days. */
async function fetchPotdHistory() {
  if (!CONFIG.WORKER_URL) return [];
  try {
    const url = new URL('/potd-history', CONFIG.WORKER_URL);
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    return data.picks ?? [];
  } catch {
    return [];
  }
}

/** Every Full Slate pick the worker has ever tracked (see worker/src/full-slate-tracking.js's getAllFullSlateTracked) — one pick per game, every sport, no filtering — up to 90 days. */
async function fetchFullSlateHistory() {
  if (!CONFIG.WORKER_URL) return [];
  try {
    const url = new URL('/full-slate-history', CONFIG.WORKER_URL);
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    return data.picks ?? [];
  } catch {
    return [];
  }
}

const TRACKER_EMPTY_MESSAGES = {
  fullslate: 'Nothing tracked yet. The worker locks in one pick per game, across every sport, at 2am ET.',
  top5: 'Nothing tracked yet. The worker generates Pixel\'s Picks at 2am ET.',
  potd: 'Nothing tracked yet. The worker generates Play of the Day at 2am ET.',
};

/**
 * Fetches all three server-side trackers' full history once — Full Slate
 * (worker/src/full-slate-tracking.js, one pick per game, every sport, no
 * filtering), Pixel's Picks (worker/src/tracking.js, 5 locked picks/day),
 * and Play of the Day (worker/src/potd.js, 1 pick/day). All three return the
 * exact same record shape (dateKey/away/home/selection/status/result/
 * suggested_stake/clv/meetsStandard), so the same groupTop5ByDay/
 * renderTop5DayBlock/summarizePicks/top5ClvPct helpers work unchanged
 * against any of them. Returns the Top5 array specifically, since
 * Calibration & Audit stays Pixel's-Picks-scoped regardless of which
 * tracker tab is active (see renderTrackerSection's own comment).
 */
async function loadTrackerHistories() {
  const [fullSlate, top5, potd] = await Promise.all([
    fetchFullSlateHistory(), fetchTop5History(), fetchPotdHistory(),
  ]);
  state.trackerPicks = { fullslate: fullSlate, top5, potd };
  renderTrackerSection();
  return top5;
}

/**
 * Populates the sport filter <select> from whichever sports the active
 * tracker's own picks actually cover — never a fixed list, so a tracker with
 * no NHL picks yet simply doesn't offer an NHL option to filter into an
 * empty view. Grouped by sportGroupLabel() rather than raw sportKey so every
 * ATP/WTA tournament week collapses into one "ATP"/"WTA" option instead of a
 * new option per tournament. Falls back to "All Sports" if the previously-
 * selected filter's sport isn't present in this tracker's picks at all
 * (e.g. switching from Full Slate, which has NHL, to Play of the Day, which
 * that day didn't).
 */
function renderTrackerSportFilterOptions(allPicks) {
  const labels = [...new Set(allPicks.map((p) => sportGroupLabel(p.sportKey)))].sort((a, b) => a.localeCompare(b));

  if (state.trackerSportFilter !== 'all' && !labels.includes(state.trackerSportFilter)) {
    state.trackerSportFilter = 'all';
  }

  el.trackerSportFilter.innerHTML = [
    '<option value="all">All Sports</option>',
    ...labels.map((label) => `<option value="${esc(label)}">${esc(label)}</option>`),
  ].join('');
  el.trackerSportFilter.value = state.trackerSportFilter;
}

/** `sportFilter` is a sportGroupLabel() string ("MLB", "ATP") or "all" — see renderTrackerSportFilterOptions. */
function filterPicksBySport(picks, sportFilter) {
  if (sportFilter === 'all') return picks;
  return picks.filter((p) => sportGroupLabel(p.sportKey) === sportFilter);
}

/** Shows whichever of List/Calendar/Graph is active, hides the other two — and reflects it on the tab buttons themselves. */
function renderTrackerViewTabs() {
  el.trackerViewTabs?.querySelectorAll('[data-tracker-view]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.trackerView === state.trackerView);
  });
  el.top5DailyHistory.hidden = state.trackerView !== 'list';
  el.trackerCalendarView.hidden = state.trackerView !== 'calendar';
  el.trackerGraphView.hidden = state.trackerView !== 'graph';
}

/**
 * Month-grid calendar — one cell per calendar day, colored green (net
 * profit that day), red (net loss), or neutral (nothing graded yet / no
 * picks at all that day). Clicking a day with data toggles an expanded
 * detail panel below the grid showing that day's actual picks, reusing
 * renderTop5DayBlock (pre-opened, since the click itself is the "expand"
 * action — a second collapsed <details> the user has to click again would
 * be redundant).
 */
function renderTrackerCalendar(days) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const monthStart = new Date(state.trackerCalendarMonth);
  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();
  // Local date, not ET — this is purely a "which cell gets a highlight
  // ring" visual, not a data-correctness boundary the way a pick's own
  // dateKey (always ET) has to be.
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  el.trackerCalMonthLabel.textContent = monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  el.trackerCalendarWeekdays.innerHTML = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
    .map((d) => `<span>${d}</span>`).join('');

  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);

  el.trackerCalendarGrid.innerHTML = cells.map((day) => {
    if (day == null) return '<div class="calendar-cell is-empty"></div>';
    const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const entry = byDate.get(dateKey);
    const trendCls = !entry || !entry.graded ? 'is-neutral' : entry.net > 0 ? 'is-positive' : entry.net < 0 ? 'is-negative' : 'is-neutral';
    const todayCls = dateKey === todayKey ? ' is-today' : '';
    const selectedCls = state.trackerCalendarSelectedDate === dateKey ? ' is-selected' : '';
    const summary = !entry
      ? ''
      : entry.graded
        ? esc(formatSignedMoney(entry.net))
        : `${entry.pending} pend.`;
    return `
      <button type="button" class="calendar-cell ${trendCls}${todayCls}${selectedCls}" data-cal-date="${dateKey}" ${entry ? '' : 'disabled'}>
        <span class="calendar-daynum">${day}</span>
        ${summary ? `<span class="calendar-value">${summary}</span>` : ''}
      </button>`;
  }).join('');

  const selectedEntry = state.trackerCalendarSelectedDate ? byDate.get(state.trackerCalendarSelectedDate) : null;
  el.trackerCalendarDayDetail.innerHTML = selectedEntry ? renderTop5DayBlock(selectedEntry, true) : '';
}

/** YYYY-MM-DD -> the Monday of that ISO week, also YYYY-MM-DD — the bucket key renderTrackerGraph groups a "week" view by. */
function isoWeekStart(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const isoDay = (d.getDay() + 6) % 7; // 0=Monday..6=Sunday
  d.setDate(d.getDate() - isoDay);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Collapses day-level entries into day/week/month buckets, summing net $ and graded count per bucket — chronological (oldest first), the order a graph reads left-to-right. */
function bucketTrackerDays(days, bucket) {
  const chronological = [...days].sort((a, b) => a.date.localeCompare(b.date));
  if (bucket === 'day') {
    return chronological.map((d) => ({ label: d.date, net: d.net, graded: d.graded }));
  }
  const keyFor = bucket === 'week' ? isoWeekStart : (dateStr) => dateStr.slice(0, 7);
  const byBucket = new Map();
  for (const d of chronological) {
    const key = keyFor(d.date);
    if (!byBucket.has(key)) byBucket.set(key, { label: key, net: 0, graded: 0 });
    const b = byBucket.get(key);
    b.net += d.net;
    b.graded += d.graded;
  }
  return [...byBucket.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** A bucket's label (a date or year-month string) formatted for the graph's x-axis. */
function formatGraphLabel(label, bucket) {
  if (bucket === 'month') {
    const [y, m] = label.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  }
  return new Date(`${label}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * A hand-rolled SVG line chart of cumulative net $ over time — no charting
 * library, same "plain div/SVG math" approach the rest of this app already
 * uses for bars (statBar, compareRow) rather than pulling in a dependency
 * for something this size. Each point's dot is colored by that bucket's OWN
 * net (green/red), while the line itself is colored by where the running
 * total ends up — the two read together as "which single day/week/month
 * moved it" (the dots) vs. "how's the whole thing trending" (the line).
 * Buckets with nothing graded yet are excluded entirely — a pending day
 * plotted at $0 would misread as a wash instead of "no data yet."
 */
function renderTrackerGraph(days) {
  el.trackerGraphBucketTabs?.querySelectorAll('[data-graph-bucket]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.graphBucket === state.trackerGraphBucket);
  });

  const buckets = bucketTrackerDays(days.filter((d) => d.graded > 0), state.trackerGraphBucket);
  if (!buckets.length) {
    el.trackerGraphSvgWrap.innerHTML = '<p class="empty">Nothing graded yet — check back once today’s picks settle.</p>';
    return;
  }

  let running = 0;
  const series = buckets.map((b) => {
    running += b.net;
    return { ...b, cumulative: running };
  });

  const W = 720;
  const H = 260;
  const PAD_L = 60;
  const PAD_R = 16;
  const PAD_T = 16;
  const PAD_B = 32;
  const values = series.map((p) => p.cumulative);
  const minV = Math.min(0, ...values);
  const maxV = Math.max(0, ...values);
  const range = maxV - minV || 1;

  const xAt = (i) => PAD_L + (series.length === 1 ? (W - PAD_L - PAD_R) / 2 : (i / (series.length - 1)) * (W - PAD_L - PAD_R));
  const yAt = (v) => PAD_T + (1 - (v - minV) / range) * (H - PAD_T - PAD_B);

  const points = series.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.cumulative).toFixed(1)}`).join(' ');
  const lineColor = series[series.length - 1].cumulative >= 0 ? '#4ade80' : '#ef4444';
  const dots = series.map((p, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.cumulative).toFixed(1)}" r="3.5" fill="${p.net >= 0 ? '#4ade80' : '#ef4444'}" />`).join('');

  const labelEvery = Math.max(1, Math.ceil(series.length / 8));
  const xLabels = series.map((p, i) => (i % labelEvery === 0 || i === series.length - 1)
    ? `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" font-size="10" fill="var(--muted)" text-anchor="middle">${esc(formatGraphLabel(p.label, state.trackerGraphBucket))}</text>`
    : '').join('');

  const yTicks = [...new Set([minV, 0, maxV])];
  const yGrid = yTicks.map((v) => `<line x1="${PAD_L}" y1="${yAt(v).toFixed(1)}" x2="${W - PAD_R}" y2="${yAt(v).toFixed(1)}" stroke="var(--line)" stroke-width="1" ${v !== 0 ? 'stroke-dasharray="3,3"' : ''} />`).join('');
  const yLabels = yTicks.map((v) => `<text x="${PAD_L - 8}" y="${(yAt(v) + 3).toFixed(1)}" font-size="10" fill="var(--muted)" text-anchor="end">${esc(formatSignedMoney(v))}</text>`).join('');

  el.trackerGraphSvgWrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="tracker-graph-svg" preserveAspectRatio="xMidYMid meet">
      ${yGrid}
      <polyline points="${points}" fill="none" stroke="${lineColor}" stroke-width="2" />
      ${dots}
      ${xLabels}
      ${yLabels}
    </svg>`;
}

/**
 * Renders whichever of the three trackers state.activeTracker names into
 * the dashboard's one shared set of metric cards + history container —
 * three parallel DOM sections were considered and rejected in favor of this.
 *
 * Every pick counts toward its tracker's own totals, flagged or not — this
 * used to exclude Pixel's Picks' flagged (guaranteeCount() fallback)
 * picks, but that's a deliberate reversal: all 5 daily picks are tracked
 * "regardless of criteria." Full Slate and Play of the Day never flag
 * picks in the first place (no padding concept for either), so this only
 * actually changes Pixel's Picks' own numbers.
 *
 * Calibration & Audit (renderCalibrationReport) and Algorithm Health both
 * stay scoped to Pixel's Picks specifically, regardless of which tab is
 * active — both are about auditing/tuning Pixel's Picks' own selection
 * criteria, which Full Slate deliberately has none of and Play of the Day
 * has its own separate (untuned) −200/+150 band.
 */
function renderTrackerSection() {
  const allPicks = state.trackerPicks[state.activeTracker] ?? [];
  renderTrackerSportFilterOptions(allPicks);
  const picks = filterPicksBySport(allPicks, state.trackerSportFilter);

  const overall = summarizePicks(picks);
  const winRate = overall.graded ? (overall.wins / overall.graded) * 100 : 0;
  const clvValues = picks.map(top5ClvPct).filter((v) => v != null);
  const avgClv = clvValues.length ? clvValues.reduce((a, b) => a + b, 0) / clvValues.length : null;

  el.top5TotalPicks.textContent = overall.total;
  el.top5GradedPicks.textContent = overall.graded;
  el.top5WinRate.textContent = overall.graded ? winRate.toFixed(1) + '%' : '—';
  setTrendMetric(el.top5Roi, overall.graded ? overall.roi : null, formatSignedPct);
  setTrendMetric(el.top5NetProfit, overall.graded ? overall.net : null, formatSignedMoney);
  setTrendMetric(el.top5AvgClv, avgClv, formatSignedPct);

  const days = groupTop5ByDay(picks);

  el.trackerTabs?.querySelectorAll('[data-tracker]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tracker === state.activeTracker);
  });

  renderTrackerViewTabs();
  if (state.trackerView === 'list') {
    el.top5DailyHistory.innerHTML = days.length
      ? days.map((d) => renderTop5DayBlock(d)).join('')
      : `<p class="empty">${esc(TRACKER_EMPTY_MESSAGES[state.activeTracker])}</p>`;
  } else if (state.trackerView === 'calendar') {
    renderTrackerCalendar(days);
  } else if (state.trackerView === 'graph') {
    renderTrackerGraph(days);
  }
}

/**
 * Reporting only, per the brief this was scoped to — never adjusts any
 * threshold or weight itself. Computes a real Brier score (using each
 * pick's stored consensusProb, the model's own probability estimate, not
 * the 0-100 composite score) against actual outcome frequency, average CLV
 * segmented by sport (a sport consistently losing the close is flagged),
 * and win rate segmented by confidence tier and market type.
 */
function renderCalibrationReport(picks) {
  // Flagged (non-standard) picks were never real sharp locks — mixing them
  // in would skew the read on how well confidence/CLV track reality for
  // the picks that actually clear the standard.
  const graded = picks.filter(meetsTrackingStandard).filter((p) => p.status === 'won' || p.status === 'lost');
  if (graded.length < 5) {
    el.calibrationReport.innerHTML = `<div class="rec-item">Not enough graded picks yet (${graded.length}) for a meaningful read. Check back after a couple of weeks of tracking.</div>`;
    return;
  }

  const items = [];

  // Brier score: mean squared error between the model's own consensusProb
  // and the actual 0/1 outcome. 0 is perfect, 0.25 is what always-guess-50%
  // scores, higher is worse. Only picks with a stored consensusProb count —
  // older records predating that field are skipped rather than guessed.
  const withProb = graded.filter((p) => typeof p.consensusProb === 'number');
  if (withProb.length) {
    const brier = withProb.reduce((sum, p) => {
      const outcome = p.status === 'won' ? 1 : 0;
      return sum + (p.consensusProb - outcome) ** 2;
    }, 0) / withProb.length;
    const avgPredicted = withProb.reduce((s, p) => s + p.consensusProb, 0) / withProb.length * 100;
    const actualWinRate = (withProb.filter((p) => p.status === 'won').length / withProb.length) * 100;
    const gap = actualWinRate - avgPredicted;
    const severity = Math.abs(gap) > 10 ? 'high' : Math.abs(gap) > 5 ? '' : 'low';
    items.push(`<div class="rec-item ${severity}">Brier score ${brier.toFixed(3)} across ${withProb.length} graded picks. The model's own average predicted win probability is ${avgPredicted.toFixed(1)}%; actual win rate is ${actualWinRate.toFixed(1)}%, a ${Math.abs(gap).toFixed(1)}pp gap${gap < -5 ? ' (overconfident: real results are coming in below what the model expected)' : gap > 5 ? ' (underconfident: real results are beating what the model expected)' : ' (reasonably well calibrated)'}.</div>`);
  }

  // CLV by sport — a sport consistently losing the close is worth flagging.
  const bySport = new Map();
  for (const p of graded) {
    const label = sportGroupLabel(p.sportKey);
    const clv = top5ClvPct(p);
    if (clv == null) continue;
    if (!bySport.has(label)) bySport.set(label, []);
    bySport.get(label).push(clv);
  }
  for (const [label, values] of bySport) {
    if (values.length < 3) continue;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    if (avg < -1) {
      items.push(`<div class="rec-item high">${esc(label)} is losing the closing line on average (${formatSignedPct(avg)} CLV across ${values.length} picks). The price we're taking is consistently worse than where the market settles, which is a red flag independent of win rate.</div>`);
    } else if (avg > 1) {
      items.push(`<div class="rec-item low">${esc(label)} is consistently beating the closing line (${formatSignedPct(avg)} CLV across ${values.length} picks), a real, structural edge in this market.</div>`);
    }
  }

  // Win rate by confidence tier.
  const tiers = [
    { label: 'Very High (80+)', test: (s) => s >= 80 },
    { label: 'High (70-79)', test: (s) => s >= 70 && s < 80 },
    { label: 'Medium (60-69)', test: (s) => s >= 60 && s < 70 },
    { label: 'Low (50-59)', test: (s) => s >= 50 && s < 60 },
  ];
  const tierRows = tiers.map(({ label, test }) => {
    const bucket = graded.filter((p) => test(p.score));
    if (!bucket.length) return null;
    const wins = bucket.filter((p) => p.status === 'won').length;
    const rate = (wins / bucket.length) * 100;
    return `<div class="learning-table-row"><div class="label">${esc(label)}</div><div class="stat">${bucket.length}</div><div class="stat win-rate">${rate.toFixed(1)}%</div></div>`;
  }).filter(Boolean);

  el.calibrationReport.innerHTML = [
    items.length ? items.join('') : `<div class="rec-item">Nothing flagged yet. CLV and calibration look reasonable across every segment with enough sample size.</div>`,
    tierRows.length ? `<div class="learning-table" style="margin-top:12px">${tierRows.join('')}</div>` : '',
  ].join('');
}

const ALGO_HEALTH_MARKET_LABELS = { h2h: 'Moneyline', spreads: 'Spread', totals: 'Total', alternate_spreads: 'Alt Spread' };

/** "sportKey|marketKey" (worker/src/algo-health.js's segment key, sport half already
 * normalized, one virtual ATP/WTA segment regardless of which tournament) into a
 * readable label, e.g. "MMA: Moneyline". */
function algoSegmentLabel(key) {
  const [sportKey, marketKey] = String(key ?? '').split('|');
  const sportLabel = sportKey === 'tennis_atp' ? 'ATP' : sportKey === 'tennis_wta' ? 'WTA' : sportGroupLabel(sportKey ?? '');
  return `${sportLabel}: ${ALGO_HEALTH_MARKET_LABELS[marketKey] ?? marketKey}`;
}

const ODDS_BAND_LABELS = {
  heavyfav: 'Heavy favorites (−180 and shorter)',
  fav: 'Favorites (−179 to −120)',
  close: 'Near-pickem (−119 to +119)',
  dog: 'Underdogs (+120 and longer)',
};

/** "seg:sport|market" or "odds:band" (worker/src/daily-learning.js's feature keys) into a readable label. */
function learnFeatureLabel(key) {
  const k = String(key ?? '');
  if (k.startsWith('odds:')) return ODDS_BAND_LABELS[k.slice(5)] ?? k;
  if (k.startsWith('seg:')) return algoSegmentLabel(k.slice(4));
  return k;
}

/** Current daily-learning weight profile + report log (see worker/src/daily-learning.js). */
async function fetchDailyLearning() {
  if (!CONFIG.WORKER_URL) return null;
  try {
    const res = await fetch(new URL('/learning', CONFIG.WORKER_URL), { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Renders the Daily Learning section: the active reliability weights (what
 * today's selection is being adjusted by, with the evidence behind each),
 * and the day-by-day report log — the plain-English account of what the
 * review saw each morning and what it changed.
 */
async function renderDailyLearningSection() {
  const data = await fetchDailyLearning();
  if (!data) {
    el.dailyLearnWeights.innerHTML = `<p class="empty">Couldn't load daily learning data.</p>`;
    el.dailyLearnLog.innerHTML = '';
    return;
  }

  const weights = data.profile?.weights ?? {};
  const evidence = data.profile?.evidence ?? {};
  const entries = Object.entries(weights).sort(([, a], [, b]) => a - b);

  el.dailyLearnWeights.innerHTML = entries.length
    ? entries.map(([key, w]) => {
        const stats = evidence[key];
        const why = stats
          ? ` — ${stats.wins}/${stats.n} vs ${stats.expectedWins.toFixed(1)} expected${typeof stats.avgClvPts === 'number' ? `, CLV ${stats.avgClvPts >= 0 ? '+' : ''}${stats.avgClvPts.toFixed(2)}pts` : ''}`
          : '';
        return `<div class="rec-item ${w < 1 ? 'high' : 'low'}"><strong>x${w.toFixed(3)}</strong> ${esc(learnFeatureLabel(key))}${esc(why)}</div>`;
      }).join('')
    : `<div class="rec-item low">No active adjustments — either every segment is performing within its expected range, or there isn't enough graded evidence yet (15 graded picks per segment before anything moves).</div>`;

  const log = (data.log ?? []).slice(0, 14);
  el.dailyLearnLog.innerHTML = log.length
    ? log.map((e) => `
      <div class="rec-item">
        <strong>${esc(e.dateKey)}</strong>
        ${(e.report ?? []).map((line) => `<div>${esc(line)}</div>`).join('')}
      </div>`).join('')
    : `<div class="rec-item">No reviews yet — the first one runs at the next 2am ET batch and reports here every morning after.</div>`;
}

/** Current state of the weekly algorithm health review (see worker/src/algo-health.js). */
async function fetchAlgoHealth() {
  if (!CONFIG.WORKER_URL) return null;
  try {
    const url = new URL('/algo-health', CONFIG.WORKER_URL);
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const ALGO_HEALTH_PARAM_LABELS = {
  MIN_EV_PCT: { label: 'EV floor', fmt: (v) => `${(v * 100).toFixed(2)}%` },
  MIN_KELLY_FRACTION: { label: 'Kelly floor', fmt: (v) => `${(v * 100).toFixed(2)}%` },
  MIN_SCORE: { label: 'Score floor', fmt: (v) => v.toFixed(0) },
};

const ALGO_HEALTH_ACTION_LABELS = {
  pause: { label: 'Paused', cls: 'high' },
  resume: { label: 'Resumed', cls: 'low' },
  tighten: { label: 'Tightened', cls: '' },
  proposal: { label: 'Proposal', cls: '' },
  reset: { label: 'Reset', cls: '' },
  reviewed: { label: 'Reviewed', cls: '' },
};

/**
 * Renders the Algorithm Health panel: current tuned config vs. shipped
 * defaults (with a "tightened" indicator when they differ), the paused-
 * segment list with a manual "Resume now" per segment, and a scrollable log
 * of past actions/proposals — everything the weekly review
 * (worker/src/algo-health.js's runAlgoHealthReview) has done or flagged.
 * Unlike Calibration & Audit above, this section documents automatic
 * behavior, so it says so plainly rather than implying it's just reporting.
 */
async function renderAlgoHealthSection() {
  const data = await fetchAlgoHealth();
  if (!data) {
    el.algoHealthConfig.innerHTML = `<p class="empty">Couldn't load algorithm health data.</p>`;
    el.algoHealthPaused.innerHTML = '';
    el.algoHealthLog.innerHTML = '';
    return;
  }

  const { config, defaults, bounds, paused, log } = data;

  el.algoHealthConfig.innerHTML = Object.entries(ALGO_HEALTH_PARAM_LABELS)
    .map(([param, { label, fmt }]) => {
      const current = config[param];
      const isTightened = current !== defaults[param];
      return `
        <div class="learning-table-row">
          <div class="label">${esc(label)}${isTightened ? ' <span class="stat-pill is-warn">tightened</span>' : ''}</div>
          <div class="stat">${esc(fmt(current))}</div>
          <div class="stat" style="opacity:.6">default ${esc(fmt(defaults[param]))} · max ${esc(fmt(bounds[param].max))}</div>
        </div>`;
    })
    .join('');

  el.algoHealthPaused.innerHTML = paused.length
    ? paused.map((p) => `
      <div class="rec-item high">
        <strong>${esc(algoSegmentLabel(p.key))}</strong> paused since ${esc(new Date(p.pausedAt).toLocaleDateString())} — ${esc(p.reason ?? '')}
        <button type="button" class="link-btn" data-algo-resume="${esc(p.key)}" style="margin-left:8px">Resume now</button>
      </div>`).join('')
    : `<div class="rec-item low">No segments currently paused.</div>`;

  const logEntries = (log ?? []).filter((e) => e.action !== 'reviewed').slice(0, 30);
  el.algoHealthLog.innerHTML = logEntries.length
    ? logEntries.map((e) => {
        const meta = ALGO_HEALTH_ACTION_LABELS[e.action] ?? { label: e.action, cls: '' };
        const segmentPart = e.segment ? `${esc(algoSegmentLabel(e.segment))}: ` : '';
        return `<div class="rec-item ${meta.cls}"><strong>${esc(meta.label)}</strong> (${esc(e.week)}): ${segmentPart}${esc(e.reason ?? '')}</div>`;
      }).join('')
    : `<div class="rec-item">No actions or proposals yet. The first weekly review runs the next Monday 7am ET after enough graded history accumulates.</div>`;
}

document.body.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-algo-resume]');
  if (!button || !CONFIG.WORKER_URL) return;
  button.disabled = true;
  try {
    const url = new URL('/algo-health/resume', CONFIG.WORKER_URL);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: button.dataset.algoResume }),
    });
    await renderAlgoHealthSection();
  } finally {
    button.disabled = false;
  }
});

el.algoHealthResetBtn?.addEventListener('click', async () => {
  if (!CONFIG.WORKER_URL) return;
  if (!confirm('Reset all algorithm tuning back to shipped defaults? Paused segments are not affected — resume those individually.')) return;
  el.algoHealthResetBtn.disabled = true;
  try {
    const url = new URL('/algo-health/reset', CONFIG.WORKER_URL);
    await fetch(url, { method: 'POST' });
    await renderAlgoHealthSection();
  } finally {
    el.algoHealthResetBtn.disabled = false;
  }
});

/**
 * Everything the Tracking Dashboard shows: the three server-tracked
 * trackers (Full Slate / Pixel's Picks / Play of the Day), Calibration &
 * Audit, and Algorithm Health. There used to also be a first, client-side
 * IndexedDB-backed "Overall Performance" section here (Calendar, a Week/
 * Month/Year graph, Confidence/Sport breakdowns) that mirrored a subset of
 * Pixel's Picks into local storage with its own $20/$1000-bankroll
 * accounting, a second, independent set of numbers for the same concept,
 * built before Pixel's Picks moved fully server-side. It was removed: it
 * disagreed with the server-tracked numbers below (it excluded flagged
 * picks; the server tracker counts them, per the sharp-standard rule) and
 * its data reset on every cleared browser/new device while the server
 * data didn't. The server-tracked section is now the single source of
 * truth for pick performance.
 */
async function renderLearningDashboard() {
  const top5Picks = await loadTrackerHistories();
  renderCalibrationReport(top5Picks);
  await Promise.all([renderDailyLearningSection(), renderAlgoHealthSection(), renderMlbPropsSection(), renderNflPropsSection(), renderWnbaPropsSection(), renderNhlPropsSection()]);
}

/** worker/src/mlb-props.js's own tracked-pick history — pitcher outs/strikeouts, each game scanned once 2-3 hours before its own first pitch. */
async function fetchMlbProps() {
  if (!CONFIG.WORKER_URL) return null;
  try {
    const url = new URL('/mlb-props-history', CONFIG.WORKER_URL);
    url.searchParams.set('days', '30');
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Renders the MLB Pitcher Props section: the same W-L/ROI summary math
 * every other tracked board uses (summarizePicks, from docs/learning.js),
 * plus a day-by-day list of what was picked and how it graded.
 */
async function renderMlbPropsSection() {
  if (!el.mlbPropsSummary || !el.mlbPropsList) return;
  const data = await fetchMlbProps();
  if (!data) {
    el.mlbPropsSummary.innerHTML = `<p class="empty">Couldn't load MLB props data.</p>`;
    el.mlbPropsList.innerHTML = '';
    return;
  }

  const picks = data.picks ?? [];
  const summary = summarizePicks(picks);
  el.mlbPropsSummary.innerHTML = picks.length
    ? `<div class="rec-item">
        <strong>${summary.wins}-${summary.losses}</strong> (${summary.voided} void, ${summary.pending} pending) &middot;
        ROI ${summary.roi >= 0 ? '+' : ''}${summary.roi.toFixed(1)}% &middot;
        staked $${summary.staked.toFixed(0)}, net ${summary.net >= 0 ? '+' : ''}$${summary.net.toFixed(0)}
      </div>`
    : `<div class="rec-item">No pitcher props tracked yet — each game is scanned once it's 2-3 hours from its own first pitch.</div>`;

  const byDate = [...picks].sort((a, b) => (b.dateKey ?? '').localeCompare(a.dateKey ?? '') || b.generatedAt - a.generatedAt);
  el.mlbPropsList.innerHTML = byDate.length
    ? byDate.slice(0, 40).map((p) => {
        const statusCls = p.status === 'won' ? 'low' : p.status === 'lost' ? 'high' : '';
        const resultText = p.status === 'pending' ? 'pending'
          : p.status === 'void' ? `void (${p.result?.voidReason ?? 'no action'})`
          : `${p.status}${typeof p.result?.actual === 'number' ? ` — actual ${p.result.actual}` : ''}`;
        return `<div class="rec-item ${statusCls}">
          <strong>${esc(p.dateKey)}</strong> ${esc(p.selection)} (${formatAmerican(p.american)} at ${esc(p.book)}) — ${esc(resultText)}
        </div>`;
      }).join('')
    : '';
}

/** worker/src/nfl-props.js's own tracked-pick history — QB pass completions/attempts, each game scanned once 2-3 hours before its own kickoff. */
async function fetchNflProps() {
  if (!CONFIG.WORKER_URL) return null;
  try {
    const url = new URL('/nfl-props-history', CONFIG.WORKER_URL);
    url.searchParams.set('days', '30');
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Renders the NFL QB Props section — same shape as renderMlbPropsSection. */
async function renderNflPropsSection() {
  if (!el.nflPropsSummary || !el.nflPropsList) return;
  const data = await fetchNflProps();
  if (!data) {
    el.nflPropsSummary.innerHTML = `<p class="empty">Couldn't load NFL props data.</p>`;
    el.nflPropsList.innerHTML = '';
    return;
  }

  const picks = data.picks ?? [];
  const summary = summarizePicks(picks);
  el.nflPropsSummary.innerHTML = picks.length
    ? `<div class="rec-item">
        <strong>${summary.wins}-${summary.losses}</strong> (${summary.voided} void, ${summary.pending} pending) &middot;
        ROI ${summary.roi >= 0 ? '+' : ''}${summary.roi.toFixed(1)}% &middot;
        staked $${summary.staked.toFixed(0)}, net ${summary.net >= 0 ? '+' : ''}$${summary.net.toFixed(0)}
      </div>`
    : `<div class="rec-item">No QB props tracked yet — each game is scanned once it's 2-3 hours from its own kickoff.</div>`;

  const byDate = [...picks].sort((a, b) => (b.dateKey ?? '').localeCompare(a.dateKey ?? '') || b.generatedAt - a.generatedAt);
  el.nflPropsList.innerHTML = byDate.length
    ? byDate.slice(0, 40).map((p) => {
        const statusCls = p.status === 'won' ? 'low' : p.status === 'lost' ? 'high' : '';
        const resultText = p.status === 'pending' ? 'pending'
          : p.status === 'void' ? `void (${p.result?.voidReason ?? 'no action'})`
          : `${p.status}${typeof p.result?.actual === 'number' ? ` — actual ${p.result.actual}` : ''}`;
        return `<div class="rec-item ${statusCls}">
          <strong>${esc(p.dateKey)}</strong> ${esc(p.selection)} (${formatAmerican(p.american)} at ${esc(p.book)}) — ${esc(resultText)}
        </div>`;
      }).join('')
    : '';
}

/** worker/src/wnba-props.js's own tracked-pick history — PRA/Reb+Ast, each game scanned once 2-3 hours before its own tip-off. */
async function fetchWnbaProps() {
  if (!CONFIG.WORKER_URL) return null;
  try {
    const url = new URL('/wnba-props-history', CONFIG.WORKER_URL);
    url.searchParams.set('days', '30');
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Renders the WNBA Player Props section — same shape as renderMlbPropsSection/renderNflPropsSection. */
async function renderWnbaPropsSection() {
  if (!el.wnbaPropsSummary || !el.wnbaPropsList) return;
  const data = await fetchWnbaProps();
  if (!data) {
    el.wnbaPropsSummary.innerHTML = `<p class="empty">Couldn't load WNBA props data.</p>`;
    el.wnbaPropsList.innerHTML = '';
    return;
  }

  const picks = data.picks ?? [];
  const summary = summarizePicks(picks);
  el.wnbaPropsSummary.innerHTML = picks.length
    ? `<div class="rec-item">
        <strong>${summary.wins}-${summary.losses}</strong> (${summary.voided} void, ${summary.pending} pending) &middot;
        ROI ${summary.roi >= 0 ? '+' : ''}${summary.roi.toFixed(1)}% &middot;
        staked $${summary.staked.toFixed(0)}, net ${summary.net >= 0 ? '+' : ''}$${summary.net.toFixed(0)}
      </div>`
    : `<div class="rec-item">No player props tracked yet — each game is scanned once it's 2-3 hours from its own tip-off.</div>`;

  const byDate = [...picks].sort((a, b) => (b.dateKey ?? '').localeCompare(a.dateKey ?? '') || b.generatedAt - a.generatedAt);
  el.wnbaPropsList.innerHTML = byDate.length
    ? byDate.slice(0, 40).map((p) => {
        const statusCls = p.status === 'won' ? 'low' : p.status === 'lost' ? 'high' : '';
        const resultText = p.status === 'pending' ? 'pending'
          : p.status === 'void' ? `void (${p.result?.voidReason ?? 'no action'})`
          : `${p.status}${typeof p.result?.actual === 'number' ? ` — actual ${p.result.actual}` : ''}`;
        return `<div class="rec-item ${statusCls}">
          <strong>${esc(p.dateKey)}</strong> ${esc(p.selection)} (${formatAmerican(p.american)} at ${esc(p.book)}) — ${esc(resultText)}
        </div>`;
      }).join('')
    : '';
}

/** worker/src/nhl-props.js's own tracked-pick history — Shots on Goal, each game scanned once 2-3 hours before its own puck drop. */
async function fetchNhlProps() {
  if (!CONFIG.WORKER_URL) return null;
  try {
    const url = new URL('/nhl-props-history', CONFIG.WORKER_URL);
    url.searchParams.set('days', '30');
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Renders the NHL Player Props section — same shape as the other prop sections above. */
async function renderNhlPropsSection() {
  if (!el.nhlPropsSummary || !el.nhlPropsList) return;
  const data = await fetchNhlProps();
  if (!data) {
    el.nhlPropsSummary.innerHTML = `<p class="empty">Couldn't load NHL props data.</p>`;
    el.nhlPropsList.innerHTML = '';
    return;
  }

  const picks = data.picks ?? [];
  const summary = summarizePicks(picks);
  el.nhlPropsSummary.innerHTML = picks.length
    ? `<div class="rec-item">
        <strong>${summary.wins}-${summary.losses}</strong> (${summary.voided} void, ${summary.pending} pending) &middot;
        ROI ${summary.roi >= 0 ? '+' : ''}${summary.roi.toFixed(1)}% &middot;
        staked $${summary.staked.toFixed(0)}, net ${summary.net >= 0 ? '+' : ''}$${summary.net.toFixed(0)}
      </div>`
    : `<div class="rec-item">No shots-on-goal props tracked yet — each game is scanned once it's 2-3 hours from its own puck drop.</div>`;

  const byDate = [...picks].sort((a, b) => (b.dateKey ?? '').localeCompare(a.dateKey ?? '') || b.generatedAt - a.generatedAt);
  el.nhlPropsList.innerHTML = byDate.length
    ? byDate.slice(0, 40).map((p) => {
        const statusCls = p.status === 'won' ? 'low' : p.status === 'lost' ? 'high' : '';
        const resultText = p.status === 'pending' ? 'pending'
          : p.status === 'void' ? `void (${p.result?.voidReason ?? 'no action'})`
          : `${p.status}${typeof p.result?.actual === 'number' ? ` — actual ${p.result.actual}` : ''}`;
        return `<div class="rec-item ${statusCls}">
          <strong>${esc(p.dateKey)}</strong> ${esc(p.selection)} (${formatAmerican(p.american)} at ${esc(p.book)}) — ${esc(resultText)}
        </div>`;
      }).join('')
    : '';
}

/** Applies the user's last-dragged width, if any — otherwise the panel keeps its CSS default (fills the viewport). */
function applyLearningPanelWidth() {
  const saved = loadJSON(LEARNING_PANEL_WIDTH_KEY, null);
  if (!Number.isFinite(saved)) {
    el.learningPanel.style.width = '';
    return;
  }
  const clamped = Math.min(Math.max(saved, LEARNING_PANEL_MIN_WIDTH), window.innerWidth);
  el.learningPanel.style.width = `${clamped}px`;
}

/** Drag-to-resize on the panel's left edge — pointer events cover mouse and touch alike, so this works the same on mobile and desktop. */
function initLearningPanelResize() {
  const handle = el.learningPanelResize;
  let dragging = false;
  let startX = 0;
  let moved = false;
  let lastTapAt = 0;

  function onPointerMove(event) {
    if (!dragging) return;
    if (Math.abs(event.clientX - startX) > 3) moved = true;
    const width = Math.min(Math.max(window.innerWidth - event.clientX, LEARNING_PANEL_MIN_WIDTH), window.innerWidth);
    el.learningPanel.style.width = `${width}px`;
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('is-dragging');
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);

    if (!moved) {
      // A plain tap/click, not a drag. The handle's pointerdown below calls
      // preventDefault() (needed to stop text selection mid-drag), which
      // also suppresses the browser's own synthesized dblclick — so two
      // quick taps are detected by hand instead, as "reset to fullscreen".
      const now = Date.now();
      if (now - lastTapAt < 400) {
        el.learningPanel.style.width = '';
        saveJSON(LEARNING_PANEL_WIDTH_KEY, null);
        lastTapAt = 0;
      } else {
        lastTapAt = now;
      }
      return;
    }

    const width = Math.round(el.learningPanel.getBoundingClientRect().width);
    // Full-width (or near enough) counts as "still at the default" — no
    // point pinning a literal pixel figure that just happens to match.
    saveJSON(LEARNING_PANEL_WIDTH_KEY, width >= window.innerWidth - 4 ? null : width);
  }

  handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    moved = false;
    startX = event.clientX;
    handle.classList.add('is-dragging');
    event.preventDefault();
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  });

  // A saved custom width can outlive the window it was dragged in (rotating
  // a phone, shrinking a desktop window) — reclamp so it never sticks out
  // past the new viewport while the panel's open.
  window.addEventListener('resize', () => {
    if (el.learningPanel.hidden) return;
    const current = parseFloat(el.learningPanel.style.width);
    if (Number.isFinite(current) && current > window.innerWidth) {
      el.learningPanel.style.width = `${window.innerWidth}px`;
    }
  });
}

async function openLearningDashboard() {
  el.scrim.hidden = false;
  el.learningPanel.hidden = false;
  applyLearningPanelWidth();
  await renderLearningDashboard();
}

/* ---------------------------------------------------------------- */
/* Boot                                                              */
/* ---------------------------------------------------------------- */

(async function init() {
  if (!checkAuth()) return;

  el.logoutBtn.hidden = !getToken();
  el.pixelSort.value = state.pixelSort;

  renderDayToggle();
  renderSlateStateToggle();
  initLearningPanelResize();

  // Adopt server-side bankroll/unit settings before anything renders a stake,
  // so a synced device doesn't briefly show figures from a stale local copy.
  // Fire-and-forget on failure — the localStorage values already loaded into
  // state.bankroll stand in, exactly as before sync existed.
  loadSettings().then((result) => {
    if (!result.ok) return;
    renderBankrollPanel();
    refreshStakeDisplays();
  });

  el.slateStatus.textContent = 'Loading all leagues…';
  // Catalogue first — ATP/WTA can't resolve their tournament keys without it.
  await loadCatalogue();
  await refreshAllLeagues();
  el.slateStatus.textContent = state.rawEvents.length
    ? `${state.rawEvents.length} games loaded across every league, pick one below.`
    : 'Odds feed unavailable right now, try Refresh slate in a moment.';

  renderSlateLeagueOptions();
  renderFullSlate();
  await loadPixelPicks(); // Pixel's Picks is the worker's own 2am ET locked set, never re-picked client-side
  refreshQualitativeSignals(); // fire-and-forget — enriches scores with form/H2H/injuries once loaded

  setStatus(
    CONFIG.WORKER_URL
      ? 'Ready — today\'s locks below'
      : 'Demo data — set WORKER_URL in config.js for live odds',
    CONFIG.WORKER_URL ? '' : 'demo',
  );

  startSlateAutoRefresh();
})();

/**
 * Keeps Full Slate's game states current without requiring the viewer to
 * touch anything. Before this, refreshSlateScores/refreshSlateTrackedPicks
 * only ran as a side effect of renderFullSlate, which itself only ran on a
 * user action (switching league/day/tab) — so a board left open just sat
 * there. A fight or game that finished minutes ago kept showing "● Live"
 * forever (slateGameState falls back to 'live' once commence time has
 * passed and no completed score has arrived) and never migrated to the
 * Finished tab, since nothing ever re-fetched /scores to learn it had ended.
 *
 * 60s matches refreshSlateScores'/refreshSlateTrackedPicks' own per-group
 * throttle (see their comments) — polling faster wouldn't get fresher data,
 * since that throttle no-ops in between anyway. Only fires while the Full
 * Slate tab is the one showing and the browser tab itself is in the
 * foreground, so a backgrounded or unused tab isn't silently spending odds
 * API credits.
 */
const SLATE_AUTO_REFRESH_MS = 60000;
function startSlateAutoRefresh() {
  const tick = () => {
    if (document.visibilityState !== 'visible') return;
    if (el.slateView.hidden) return;
    if (!state.candidates.length && !state.rawEvents.length) return;
    renderFullSlate();
  };
  setInterval(tick, SLATE_AUTO_REFRESH_MS);
  // Catches the common "left it open in a background tab" case immediately
  // on return, rather than waiting up to 60s for the next tick.
  document.addEventListener('visibilitychange', tick);
}
