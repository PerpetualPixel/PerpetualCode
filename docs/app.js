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
  RULES,
  SPORTSBOOKS,
  DEFAULT_BOOKS,
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

const HISTORY_KEY = 'pixelpick.history.v2';
const LEAGUES_KEY = 'pixelpick.leagues.v2';
const BOOKS_KEY = 'pixelpick.books.v1';
const FILTERS_KEY = 'pixelpick.range.v1';
const PARLAY_KEY = 'pixelpick.parlay.v1';
const BANKROLL_KEY = 'pixelpick.bankroll.v1';
const SLATE_LEAGUE_KEY = 'pixelpick.slateLeague.v1';
const PIXEL_SORT_KEY = 'pixelpick.sort.v1';
// 1-2% of bankroll per unit is the standard range a flat-staking bettor
// works from; 2% is the more conservative, more commonly cited end of it —
// used here as the default recommendation when the user hasn't set their own.
const RECOMMENDED_UNIT_PCT = 0.02;
// Entries carry full leg data now so history can be re-priced and reopened,
// which makes each one heavier than the old summary rows.
const HISTORY_LIMIT = 40;

const el = {
  status: document.getElementById('status'),
  generate: document.getElementById('generate'),
  poolLine: document.getElementById('poolLine'),
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
  leagueToggle: document.getElementById('leagueToggle'),
  leaguePanel: document.getElementById('leaguePanel'),
  leagueList: document.getElementById('leagueList'),
  leagueSummary: document.getElementById('leagueSummary'),
  leagueHint: document.getElementById('leagueHint'),
  leagueCost: document.getElementById('leagueCost'),
  leagueReset: document.getElementById('leagueReset'),
  bookToggle: document.getElementById('bookToggle'),
  bookPanel: document.getElementById('bookPanel'),
  bookAll: document.getElementById('bookAll'),
  bookList: document.getElementById('bookList'),
  bookSummary: document.getElementById('bookSummary'),
  rangeToggle: document.getElementById('rangeToggle'),
  rangePanel: document.getElementById('rangePanel'),
  rangeSummary: document.getElementById('rangeSummary'),
  rangeReset: document.getElementById('rangeReset'),
  oddsMinSlider: document.getElementById('oddsMinSlider'),
  oddsMinLabel: document.getElementById('oddsMinLabel'),
  oddsMaxSlider: document.getElementById('oddsMaxSlider'),
  oddsMaxLabel: document.getElementById('oddsMaxLabel'),
  confidenceSlider: document.getElementById('confidenceSlider'),
  confidenceLabel: document.getElementById('confidenceLabel'),
  tabSlate: document.getElementById('tabSlate'),
  slateView: document.getElementById('slateView'),
  slateStatus: document.getElementById('slateStatus'),
  slateLeagueSelect: document.getElementById('slateLeagueSelect'),
  slateLoad: document.getElementById('slateLoad'),
  slateEventRow: document.getElementById('slateEventRow'),
  slateEventSelect: document.getElementById('slateEventSelect'),
  slateSortSelect: document.getElementById('slateSortSelect'),
  slateBody: document.getElementById('slateBody'),
  tabBoard: document.getElementById('tabBoard'),
  tabPotd: document.getElementById('tabPotd'),
  boardView: document.getElementById('boardView'),
  potdView: document.getElementById('potdView'),
  potdBody: document.getElementById('potdBody'),
  tabParlay: document.getElementById('tabParlay'),
  parlayView: document.getElementById('parlayView'),
  parlaySports: document.getElementById('parlaySports'),
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
  seen: new Set(),
  history: loadJSON(HISTORY_KEY, []),
  books: new Set(loadJSON(BOOKS_KEY, DEFAULT_BOOKS)),
  // Leagues the user has chosen to PULL. This is a spend decision, not a view
  // filter: each entry is its own billed upstream call, so the set is capped.
  selected: new Set(loadJSON(LEAGUES_KEY, CONFIG.SPORTS)),
  // The requestable catalogue, from the worker's free /sports endpoint.
  catalogue: [],
  // Research caches. Both are free to fetch — ESPN and a static archive — so
  // they never touch the odds credit budget.
  tennis: new Map(),   // 'atp' | 'wta' -> parsed archive
  context: new Map(),  // eventId -> normalised ESPN bundle, or null when unmatched
  tennisAltSpreads: new Map(), // eventId -> raw alternate-spread event, or null when unfetched/unmatched
  // Odds range and confidence floor for the top-picks board. A view filter,
  // not a spend decision — unlike leagues/books this never changes what's
  // fetched, only which already-fetched candidates qualify.
  ...loadJSON(FILTERS_KEY, {
    oddsMin: CONFIG.ODDS_MIN_DEFAULT,
    oddsMax: CONFIG.ODDS_MAX_DEFAULT,
    minScore: CONFIG.MIN_SCORE_DEFAULT,
  }),
  // Parlay Builder's own filters — deliberately separate from the board's
  // oddsMin/oddsMax/minScore above, since a parlay leg and a top-8 pick can
  // reasonably want different ranges (the whole point of a manual builder).
  // `sports` is never persisted: it's a Map<sportKey, Set<marketKey>> of
  // what's toggled on, re-derived fresh from whatever's currently loaded each
  // time the tab renders, since a saved sportKey could refer to a league
  // that's no longer selected on the Board tab.
  parlay: {
    sports: new Map(),
    ...loadJSON(PARLAY_KEY, { oddsMin: -250, oddsMax: 100, minScore: 60, legCount: 2 }),
  },
  // Bankroll and unit size, purely local — never sent anywhere, only used to
  // turn a stake's %-of-bankroll figure into a dollar amount or unit count.
  // amount/unit of 0 means "unset"; unset amount falls back to showing the
  // plain percentage everywhere a stake is displayed. `confirmed` gates that
  // conversion on having actually pressed Submit — typing a number into the
  // field alone shouldn't start changing what every "why" panel recommends.
  bankroll: loadJSON(BANKROLL_KEY, { amount: 0, unit: 0, displayMode: 'dollars', confirmed: false }),
  // Which league the Full Slate tab is currently showing. Re-derived against
  // whatever's actually selected on boot (see init()) since a saved league
  // could refer to one the user no longer has picked.
  slateLeague: loadJSON(SLATE_LEAGUE_KEY, null),
  // Which MMA card is filtered to, or 'all'. Not persisted — a saved event id
  // is only meaningful for one specific night's slate, not future sessions.
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

// Reads the live slider state rather than RULES' fixed defaults — RULES still
// supplies the initial values (see FILTERS_KEY above) but the user can widen
// or narrow both from here on.
const qualifies = (c) =>
  c.american >= state.oddsMin &&
  c.american <= state.oddsMax &&
  c.score >= state.minScore;

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
    state.catalogue.unshift({ key: 'upcoming', title: 'Next up (all sports)' });
    renderLeagueFilter();
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
    // A missing catalogue shouldn't block the app — fall back to whatever the
    // user already had selected so they can still pull a board.
    state.catalogue = [...state.selected].map((key) => ({ key, title: key }));
  }
  renderLeagueFilter();
  renderSlateLeagueOptions();
}

function leagueCredits() {
  return state.selected.size * CONFIG.CREDITS_PER_LEAGUE;
}

function renderLeagueFilter() {
  const atCap = state.selected.size >= CONFIG.MAX_LEAGUES;

  el.leagueCost.innerHTML =
    `<strong>${leagueCredits()}</strong> credits per refresh ` +
    `· ${state.selected.size}/${CONFIG.MAX_LEAGUES} leagues`;
  el.leagueCost.classList.toggle('is-max', atCap);

  if (!state.catalogue.length) {
    el.leagueList.innerHTML = '';
    return;
  }

  el.leagueList.innerHTML = state.catalogue
    .map(({ key, title }) => {
      const on = state.selected.has(key);
      // At the cap, unchecked boxes lock rather than silently doing nothing.
      const locked = atCap && !on && key !== 'upcoming';
      return `
        <label class="check">
          <input type="checkbox" data-league="${esc(key)}"
                 ${on ? 'checked' : ''} ${locked ? 'disabled' : ''}>
          <span>${esc(title)}</span>
        </label>`;
    })
    .join('');

  el.leagueSummary.textContent = state.selected.has('upcoming')
    ? 'next up'
    : String(state.selected.size);
}

/**
 * 'upcoming' is one call covering every sport, so mixing it with named leagues
 * would pay twice for overlapping games. Selecting either clears the other.
 */
function toggleLeague(key, on) {
  if (!on) {
    state.selected.delete(key);
    if (!state.selected.size) state.selected.add('upcoming');
  } else if (key === 'upcoming') {
    state.selected = new Set(['upcoming']);
  } else {
    state.selected.delete('upcoming');
    if (state.selected.size >= CONFIG.MAX_LEAGUES) return;
    state.selected.add(key);
  }

  saveJSON(LEAGUES_KEY, [...state.selected]);
  // The board on screen came from a different set of leagues, so the next tap
  // has to go and get a new one.
  state.fetchedAt = 0;
  renderLeagueFilter();
  updatePoolLine();
}

function renderBookFilter() {
  const ids = Object.keys(SPORTSBOOKS);

  el.bookList.innerHTML = ids
    .map((id) => `
      <label class="check">
        <input type="checkbox" data-book="${esc(id)}"
               ${state.books.has(id) ? 'checked' : ''}>
        <span>${esc(SPORTSBOOKS[id].name)}</span>
      </label>`)
    .join('');

  el.bookSummary.textContent = String(state.books.size);
  el.bookAll.checked = state.books.size === ids.length;
  el.bookAll.indeterminate = state.books.size > 0 && state.books.size < ids.length;
}

/** Sync the range/confidence sliders and their labels to state. */
function renderRangeFilter() {
  el.oddsMinSlider.value = String(state.oddsMin);
  el.oddsMaxSlider.value = String(state.oddsMax);
  el.confidenceSlider.value = String(state.minScore);

  el.oddsMinLabel.textContent = formatAmerican(state.oddsMin);
  el.oddsMaxLabel.textContent = formatAmerican(state.oddsMax);
  el.confidenceLabel.textContent = `≥ ${Math.round(state.minScore)}`;

  el.rangeSummary.textContent =
    `${formatAmerican(state.oddsMin)}/${formatAmerican(state.oddsMax)} · ≥${Math.round(state.minScore)}`;
}

function setPanelOpen(button, panel, open) {
  panel.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
}

/* ---------------------------------------------------------------- */
/* Data                                                              */
/* ---------------------------------------------------------------- */

async function loadOdds({ force = false } = {}) {
  const fresh = Date.now() - state.fetchedAt < CONFIG.REFRESH_MS;
  if (!force && fresh && state.candidates.length) return;

  if (!CONFIG.WORKER_URL) {
    const wanted = state.selected;
    const events = wanted.has('upcoming')
      ? DEMO_EVENTS
      : DEMO_EVENTS.filter((e) => wanted.has(e.sport_key));
    state.candidates = analyze(events);
    state.rawEvents = events;
    state.isDemo = true;
    state.fetchedAt = Date.now();
    setStatus('Demo data — set WORKER_URL in config.js for live odds', 'demo');
    return;
  }

  const url = new URL('/odds', CONFIG.WORKER_URL);
  url.searchParams.set('sports', [...state.selected].join(','));

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
  state.candidates = analyze(data.events);
  state.rawEvents = data.events;
  state.isDemo = false;
  state.fetchedAt = Date.now();

  const bits = [`${data.events.length} games priced`];
  if (data.cached) bits.push('cached — no credits spent');
  setStatus(bits.join(' · '));
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
 * One button per book the user bets at. A book with no quote on this exact line
 * is rendered but disabled — knowing FanDuel isn't offering it is information.
 */
function renderBooks(leg) {
  if (!state.books.size) {
    return `<p class="books-empty">No sportsbooks selected — pick yours above.</p>`;
  }

  const offers = bookOffers(leg);

  const buttons = [...state.books]
    .filter((id) => SPORTSBOOKS[id])
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

  return `
    <article class="pick">
      <div class="pick-head">
        <span class="chip"><strong>${esc(sport)}</strong> ·
          ${isCombo ? '2-leg combo' : 'Straight bet'}</span>
        <span class="price">${esc(formatAmerican(pick.american))}</span>
      </div>

      ${renderConfidence(pick)}

      ${isCombo ? `<p class="pair-note">${esc(pick.pairReason)}</p>` : ''}

      ${pick.legs.map((leg, i) => renderLeg(leg, i, isCombo)).join('')}
    </article>`;
}

function renderSlate(slate) {
  renderedLegs.length = 0;

  if (!slate.picks.length) {
    el.picks.innerHTML = `<p class="empty">Nothing clears ${Math.round(state.minScore)}
      confidence inside ${esc(formatAmerican(state.oddsMin))} to
      ${esc(formatAmerican(state.oddsMax))} right now. Widen the range under
      <strong>Odds &amp; Confidence</strong>, add a league, or come back when
      more games are priced.</p>`;
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
  if (!state.books.size) return '';
  const offers = bookOffers(leg);

  const links = [...state.books]
    .filter((id) => SPORTSBOOKS[id])
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
    // Parse MMA analysis which includes victory methods
    if (isMma(leg.sportKey) && analysis) {
      try {
        const parsed = JSON.parse(analysis);
        if (parsed.analysis && parsed.victoryMethods) {
          analysisText = parsed.analysis;
          victoryMethods = parsed.victoryMethods;
        } else {
          analysisText = analysis;
        }
      } catch {
        analysisText = analysis;
      }
    } else {
      analysisText = analysis;
    }
  } catch {
    /* Research is a bonus; the price case and book table still stand alone. */
  }

  // Build victory methods HTML for MMA
  const victoryMethodsHtml = victoryMethods
    ? `
      <div class="stats-section victory-methods">
        <h4>Expected Methods of Victory</h4>
        <div class="victory-fighters">
          <div class="victory-fighter">
            <div class="fighter-name">${esc(leg.away)}</div>
            <ul class="victory-list">
              ${(victoryMethods[leg.away] || [])
                .map((v) => `<li><strong>${esc(v.method)}</strong>: ${esc(v.reasoning)}</li>`)
                .join('')}
            </ul>
          </div>
          <div class="victory-fighter">
            <div class="fighter-name">${esc(leg.home)}</div>
            <ul class="victory-list">
              ${(victoryMethods[leg.home] || [])
                .map((v) => `<li><strong>${esc(v.method)}</strong>: ${esc(v.reasoning)}</li>`)
                .join('')}
            </ul>
          </div>
        </div>
      </div>`
    : '';

  // The AI-written matchup analysis replaces the quantitative price case
  // entirely when it's available (see worker/src/analysis.js) — falls back
  // to the existing no-vig/EV read whenever it isn't, so the drawer always
  // has a real "why" either way.
  const priceHtml = analysisText
    ? `
      <div class="stats-section">
        <h3>Matchup Analysis <span class="stats-source">AI-written, once daily</span></h3>
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
  // the same treatment as the case for it. Still the quantitative version —
  // the AI analysis is scoped to the game overall, not a specific side, per
  // the same design that lets one analysis serve every market on the event.
  const devilHtml = opposite
    ? `
      <div class="stats-section devil-advocate">
        <h3>Devil's Advocate — ${esc(opposite.selection)}</h3>
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
 * This sport's candidates, grouped by event and split into the two sides of
 * each market. Built from state.rawEvents rather than state.candidates alone,
 * so a game where every market stayed too thin to grade (fewer than
 * RULES.MIN_BOOKS quoting it) still shows up on the slate — just with a dash
 * instead of a price — rather than silently vanishing.
 */
function buildSlateGames(sportKey) {
  const now = Date.now();
  const byEvent = new Map();
  for (const c of state.candidates) {
    if (c.sportKey !== sportKey) continue;
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

  return (state.rawEvents ?? [])
    .filter((e) => e.sport_key === sportKey)
    .map((event) => {
      const commenceMs = new Date(event.commence_time).getTime();
      const cands = byEvent.get(event.id) ?? [];
      return {
        eventId: event.id,
        sportKey,
        home: event.home_team,
        away: event.away_team,
        commenceMs,
        h2h: pairFor(cands, 'h2h', event),
        spreads: pairFor(cands, 'spreads', event),
        totals: pairFor(cands, 'totals', event),
        ufc_event: event.ufc_event,
      };
    })
    .filter((g) => Number.isFinite(g.commenceMs) && g.commenceMs > now)
    .sort((a, b) => a.commenceMs - b.commenceMs);
}

/**
 * One market cell. A real candidate renders as a clickable price, ringed
 * with a highlight when it grades higher than its market-mate (or when it's
 * the only side priced at all — nothing to compare against, but still the
 * only actionable side). A market with no qualifying price on this side
 * renders a plain dash rather than making the whole game disappear.
 */
function slateCell(cand, opposite, { totalLabel } = {}) {
  if (!cand) return `<span class="slate-cell is-empty">—</span>`;

  const recommended = opposite ? cand.score > opposite.score : true;
  const idx = renderedSlateCells.push({ cand, opposite }) - 1;
  const label = totalLabel ? `${totalLabel}${formatAmerican(cand.american)}` : formatAmerican(cand.american);

  return `
    <button type="button" class="slate-cell ${recommended ? 'is-rec' : ''}"
            data-slate-cell="${idx}" title="${esc(cand.selection)}">${esc(label)}</button>`;
}

function slateTeamRow(game, side) {
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
  // already built from, just read as a probability instead of a price.
  const winPct = h2h ? `${Math.round(h2h.consensusProb * 100)}%` : null;
  const logo = teamLogoUrl(game.sportKey, team);

  return `
    <div class="slate-team-row">
      <span class="slate-team">
        ${logo ? `<img class="slate-logo" src="${esc(logo)}" alt="" loading="lazy">` : ''}
        ${esc(team)}${winPct ? ` <span class="slate-team-pct">${winPct}</span>` : ''}
      </span>
      ${slateCell(spread, oppSpread)}
      ${slateCell(total, oppTotal, { totalLabel })}
      ${slateCell(h2h, oppH2h)}
    </div>`;
}

/** The single highest-graded side across every market on this game. */
function bestCandidateForGame(game) {
  const all = [
    game.h2h.away, game.h2h.home,
    game.spreads.away, game.spreads.home,
    game.totals.away, game.totals.home,
  ].filter(Boolean);
  if (!all.length) return null;
  return all.reduce((best, c) => (c.score > best.score ? c : best));
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
  const hasAnyPrice = bestCandidateForGame(game) != null;
  return `
    <article class="slate-game">
      <div class="slate-game-time">
        <span>${esc(dateFmt.format(new Date(game.commenceMs)))}</span>
        ${hasAnyPrice ? `<button type="button" class="more-info-btn" data-more-info="${idx}">More Info</button>` : ''}
      </div>
      <div class="slate-header-row">
        <span></span><span>Spread</span><span>O/U</span><span>ML</span>
      </div>
      ${slateTeamRow(game, 'away')}
      ${slateTeamRow(game, 'home')}
    </article>`;
}

/** Every real sport key currently loaded into state.rawEvents. */
function loadedSportKeys() {
  return new Set((state.rawEvents ?? []).map((e) => e.sport_key));
}

/**
 * Populate the league dropdown from the full catalogue — every league the
 * app can request, not just whichever ones happen to already be pulled. A
 * league not yet loaded still shows up here; loadSlate() fetches it on
 * demand the moment it's chosen and Load Slate is tapped, same as any other
 * league. Falls back to whatever's already loaded (or raw selected-leagues)
 * only if the free /sports catalogue hasn't come back yet.
 */
function renderSlateLeagueOptions() {
  const loaded = loadedSportKeys();
  const catalogueLeagues = state.catalogue.map((s) => s.key).filter((k) => k !== 'upcoming');
  const leagues = catalogueLeagues.length
    ? catalogueLeagues
    : [...new Set([...loaded, ...state.selected])].filter((k) => k !== 'upcoming');
  const labelFor = (key) =>
    state.candidates.find((c) => c.sportKey === key)?.sportTitle
    ?? state.catalogue.find((s) => s.key === key)?.title
    ?? key;

  if (!leagues.length) {
    el.slateLeagueSelect.innerHTML = `<option value="">No leagues available</option>`;
    el.slateLeagueSelect.disabled = true;
    return;
  }

  el.slateLeagueSelect.disabled = false;
  if (!state.slateLeague || !leagues.includes(state.slateLeague)) {
    state.slateLeague = leagues[0];
  }
  el.slateLeagueSelect.innerHTML = leagues
    .map((key) => `<option value="${esc(key)}" ${key === state.slateLeague ? 'selected' : ''}>${esc(labelFor(key))}${loaded.has(key) ? '' : ' — tap Load Slate'}</option>`)
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

    // Must be upcoming (not in the past)
    if (game.commenceMs < now) return false;

    // Should be within roughly 2 weeks (upcoming events)
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

function renderFullSlate() {
  renderedSlateCells.length = 0;
  renderedSlateGames.length = 0;

  if (!state.slateLeague) {
    el.slateBody.innerHTML = `<p class="empty">Select a league above, then tap Load slate.</p>`;
    el.slateEventRow.hidden = true;
    return;
  }

  const allGames = buildSlateGames(state.slateLeague);
  if (!allGames.length) {
    el.slateBody.innerHTML = `<p class="empty">Nothing upcoming for this league right now — check back closer to game time, or pick another league above.</p>`;
    el.slateEventRow.hidden = true;
    return;
  }

  let games = allGames;
  const clusters = isMma(state.slateLeague) ? mmaClusters(allGames) : [];

  // For MMA, only show card selector if we have UFC/PFL events with markets
  if (isMma(state.slateLeague)) {
    el.slateEventRow.hidden = clusters.length < 2;

    if (clusters.length >= 2) {
      // Count total fights across all UFC/PFL events
      const totalFights = clusters.reduce((sum, c) => sum + c.games.length, 0);
      const options = [`<option value="all">All cards — ${totalFights} fights</option>`]
        .concat(clusters.map((c) => {
          const value = c.eventKey;
          return `<option value="${esc(value)}" ${value === state.slateEvent ? 'selected' : ''}>${esc(c.label)}</option>`;
        }));
      el.slateEventSelect.innerHTML = options.join('');

      if (state.slateEvent !== 'all') {
        const match = clusters.find((c) => c.eventKey === state.slateEvent);
        // Show only fights from selected event
        games = match ? match.games : [];
      } else {
        // Show all filtered UFC/PFL fights (not the entire allGames list)
        games = clusters.flatMap(c => c.games);
      }
    } else if (clusters.length === 1) {
      // Only one event, show it without dropdown
      games = clusters[0].games;
      el.slateEventRow.hidden = true;
    } else {
      // No UFC/PFL events with markets, show empty
      games = [];
      el.slateEventRow.hidden = true;
    }
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
      const eventName = game.ufc_event?.event || 'Upcoming Event';

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
    el.slateBody.innerHTML = `<p class="empty">No upcoming UFC/PFL events with moneyline markets. Check back soon!</p>`;
  }
}

/**
 * A league the user picked that isn't part of the normal selected/upcoming
 * pull yet — Pixel Picks and Parlay never asked for it, so nothing loaded it.
 * Fetches just that one league and merges it into rawEvents/candidates. This
 * is its own real odds credit (same as adding a league under Leagues would
 * be); it deliberately doesn't touch state.selected, so it doesn't start
 * counting against the 3-league pull cap the rest of the app budgets by.
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
 * Pulls the same /odds call Pixel Picks uses (and shares its cache — loading
 * the slate right after generating picks, or vice versa, costs nothing extra
 * within the 15-minute window) and renders every game for the selected
 * league, filtered by nothing but which league is chosen. A league outside
 * the normal pull gets its own on-demand fetch via fetchSingleLeague.
 */
function updateRefreshStatus() {
  const now = Date.now();
  const oneHourMs = 60 * 60 * 1000;
  const timeSinceRefresh = now - state.slateRefreshTime;

  if (state.slateRefreshTime === 0) {
    el.slateLoad.disabled = false;
    return;
  }

  if (timeSinceRefresh < oneHourMs) {
    const minutesLeft = Math.ceil((oneHourMs - timeSinceRefresh) / 60000);
    el.slateLoad.disabled = true;
    el.slateLoad.title = `Next refresh in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}`;
  } else {
    el.slateLoad.disabled = false;
    el.slateLoad.title = 'Refresh odds (1+ hour since last refresh)';
  }
}

async function loadSlate() {
  const now = Date.now();
  const oneHourMs = 60 * 60 * 1000;
  const timeSinceRefresh = now - state.slateRefreshTime;

  // Rate limit: only allow refresh if 1+ hour has passed
  if (state.slateRefreshTime > 0 && timeSinceRefresh < oneHourMs) {
    const minutesLeft = Math.ceil((oneHourMs - timeSinceRefresh) / 60000);
    el.slateBody.innerHTML =
      `<p class="empty">Odds refreshed recently. Next refresh available in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.</p>`;
    return;
  }

  el.slateLoad.disabled = true;
  el.slateBody.innerHTML = `<p class="empty">Refreshing odds…</p>`;
  try {
    await loadOdds();
    state.slateRefreshTime = Date.now();
    renderSlateLeagueOptions();
    if (state.slateLeague && !loadedSportKeys().has(state.slateLeague)) {
      await fetchSingleLeague(state.slateLeague);
      renderSlateLeagueOptions();
    }
    renderFullSlate();
  } catch (error) {
    el.slateBody.innerHTML = `<p class="empty">Couldn't reach the odds feed. ${esc(error.message)}</p>`;
  } finally {
    el.slateLoad.disabled = false;
    updateRefreshStatus();
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

async function generate() {
  el.generate.disabled = true;
  try {
    await loadOdds();
    await enrichTennisAltSpreads();
    updateClvSnapshots();

    const slate = topPicks(state.candidates, {
      count: CONFIG.TOP_PICKS_COUNT,
      oddsMin: state.oddsMin,
      oddsMax: state.oddsMax,
      minScore: state.minScore,
      exclude: state.seen,
    });
    slate.picks.forEach((pick) => pick.legs.forEach((leg) => state.seen.add(leg.id)));

    state.lastPixelSlate = slate;
    el.pixelSortRow.hidden = !slate.picks.length;
    renderSlate({ ...slate, picks: sortPicks(slate.picks, state.pixelSort) });
    recordSlate(slate);
    updatePoolLine();
  } catch (error) {
    setStatus(error.message, 'error');
    el.picks.innerHTML = `<p class="empty">Couldn't reach the odds feed.
      ${esc(error.message)}</p>`;
  } finally {
    el.generate.disabled = false;
  }
}

function updatePoolLine() {
  // fetchedAt is zeroed when the league selection changes, so any count we still
  // hold describes a board the user is no longer asking for. Say what the next
  // tap will do instead of quoting a stale number.
  if (!state.fetchedAt) {
    const n = state.selected.size;
    el.poolLine.textContent = `Tap to pull ${n} league${n === 1 ? '' : 's'}`;
    return;
  }
  const count = state.candidates.filter(qualifies).length;
  el.poolLine.textContent =
    `${count} qualifying bet${count === 1 ? '' : 's'} available`;
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

el.generate.addEventListener('click', generate);

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

el.scrim.addEventListener('click', () => {
  if (openAside) setAsideOpen(openAside.panel, openAside.toggle, false);
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

// Only one filter panel open at a time — opening one closes the other two.
function closeOtherPanels(keepOpen) {
  for (const [toggle, panel] of [
    [el.leagueToggle, el.leaguePanel],
    [el.bookToggle, el.bookPanel],
    [el.rangeToggle, el.rangePanel],
  ]) {
    if (panel !== keepOpen) setPanelOpen(toggle, panel, false);
  }
}

el.leagueToggle.addEventListener('click', () => {
  const open = el.leaguePanel.hidden;
  setPanelOpen(el.leagueToggle, el.leaguePanel, open);
  if (open) closeOtherPanels(el.leaguePanel);
});

el.bookToggle.addEventListener('click', () => {
  const open = el.bookPanel.hidden;
  setPanelOpen(el.bookToggle, el.bookPanel, open);
  if (open) closeOtherPanels(el.bookPanel);
});

el.rangeToggle.addEventListener('click', () => {
  const open = el.rangePanel.hidden;
  setPanelOpen(el.rangeToggle, el.rangePanel, open);
  if (open) closeOtherPanels(el.rangePanel);
});

el.leagueReset.addEventListener('click', () => {
  state.selected = new Set(CONFIG.SPORTS);
  saveJSON(LEAGUES_KEY, [...state.selected]);
  state.fetchedAt = 0;
  renderLeagueFilter();
  updatePoolLine();
});

el.leagueList.addEventListener('change', (event) => {
  const box = event.target.closest('input[data-league]');
  if (!box) return;
  toggleLeague(box.dataset.league, box.checked);
});

el.bookAll.addEventListener('change', () => {
  state.books = el.bookAll.checked ? new Set(Object.keys(SPORTSBOOKS)) : new Set();
  saveJSON(BOOKS_KEY, [...state.books]);
  renderBookFilter();
});

el.bookList.addEventListener('change', (event) => {
  const box = event.target.closest('input[data-book]');
  if (!box) return;
  if (box.checked) state.books.add(box.dataset.book);
  else state.books.delete(box.dataset.book);
  saveJSON(BOOKS_KEY, [...state.books]);
  renderBookFilter();
});

function persistFilters() {
  saveJSON(FILTERS_KEY, {
    oddsMin: state.oddsMin,
    oddsMax: state.oddsMax,
    minScore: state.minScore,
  });
}

// 'input' fires continuously while dragging, for a live-updating label; the
// filter itself only takes effect on the next Generate tap (free, within the
// cache window), matching how the league/book filters already behave.
el.oddsMinSlider.addEventListener('input', () => {
  state.oddsMin = Number(el.oddsMinSlider.value);
  renderRangeFilter();
});
el.oddsMinSlider.addEventListener('change', persistFilters);

el.oddsMaxSlider.addEventListener('input', () => {
  state.oddsMax = Number(el.oddsMaxSlider.value);
  renderRangeFilter();
});
el.oddsMaxSlider.addEventListener('change', persistFilters);

el.confidenceSlider.addEventListener('input', () => {
  state.minScore = Number(el.confidenceSlider.value);
  renderRangeFilter();
});
el.confidenceSlider.addEventListener('change', persistFilters);

el.rangeReset.addEventListener('click', () => {
  state.oddsMin = CONFIG.ODDS_MIN_DEFAULT;
  state.oddsMax = CONFIG.ODDS_MAX_DEFAULT;
  state.minScore = CONFIG.MIN_SCORE_DEFAULT;
  persistFilters();
  renderRangeFilter();
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
  closeOtherPanels(null);
});

/* ---------------------------------------------------------------- */
/* Parlay Builder                                                     */
/* ---------------------------------------------------------------- */

/** sportKey -> { title, markets: Map<marketKey, label> }, from whatever the
 * Board tab currently has loaded. This is the only source of sports/markets
 * the builder can offer — it never fetches anything of its own. */
function parlaySportOptions() {
  const bySport = new Map();
  for (const c of state.candidates) {
    if (!bySport.has(c.sportKey)) {
      bySport.set(c.sportKey, { title: c.sportTitle ?? c.sportKey, markets: new Map() });
    }
    bySport.get(c.sportKey).markets.set(c.marketKey, c.marketLabel);
  }
  return bySport;
}

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

function renderParlaySports() {
  const bySport = parlaySportOptions();

  if (!bySport.size) {
    el.parlaySports.innerHTML = `<p class="empty">
      Nothing loaded yet. Go to Board and tap Generate Picks first — the
      builder pulls from whatever that board ends up holding.</p>`;
    return;
  }

  el.parlaySports.innerHTML = [...bySport.entries()]
    .map(([sportKey, { title, markets }]) => {
      const enabled = state.parlay.sports.has(sportKey);
      const selected = state.parlay.sports.get(sportKey) ?? new Set();
      return `
        <div class="parlay-sport">
          <label class="check">
            <input type="checkbox" data-parlay-sport="${esc(sportKey)}" ${enabled ? 'checked' : ''}>
            <span><strong>${esc(title)}</strong></span>
          </label>
          <div class="parlay-market-row" ${enabled ? '' : 'hidden'}>
            ${[...markets.entries()].map(([marketKey, label]) => `
              <label class="check-pill">
                <input type="checkbox" data-parlay-market="${esc(sportKey)}|${esc(marketKey)}"
                       ${selected.has(marketKey) ? 'checked' : ''}>
                <span>${esc(label)}</span>
              </label>`).join('')}
          </div>
        </div>`;
    })
    .join('');
}

function renderParlayResult(result) {
  if (!result.complete) {
    el.parlayResult.innerHTML = `<p class="empty">
      Only ${result.legs.length} of ${state.parlay.legCount} leg${state.parlay.legCount === 1 ? '' : 's'}
      available (${result.poolSize} candidate${result.poolSize === 1 ? '' : 's'} qualify). Toggle on more
      sports or markets, or widen the range.</p>`;
    return;
  }

  renderedLegs.length = 0;
  const legsHtml = result.legs.map((leg, i) => renderLeg(leg, i, true)).join('');
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
  const sportMarkets = new Map(
    [...state.parlay.sports].filter(([, markets]) => markets.size),
  );
  if (!sportMarkets.size) {
    el.parlayResult.innerHTML = `<p class="empty">Toggle on at least one sport and market first.</p>`;
    return;
  }

  const result = buildParlay(state.candidates, {
    legCount: state.parlay.legCount,
    oddsMin: state.parlay.oddsMin,
    oddsMax: state.parlay.oddsMax,
    minScore: state.parlay.minScore,
    sportMarkets,
  });
  renderParlayResult(result);
}

el.parlaySports.addEventListener('change', (event) => {
  const sportBox = event.target.closest('input[data-parlay-sport]');
  if (sportBox) {
    const sportKey = sportBox.dataset.parlaySport;
    if (sportBox.checked) {
      // Default to every market that sport currently offers — the user
      // narrows down from "all" rather than building up from nothing.
      const markets = parlaySportOptions().get(sportKey)?.markets;
      state.parlay.sports.set(sportKey, new Set(markets ? markets.keys() : []));
    } else {
      state.parlay.sports.delete(sportKey);
    }
    renderParlaySports();
    return;
  }

  const marketBox = event.target.closest('input[data-parlay-market]');
  if (marketBox) {
    const [sportKey, marketKey] = marketBox.dataset.parlayMarket.split('|');
    const set = state.parlay.sports.get(sportKey);
    if (!set) return;
    if (marketBox.checked) set.add(marketKey);
    else set.delete(marketKey);
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
  persistBankroll();
  renderBankrollPanel();
});

el.bankrollShowDollars.addEventListener('click', () => {
  state.bankroll.displayMode = 'dollars';
  persistBankroll();
  renderBankrollPanel();
});

el.bankrollShowUnits.addEventListener('click', () => {
  state.bankroll.displayMode = 'units';
  persistBankroll();
  renderBankrollPanel();
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

  if (tab === 'potd') loadPotd();
  if (tab === 'parlay') renderParlaySports();
  // Re-render from whatever's already cached rather than re-fetching — the
  // slate shares loadOdds()'s own 15-minute cache with Pixel Picks, so
  // switching tabs is never itself a billed call.
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
/* Boot                                                              */
/* ---------------------------------------------------------------- */

(async function init() {
  if (!checkAuth()) return;

  el.logoutBtn.hidden = !(CONFIG.REQUIRE_AUTH && getToken());
  el.pixelSort.value = state.pixelSort;

  renderLeagueFilter();
  renderBookFilter();
  renderRangeFilter();
  renderParlaySliders();
  renderHistory();
  // Free call, so it can happen on load.
  loadCatalogue();

  // Auto-load Full Slate data on app startup.
  if (CONFIG.WORKER_URL) {
    // Default to MMA for Full Slate
    state.slateLeague = 'mma_mixed_martial_arts';
    renderSlateLeagueOptions();
    // Fetch MMA data directly since 'upcoming' doesn't include MMA
    await fetchSingleLeague('mma_mixed_martial_arts');
    renderFullSlate();
  }

  setStatus(
    CONFIG.WORKER_URL
      ? 'Ready — tap to pull the board'
      : 'Demo data — set WORKER_URL in config.js for live odds',
    CONFIG.WORKER_URL ? '' : 'demo',
  );
  updatePoolLine();
  el.generate.disabled = false;
})();
