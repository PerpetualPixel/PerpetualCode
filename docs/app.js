/**
 * Pixel Pick — UI layer.
 *
 * Responsibilities kept deliberately thin: fetch the odds pool, hand it to the
 * engine, render what comes back, and persist history. All betting logic lives
 * in engine.js so it can be tested without a browser.
 */

import { CONFIG } from './config.js';
import { DEMO_EVENTS } from './demo.js';
import { teamLogoUrl } from './team-logos.js';
import {
  initializePickDatabase,
  logPick,
  logResult,
  identifyPatterns,
  exportData,
  getPendingPicks,
  getAllPicks,
  summarizePicks,
  groupPicksByDay,
  gradePick,
  clearAllPicks,
  BANKROLL_INITIAL,
  FLAT_UNIT_STAKE,
} from './learning.js';
import {
  RULES,
  SPORTSBOOKS,
  analyze,
  topPicks,
  buildParlay,
  explain,
  explainExtensive,
  formatAmerican,
  confidenceColor,
  bookOffers,
  impliedProb,
  americanToDecimal,
  suggestedParlayStake,
  suggestedStake,
} from './engine.js';
import {
  buildInsights,
  insightTexts,
  insightsByTier,
  isTennis,
  isMma,
  resolveMmaFighters,
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

const PARLAY_KEY = 'pixelpick.parlay.v2';
const BANKROLL_KEY = 'pixelpick.bankroll.v1';
const SLATE_LEAGUE_KEY = 'pixelpick.slateLeague.v2';
const PIXEL_SORT_KEY = 'pixelpick.sort.v1';
const HISTORY_KEY = 'pixelpick.history.v2';
const DAY_FILTER_KEY = 'pixelpick.dayFilter.v1';
const CALENDAR_METRIC_KEY = 'pixelpick.calendarMetric.v1';
const TRACKER_SPORT_FILTER_KEY = 'pixelpick.trackerSportFilter.v1';
// The Tracking Dashboard's user-dragged width in px, or null for its default
// (fills the viewport). Only ever set by actually dragging the resize
// handle — there's no other UI that writes to this.
const LEARNING_PANEL_WIDTH_KEY = 'pixelpick.learningPanelWidth.v1';
const LEARNING_PANEL_MIN_WIDTH = 320;
// 1-2% of bankroll per unit is the standard range a flat-staking bettor
// works from; 2% is the more conservative, more commonly cited end of it —
// used here as the default recommendation when the user hasn't set their own.
const RECOMMENDED_UNIT_PCT = 0.02;
// Entries carry full leg data now so history can be re-priced and reopened,
// which makes each one heavier than the old summary rows.
const HISTORY_LIMIT = 40;

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
  { id: 'nhl', label: 'NHL', keys: ['icehockey_nhl'] },
];
const LEAGUE_GROUP_BY_ID = new Map(LEAGUE_GROUPS.map((g) => [g.id, g]));

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

/** [start, end) timestamps for the local calendar day 'today' or 'tomorrow' falls on. */
function dayBounds(which) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (which === 'tomorrow') start.setDate(start.getDate() + 1);
  return [start.getTime(), start.getTime() + ONE_DAY_MS];
}

/**
 * Whether a game belongs on the board under the current Today/Tomorrow
 * toggle. MMA is exempt — cards get announced and sell tickets weeks out, so
 * it keeps its own longer (~2 week) horizon via filterMmaGames instead of
 * being scoped to a single day like every other league.
 */
function withinDayFilter(commenceMs, sportKey) {
  if (isMmaSportKey(sportKey)) return true;
  const [start, end] = dayBounds(state.dayFilter);
  return commenceMs >= start && commenceMs < end;
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
  const [tomorrowStart] = dayBounds('tomorrow');
  el.tomorrowDateLabel.textContent = `(${new Date(tomorrowStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })})`;
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
    generate(); // Pixel's Picks re-ranks automatically for the newly-selected day
  }
  renderParlayFilters();
}

function renderSlateStateToggle() {
  el.slateStateUpcoming.classList.toggle('is-active', state.slateGameFilter === 'upcoming');
  el.slateStateUpcoming.setAttribute('aria-pressed', String(state.slateGameFilter === 'upcoming'));
  el.slateStateLive.classList.toggle('is-active', state.slateGameFilter === 'live');
  el.slateStateLive.setAttribute('aria-pressed', String(state.slateGameFilter === 'live'));
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
  'Chicago White Sox': 'CWS',
  'Cleveland Guardians': 'CLE',
  'Detroit Tigers': 'DET',
  'Kansas City Royals': 'KC',
  'Minnesota Twins': 'MIN',
  'Houston Astros': 'HOU',
  'Los Angeles Dodgers': 'LAD',
  'Oakland Athletics': 'OAK',
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

// MLB Stats display
async function showTeamStats(awayTeam, homeTeam, awayAbbr, homeAbbr) {
  // Get proper abbreviations
  const awayAbbrev = awayAbbr ? getTeamAbbr(awayAbbr) : getTeamAbbr(awayTeam);
  const homeAbbrev = homeAbbr ? getTeamAbbr(homeAbbr) : getTeamAbbr(homeTeam);

  const [awayStats, homeStats] = await Promise.all([
    fetch(`/mlb-stats?team=${awayAbbrev}`).then((r) => r.json()),
    fetch(`/mlb-stats?team=${homeAbbrev}`).then((r) => r.json()),
  ]);

  const statsHtml = `
    <div class="stats-matchup">
      <h3>${awayTeam} @ ${homeTeam}</h3>
    </div>

    <div class="stats-section">
      <h4>TEAM STATS</h4>
      <div class="stats-grid">
        <div class="stats-team">
          <div class="team-header">
            <img src="/logo.svg" alt="${awayTeam}" class="team-logo">
            <span class="team-name">${awayTeam}</span>
          </div>
          ${renderOffenseStats(awayStats.teamStats)}
        </div>

        <div class="stats-divider"></div>

        <div class="stats-team">
          <div class="team-header">
            <span class="team-name">${homeTeam}</span>
            <img src="/logo.svg" alt="${homeTeam}" class="team-logo">
          </div>
          ${renderDefenseStats(homeStats.teamStats)}
        </div>
      </div>
    </div>

    <div class="stats-section">
      <h4>RECENT SCHEDULE</h4>
      <div class="stats-tabs">
        <button class="stats-tab is-active" data-tab="away">${awayTeam}</button>
        <button class="stats-tab" data-tab="h2h">Head-to-Head</button>
        <button class="stats-tab" data-tab="home">${homeTeam}</button>
      </div>
      <div id="scheduleContent" class="schedule-content">
        ${renderSchedule(awayStats.recentSchedule)}
      </div>
    </div>
  `;

  el.statsTitle.textContent = `${awayTeam} @ ${homeTeam}`;
  el.statsBody.innerHTML = statsHtml;
  el.statsPanel.hidden = false;
  el.scrim.hidden = false;
}

function renderOffenseStats(teamStats) {
  if (!teamStats) return '<p>Stats unavailable</p>';

  const stats = [
    { label: 'Batting Avg', value: teamStats.offense?.battingAvg, rank: 18 },
    { label: 'OBP+SLG%', value: teamStats.offense?.obpSlugging, rank: 24 },
    { label: 'RBI', value: teamStats.offense?.rbi, rank: 25 },
    { label: 'Strikeouts', value: teamStats.offense?.strikeouts, rank: 15 },
    { label: 'Runs', value: teamStats.offense?.runs, rank: 25 },
    { label: 'Stolen Bases', value: teamStats.offense?.stolenBases, rank: 21 },
    { label: 'Doubles', value: teamStats.offense?.doubles, rank: 26 },
    { label: 'Hits', value: teamStats.offense?.hits, rank: 22 },
    { label: 'Triples', value: teamStats.offense?.triples, rank: 10 },
    { label: 'Walks', value: teamStats.offense?.walks, rank: 21 },
    { label: 'Home Runs', value: teamStats.offense?.homeRuns, rank: 11 },
  ];

  return `<div class="offense-stats">
    <h5>Offense</h5>
    ${stats.map((s) => `
      <div class="stat-row">
        <span class="stat-rank ${s.rank > 15 ? 'bad' : 'good'}">${s.rank}</span>
        <span class="stat-label">${s.label}</span>
        <span class="stat-value">${s.value || '—'}</span>
      </div>
    `).join('')}
  </div>`;
}

function renderDefenseStats(teamStats) {
  if (!teamStats) return '<p>Stats unavailable</p>';

  const stats = [
    { label: 'ERA', value: teamStats.defense?.era, rank: 18 },
    { label: 'WHIP', value: teamStats.defense?.whip, rank: 25 },
  ];

  return `<div class="defense-stats">
    <h5>Defense</h5>
    ${stats.map((s) => `
      <div class="stat-row">
        <span class="stat-rank ${s.rank > 15 ? 'bad' : 'good'}">${s.rank}</span>
        <span class="stat-label">${s.label}</span>
        <span class="stat-value">${s.value || '—'}</span>
      </div>
    `).join('')}
  </div>`;
}

function renderSchedule(games) {
  if (!games || games.length === 0) return '<p>No recent games</p>';

  return `<div class="schedule-table">
    ${games.map((g) => `
      <div class="schedule-row">
        <span class="schedule-game">${g.opponent}</span>
        <span class="schedule-result ${g.result === 'W' ? 'win' : 'loss'}">${g.result} ${g.score}</span>
        <span class="schedule-ats">${g.ats || '—'}</span>
        <span class="schedule-ou">${g.ou || '—'}</span>
      </div>
    `).join('')}
  </div>`;
}

const el = {
  status: document.getElementById('status'),
  picks: document.getElementById('picks'),
  pixelSortRow: document.getElementById('pixelSortRow'),
  pixelSort: document.getElementById('pixelSort'),
  historyToggle: document.getElementById('historyToggle'),
  historyPanel: document.getElementById('historyPanel'),
  historyClose: document.getElementById('historyClose'),
  historyClear: document.getElementById('historyClear'),
  historyList: document.getElementById('historyList'),
  historyCount: document.getElementById('historyCount'),
  clvSummary: document.getElementById('clvSummary'),
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
  guideToggle: document.getElementById('guideToggle'),
  guidePanel: document.getElementById('guidePanel'),
  guideClose: document.getElementById('guideClose'),
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
  slateLoad: document.getElementById('slateLoad'),
  slateStateUpcoming: document.getElementById('slateStateUpcoming'),
  slateStateLive: document.getElementById('slateStateLive'),
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
  tabParlay: document.getElementById('tabParlay'),
  parlayView: document.getElementById('parlayView'),
  parlayLeagueSelect: document.getElementById('parlayLeagueSelect'),
  parlayEventFilterRow: document.getElementById('parlayEventFilterRow'),
  parlayEventFilterSelect: document.getElementById('parlayEventFilterSelect'),
  parlayMarketsList: document.getElementById('parlayMarketsList'),
  parlayOddsMinSlider: document.getElementById('parlayOddsMinSlider'),
  parlayOddsMinLabel: document.getElementById('parlayOddsMinLabel'),
  parlayOddsMaxSlider: document.getElementById('parlayOddsMaxSlider'),
  parlayOddsMaxLabel: document.getElementById('parlayOddsMaxLabel'),
  parlayConfidenceSlider: document.getElementById('parlayConfidenceSlider'),
  parlayConfidenceLabel: document.getElementById('parlayConfidenceLabel'),
  parlayLegCountSlider: document.getElementById('parlayLegCountSlider'),
  parlayLegCountLabel: document.getElementById('parlayLegCountLabel'),
  parlayGenerate: document.getElementById('parlayGenerate'),
  parlayResult: document.getElementById('parlayResult'),
  learningPanel: document.getElementById('learningPanel'),
  learningPanelResize: document.getElementById('learningPanelResize'),
  learningPanelClose: document.getElementById('learningPanelClose'),
  totalPicks: document.getElementById('totalPicks'),
  gradedPicks: document.getElementById('gradedPicks'),
  winRate: document.getElementById('winRate'),
  avgRoi: document.getElementById('avgRoi'),
  currentBankroll: document.getElementById('currentBankroll'),
  netProfit: document.getElementById('netProfit'),
  trackerSportFilter: document.getElementById('trackerSportFilter'),
  calendarMonthLabel: document.getElementById('calendarMonthLabel'),
  calendarPrevMonth: document.getElementById('calendarPrevMonth'),
  calendarNextMonth: document.getElementById('calendarNextMonth'),
  calendarMetricToggle: document.getElementById('calendarMetricToggle'),
  calendarGrid: document.getElementById('calendarGrid'),
  perfPeriodTabs: document.getElementById('perfPeriodTabs'),
  perfPeriodLabel: document.getElementById('perfPeriodLabel'),
  perfProfit: document.getElementById('perfProfit'),
  perfRoi: document.getElementById('perfRoi'),
  perfRecord: document.getElementById('perfRecord'),
  perfGraph: document.getElementById('perfGraph'),
  dailyHistory: document.getElementById('dailyHistory'),
  checkResultsBtn: document.getElementById('checkResultsBtn'),
  confidenceAnalysis: document.getElementById('confidenceAnalysis'),
  sportAnalysis: document.getElementById('sportAnalysis'),
  recommendations: document.getElementById('recommendations'),
  top5TotalPicks: document.getElementById('top5TotalPicks'),
  top5GradedPicks: document.getElementById('top5GradedPicks'),
  top5WinRate: document.getElementById('top5WinRate'),
  top5Roi: document.getElementById('top5Roi'),
  top5NetProfit: document.getElementById('top5NetProfit'),
  top5AvgClv: document.getElementById('top5AvgClv'),
  top5DailyHistory: document.getElementById('top5DailyHistory'),
  calibrationReport: document.getElementById('calibrationReport'),
  exportDataBtn: document.getElementById('exportDataBtn'),
  archiveResetBtn: document.getElementById('archiveResetBtn'),
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
  history: loadJSON(HISTORY_KEY, []),
  // The requestable catalogue, from the worker's free /sports endpoint.
  catalogue: [],
  // Which calendar day Full Slate, Pixel Picks, and Parlay Builder all pull
  // from — 'today' or 'tomorrow'. Shared globally rather than per-tab: it's
  // one "which day am I looking at" question, not three. MMA ignores this
  // entirely (see withinDayFilter/isMmaSportKey) since cards are announced
  // and worth showing weeks ahead of a single day toggle.
  dayFilter: ['today', 'tomorrow'].includes(loadJSON(DAY_FILTER_KEY, 'today'))
    ? loadJSON(DAY_FILTER_KEY, 'today')
    : 'today',
  // Learning dashboard's calendar/graph — which month is on screen (also
  // doubles as the range for the Month/Year performance-panel tabs, so
  // paging the calendar moves the graph with it), which unit its cells and
  // graph are shown in, and which sports (by League Group label, e.g. 'ATP')
  // are excluded from every figure in the panel. Empty exclusion set means
  // no filter — everything tracked counts, which is the default.
  calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  calendarMetric: ['dollars', 'units', 'roi'].includes(loadJSON(CALENDAR_METRIC_KEY, 'dollars'))
    ? loadJSON(CALENDAR_METRIC_KEY, 'dollars')
    : 'dollars',
  perfPeriod: 'week',
  trackerExcludedSports: new Set(loadJSON(TRACKER_SPORT_FILTER_KEY, [])),
  // Today's server-side tracked Top 5 pick ids (see worker/src/tracking.js),
  // fetched once at boot — just for badging matching Pixel Picks cards, not
  // itself the source of truth for anything the client computes.
  top5Ids: new Set(),
  // Full Slate's live/final game state — eventId -> the raw /scores event
  // for it (has `completed` and `scores`). Refreshed at most once a minute
  // per sport-group (see refreshSlateScores) rather than on every render.
  slateScores: new Map(),
  slateScoresFetchedAt: new Map(), // group.id -> last fetch time, so switching leagues never gets throttled by an unrelated sport's recent fetch
  // Full Slate's Upcoming/Live/Finished toggle — defaults to Upcoming each
  // fresh load rather than persisting, since "what's live right now" isn't
  // something you'd want stuck from a prior session.
  slateGameFilter: 'upcoming',
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
  // Parlay Builder's own filters — deliberately separate from Pixel Picks'
  // fixed oddsMin/oddsMax/minScore above, since a manually-built parlay leg
  // can reasonably want a different range. `markets` (a Set of market keys —
  // h2h/spreads/totals) is never persisted: it's re-derived from whatever the
  // currently-chosen league/event pool actually offers each time the tab
  // renders, since a saved key could refer to a market that pool no longer has.
  parlay: {
    markets: new Set(),
    // Leg id -> candidate object, in-memory only (never persisted — a locked
    // leg's price can go stale across sessions). Pinned into every
    // subsequent buildParlay() call until explicitly unlocked or the
    // league/event changes out from under it.
    lockedLegs: new Map(),
    ...loadJSON(PARLAY_KEY, { oddsMin: -250, oddsMax: 250, minScore: 50, legCount: 3 }),
  },
  // Bankroll and unit size, purely local — never sent anywhere, only used to
  // turn a stake's %-of-bankroll figure into a dollar amount or unit count.
  // amount/unit of 0 means "unset"; unset amount falls back to showing the
  // plain percentage everywhere a stake is displayed. `confirmed` gates that
  // conversion on having actually pressed Submit — typing a number into the
  // field alone shouldn't start changing what every "why" panel recommends.
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
  // Parlay Builder's own league/event pickers — deliberately separate state
  // from the Full Slate tab's, so building a parlay never disturbs what's on
  // screen there.
  parlayLeague: null,
  parlayEvent: 'all',
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
  return localStorage.getItem('pixelpick_token');
}

function signOut() {
  localStorage.removeItem('pixelpick_token');
  localStorage.removeItem('pixelpick_user_id');
  window.location.href = 'auth.html';
}

/** Returns false when the page is being redirected to sign-in. */
function checkAuth() {
  if (!CONFIG.REQUIRE_AUTH) return true;
  if (getToken()) return true;
  window.location.href = 'auth.html';
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
 * This is the app's one and only fetch orchestration now — Full Slate, Pixel
 * Picks, and Parlay Builder all read from the same always-loaded pool rather
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
  const allKeys = [...new Set(LEAGUE_GROUPS.flatMap((g) => g.keys))];
  const results = await Promise.allSettled(allKeys.map((key) => fetchSingleLeague(key)));
  const failed = results.filter((r) => r.status === 'rejected').length;

  state.isDemo = false;
  state.fetchedAt = Date.now();

  if (failed) {
    setStatus(`Loaded ${allKeys.length - failed}/${allKeys.length} leagues — some odds may be missing`, 'error');
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
 * Sherdog-derived fighter research for one MMA matchup, via the worker. Free —
 * no odds credits — and cached by fighter pair, same pattern as eventContext.
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
 * The AI-written matchup analysis for one game, via the worker — one per
 * game per ET calendar day, cached there, shared across every market/leg on
 * that event (see worker/src/analysis.js). Null whenever the feature isn't
 * available for any reason (no ANTHROPIC_API_KEY configured, no research
 * context for this event, or the model call itself failed) — the caller
 * falls back to the existing quantitative price case in that case, never
 * shows a broken section.
 */
function matchupAnalysisFor(leg) {
  const key = `analysis:${leg.eventId}`;
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
 * A stake fraction (0–1) as display text. With no bankroll set, this is just
 * the %-of-bankroll figure the Kelly math produces — which is all the app
 * can say without knowing what "bankroll" means to this user. Once a
 * bankroll is set, it converts to a real dollar amount or, if a unit size is
 * also available (set or recommended), a unit count in the user's chosen
 * display mode.
 */
function formatStakeLine(stake) {
  if (stake <= 0) return null;
  const pct = `${(stake * 100).toFixed(1)}%`;

  // A dollar/unit figure only appears once the user has actually pressed
  // Submit on the Bankroll panel — typing a number into the field shouldn't,
  // by itself, start changing what every "why" panel recommends betting.
  if (!(state.bankroll.amount > 0) || !state.bankroll.confirmed) {
    return `Suggested stake: ${pct} of bankroll (¼-Kelly)`;
  }

  const dollars = state.bankroll.amount * stake;
  const unit = effectiveUnit();
  const dollarsText = `$${dollars.toFixed(2)}`;
  const unitsText = unit > 0 ? `${(dollars / unit).toFixed(2)}u` : null;

  const primary = state.bankroll.displayMode === 'units' && unitsText ? unitsText : dollarsText;
  return `Suggested stake: ${primary} (${pct} · ¼-Kelly)`;
}

function stakeLine(pick) {
  const stake = suggestedParlayStake(pick.legs, americanToDecimal(pick.american));
  return formatStakeLine(stake);
}

/** Same stake line, for a single raw candidate rather than an assembled pick. */
function singleStakeLine(candidate) {
  return formatStakeLine(suggestedStake(candidate));
}

function renderConfidence(pick) {
  const color = confidenceColor(pick.score, state.minScore);
  const beats = Math.round(pick.percentile ?? 0);
  const stake = stakeLine(pick);

  return `
    <div class="confidence" style="--conf:${color}">
      <div class="conf-track">
        <span class="conf-fill" style="width:${Math.round(pick.score)}%"></span>
      </div>
      <div class="conf-label">
        <span>Confidence <span class="conf-score">${Math.round(pick.score)}</span>/100</span>
        <span>Beats ${beats}% of the board</span>
      </div>
      ${stake ? `<div class="stake-line">${esc(stake)}</div>` : ''}
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
  const isCombo = pick.type === 'combo';
  const lead = pick.legs[0];
  const sport = lead.sportTitle ?? lead.sportKey;
  const flagged = pick.meetsStandard === false;
  // Badges whichever card matches one of today's server-tracked Top 5 —
  // the same candidate id scheme (eventId+market+outcome+point) both the
  // client and worker's own topPicks() call produce, so a straight id
  // lookup is all this needs (see loadTop5Tags).
  const isTop5 = !isCombo && state.top5Ids.has(lead.id);

  return `
    <article class="pick ${flagged ? 'is-outside-standard' : ''}">
      <div class="pick-head">
        <span class="pick-head-left">
          <span class="chip"><strong>${esc(sport)}</strong> ·
            ${isCombo ? '2-leg combo' : 'Straight bet'}</span>
          ${isTop5 ? '<span class="top5-badge">🏆 Top 5</span>' : ''}
        </span>
        <span class="price">${esc(formatAmerican(pick.american))}</span>
      </div>

      ${flagged ? `<div class="pick-flag">⚠ Outside standard criteria — ${esc(pick.flagReason)}</div>` : ''}

      ${renderConfidence(pick)}

      ${isCombo ? `<p class="pair-note">${esc(pick.pairReason)}</p>` : ''}

      ${pick.legs.map((leg, i) => renderLeg(leg, i, isCombo)).join('')}
    </article>`;
}

function renderSlate(slate) {
  renderedLegs.length = 0;

  if (!slate.picks.length) {
    el.picks.innerHTML = `<p class="empty">Nothing loaded yet — the board fills
      in automatically once odds finish fetching. Give it a moment and tap
      Generate again.</p>`;
    return;
  }
  el.picks.innerHTML = slate.picks.map(renderPick).join('');
  hydrateInsights();
}

/* ---------------------------------------------------------------- */
/* History                                                           */
/* ---------------------------------------------------------------- */

function saveHistory() {
  saveJSON(HISTORY_KEY, state.history.slice(0, HISTORY_LIMIT));
}

function recordSlate(slate) {
  state.history.unshift({
    at: slate.generatedAt,
    poolSize: slate.poolSize,
    demo: state.isDemo,
    picks: slate.picks.map((pick) => ({
      type: pick.type,
      american: pick.american,
      score: pick.score,
      percentile: pick.percentile,
      pairReason: pick.pairReason,
      // Full legs, minus the score breakdown: enough to re-render the pick and
      // to re-price it against a later board.
      legs: pick.legs.map(({ parts, ...leg }) => ({
        ...leg,
        // Closing Line Value tracking: the sharp benchmark from the framework
        // this app is built around — beating the closing line, consistently,
        // is what separates a real edge from short-term variance. There's no
        // historical-odds feed here to read a true close from, so this is a
        // best-effort approximation: the freshest price seen for this exact
        // leg while its game hadn't started yet, updated every time the board
        // refreshes (updateClvSnapshots below) and left frozen the moment the
        // game goes off the board. Seeded to the pick's own price so a leg
        // that's never seen again still has a defined (zero-movement) CLV
        // rather than a missing one.
        lastKnownAmerican: leg.american,
        lastKnownAt: slate.generatedAt,
      })),
    })),
  });
  state.history = state.history.slice(0, HISTORY_LIMIT);
  saveHistory();
  renderHistory();
}

/**
 * Refresh each open history leg's CLV snapshot against the board currently in
 * state.candidates. A leg still priced (game hasn't started) gets its
 * lastKnownAmerican/lastKnownAt bumped forward; a leg no longer on the board
 * is left exactly as it was on the last refresh that did see it — which is
 * this app's best available stand-in for "the closing price."
 */
function updateClvSnapshots() {
  const live = livePriceIndex();
  let changed = false;

  for (const entry of state.history) {
    for (const pick of entry.picks) {
      for (const leg of pick.legs) {
        const current = live.get(leg.id);
        if (!current) continue; // off the board — freeze what we last saw
        if (current.american === leg.lastKnownAmerican) continue;
        leg.lastKnownAmerican = current.american;
        leg.lastKnownAt = Date.now();
        changed = true;
      }
    }
  }

  if (changed) saveHistory();
  return changed;
}

/**
 * CLV for one leg, or null when the game hasn't started yet — CLV is only
 * meaningful once the price has actually stopped moving. American odds
 * compare directly regardless of favorite/underdog: a higher number is
 * always the better price for that same side, so pick.american >
 * lastKnownAmerican is a beaten close in every case, not just favorites.
 */
function clvFor(leg) {
  if (livePriceIndex().has(leg.id)) return null; // still on the board, not closed
  if (leg.lastKnownAmerican === leg.american) return { pct: 0, beat: null };

  const pct =
    (impliedProb(leg.lastKnownAmerican) - impliedProb(leg.american)) * 100;
  return { pct, beat: leg.american > leg.lastKnownAmerican };
}

/** Where each stored leg is priced on the board we're holding right now. */
function livePriceIndex() {
  const index = new Map();
  for (const c of state.candidates) index.set(c.id, c);
  return index;
}

function renderLiveLine(leg, live) {
  if (!live) {
    const clv = clvFor(leg);
    if (!clv || clv.beat === null) {
      return `<div class="h-now"><span class="h-gone">off the board</span></div>`;
    }
    // "Closing" here means the last price this app ever saw for this leg
    // before its game started, not a real historical-odds close — this app
    // has no time-series feed to read a true one from. Framed honestly as an
    // approximation rather than borrowing the sharp-betting term outright.
    const cls = clv.beat ? 'h-moved-up' : 'h-moved-down';
    return `
      <div class="h-now">
        <span class="${cls}">${clv.beat ? 'Beat' : 'Missed'} the close by ${Math.abs(clv.pct).toFixed(1)}pp</span>
        · closed ${esc(formatAmerican(leg.lastKnownAmerican))}
      </div>`;
  }
  if (live.american === leg.american) {
    return `<div class="h-now">now ${esc(formatAmerican(live.american))} · unchanged</div>`;
  }

  const better = live.american > leg.american;
  const cls = better ? 'h-moved-up' : 'h-moved-down';
  return `
    <div class="h-now">now
      <span class="${cls}">${esc(formatAmerican(live.american))}</span>
      · ${better ? 'better than' : 'worse than'} when picked
    </div>`;
}

function renderHistoryBooks(leg) {
  const offers = bookOffers(leg);

  const links = Object.keys(SPORTSBOOKS)
    .map((id) => {
      const meta = SPORTSBOOKS[id];
      const offer = offers.get(id);
      if (!offer) {
        return `<span class="h-book is-off">${esc(meta.name)} —</span>`;
      }
      return `
        <a class="h-book" style="--book:${esc(meta.color)}"
           href="${esc(offer.link ?? meta.url)}" target="_blank" rel="noopener">
          ${esc(meta.name)} ${esc(formatAmerican(offer.american))}
        </a>`;
    })
    .join('');

  return `<div class="history-books">${links}</div>`;
}

/**
 * Average CLV across every closed (off-the-board) leg in history. This is
 * the number the framework this app is built around treats as the real
 * long-run tell — a single bet's outcome is variance, but a bettor who
 * consistently beats the close is, by that model, playing a genuine edge
 * regardless of how any one game landed.
 */
function aggregateClv() {
  let sum = 0;
  let n = 0;
  for (const entry of state.history) {
    for (const pick of entry.picks) {
      for (const leg of pick.legs) {
        const clv = clvFor(leg);
        if (!clv || clv.beat === null) continue;
        sum += clv.pct;
        n++;
      }
    }
  }
  return n ? { avgPct: sum / n, n } : null;
}

function renderHistory() {
  const total = state.history.reduce((n, entry) => n + entry.picks.length, 0);
  el.historyCount.textContent = String(total);
  el.historyCount.hidden = total === 0;

  const clv = aggregateClv();
  el.clvSummary.hidden = !clv;
  if (clv) {
    const sign = clv.avgPct >= 0 ? '+' : '';
    el.clvSummary.textContent =
      `Your CLV: ${sign}${clv.avgPct.toFixed(1)}pp avg, beating the close vs. missing it, ` +
      `across ${clv.n} closed ${clv.n === 1 ? 'leg' : 'legs'}.`;
    el.clvSummary.classList.toggle('is-negative', clv.avgPct < 0);
  }

  if (!state.history.length) {
    el.historyList.innerHTML =
      `<p class="history-empty">No picks yet. Hit Generate Picks.</p>`;
    return;
  }

  const live = livePriceIndex();

  el.historyList.innerHTML = state.history
    .map((entry, entryIndex) => {
      const groups = entry.picks
        .map((pick, pickIndex) => {
          const color = confidenceColor(pick.score ?? state.minScore, state.minScore);

          const legs = pick.legs
            .map((leg) => {
              const current = live.get(leg.id) ?? null;
              return `
                <div class="history-item" style="--conf:${color}">
                  <div class="h-sel">${esc(leg.selection)}</div>
                  <div class="h-meta">
                    <span class="h-price">${esc(formatAmerican(leg.american))}</span>
                    · ${esc(leg.book)} · ${esc(leg.away)} @ ${esc(leg.home)}
                  </div>
                  ${renderLiveLine(leg, current)}
                  ${renderHistoryBooks(current ?? leg)}
                </div>`;
            })
            .join('');

          return `
            <button class="history-entry" type="button"
                    data-entry="${entryIndex}" data-pick="${pickIndex}">
              ${legs}
              <span class="history-foot">
                <span>${esc(formatAmerican(pick.american))} ·
                  ${pick.type === 'combo' ? '2-leg' : 'straight'}</span>
                <span class="h-reopen">Reopen</span>
              </span>
            </button>`;
        })
        .join('');

      return `
        <div class="history-group">
          <h3>${esc(timeFmt.format(new Date(entry.at)))} ·
            ${entry.picks.length} pick${entry.picks.length === 1 ? '' : 's'} ·
            ${entry.poolSize} available${entry.demo ? ' · demo' : ''}</h3>
          ${groups}
        </div>`;
    })
    .join('');
}

/** Reopen a stored pick on the main view, re-priced against the current board. */
function reopenPick(entryIndex, pickIndex) {
  const stored = state.history[entryIndex]?.picks?.[pickIndex];
  if (!stored) return;

  const live = livePriceIndex();
  const pick = {
    ...stored,
    legs: stored.legs.map((leg) => live.get(leg.id) ?? leg),
  };

  renderedLegs.length = 0;
  el.picks.innerHTML = renderPick(pick);
  hydrateInsights();
  setHistoryOpen(false);
  el.picks.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Shared side-panel open/close for History, Bankroll, and Guide — they all
 * slide from the same edge and share one scrim, so only one can be open at a
 * time. Opening one closes whichever else was open rather than stacking.
 */
let openAside = null; // { panel, toggle } or null

function setAsideOpen(panel, toggle, open, { onOpen, focusEl } = {}) {
  if (open && openAside && openAside.panel !== panel) {
    openAside.panel.hidden = true;
    openAside.toggle.setAttribute('aria-expanded', 'false');
  }
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  el.scrim.hidden = !open;
  openAside = open ? { panel, toggle } : null;
  if (open) {
    onOpen?.();
    focusEl?.focus();
  }
}

function setHistoryOpen(open) {
  // Re-price on open so the panel reflects the board we're holding now.
  setAsideOpen(el.historyPanel, el.historyToggle, open, {
    onOpen: renderHistory,
    focusEl: el.historyClose,
  });
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
  setAsideOpen(el.statsDrawer, statsDrawerToggleStub, open, { focusEl: el.statsDrawerClose });
}

function renderStatsSkeleton() {
  return `<div class="stats-skeleton">${
    Array.from({ length: 6 }, () => '<div class="stats-skeleton-row"></div>').join('')
  }</div>`;
}

/** Every book's price on this exact line, sorted best to worst, with the
 * implied probability that price carries — the same quotes already backing
 * the book buttons on the compact card, just as a full table instead of a
 * greyed-out/highlighted row of pills. */
function renderPriceTable(leg) {
  if (!leg.quotes?.length) return '';
  const sorted = [...leg.quotes].sort((a, b) => b.decimal - a.decimal);
  const rows = sorted.map((q, i) => `
    <tr class="${i === 0 ? 'is-best' : ''}">
      <td>${esc(q.book)}</td>
      <td>${esc(formatAmerican(q.american))}</td>
      <td>${(impliedProb(q.american) * 100).toFixed(1)}%</td>
    </tr>`).join('');

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
    ? `<span class="stat-pill is-warn">Retractable roof — status unknown</span>`
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

/** A labelled horizontal bar, its width the share of `total` — the same
 * lightweight div-width technique as the confidence meter, no charting
 * library needed for something this simple. */
function statBar(label, count, total) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return `
    <div class="mma-bar-row">
      <span class="mma-bar-label">${esc(label)}</span>
      <div class="mma-bar-track"><span class="mma-bar-fill" style="width:${pct}%"></span></div>
      <span class="mma-bar-count">${count}</span>
    </div>`;
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

/**
 * Striking/takedown accuracy and significant-strike-by-position bars, from
 * ufc.com's own athlete page — only ever populated for a fighter who's
 * actually competed in the UFC, null otherwise (a PFL/Bellator-only fighter
 * has no ufc.com profile at all, a real "no data" case, not an error).
 */
function pctBar(label, pct) {
  return `
    <div class="mma-bar-row">
      <span class="mma-bar-label">${esc(label)}</span>
      <div class="mma-bar-track"><span class="mma-bar-fill" style="width:${pct}%"></span></div>
      <span class="mma-bar-count">${pct}%</span>
    </div>`;
}

function renderUfcCareerStats(fighter) {
  const ufc = fighter?.ufc;
  if (!ufc) return '';
  const rows = [];
  if (ufc.strikingAccuracy != null) rows.push(pctBar('Striking Acc.', ufc.strikingAccuracy));
  if (ufc.takedownAccuracy != null) rows.push(pctBar('Takedown Acc.', ufc.takedownAccuracy));
  for (const p of ufc.strikePosition ?? []) rows.push(pctBar(`Str. ${p.label}`, p.pct));
  if (!rows.length) return '';
  return `<p class="stats-fighter-label">${esc(fighter.name)}</p>${rows.join('')}`;
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
    formAway.length ? `<p class="stats-fighter-label">${esc(away)} — Recent Form</p>${tennisFormTable(formAway)}` : '',
    formHome.length ? `<p class="stats-fighter-label">${esc(home)} — Recent Form</p>${tennisFormTable(formHome)}` : '',
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
  const side = (fighter) => fighter ? `
    <div class="mma-photo-side">
      ${photoOf(fighter)
        ? `<img class="mma-photo" src="${esc(photoOf(fighter))}" alt="${esc(fighter.name)}" loading="lazy"
             onerror="this.outerHTML='<span class=&quot;mma-photo mma-photo-fallback&quot;>${initials(fighter.name)}</span>'">`
        : `<span class="mma-photo mma-photo-fallback">${initials(fighter.name)}</span>`}
      <p class="mma-photo-name">${esc(fighter.name)}</p>
    </div>` : '';

  if (!photoOf(me) && !photoOf(opponent)) return '';
  return `
    <div class="mma-photo-row">
      ${side(me)}
      ${opponent ? '<span class="mma-photo-vs">VS</span>' : ''}
      ${side(opponent)}
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
function renderMmaBreakdown(mmaContext, subjectName) {
  const { me, opponent } = resolveMmaFighters(mmaContext, subjectName);
  if (!me) return '';

  const sections = [];

  const photos = renderMmaPhotos(me, opponent);
  if (photos) sections.push(photos);

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

  const ufcMe = renderUfcCareerStats(me);
  const ufcOpp = opponent ? renderUfcCareerStats(opponent) : '';
  if (ufcMe || ufcOpp) {
    sections.push(`
      <div class="stats-section">
        <h3>Career Stats <span class="stats-source">via UFC.com</span></h3>
        ${ufcMe}${ufcOpp}
      </div>`);
  }

  const relPills = [`<span class="stat-pill">${esc(me.name)}: ${dataReliability(me.history)} (${me.history?.length ?? 0} fights on file)</span>`];
  if (opponent) {
    relPills.push(`<span class="stat-pill">${esc(opponent.name)}: ${dataReliability(opponent.history)} (${opponent.history?.length ?? 0} fights on file)</span>`);
  }
  sections.push(`<div class="stats-section"><h3>Data Reliability</h3><div class="stats-pills">${relPills.join('')}</div></div>`);

  const methodBars = (fighter) => {
    const fin = finishSummary(fighter);
    if (!fin) return '';
    return `
      <p class="stats-fighter-label">${esc(fighter.name)} — Method of Victory (${fin.wins} wins)</p>
      ${statBar('KO/TKO', fin.knockout, fin.wins)}
      ${statBar('Submission', fin.submission, fin.wins)}
      ${statBar('Decision', fin.decision, fin.wins)}`;
  };
  const victoryHtml = [methodBars(me), opponent ? methodBars(opponent) : ''].filter(Boolean).join('');
  if (victoryHtml) sections.push(`<div class="stats-section"><h3>Method of Victory</h3>${victoryHtml}</div>`);

  const defeatBars = (fighter) => {
    const vuln = vulnerabilitySummary(fighter);
    if (!vuln) return '';
    const otherLosses = vuln.losses - vuln.koLosses - vuln.subLosses;
    return `
      <p class="stats-fighter-label">${esc(fighter.name)} — Method of Defeat (${vuln.losses} losses)</p>
      ${statBar('KO/TKO', vuln.koLosses, vuln.losses)}
      ${statBar('Submission', vuln.subLosses, vuln.losses)}
      ${statBar('Decision/Other', otherLosses, vuln.losses)}`;
  };
  const defeatHtml = [defeatBars(me), opponent ? defeatBars(opponent) : ''].filter(Boolean).join('');
  if (defeatHtml) sections.push(`<div class="stats-section"><h3>Method of Defeat</h3>${defeatHtml}</div>`);

  const roundsHtml = (fighter) => {
    const { rounds } = fighterRoundsEnded(fighter.history);
    if (!rounds.length) return '';
    const total = rounds.reduce((n, r) => n + r.count, 0);
    return `
      <p class="stats-fighter-label">${esc(fighter.name)} — Fights End By Round</p>
      ${rounds.map((r) => statBar(`Round ${r.round}`, r.count, total)).join('')}`;
  };
  const roundsAll = [roundsHtml(me), opponent ? roundsHtml(opponent) : ''].filter(Boolean).join('');
  if (roundsAll) sections.push(`<div class="stats-section"><h3>Fights End By Round</h3>${roundsAll}</div>`);

  const activityHtml = (fighter) => {
    const byYear = fighterActivityByYear(fighter.history);
    if (!byYear.length) return '';
    const max = Math.max(...byYear.map((a) => a.count));
    return `
      <p class="stats-fighter-label">${esc(fighter.name)} — Activity by Year</p>
      ${byYear.map((a) => statBar(String(a.year), a.count, max)).join('')}`;
  };
  const activityAll = [activityHtml(me), opponent ? activityHtml(opponent) : ''].filter(Boolean).join('');
  if (activityAll) sections.push(`<div class="stats-section"><h3>Activity by Year</h3>${activityAll}</div>`);

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
 * Open the More Stats drawer for one leg: show a skeleton immediately, then
 * fill in the full breakdown once research resolves. Reuses the exact same
 * cached fetches (tennisArchive/mmaContextFor/eventContext/weatherFor) the
 * compact card's "why" panel already triggers — opening this for a leg
 * whose "why" panel is already open costs no extra network call.
 */
async function openStatsDrawer(leg, opposite = null, { fullscreen = false } = {}) {
  el.statsDrawer.classList.toggle('is-fullscreen', fullscreen);
  el.statsDrawerTitle.textContent = leg.selection;
  el.statsDrawerBody.innerHTML = renderStatsSkeleton();
  setStatsDrawerOpen(true);

  const stake = singleStakeLine(leg);
  const devilStake = opposite ? singleStakeLine(opposite) : null;

  let bullets = [];
  let weather = null;
  let mmaBreakdownHtml = '';
  let tennisBreakdownHtml = '';
  let analysisText = null;
  let victoryMethods = null;
  let favoredSide = null;
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
      const subject = leg.selection.replace(/ to win$/i, '').trim();
      mmaBreakdownHtml = renderMmaBreakdown(mmaContext, subject);
    } else {
      const [context, w] = await Promise.all([eventContext(leg), weatherFor(leg)]);
      weather = w;
      bullets = buildInsights(leg, { context, weather });
    }
    const analysis = await analysisPromise;
    // The worker always returns a JSON envelope now — {analysis,
    // favoredSide, quickTake, devilsAdvocate, victoryMethods?} —
    // favoredSide is the model's own independent read of which side the
    // facts support, worked out with no knowledge of which side this card
    // is actually highlighting. Compared against leg below so a
    // disagreement is shown plainly instead of the title and the write-up
    // silently contradicting each other.
    if (analysis) {
      try {
        const parsed = JSON.parse(analysis);
        analysisText = parsed.analysis ?? analysis;
        favoredSide = parsed.favoredSide ?? null;
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

  // leg.outcomeName is the exact team/player name for h2h and spreads, and
  // literally "Over"/"Under" for totals — the same vocabulary favoredSide
  // uses, so a plain string compare is enough to detect disagreement.
  const disagreesWithPick = favoredSide && favoredSide !== leg.outcomeName;
  const disagreementHtml = disagreesWithPick
    ? `<p class="analysis-disagree">⚠ This matchup read favors <strong>${esc(favoredSide)}</strong>, not ${esc(leg.outcomeName)} — the algorithm's price-based pick and this qualitative read don't agree here. Worth weighing both before betting.</p>`
    : '';

  const methodLabel = { SUB: 'Submission', TKO: 'TKO/KO', DEC: 'Decision' };
  const victoryList = (entries) =>
    (entries ?? [])
      .map((v) => `<li><strong>${esc(methodLabel[v.method] ?? v.method)}</strong>${v.percentage != null ? ` — ${v.percentage}%` : ''}: ${esc(v.reasoning)}</li>`)
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

  // The AI-written matchup analysis replaces the quantitative price case
  // entirely when it's available (see worker/src/analysis.js) — falls back
  // to the existing no-vig/EV read whenever it isn't, so the drawer always
  // has a real "why" either way.
  const priceHtml = analysisText
    ? `
      <div class="stats-section">
        <h3>Matchup Analysis</h3>
        ${disagreementHtml}
        ${quickTakeHtml}
        <p class="analysis-text">${esc(analysisText)}</p>
        ${victoryMethodsHtml}
        ${stake ? `<div class="stake-line">${esc(stake)}</div>` : ''}
      </div>`
    : `
      <div class="stats-section">
        <h3>The Market &amp; Price Case</h3>
        <ul>${explainExtensive(leg).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        ${stake ? `<div class="stake-line">${esc(stake)}</div>` : ''}
      </div>`;

  // The other side of the same market, argued on its own terms — the board
  // highlights one side, but a market cutting both ways is exactly why a bet
  // has a price at all, and the case against the algorithm's lean deserves
  // the same treatment as the case for it. devilsAdvocate (qualitative, from
  // the same AI read as favoredSide) leads when available; the quantitative
  // price-case bullets always follow, since that math holds regardless of
  // whether the AI analysis loaded.
  const devilQuickTakeHtml = devilsAdvocate?.length
    ? `<ul class="quick-take-list">${devilsAdvocate.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
    : '';
  const devilHtml = opposite
    ? `
      <div class="stats-section devil-advocate">
        <h3>Devil's Advocate — ${esc(opposite.selection)}</h3>
        ${devilQuickTakeHtml}
        <ul>${explainExtensive(opposite).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        ${devilStake ? `<div class="stake-line">${esc(devilStake)}</div>` : ''}
      </div>`
    : '';

  // The drawer may have been closed (or reopened for a different leg) while
  // these fetches were in flight — never paint a stale result over whatever
  // the user is looking at now.
  if (el.statsDrawer.hidden || el.statsDrawerTitle.textContent !== leg.selection) return;

  const awayLogo = teamLogoUrl(leg.sportKey, leg.away);
  const homeLogo = teamLogoUrl(leg.sportKey, leg.home);
  el.statsDrawerBody.innerHTML =
    `<p class="stats-meta">` +
    `<strong>` +
    `${awayLogo ? `<img class="stats-meta-logo" src="${esc(awayLogo)}" alt="" loading="lazy">` : ''}${esc(leg.away)} @ ` +
    `${homeLogo ? `<img class="stats-meta-logo" src="${esc(homeLogo)}" alt="" loading="lazy">` : ''}${esc(leg.home)}` +
    `</strong> · ${esc(leg.marketLabel)} · ` +
    `${esc(dateFmt.format(new Date(leg.commenceMs)))}</p>` +
    renderWeatherPills(weather) +
    priceHtml +
    devilHtml +
    mmaBreakdownHtml +
    tennisBreakdownHtml +
    renderStatsResearch(bullets) +
    renderPriceTable(leg);
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

el.statsDrawerClose.addEventListener('click', () => setStatsDrawerOpen(false));

function persistBankroll() {
  saveJSON(BANKROLL_KEY, state.bankroll);
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
    ? 'Applied — every "why" panel now shows a real $ or unit amount.'
    : 'Tap Submit to start seeing suggested stakes in real $ or units, not just %.';
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
  // more — for a finished game that's immediate, so it's often gone from
  // state.rawEvents entirely even though /scores still has its final
  // result. Backfill those from whatever scores are already cached
  // (state.slateScores, populated by refreshSlateScores) as market-less
  // games — no spread/total/ML, since the book pulled them — so a
  // finished game still shows up with its score instead of vanishing.
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
      ufc_event: undefined,
    });
  }

  return oddsGames.concat(orphanGames)
    .filter((g) => Number.isFinite(g.commenceMs) && withinDayFilter(g.commenceMs, g.sportKey))
    .sort((a, b) => a.commenceMs - b.commenceMs);
}

/** Raw per-team score lookup from a /scores event, same pattern as worker/src/tracking.js's own gradePick() uses. */
function slateScoreFor(scoreEvent, teamName) {
  if (!scoreEvent?.scores) return null;
  const entry = scoreEvent.scores.find((s) => s.name === teamName);
  const value = entry ? Number(entry.score) : NaN;
  return Number.isFinite(value) ? value : null;
}

/** 'upcoming' | 'live' | 'finished' for a game, from whatever /scores data is currently cached. */
function slateGameState(game) {
  const scoreEvent = state.slateScores.get(game.eventId);
  if (scoreEvent?.completed) return 'finished';
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
  return outcome ? (outcome.won ? 'won' : 'lost') : null;
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
 * One market cell. A real candidate renders as a clickable price, ringed
 * with a highlight when it grades higher than its market-mate (or when it's
 * the only side priced at all — nothing to compare against, but still the
 * only actionable side). A market with no qualifying price on this side
 * renders a plain dash rather than making the whole game disappear.
 */
function slateCell(cand, opposite, { totalLabel, suppressRec = false, rank = null } = {}) {
  if (!cand) return `<span class="slate-cell is-empty">—</span>`;

  // Once a game is live or finished, the recommended-side glow stops
  // meaning anything — it was a pregame read, not a live one — so it's
  // suppressed rather than left pointing at a bet that's already decided.
  const recommended = !suppressRec && (opposite ? cand.score > opposite.score : true);
  const idx = renderedSlateCells.push({ cand, opposite }) - 1;
  const label = totalLabel ? `${totalLabel}${formatAmerican(cand.american)}` : formatAmerican(cand.american);
  const badge = recommended && rank ? `<span class="slate-rank-badge">${rank}</span>` : '';

  return `
    <button type="button" class="slate-cell ${recommended ? 'is-rec' : ''}"
            data-slate-cell="${idx}" title="${esc(cand.selection)}">${badge}${esc(label)}</button>`;
}

/**
 * Up to three ranked picks per game — the same recommended side per market
 * (spread/total/moneyline) slateCell() already glows, just ranked 1 (Main),
 * 2 (Secondary), 3 (Tertiary) by score. Rank 1 is always the same candidate
 * bestCandidateForGame() picks, since that's just the highest-scored of
 * these same three — so "the Main play" shown pregame and "the pick" a
 * finished game's outcome later gets graded against are never two
 * different answers to the same question.
 */
function rankedGamePicks(game) {
  const picks = [];
  for (const [away, home] of [
    [game.spreads.away, game.spreads.home],
    [game.totals.away, game.totals.home],
    [game.h2h.away, game.h2h.home],
  ]) {
    if (away && home) picks.push(away.score > home.score ? away : home);
    else if (away || home) picks.push(away || home);
  }
  picks.sort((a, b) => b.score - a.score);

  const ranks = new Map();
  picks.forEach((cand, i) => ranks.set(cand.id, i + 1));
  return ranks;
}

function slateTeamRow(game, side, { gameState, scoreEvent, ranks, hideMarkets = false }) {
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
      ${slateCell(spread, oppSpread, { suppressRec, rank: spread && ranks.get(spread.id) })}
      ${slateCell(total, oppTotal, { totalLabel, suppressRec, rank: total && ranks.get(total.id) })}
      ${slateCell(h2h, oppH2h, { suppressRec, rank: h2h && ranks.get(h2h.id) })}
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
  const outcome = slateGameOutcome(game, rec); // 'won' | 'lost' | null — only set once finished
  const isFinished = gameState === 'finished';
  const rowProps = { gameState, scoreEvent, ranks: rankedGamePicks(game), hideMarkets: isFinished };

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

  // Once a game is finished, the per-market price grid no longer means
  // anything — replaced by a single line naming the algorithm's Main play
  // (the same candidate the card's green/red border is graded from) and
  // whether it won. No tag at all if it couldn't be graded (e.g. a push).
  const mainPlayHtml = isFinished && rec
    ? `<div class="slate-main-play">
        <span class="slate-main-play-label">Main play</span>
        <span class="slate-main-play-selection">${esc(rec.selection)}</span>
        ${outcome ? `<span class="slate-main-play-outcome is-${outcome}">${outcome === 'won' ? 'Won' : 'Lost'}</span>` : ''}
      </div>`
    : '';

  return `
    <article class="${cardClass}" ${isMlb ? `data-game-index="${idx}"` : ''}>
      <div class="slate-game-time">
        ${timeHtml}
        ${infoButtonHtml}
      </div>
      ${isFinished ? '' : `
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
 * The eight fixed league groups, each with its live game count. Every group
 * is always "loaded" in the sense that refreshAllLeagues() already asked for
 * it on boot — a count of 0 just means nothing's on the board right now
 * (MMA between fight weeks, say), not that the league needs fetching.
 */
function renderSlateLeagueOptions() {
  el.slateLeagueSelect.disabled = false;
  if (!state.slateLeague) state.slateLeague = LEAGUE_GROUPS[0].id;

  el.slateLeagueSelect.innerHTML = LEAGUE_GROUPS
    .map((group) => {
      const count = groupGameCount(group);
      const label = `${group.label} — ${count} game${count === 1 ? '' : 's'}`;
      return `<option value="${esc(group.id)}" ${group.id === state.slateLeague ? 'selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
}

/**
 * Filter MMA games to only those with moneyline markets and upcoming dates.
 * Only includes UFC/PFL events with known event metadata (to filter out noise).
 */
function filterMmaGames(games) {
  const now = Date.now();
  const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;

  return games.filter((game) => {
    // Must have moneyline (h2h) odds
    if (!game.h2h?.away || !game.h2h?.home) return false;

    // Must have event enrichment (Sherdog or fallback date-based)
    if (!game.ufc_event?.event) return false;

    // Should be within roughly 2 weeks (upcoming events) — no lower bound, so
    // a card that's started stays visible instead of vanishing mid-event.
    if (game.commenceMs > now + twoWeeksMs) return false;

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
    const eventKey = game.ufc_event.event; // Already guaranteed to exist
    if (!byEvent.has(eventKey)) byEvent.set(eventKey, []);
    byEvent.get(eventKey).push(game);
  }

  return [...byEvent.entries()]
    .map(([eventKey, cardGames]) => {
      const label = cardGames.length > 1
        ? `${eventKey} — ${cardGames.length} fights`
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
      const label = `${title} — ${matches.length} match${matches.length === 1 ? '' : 'es'}`;
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

  // Fire-and-forget: renders now with whatever's already cached (nothing on
  // first load), then repaints once fresh scores land — but only if the
  // user is still looking at this same league by the time they do, so a
  // slow response can't overwrite a board they've since navigated away from.
  refreshSlateScores(group).then((updated) => {
    if (updated && (LEAGUE_GROUP_BY_ID.get(state.slateLeague) ?? LEAGUE_GROUPS[0]) === group) {
      renderFullSlate();
    }
  });

  const allGames = buildSlateGames(group.keys);

  if (!allGames.length) {
    el.slateBody.innerHTML = `<p class="empty">Nothing on the board for ${esc(group.label)} right now — check back closer to game time.</p>`;
    el.slateEventRow.hidden = true;
    return;
  }

  let games = allGames;
  const clusters = eventClustersFor(group.id, allGames);
  const eventLabel = group.id === 'mma' ? 'Card' : 'Event';
  el.slateEventLabel && (el.slateEventLabel.textContent = eventLabel);

  if (clusters.length >= 2) {
    const totalGames = clusters.reduce((sum, c) => sum + c.games.length, 0);
    const allLabel = group.id === 'mma' ? `All cards — ${totalGames} fights` : `All of ${group.label} — ${totalGames} matches`;
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

  // Upcoming/Live/Finished toggle — applied after event/card selection so
  // switching it never reshuffles the tournament/card dropdown itself.
  games = games.filter((g) => slateGameState(g) === state.slateGameFilter);

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
        eventName = game.ufc_event?.event || 'Upcoming Event';
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
 * Pixel's Picks: fully automatic, no button — every league is already
 * loaded (refreshAllLeagues ran at boot), so this just ranks the pool
 * already sitting in state.candidates, scoped to the current day filter,
 * and re-runs whenever that pool changes (boot, Today/Tomorrow toggle).
 * Up to TOP_PICKS_COUNT picks; topPicks()'s guaranteeCount fills any slots
 * the sharp standard (-250/+250, confidence floor) can't with the next-best
 * candidates available, flagged as such — but minEv/minKelly are a hard
 * floor even in that fallback, so a thin day with too few real edges comes
 * back with fewer than 8 rather than padding the board out with a bet
 * that's demonstrably not worth taking.
 */
async function generate() {
  try {
    await enrichTennisAltSpreads();
    updateClvSnapshots();

    const slate = topPicks(dayFilteredCandidates(), {
      count: CONFIG.TOP_PICKS_COUNT,
      oddsMin: state.oddsMin,
      oddsMax: state.oddsMax,
      minScore: state.minScore,
      // A candidate can clear minScore on liquidity/agreement/freshness
      // alone with almost no real edge — these are the hard "is this
      // actually worth the stake" floors on top of that (see RULES in
      // engine.js). Applied even to guaranteeCount's fallback slots: a -EV
      // or dust-edge pick doesn't become a real lock just because the board
      // is thin that day.
      minEv: RULES.MIN_EV_PCT,
      minKelly: RULES.MIN_KELLY_FRACTION,
      guaranteeCount: true,
    });

    state.lastPixelSlate = slate;
    el.pixelSortRow.hidden = !slate.picks.length;
    renderSlate({ ...slate, picks: sortPicks(slate.picks, state.pixelSort) });
    recordSlate(slate);
    trackNewPixelPicks(slate.picks).catch((err) => console.error('Pick tracking failed:', err));
  } catch (error) {
    setStatus(error.message, 'error');
    el.picks.innerHTML = `<p class="empty">Couldn't reach the odds feed.
      ${esc(error.message)}</p>`;
  }
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
 * the full price/why/books breakdown was pushing a whole parlay or a Pixel
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

// One delegated listener per container that can render a "?" why-button —
// the Board's picks list and the Parlay Builder's result both use renderLeg.
el.picks.addEventListener('click', toggleWhyPanel);
el.parlayResult.addEventListener('click', toggleWhyPanel);
el.picks.addEventListener('click', toggleLegBanner);
el.parlayResult.addEventListener('click', toggleLegBanner);

el.dayFilterToday.addEventListener('click', () => setDayFilter('today'));
el.dayFilterTomorrow.addEventListener('click', () => setDayFilter('tomorrow'));

el.slateStateUpcoming.addEventListener('click', () => setSlateGameFilter('upcoming'));
el.slateStateLive.addEventListener('click', () => setSlateGameFilter('live'));
el.slateStateFinished.addEventListener('click', () => setSlateGameFilter('finished'));

el.slateLoad.addEventListener('click', loadSlate);
el.slateLeagueSelect.addEventListener('change', () => {
  state.slateLeague = el.slateLeagueSelect.value || null;
  state.slateEvent = 'all'; // a card filter from the old league means nothing for a new one
  saveJSON(SLATE_LEAGUE_KEY, state.slateLeague);
  renderFullSlate();
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
  if (entry) openStatsDrawer(entry.cand, entry.opposite);
});

el.historyToggle.addEventListener('click', () => setHistoryOpen(el.historyPanel.hidden));
el.historyClose.addEventListener('click', () => setHistoryOpen(false));

el.bankrollToggle.addEventListener('click', () => setBankrollOpen(el.bankrollPanel.hidden));
el.bankrollClose.addEventListener('click', () => setBankrollOpen(false));

el.guideToggle.addEventListener('click', () => setGuideOpen(el.guidePanel.hidden));
el.guideClose.addEventListener('click', () => setGuideOpen(false));

el.learningPanelClose.addEventListener('click', () => {
  el.learningPanel.hidden = true;
  el.scrim.hidden = true;
});

const learningToggle = document.getElementById('learningToggle');
if (learningToggle) {
  learningToggle.addEventListener('click', () => openLearningDashboard());
}

el.checkResultsBtn.addEventListener('click', () => runResultCheck());

el.trackerSportFilter.addEventListener('change', (event) => {
  const box = event.target.closest('[data-tracker-sport]');
  if (!box) return;
  if (box.checked) state.trackerExcludedSports.delete(box.dataset.trackerSport);
  else state.trackerExcludedSports.add(box.dataset.trackerSport);
  saveJSON(TRACKER_SPORT_FILTER_KEY, [...state.trackerExcludedSports]);
  renderLearningDashboard();
});

el.calendarPrevMonth.addEventListener('click', () => {
  state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1);
  renderLearningDashboard();
});

el.calendarNextMonth.addEventListener('click', () => {
  state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1);
  renderLearningDashboard();
});

el.calendarMetricToggle.addEventListener('click', () => {
  const metrics = ['dollars', 'units', 'roi'];
  state.calendarMetric = metrics[(metrics.indexOf(state.calendarMetric) + 1) % metrics.length];
  saveJSON(CALENDAR_METRIC_KEY, state.calendarMetric);
  renderLearningDashboard();
});

// Tapping a calendar day jumps to and expands that day's entry in Daily History below.
el.calendarGrid.addEventListener('click', (event) => {
  const cell = event.target.closest('[data-date]');
  if (!cell) return;
  const block = el.dailyHistory.querySelector(`[data-day-date="${cell.dataset.date}"]`);
  if (!block) return;
  block.open = true;
  block.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

el.perfPeriodTabs.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-period]');
  if (!btn) return;
  state.perfPeriod = btn.dataset.period;
  [...el.perfPeriodTabs.children].forEach((b) => b.classList.toggle('is-active', b === btn));
  renderLearningDashboard();
});

el.exportDataBtn.addEventListener('click', async () => {
  const csv = await exportData(new Date(0), new Date());
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pixel-pick-history-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

/**
 * Explicit, user-triggered clean-slate action: archives (downloads a CSV of)
 * everything tracked so far, then clears this device's local history and
 * asks the worker to clear its own server-side Top 5 history too — both
 * tracking systems, one button, matching what was actually asked for rather
 * than only resetting one of the two independent histories this app now
 * keeps. Never runs on its own; only ever this click.
 */
el.archiveResetBtn.addEventListener('click', async () => {
  const ok = confirm(
    'This downloads a CSV of everything tracked so far, then permanently clears it — both on this device and the worker\'s own Top 5 history. This can\'t be undone. Continue?',
  );
  if (!ok) return;

  el.archiveResetBtn.disabled = true;
  el.archiveResetBtn.textContent = 'Archiving…';
  try {
    const csv = await exportData(new Date(0), new Date());
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pixel-pick-archive-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    await clearAllPicks();

    if (CONFIG.WORKER_URL) {
      try {
        await fetch(new URL('/top5-reset', CONFIG.WORKER_URL), { method: 'POST' });
      } catch {
        /* Server-side reset is best-effort — the local reset above already succeeded either way. */
      }
    }

    await renderLearningDashboard();
  } finally {
    el.archiveResetBtn.disabled = false;
    el.archiveResetBtn.textContent = 'Archive & Reset All Tracking';
  }
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

el.historyClear.addEventListener('click', () => {
  state.history = [];
  saveHistory();
  renderHistory();
});

el.historyList.addEventListener('click', (event) => {
  const entry = event.target.closest('.history-entry');
  // A book link inside the entry is its own destination, not a reopen.
  if (!entry || event.target.closest('.h-book')) return;
  reopenPick(Number(entry.dataset.entry), Number(entry.dataset.pick));
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

/* ---------------------------------------------------------------- */
/* Parlay Builder                                                     */
/* ---------------------------------------------------------------- */

/** sportKey -> { title, markets: Map<marketKey, label> }, from whatever the
 * Board tab currently has loaded. This is the only source of sports/markets
 * the builder can offer — it never fetches anything of its own. */
function persistParlayFilters() {
  saveJSON(PARLAY_KEY, {
    oddsMin: state.parlay.oddsMin,
    oddsMax: state.parlay.oddsMax,
    minScore: state.parlay.minScore,
    legCount: state.parlay.legCount,
  });
}

function renderParlaySliders() {
  el.parlayOddsMinSlider.value = String(state.parlay.oddsMin);
  el.parlayOddsMaxSlider.value = String(state.parlay.oddsMax);
  el.parlayConfidenceSlider.value = String(state.parlay.minScore);
  el.parlayLegCountSlider.value = String(state.parlay.legCount);

  el.parlayOddsMinLabel.textContent = formatAmerican(state.parlay.oddsMin);
  el.parlayOddsMaxLabel.textContent = formatAmerican(state.parlay.oddsMax);
  el.parlayConfidenceLabel.textContent = `≥ ${Math.round(state.parlay.minScore)}`;
  el.parlayLegCountLabel.textContent = String(state.parlay.legCount);
}

/**
 * The candidate pool a parlay may draw from: every market on every game
 * under the chosen league group, narrowed further to one tournament/card if
 * the event filter isn't 'all'. Mirrors Full Slate's League → Event pattern
 * exactly, just resolved to a candidate list instead of a rendered board.
 */
function resolveParlayPool() {
  const group = LEAGUE_GROUP_BY_ID.get(state.parlayLeague);
  if (!group) return [];

  const allGames = buildSlateGames(group.keys);
  const clusters = eventClustersFor(group.id, allGames);
  const games = clusters.length && state.parlayEvent !== 'all'
    ? (clusters.find((c) => c.eventKey === state.parlayEvent)?.games ?? [])
    : allGames;

  const eventIds = new Set(games.map((g) => g.eventId));
  return state.candidates.filter((c) => eventIds.has(c.eventId));
}

function renderParlayFilters() {
  el.parlayLeagueSelect.innerHTML = LEAGUE_GROUPS
    .map((g) => `<option value="${esc(g.id)}" ${g.id === state.parlayLeague ? 'selected' : ''}>${esc(g.label)} — ${groupGameCount(g)} games</option>`)
    .join('');
  if (!state.parlayLeague) {
    state.parlayLeague = LEAGUE_GROUPS[0].id;
    el.parlayLeagueSelect.value = state.parlayLeague;
  }

  const group = LEAGUE_GROUP_BY_ID.get(state.parlayLeague);
  const allGames = group ? buildSlateGames(group.keys) : [];
  const clusters = group ? eventClustersFor(group.id, allGames) : [];

  if (clusters.length >= 2) {
    el.parlayEventFilterRow.hidden = false;
    const totalGames = clusters.reduce((sum, c) => sum + c.games.length, 0);
    const allLabel = group.id === 'mma' ? `All cards — ${totalGames} fights` : `All of ${group.label} — ${totalGames} matches`;
    el.parlayEventFilterSelect.innerHTML = [`<option value="all">${esc(allLabel)}</option>`]
      .concat(clusters.map((c) => `<option value="${esc(c.eventKey)}" ${c.eventKey === state.parlayEvent ? 'selected' : ''}>${esc(c.label)}</option>`))
      .join('');
  } else {
    el.parlayEventFilterRow.hidden = true;
    state.parlayEvent = 'all';
  }

  const pool = resolveParlayPool();

  const marketLabels = new Map();
  for (const c of pool) marketLabels.set(c.marketKey, c.marketLabel);

  if (!marketLabels.size) {
    el.parlayMarketsList.innerHTML = `<p class="empty">No games in this pool yet — try a different league or event.</p>`;
    state.parlay.markets.clear();
    return;
  }

  // Nothing checked yet (first render for this pool) defaults to every
  // market on, so Generate works immediately without extra taps.
  if (!state.parlay.markets.size) {
    for (const key of marketLabels.keys()) state.parlay.markets.add(key);
  }

  el.parlayMarketsList.innerHTML = [...marketLabels.entries()]
    .map(([key, label]) => {
      const checked = state.parlay.markets.has(key) ? 'checked' : '';
      return `
        <div class="filter-checkbox">
          <input type="checkbox" id="market-${esc(key)}" data-parlay-market="${esc(key)}" ${checked}>
          <label for="market-${esc(key)}">${esc(label)}</label>
        </div>`;
    })
    .join('');
}

// The most recently rendered parlay result — kept so the lock button's click
// handler can re-render (toggling a lock's visual state) without having to
// regenerate the ticket, and so it can look a leg candidate up by id when
// locking it for the first time.
let lastParlayResult = null;

/** One leg plus its lock toggle — the lock stays outside renderLeg() itself since that's shared with Pixel Picks combos, which have no locking concept. */
function renderParlayLeg(leg, index) {
  const locked = state.parlay.lockedLegs.has(leg.id);
  return `
    <div class="parlay-leg">
      <button type="button" class="leg-lock-btn ${locked ? 'is-locked' : ''}"
              data-lock-leg="${esc(leg.id)}" aria-pressed="${locked}"
              aria-label="${locked ? 'Unlock this leg' : 'Lock this leg so it survives Generate'}"
              title="${locked ? 'Locked — survives Generate' : 'Lock this leg'}">${locked ? '🔒' : '🔓'}</button>
      <div class="parlay-leg-body">${renderLeg(leg, index, true)}</div>
    </div>`;
}

function renderParlayResult(result) {
  lastParlayResult = result;
  renderedLegs.length = 0;

  if (!result.complete) {
    // Locked legs still render even when the ticket can't complete, so
    // locking one, then tightening a filter until nothing else qualifies,
    // doesn't look like the lock silently vanished.
    const lockedHtml = result.legs.length
      ? result.legs.map((leg, i) => renderParlayLeg(leg, i)).join('')
      : '';
    el.parlayResult.innerHTML = `
      ${lockedHtml}
      <p class="empty">
        Only ${result.legs.length} of ${state.parlay.legCount} leg${state.parlay.legCount === 1 ? '' : 's'}
        available (${result.poolSize} candidate${result.poolSize === 1 ? '' : 's'} qualify). Toggle on more
        markets, pick "All" for the event, or widen the range.</p>`;
    if (result.legs.length) hydrateInsights(el.parlayResult);
    return;
  }

  const legsHtml = result.legs.map((leg, i) => renderParlayLeg(leg, i)).join('');
  const stake = suggestedParlayStake(result.legs, result.combined.decimal);
  const stakeMsg = formatStakeLine(stake);

  el.parlayResult.innerHTML = `
    <article class="pick">
      <div class="pick-head">
        <span class="chip"><strong>${result.legs.length}-leg parlay</strong></span>
        <span class="price">${esc(formatAmerican(result.combined.american))}</span>
      </div>
      ${stakeMsg ? `<div class="stake-line">${esc(stakeMsg)}</div>` : ''}
      ${legsHtml}
    </article>`;
  hydrateInsights(el.parlayResult);
}

function generateParlay() {
  const pool = resolveParlayPool();
  if (!pool.length) {
    el.parlayResult.innerHTML = `<p class="empty">Nothing loaded for this league/event yet.</p>`;
    return;
  }
  if (!state.parlay.markets.size) {
    el.parlayResult.innerHTML = `<p class="empty">Toggle on at least one market first.</p>`;
    return;
  }

  const sportKeysInPool = new Set(pool.map((c) => c.sportKey));
  const sportMarkets = new Map([...sportKeysInPool].map((key) => [key, state.parlay.markets]));

  const result = buildParlay(pool, {
    legCount: state.parlay.legCount,
    oddsMin: state.parlay.oddsMin,
    oddsMax: state.parlay.oddsMax,
    minScore: state.parlay.minScore,
    lockedLegs: [...state.parlay.lockedLegs.values()],
    randomize: true,
    sportMarkets,
  });
  renderParlayResult(result);
}

el.parlayLeagueSelect.addEventListener('change', () => {
  state.parlayLeague = el.parlayLeagueSelect.value || null;
  state.parlayEvent = 'all';
  state.parlay.markets.clear();
  state.parlay.lockedLegs.clear(); // a lock from the old league/event has no business surviving into a completely different pool
  renderParlayFilters();
});

el.parlayEventFilterSelect.addEventListener('change', () => {
  state.parlayEvent = el.parlayEventFilterSelect.value;
  state.parlay.markets.clear();
  state.parlay.lockedLegs.clear();
  renderParlayFilters();
});

el.parlayResult.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-lock-leg]');
  if (!btn || !lastParlayResult) return;
  const id = btn.dataset.lockLeg;
  if (state.parlay.lockedLegs.has(id)) {
    state.parlay.lockedLegs.delete(id);
  } else {
    const leg = lastParlayResult.legs.find((l) => l.id === id);
    if (leg) state.parlay.lockedLegs.set(id, leg);
  }
  renderParlayResult(lastParlayResult);
});

el.parlayMarketsList.addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-parlay-market]');
  if (checkbox) {
    if (checkbox.checked) state.parlay.markets.add(checkbox.dataset.parlayMarket);
    else state.parlay.markets.delete(checkbox.dataset.parlayMarket);
  }
});

el.parlayOddsMinSlider.addEventListener('input', () => {
  state.parlay.oddsMin = Number(el.parlayOddsMinSlider.value);
  renderParlaySliders();
});
el.parlayOddsMinSlider.addEventListener('change', persistParlayFilters);

el.parlayOddsMaxSlider.addEventListener('input', () => {
  state.parlay.oddsMax = Number(el.parlayOddsMaxSlider.value);
  renderParlaySliders();
});
el.parlayOddsMaxSlider.addEventListener('change', persistParlayFilters);

el.parlayConfidenceSlider.addEventListener('input', () => {
  state.parlay.minScore = Number(el.parlayConfidenceSlider.value);
  renderParlaySliders();
});
el.parlayConfidenceSlider.addEventListener('change', persistParlayFilters);

el.parlayLegCountSlider.addEventListener('input', () => {
  state.parlay.legCount = Number(el.parlayLegCountSlider.value);
  renderParlaySliders();
});
el.parlayLegCountSlider.addEventListener('change', persistParlayFilters);

el.parlayGenerate.addEventListener('click', generateParlay);

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
  if (lastParlayResult) renderParlayResult(lastParlayResult);
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
  const stakeMsg = formatStakeLine(stake);
  const stakeText = stakeMsg ? `<div class="stake-line">${esc(stakeMsg)}</div>` : '';
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

/** One Play of the Day card — the main daily pick and each per-sport pick
 * share this exact rendering, since a per-sport pick is the same kind of
 * editorial call, just scoped to one league instead of the whole board. */
function renderPotdCard(writeup, generatedAt, stale) {
  const staleNote = stale
    ? `<p class="potd-stale">Today's pick hasn't posted yet — showing yesterday's.</p>`
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
      ${writeup.sections.map(renderPotdSection).join('')}
      <p class="potd-meta">
        Best price at ${esc(writeup.book)} · posted ${esc(potdDateTimeFmt.format(new Date(generatedAt)))}
      </p>
    </article>`;
}

function renderPotd(potd, bySport = {}) {
  const bySportHtml = Object.entries(bySport)
    .map(([, entry]) => renderPotdCard(entry.writeup, entry.generatedAt, entry.stale))
    .join('');
  const bySportSection = bySportHtml
    ? `<h2 class="potd-by-sport-head">Play of the Day, by sport</h2><div class="potd-by-sport">${bySportHtml}</div>`
    : '';

  if (!potd) {
    el.potdBody.innerHTML = `<p class="empty">
      Nothing posted yet today. Play of the Day goes up once daily — around
      8am ET most days, or the evening before when the pick's own game starts
      too early for that (an early tennis match, say). Check back soon.</p>` + bySportSection;
    return;
  }

  const { writeup, generatedAt, stale } = potd;
  el.potdBody.innerHTML = renderPotdCard(writeup, generatedAt, stale) + bySportSection;
}

let potdLoaded = false;
async function loadPotd({ force = false } = {}) {
  if (potdLoaded && !force) return;
  potdLoaded = true;

  if (!CONFIG.WORKER_URL) {
    el.potdBody.innerHTML = `<p class="empty">
      Play of the Day needs the odds worker — set WORKER_URL in config.js.</p>`;
    return;
  }

  el.potdBody.innerHTML = `<p class="empty">Loading…</p>`;
  try {
    const [potdRes, bySportRes] = await Promise.all([
      fetch(new URL('/potd', CONFIG.WORKER_URL), { headers: { Accept: 'application/json' } }),
      fetch(new URL('/potd-by-sport', CONFIG.WORKER_URL), { headers: { Accept: 'application/json' } }),
    ]);
    const data = await potdRes.json();
    // A per-sport fetch failing shouldn't take down the main pick — it just
    // means the "by sport" section is empty this load.
    const bySportData = await bySportRes.json().catch(() => ({ bySport: {} }));
    renderPotd(data.potd ?? null, bySportData.bySport ?? {});
  } catch {
    potdLoaded = false; // a network hiccup shouldn't permanently give up
    el.potdBody.innerHTML = `<p class="empty">Couldn't reach the odds feed.</p>`;
  }
}

function setActiveTab(tab) {
  const views = { slate: el.slateView, board: el.boardView, parlay: el.parlayView, potd: el.potdView };
  const tabs = { slate: el.tabSlate, board: el.tabBoard, parlay: el.tabParlay, potd: el.tabPotd };

  for (const [name, view] of Object.entries(views)) {
    const active = name === tab;
    view.hidden = !active;
    tabs[name].classList.toggle('is-active', active);
    tabs[name].setAttribute('aria-selected', String(active));
  }

  // The day toggle applies to Full Slate/Pixel Picks/Parlay only — Play of
  // the Day is a single fixed daily pick with no day of its own to choose.
  el.dayFilterBar.hidden = tab === 'potd';

  if (tab === 'potd') loadPotd();
  if (tab === 'parlay') renderParlayFilters();
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
el.tabParlay.addEventListener('click', () => setActiveTab('parlay'));
el.tabPotd.addEventListener('click', () => setActiveTab('potd'));

/* ---------------------------------------------------------------- */
/* Learning Dashboard                                                */
/* ---------------------------------------------------------------- */

/**
 * Every Pixel Picks Generate tap logs its 8 picks here automatically — flat
 * $20 (1 unit) each against the $1000 simulated bankroll, regardless of
 * odds, exactly as flagged and unflagged locks alike. logPick() itself is
 * the dedup boundary: a pick already tracked today (same game, market, side)
 * is silently skipped, so tapping Generate again only ever adds picks that
 * weren't on an earlier board today.
 */
async function trackNewPixelPicks(picks) {
  let added = 0;
  for (const pick of picks) {
    const leg = pick.legs[0];
    const recorded = await logPick({
      eventId: leg.eventId,
      sportKey: leg.sportKey,
      away: leg.away,
      home: leg.home,
      side: leg.selection,
      outcomeName: leg.outcomeName,
      point: leg.point,
      marketKey: leg.marketKey,
      american: leg.american,
      decimal: leg.decimal,
      book: leg.book,
      score: pick.score,
      consensusProb: leg.consensusProb,
      ev: leg.ev,
      kelly: leg.kelly,
      commenceMs: leg.commenceMs,
    });
    if (recorded) added++;
  }
  if (added && !el.learningPanel.hidden) await renderLearningDashboard();
  return added;
}

/**
 * Fetch scores for every sport with a pending tracked pick and grade
 * whichever ones are now complete. Safe to call repeatedly — a graded pick's
 * status is no longer 'pending', so it just drops out of the next pass.
 */
async function checkPendingResults() {
  const pending = await getPendingPicks();
  if (!pending.length || !CONFIG.WORKER_URL) return { checked: pending.length, graded: 0 };

  const sportKeys = [...new Set(pending.map((p) => p.sport))];
  let scoreEvents = [];
  try {
    const url = new URL('/scores', CONFIG.WORKER_URL);
    url.searchParams.set('sports', sportKeys.join(','));
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.ok) scoreEvents = (await res.json()).events ?? [];
  } catch (err) {
    console.error('Score fetch failed:', err);
  }

  const byEventId = new Map(scoreEvents.map((e) => [e.id, e]));
  let graded = 0;
  for (const pick of pending) {
    const outcome = gradePick(pick, byEventId.get(pick.eventId));
    if (!outcome) continue;
    await logResult(pick.pickId, outcome.won, outcome.payout);
    graded++;
  }
  return { checked: pending.length, graded };
}

function formatSignedMoney(amount) {
  const sign = amount > 0 ? '+' : amount < 0 ? '−' : '';
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

function formatSignedPct(pct) {
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Zero-padded local YYYY-MM-DD — matches stablePickId's date component exactly (see learning.js). */
function ymd(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Every tracked pick, minus whatever sports are unchecked in the tracker's sport filter. */
async function trackerFilteredPicks() {
  const all = await getAllPicks();
  if (!state.trackerExcludedSports.size) return all;
  return all.filter((p) => !state.trackerExcludedSports.has(sportGroupLabel(p.sport)));
}

/** A day's net/units/ROI in the calendar's current unit, or null if nothing graded that day. */
function metricValueFor(day, metric) {
  if (!day || !day.graded) return null;
  if (metric === 'units') return day.net / FLAT_UNIT_STAKE;
  if (metric === 'roi') return day.roi;
  return day.net;
}

function formatMetricValue(value, metric) {
  if (value == null) return '';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  const abs = Math.abs(value);
  if (metric === 'units') return `${sign}${abs.toFixed(1)}u`;
  if (metric === 'roi') return `${sign}${abs.toFixed(0)}%`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** One collapsible day: header shows record/ROI/net at a glance, body lists every pick graded or not. */
function renderDayBlock(day) {
  const dateLabel = new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
  const record = `${day.wins}-${day.losses}` + (day.pending ? ` · ${day.pending} pending` : '');
  const trendClass = day.net > 0 ? 'positive' : day.net < 0 ? 'negative' : '';

  const rows = day.picks.map((p) => {
    const statusClass = p.status === 'won' ? 'status-won' : p.status === 'lost' ? 'status-lost' : 'status-pending';
    const statusLabel = p.status === 'won' ? 'WIN' : p.status === 'lost' ? 'LOSS' : 'PENDING';
    const payoutLabel = p.result ? formatSignedMoney(p.result.payout) : '—';
    return `
      <div class="day-pick-row ${statusClass}">
        <span class="pick-matchup">${esc(p.team)}</span>
        <span class="pick-side">${esc(p.side)} (${esc(formatAmerican(p.american))})</span>
        <span class="pick-status">${statusLabel}</span>
        <span class="pick-payout">${esc(payoutLabel)}</span>
      </div>`;
  }).join('');

  return `
    <details class="day-block" data-day-date="${esc(day.date)}">
      <summary>
        <span class="day-date">${esc(dateLabel)}</span>
        <span class="day-record">${esc(record)}</span>
        <span class="day-roi ${trendClass}">${day.graded ? esc(formatSignedPct(day.roi)) : '—'}</span>
        <span class="day-net ${trendClass}">${day.graded ? esc(formatSignedMoney(day.net)) : '—'}</span>
      </summary>
      <div class="day-picks">${rows}</div>
    </details>`;
}

/** Sport-filter checkboxes — one per League Group the app tracks picks for, all checked by default. Static, not derived from pick history, so a sport with zero picks so far still has a filter to toggle once it does. */
function renderSportFilter() {
  const sports = LEAGUE_GROUPS.map((g) => g.label).sort();

  el.trackerSportFilter.innerHTML = sports
    .map((sport) => {
      const checked = !state.trackerExcludedSports.has(sport) ? 'checked' : '';
      return `
        <div class="filter-checkbox">
          <input type="checkbox" id="tracker-sport-${esc(sport)}" data-tracker-sport="${esc(sport)}" ${checked}>
          <label for="tracker-sport-${esc(sport)}">${esc(sport)}</label>
        </div>`;
    })
    .join('');
}

/** Calendar grid for state.calendarMonth, colored/valued by state.calendarMetric, from the filtered picks pool. */
function renderCalendar(filteredPicks) {
  const dayList = groupPicksByDay(filteredPicks);
  const byDate = new Map(dayList.map((d) => [d.date, d]));

  const year = state.calendarMonth.getFullYear();
  const month = state.calendarMonth.getMonth();
  el.calendarMonthLabel.textContent = state.calendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  el.calendarMetricToggle.textContent = { dollars: '$', units: 'Units', roi: 'ROI %' }[state.calendarMetric];

  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const now = new Date();
  const todayKey = ymd(now.getFullYear(), now.getMonth(), now.getDate());

  let maxAbs = 1;
  for (let d = 1; d <= daysInMonth; d++) {
    const day = byDate.get(ymd(year, month, d));
    if (day?.graded) maxAbs = Math.max(maxAbs, Math.abs(day.net));
  }

  let cells = '';
  for (let i = 0; i < firstWeekday; i++) cells += `<div class="calendar-cell is-empty"></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const key = ymd(year, month, d);
    const day = byDate.get(key);
    const value = metricValueFor(day, state.calendarMetric);
    let cls = 'calendar-cell';
    let style = '';
    if (value != null) {
      const alpha = (0.28 + 0.6 * (Math.abs(day.net) / maxAbs)).toFixed(2);
      cls += value > 0 ? ' is-positive' : value < 0 ? ' is-negative' : ' is-flat';
      const rgb = value > 0 ? '16,185,129' : value < 0 ? '239,68,68' : '148,163,184';
      style = ` style="background: rgba(${rgb}, ${alpha})"`;
    }
    if (key === todayKey) cls += ' is-today';
    const valueLabel = value != null
      ? formatMetricValue(value, state.calendarMetric)
      : (day?.pending ? `${day.pending}p` : '');
    const title = day ? `${day.wins}-${day.losses}${day.pending ? ` · ${day.pending} pending` : ''}` : 'No picks';
    cells += `
      <div class="${cls}"${style} data-date="${esc(key)}" title="${esc(title)}">
        <span class="calendar-daynum">${d}</span>
        <span class="calendar-value">${esc(valueLabel)}</span>
      </div>`;
  }

  el.calendarGrid.innerHTML = cells;
}

/** Date bounds + label for the Week/Month/Year performance tabs. Month/Year both key off the calendar's own month/year, so paging the calendar moves them too. */
function periodRange(period) {
  if (period === 'week') {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return { start, end, label: `${fmt(start)} – ${fmt(end)}` };
  }
  if (period === 'year') {
    const year = state.calendarMonth.getFullYear();
    return { start: new Date(year, 0, 1), end: new Date(year, 11, 31), label: String(year) };
  }
  const start = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth(), 1);
  const end = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 0);
  return { start, end, label: state.calendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) };
}

/** Profit/ROI/Record stat row plus the cumulative-net line graph for the selected Week/Month/Year period. */
function renderPerformancePanel(filteredPicks) {
  const { start, end, label } = periodRange(state.perfPeriod);
  const startKey = ymd(start.getFullYear(), start.getMonth(), start.getDate());
  const endKey = ymd(end.getFullYear(), end.getMonth(), end.getDate());

  const inRange = groupPicksByDay(filteredPicks)
    .filter((d) => d.date >= startKey && d.date <= endKey)
    .sort((a, b) => a.date.localeCompare(b.date));

  const summary = summarizePicks(inRange.flatMap((d) => d.picks));

  el.perfPeriodLabel.textContent = label;
  el.perfProfit.textContent = summary.graded ? formatSignedMoney(summary.net) : '—';
  el.perfProfit.className = 'perf-stat-value' + (summary.net > 0 ? ' positive' : summary.net < 0 ? ' negative' : '');
  el.perfRoi.textContent = summary.graded ? formatSignedPct(summary.roi) : '—';
  el.perfRoi.className = 'perf-stat-value' + (summary.roi > 0 ? ' positive' : summary.roi < 0 ? ' negative' : '');
  el.perfRecord.textContent = summary.graded ? `${summary.wins}-${summary.losses}` : '—';

  renderPerfGraph(inRange);
}

/** A hand-rolled SVG line of cumulative net (in $ or units) across a day-summary list, day by day. */
function renderPerfGraph(dayList) {
  const graded = dayList.filter((d) => d.graded);
  if (!graded.length) {
    el.perfGraph.innerHTML = `<p class="empty">No graded picks in this period yet.</p>`;
    return;
  }

  const unitDivisor = state.calendarMetric === 'units' ? FLAT_UNIT_STAKE : 1;
  let cumulative = 0;
  const points = graded.map((d) => {
    cumulative += d.net;
    return cumulative / unitDivisor;
  });

  const width = 300, height = 120, pad = 8;
  const allValues = [0, ...points];
  const minV = Math.min(...allValues), maxV = Math.max(...allValues);
  const range = maxV - minV || 1;
  const stepX = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const toY = (v) => height - pad - ((v - minV) / range) * (height - pad * 2);

  const path = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(pad + i * stepX).toFixed(1)},${toY(v).toFixed(1)}`)
    .join(' ');
  const lineColor = points[points.length - 1] >= 0 ? 'var(--success)' : 'var(--danger)';
  const zeroY = toY(0).toFixed(1);

  el.perfGraph.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="perf-graph-svg" preserveAspectRatio="none">
      <line x1="0" y1="${zeroY}" x2="${width}" y2="${zeroY}" class="perf-graph-zero" />
      <path d="${path}" fill="none" stroke="${lineColor}" stroke-width="2" />
    </svg>`;
}

/**
 * Today's server-tracked Top 5 pick ids (see worker/src/tracking.js) — a
 * pure badge lookup, fetched once at boot. Never itself a source of truth
 * for Pixel Picks; if the fetch fails, cards just render without the badge.
 */
async function loadTop5Tags() {
  if (!CONFIG.WORKER_URL) return;
  try {
    const url = new URL('/top5', CONFIG.WORKER_URL);
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const data = await res.json();
    state.top5Ids = new Set((data.picks ?? []).map((p) => p.pickId));
  } catch {
    /* Badge is a bonus; Pixel Picks itself never depends on this. */
  }
}

/** Every pick the worker's own 6am batch has ever tracked, across every day still in KV (up to 90). */
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

/** CLV%, positive means the price beat the close (see docs/app.js's own clvFor() for the client-side equivalent this mirrors). */
function top5ClvPct(pick) {
  if (!pick.clv) return null;
  return (impliedProb(pick.clv.closeAmerican) - impliedProb(pick.clv.openAmerican)) * 100;
}

/** Groups server-tracked picks by their own stored dateKey (not a pickId prefix — these ids are raw candidate ids, not date-prefixed like the client's). */
function groupTop5ByDay(picks) {
  const byDay = new Map();
  for (const p of picks) {
    if (!byDay.has(p.dateKey)) byDay.set(p.dateKey, []);
    byDay.get(p.dateKey).push(p);
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, dayPicks]) => ({ date, picks: dayPicks, ...summarizePicks(dayPicks) }));
}

function renderTop5DayBlock(day) {
  const dateLabel = new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
  const record = `${day.wins}-${day.losses}` + (day.pending ? ` · ${day.pending} pending` : '');
  const trendClass = day.net > 0 ? 'positive' : day.net < 0 ? 'negative' : '';

  const rows = day.picks.map((p) => {
    const statusClass = p.status === 'won' ? 'status-won' : p.status === 'lost' ? 'status-lost' : 'status-pending';
    const statusLabel = p.status === 'won' ? 'WIN' : p.status === 'lost' ? 'LOSS' : 'PENDING';
    const payoutLabel = p.result ? formatSignedMoney(p.result.payout) : '—';
    return `
      <div class="day-pick-row ${statusClass}">
        <span class="pick-matchup">${esc(p.away)} @ ${esc(p.home)}</span>
        <span class="pick-side">${esc(p.selection)}</span>
        <span class="pick-status">${statusLabel}</span>
        <span class="pick-payout">${esc(payoutLabel)}</span>
      </div>`;
  }).join('');

  return `
    <details class="day-block">
      <summary>
        <span class="day-date">${esc(dateLabel)}</span>
        <span class="day-record">${esc(record)}</span>
        <span class="day-roi ${trendClass}">${day.graded ? esc(formatSignedPct(day.roi)) : '—'}</span>
        <span class="day-net ${trendClass}">${day.graded ? esc(formatSignedMoney(day.net)) : '—'}</span>
      </summary>
      <div class="day-picks">${rows}</div>
    </details>`;
}

async function renderTop5Section() {
  const picks = await fetchTop5History();
  const overall = summarizePicks(picks);
  const winRate = overall.graded ? (overall.wins / overall.graded) * 100 : 0;
  const clvValues = picks.map(top5ClvPct).filter((v) => v != null);
  const avgClv = clvValues.length ? clvValues.reduce((a, b) => a + b, 0) / clvValues.length : null;

  el.top5TotalPicks.textContent = overall.total;
  el.top5GradedPicks.textContent = overall.graded;
  el.top5WinRate.textContent = overall.graded ? winRate.toFixed(1) + '%' : '—';
  el.top5Roi.textContent = overall.graded ? formatSignedPct(overall.roi) : '—';
  el.top5NetProfit.textContent = overall.graded ? formatSignedMoney(overall.net) : '—';
  el.top5AvgClv.textContent = avgClv != null ? formatSignedPct(avgClv) : '—';

  const days = groupTop5ByDay(picks);
  el.top5DailyHistory.innerHTML = days.length
    ? days.map(renderTop5DayBlock).join('')
    : `<p class="empty">Nothing tracked yet — the worker generates its first Top 5 at 6am ET.</p>`;

  return picks;
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
  const graded = picks.filter((p) => p.status === 'won' || p.status === 'lost');
  if (graded.length < 5) {
    el.calibrationReport.innerHTML = `<div class="rec-item">Not enough graded picks yet (${graded.length}) for a meaningful read — check back after a couple of weeks of tracking.</div>`;
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
    items.push(`<div class="rec-item ${severity}">Brier score ${brier.toFixed(3)} across ${withProb.length} graded picks. The model's own average predicted win probability is ${avgPredicted.toFixed(1)}%; actual win rate is ${actualWinRate.toFixed(1)}% — a ${Math.abs(gap).toFixed(1)}pp gap${gap < -5 ? ' (overconfident: real results are coming in below what the model expected)' : gap > 5 ? ' (underconfident: real results are beating what the model expected)' : ' (reasonably well calibrated)'}.</div>`);
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
      items.push(`<div class="rec-item high">${esc(label)} is losing the closing line on average (${formatSignedPct(avg)} CLV across ${values.length} picks) — the price we're taking is consistently worse than where the market settles, which is a red flag independent of win rate.</div>`);
    } else if (avg > 1) {
      items.push(`<div class="rec-item low">${esc(label)} is consistently beating the closing line (${formatSignedPct(avg)} CLV across ${values.length} picks) — a real, structural edge in this market.</div>`);
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
    items.length ? items.join('') : `<div class="rec-item">Nothing flagged yet — CLV and calibration look reasonable across every segment with enough sample size.</div>`,
    tierRows.length ? `<div class="learning-table" style="margin-top:12px">${tierRows.join('')}</div>` : '',
  ].join('');
}

async function renderLearningDashboard() {
  const allPicks = await getAllPicks();
  const filteredPicks = allPicks.filter((p) => !state.trackerExcludedSports.has(sportGroupLabel(p.sport)));
  const overall = summarizePicks(filteredPicks);
  const winRate = overall.graded ? (overall.wins / overall.graded) * 100 : 0;
  const bankroll = BANKROLL_INITIAL + overall.net;
  const days = groupPicksByDay(filteredPicks);
  const patterns = await identifyPatterns(new Date(0), new Date());

  el.totalPicks.textContent = overall.total;
  el.gradedPicks.textContent = overall.graded;
  el.winRate.textContent = overall.graded ? winRate.toFixed(1) + '%' : '—';
  el.avgRoi.textContent = overall.graded ? formatSignedPct(overall.roi) : '—';
  el.currentBankroll.textContent = '$' + bankroll.toFixed(0);
  el.netProfit.textContent = overall.graded ? formatSignedMoney(overall.net) : '—';

  renderSportFilter();
  renderCalendar(filteredPicks);
  renderPerformancePanel(filteredPicks);

  el.dailyHistory.innerHTML = days.length
    ? days.map(renderDayBlock).join('')
    : `<p class="empty">No picks tracked yet — tap Generate on Pixel Picks.</p>`;

  const emptyBreakdown = `<p class="empty">Not enough graded picks yet.</p>`;

  if (patterns?.byConfidence && Object.keys(patterns.byConfidence).length) {
    el.confidenceAnalysis.innerHTML = Object.entries(patterns.byConfidence)
      .map(([level, data]) => `
        <div class="learning-table-row">
          <div class="label">${esc(level)} (${esc(data.range)})</div>
          <div class="stat">${data.count}</div>
          <div class="stat win-rate">${data.winRate.toFixed(1)}%</div>
          <div class="stat roi">${data.avgRoi.toFixed(2)}%</div>
        </div>`)
      .join('');
  } else {
    el.confidenceAnalysis.innerHTML = emptyBreakdown;
  }

  if (patterns?.bySport && Object.keys(patterns.bySport).length) {
    el.sportAnalysis.innerHTML = Object.entries(patterns.bySport)
      .map(([sport, data]) => `
        <div class="learning-table-row">
          <div class="label">${esc(sport)}</div>
          <div class="stat">${data.count}</div>
          <div class="stat win-rate">${data.winRate.toFixed(1)}%</div>
          <div class="stat roi">${data.avgRoi.toFixed(2)}%</div>
        </div>`)
      .join('');
  } else {
    el.sportAnalysis.innerHTML = emptyBreakdown;
  }

  el.recommendations.innerHTML = `<div class="rec-item">Every Pixel Picks board tracks automatically — $20/pick against the $1000 simulated bankroll. Tap "Check Results" any time to grade whatever's finished.</div>`;

  const top5Picks = await renderTop5Section();
  renderCalibrationReport(top5Picks);
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

/** Renders from whatever's cached first (instant), then refreshes with any newly-graded results. */
async function openLearningDashboard() {
  el.scrim.hidden = false;
  el.learningPanel.hidden = false;
  applyLearningPanelWidth();
  await renderLearningDashboard();
  await runResultCheck();
}

async function runResultCheck() {
  el.checkResultsBtn.disabled = true;
  el.checkResultsBtn.textContent = 'Checking…';
  try {
    await checkPendingResults();
    await renderLearningDashboard();
  } finally {
    el.checkResultsBtn.textContent = 'Check Results';
    el.checkResultsBtn.disabled = false;
  }
}

/* ---------------------------------------------------------------- */
/* Boot                                                              */
/* ---------------------------------------------------------------- */

(async function init() {
  if (!checkAuth()) return;

  // Initialize pick database for learning system
  try {
    await initializePickDatabase();
  } catch (err) {
    console.error('Failed to initialize pick database:', err);
  }

  el.logoutBtn.hidden = !(CONFIG.REQUIRE_AUTH && getToken());
  el.pixelSort.value = state.pixelSort;

  renderParlaySliders();
  renderHistory();
  renderDayToggle();
  renderSlateStateToggle();
  initLearningPanelResize();

  el.slateStatus.textContent = 'Loading all leagues…';
  // Catalogue first — ATP/WTA can't resolve their tournament keys without it.
  await loadCatalogue();
  await refreshAllLeagues();
  el.slateStatus.textContent = state.rawEvents.length
    ? `${state.rawEvents.length} games loaded across every league — pick one below.`
    : 'Odds feed unavailable right now — try Refresh slate in a moment.';

  renderSlateLeagueOptions();
  renderFullSlate();
  await generate(); // Pixel's Picks is automatic — no button, ready as soon as the slate is
  loadTop5Tags(); // fire-and-forget — a badge lookup, never blocks the board

  setStatus(
    CONFIG.WORKER_URL
      ? 'Ready — today\'s locks below'
      : 'Demo data — set WORKER_URL in config.js for live odds',
    CONFIG.WORKER_URL ? '' : 'demo',
  );
})();
