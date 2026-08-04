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
  analyze,
  generateSlate,
  explain,
  formatAmerican,
  actionNetworkUrl,
} from './engine.js';

const HISTORY_KEY = 'pixelpick.history.v1';
const HISTORY_LIMIT = 100;

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
};

const state = {
  candidates: [],
  fetchedAt: 0,
  isDemo: false,
  quota: null,
  seen: new Set(),
  history: loadHistory(),
};

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
/* Data                                                              */
/* ---------------------------------------------------------------- */

async function loadOdds({ force = false } = {}) {
  const fresh = Date.now() - state.fetchedAt < CONFIG.REFRESH_MS;
  if (!force && fresh && state.candidates.length) return;

  if (!CONFIG.WORKER_URL) {
    state.candidates = analyze(DEMO_EVENTS);
    state.isDemo = true;
    state.fetchedAt = Date.now();
    setStatus('Demo data — set WORKER_URL in config.js for live odds', 'demo');
    return;
  }

  const url = new URL('/odds', CONFIG.WORKER_URL);
  url.searchParams.set('sports', CONFIG.SPORTS.join(','));

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error ?? `Odds proxy returned ${response.status}`);
  }

  const data = await response.json();
  state.candidates = analyze(data.events);
  state.isDemo = false;
  state.quota = data.quota;
  state.fetchedAt = Date.now();

  const bits = [`${data.events.length} games priced`];
  if (data.cached) bits.push('cached');
  if (data.quota?.remaining) bits.push(`${data.quota.remaining} credits left`);
  setStatus(bits.join(' · '));
}

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = `status ${kind}`;
}

/* ---------------------------------------------------------------- */
/* Rendering                                                         */
/* ---------------------------------------------------------------- */

function renderLeg(leg, index, isCombo) {
  const whyId = `why-${leg.id.replace(/[^a-z0-9]/gi, '')}-${index}`;
  const items = explain(leg).map((line) => `<li>${esc(line)}</li>`).join('');

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
        <span class="grade">Grade ${leg.score.toFixed(0)}/100 ·
          fair ${esc(formatAmerican(leg.fairAmerican))} ·
          ${leg.bookCount} books</span>
      </div>

      <div class="why" id="${whyId}" hidden>
        <h4>Why this is sharp</h4>
        <ul>${items}</ul>
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

      ${isCombo ? `<p class="pair-note">${esc(pick.pairReason)}</p>` : ''}

      ${pick.legs.map((leg, i) => renderLeg(leg, i, isCombo)).join('')}

      <div class="pick-foot">
        <a class="action-link" href="${esc(actionNetworkUrl(lead))}"
           target="_blank" rel="noopener">
          Compare on Action Network
          <small>Best price found: ${esc(lead.book)} at
            ${esc(formatAmerican(lead.american))}</small>
        </a>
      </div>
    </article>`;
}

function renderSlate(slate) {
  if (!slate.picks.length) {
    el.picks.innerHTML = `<p class="empty">No bets currently fall inside the
      −250 to +150 band. Try again when more games are on the board.</p>`;
    return;
  }
  el.picks.innerHTML = slate.picks.map(renderPick).join('');
}

/* ---------------------------------------------------------------- */
/* History                                                           */
/* ---------------------------------------------------------------- */

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    // Corrupt or unavailable storage shouldn't take the app down.
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(state.history.slice(0, HISTORY_LIMIT)),
    );
  } catch {
    /* Private browsing / quota — history just won't persist. */
  }
}

function recordSlate(slate) {
  state.history.unshift({
    at: slate.generatedAt,
    poolSize: slate.poolSize,
    demo: state.isDemo,
    picks: slate.picks.map((pick) => ({
      type: pick.type,
      american: pick.american,
      legs: pick.legs.map((leg) => ({
        selection: leg.selection,
        matchup: `${leg.away} @ ${leg.home}`,
        american: leg.american,
        book: leg.book,
        commenceMs: leg.commenceMs,
      })),
    })),
  });
  state.history = state.history.slice(0, HISTORY_LIMIT);
  saveHistory();
  renderHistory();
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

  el.historyList.innerHTML = state.history
    .map((entry) => {
      const items = entry.picks
        .flatMap((pick) =>
          pick.legs.map(
            (leg) => `
            <div class="history-item">
              <div class="h-sel">${esc(leg.selection)}</div>
              <div class="h-meta">
                <span class="h-price">${esc(formatAmerican(leg.american))}</span>
                · ${esc(leg.book)} · ${esc(leg.matchup)}
              </div>
            </div>`,
          ),
        )
        .join('');

      return `
        <div class="history-group">
          <h3>${esc(timeFmt.format(new Date(entry.at)))} ·
            ${entry.picks.length} pick${entry.picks.length === 1 ? '' : 's'} ·
            ${entry.poolSize} available${entry.demo ? ' · demo' : ''}</h3>
          ${items}
        </div>`;
    })
    .join('');
}

function setHistoryOpen(open) {
  el.historyPanel.hidden = !open;
  el.scrim.hidden = !open;
  el.historyToggle.setAttribute('aria-expanded', String(open));
  if (open) el.historyClose.focus();
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
    updatePoolLine(slate.poolSize);
  } catch (error) {
    setStatus(error.message, 'error');
    el.picks.innerHTML = `<p class="empty">Couldn't reach the odds feed.
      ${esc(error.message)}</p>`;
  } finally {
    el.generate.disabled = false;
  }
}

function updatePoolLine(poolSize) {
  const count = poolSize ?? state.candidates.filter(
    (c) => c.american >= -250 && c.american <= 150,
  ).length;
  el.poolLine.textContent = `${count} qualifying bet${count === 1 ? '' : 's'} available`;
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
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.historyPanel.hidden) setHistoryOpen(false);
});

/* ---------------------------------------------------------------- */
/* Boot                                                              */
/* ---------------------------------------------------------------- */

(async function init() {
  renderHistory();
  try {
    await loadOdds();
    updatePoolLine();
    el.generate.disabled = false;
  } catch (error) {
    setStatus(error.message, 'error');
    // Still let them tap — the retry path lives in generate().
    el.generate.disabled = false;
  }
})();
