/**
 * Pixel Pick — UI layer.
 *
 * Responsibilities kept deliberately thin: fetch the odds pool, hand it to the
 * engine, render what comes back, and persist history. All betting logic lives
 * in engine.js so it can be tested without a browser.
 */

import { CONFIG } from './config.js';
import { DEMO_EVENTS } from './demo.js';
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
} from './engine.js';
import { buildInsights, insightTexts, insightsByTier, isTennis, isMma } from './insights.js';

const HISTORY_KEY = 'pixelpick.history.v2';
const LEAGUES_KEY = 'pixelpick.leagues.v2';
const BOOKS_KEY = 'pixelpick.books.v1';
const FILTERS_KEY = 'pixelpick.range.v1';
const PARLAY_KEY = 'pixelpick.parlay.v1';
const BANKROLL_KEY = 'pixelpick.bankroll.v1';
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
  // plain percentage everywhere a stake is displayed.
  bankroll: loadJSON(BANKROLL_KEY, { amount: 0, unit: 0, displayMode: 'dollars' }),
};

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

  if (!(state.bankroll.amount > 0)) {
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
  const items = explain(leg).map((line) => `<li>${esc(line)}</li>`).join('');
  // Legs are numbered as they render so hydrateInsights can find each list
  // without having to escape bet ids into a CSS selector.
  const slot = renderedLegs.push(leg) - 1;

  return `
    <div class="leg">
      ${isCombo ? `<p class="chip">Leg ${index + 1}</p>` : ''}
      <p class="leg-selection">${esc(leg.selection)}</p>
      <p class="leg-matchup">${esc(leg.away)} @ ${esc(leg.home)} · ${esc(leg.marketLabel)}</p>

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

/**
 * Open the More Stats drawer for one leg: show a skeleton immediately, then
 * fill in the full breakdown once research resolves. Reuses the exact same
 * cached fetches (tennisArchive/mmaContextFor/eventContext/weatherFor) the
 * compact card's "why" panel already triggers — opening this for a leg
 * whose "why" panel is already open costs no extra network call.
 */
async function openStatsDrawer(leg) {
  el.statsDrawerTitle.textContent = leg.selection;
  el.statsDrawerBody.innerHTML = renderStatsSkeleton();
  setStatsDrawerOpen(true);

  const priceCase = explainExtensive(leg);
  const priceHtml = `
    <div class="stats-section">
      <h3>The Market &amp; Price Case</h3>
      <ul>${priceCase.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    </div>`;

  let bullets = [];
  let weather = null;
  try {
    if (isTennis(leg.sportKey)) {
      bullets = buildInsights(leg, { tennisData: await tennisArchive(leg.sportKey) });
    } else if (isMma(leg.sportKey)) {
      bullets = buildInsights(leg, { mmaContext: await mmaContextFor(leg) });
    } else {
      const [context, w] = await Promise.all([eventContext(leg), weatherFor(leg)]);
      weather = w;
      bullets = buildInsights(leg, { context, weather });
    }
  } catch {
    /* Research is a bonus; the price case and book table still stand alone. */
  }

  // The drawer may have been closed (or reopened for a different leg) while
  // these fetches were in flight — never paint a stale result over whatever
  // the user is looking at now.
  if (el.statsDrawer.hidden || el.statsDrawerTitle.textContent !== leg.selection) return;

  el.statsDrawerBody.innerHTML =
    `<p class="stats-meta"><strong>${esc(leg.away)} @ ${esc(leg.home)}</strong> · ${esc(leg.marketLabel)} · ` +
    `${esc(dateFmt.format(new Date(leg.commenceMs)))}</p>` +
    renderWeatherPills(weather) +
    priceHtml +
    renderStatsResearch(bullets) +
    renderPriceTable(leg);
}

document.body.addEventListener('click', (event) => {
  const button = event.target.closest('[data-more-stats]');
  if (!button) return;
  const leg = renderedLegs[Number(button.dataset.moreStats)];
  if (leg) openStatsDrawer(leg);
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

    renderSlate(slate);
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

// One delegated listener per container that can render a "?" why-button —
// the Board's picks list and the Parlay Builder's result both use renderLeg.
el.picks.addEventListener('click', toggleWhyPanel);
el.parlayResult.addEventListener('click', toggleWhyPanel);

el.generate.addEventListener('click', generate);

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

function renderPotd(potd) {
  if (!potd) {
    el.potdBody.innerHTML = `<p class="empty">
      Nothing posted yet today. Play of the Day goes up once daily — around
      8am ET most days, or the evening before when the pick's own game starts
      too early for that (an early tennis match, say). Check back soon.</p>`;
    return;
  }

  const { writeup, pick, generatedAt, stale } = potd;
  const staleNote = stale
    ? `<p class="potd-stale">Today's pick hasn't posted yet — showing yesterday's.</p>`
    : '';

  el.potdBody.innerHTML = `
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
    const response = await fetch(new URL('/potd', CONFIG.WORKER_URL), {
      headers: { Accept: 'application/json' },
    });
    const data = await response.json();
    renderPotd(data.potd ?? null);
  } catch {
    potdLoaded = false; // a network hiccup shouldn't permanently give up
    el.potdBody.innerHTML = `<p class="empty">Couldn't reach the odds feed.</p>`;
  }
}

function setActiveTab(tab) {
  const views = { board: el.boardView, parlay: el.parlayView, potd: el.potdView };
  const tabs = { board: el.tabBoard, parlay: el.tabParlay, potd: el.tabPotd };

  for (const [name, view] of Object.entries(views)) {
    const active = name === tab;
    view.hidden = !active;
    tabs[name].classList.toggle('is-active', active);
    tabs[name].setAttribute('aria-selected', String(active));
  }

  if (tab === 'potd') loadPotd();
  if (tab === 'parlay') renderParlaySports();
}

el.tabBoard.addEventListener('click', () => setActiveTab('board'));
el.tabParlay.addEventListener('click', () => setActiveTab('parlay'));
el.tabPotd.addEventListener('click', () => setActiveTab('potd'));

/* ---------------------------------------------------------------- */
/* Boot                                                              */
/* ---------------------------------------------------------------- */

(function init() {
  if (!checkAuth()) return;

  el.logoutBtn.hidden = !(CONFIG.REQUIRE_AUTH && getToken());

  renderLeagueFilter();
  renderBookFilter();
  renderRangeFilter();
  renderParlaySliders();
  renderHistory();
  // Free call, so it can happen on load — unlike the odds themselves.
  loadCatalogue();

  // Deliberately no fetch on load. Odds cost API credits, and opening the app
  // isn't the same as asking for a pick — the first tap pays for the board.
  setStatus(
    CONFIG.WORKER_URL
      ? 'Ready — tap to pull the board'
      : 'Demo data — set WORKER_URL in config.js for live odds',
    CONFIG.WORKER_URL ? '' : 'demo',
  );
  updatePoolLine();
  el.generate.disabled = false;
})();
