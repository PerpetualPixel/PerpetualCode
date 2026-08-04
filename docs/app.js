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
  generateSlate,
  explain,
  formatAmerican,
  confidenceColor,
  bookOffers,
} from './engine.js';
import { buildInsights, isTennis } from './insights.js';

const HISTORY_KEY = 'pixelpick.history.v2';
const LEAGUES_KEY = 'pixelpick.leagues.v2';
const BOOKS_KEY = 'pixelpick.books.v1';
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
  scrim: document.getElementById('scrim'),
  logoutBtn: document.getElementById('logoutBtn'),
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

const qualifies = (c) =>
  c.american >= RULES.MIN_AMERICAN &&
  c.american <= RULES.MAX_AMERICAN &&
  c.score >= RULES.MIN_SCORE;

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

async function insightsFor(leg) {
  if (isTennis(leg.sportKey)) {
    return buildInsights(leg, { tennisData: await tennisArchive(leg.sportKey) });
  }
  return buildInsights(leg, { context: await eventContext(leg) });
}

/**
 * Fill in the research bullets once they arrive. Runs after the cards are
 * already on screen: the price bullet is available immediately and the rest
 * appears when the lookups land, so a slow ESPN call never delays a pick.
 */
async function hydrateInsights() {
  await Promise.all(
    renderedLegs.map(async (leg, slot) => {
      const list = el.picks.querySelector(`[data-insights="${slot}"]`);
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

function renderConfidence(pick) {
  const color = confidenceColor(pick.score);
  const beats = Math.round(pick.percentile ?? 0);

  return `
    <div class="confidence" style="--conf:${color}">
      <div class="conf-track">
        <span class="conf-fill" style="width:${Math.round(pick.score)}%"></span>
      </div>
      <div class="conf-label">
        <span>Confidence <span class="conf-score">${Math.round(pick.score)}</span>/100</span>
        <span>Beats ${beats}% of the board</span>
      </div>
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
    el.picks.innerHTML = `<p class="empty">Nothing on the board clears the
      ${RULES.MIN_SCORE} confidence floor inside the −250 to +150 band right now.
      Widen your leagues, or come back when more games are priced.</p>`;
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
      legs: pick.legs.map(({ parts, ...leg }) => leg),
    })),
  });
  state.history = state.history.slice(0, HISTORY_LIMIT);
  saveHistory();
  renderHistory();
}

/** Where each stored leg is priced on the board we're holding right now. */
function livePriceIndex() {
  const index = new Map();
  for (const c of state.candidates) index.set(c.id, c);
  return index;
}

function renderLiveLine(leg, live) {
  if (!live) {
    return `<div class="h-now"><span class="h-gone">off the board</span></div>`;
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

function renderHistory() {
  const total = state.history.reduce((n, entry) => n + entry.picks.length, 0);
  el.historyCount.textContent = String(total);
  el.historyCount.hidden = total === 0;

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
          const color = confidenceColor(pick.score ?? RULES.MIN_SCORE);

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

function setHistoryOpen(open) {
  el.historyPanel.hidden = !open;
  el.scrim.hidden = !open;
  el.historyToggle.setAttribute('aria-expanded', String(open));
  // Re-price on open so the panel reflects the board we're holding now.
  if (open) {
    renderHistory();
    el.historyClose.focus();
  }
}

/* ---------------------------------------------------------------- */
/* Events                                                            */
/* ---------------------------------------------------------------- */

async function generate() {
  el.generate.disabled = true;
  try {
    await loadOdds();

    const slate = generateSlate(state.candidates, { exclude: state.seen });
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

// One delegated listener covers every "?" button, including re-rendered ones.
el.picks.addEventListener('click', (event) => {
  const button = event.target.closest('.why-btn');
  if (!button) return;
  const panel = document.getElementById(button.getAttribute('aria-controls'));
  const open = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!open));
  panel.hidden = open;
});

el.generate.addEventListener('click', generate);

el.historyToggle.addEventListener('click', () => setHistoryOpen(el.historyPanel.hidden));
el.historyClose.addEventListener('click', () => setHistoryOpen(false));
el.scrim.addEventListener('click', () => setHistoryOpen(false));
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

el.leagueToggle.addEventListener('click', () => {
  const open = el.leaguePanel.hidden;
  setPanelOpen(el.leagueToggle, el.leaguePanel, open);
  if (open) setPanelOpen(el.bookToggle, el.bookPanel, false);
});

el.bookToggle.addEventListener('click', () => {
  const open = el.bookPanel.hidden;
  setPanelOpen(el.bookToggle, el.bookPanel, open);
  if (open) setPanelOpen(el.leagueToggle, el.leaguePanel, false);
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

el.logoutBtn.addEventListener('click', signOut);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el.historyPanel.hidden) setHistoryOpen(false);
  setPanelOpen(el.leagueToggle, el.leaguePanel, false);
  setPanelOpen(el.bookToggle, el.bookPanel, false);
});

/* ---------------------------------------------------------------- */
/* Boot                                                              */
/* ---------------------------------------------------------------- */

(function init() {
  if (!checkAuth()) return;

  el.logoutBtn.hidden = !(CONFIG.REQUIRE_AUTH && getToken());

  renderLeagueFilter();
  renderBookFilter();
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
