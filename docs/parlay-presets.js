/**
 * The Parlay Builder's saved settings (2026-11-12 direction: "adjust
 * parlay tab settings per user to default to what they want or had
 * before; allow them to save 3 parlay settings so they can load it with
 * a click"): the last settings used, restored on open, and three slots a
 * user fills and loads in one tap. Kept on the account
 * (worker/src/settings.js's parlay) with the device copy as fallback.
 * Pure helpers here; the DOM lives in app.js.
 *
 * A snapshot holds what a user means by "my settings": the leagues, the
 * book, the legs, the bars, the prop types, the odds range, the side,
 * starters only, whether red-flagged players are left out, and the stake. The games and the team are the day's and
 * are left out.
 *
 * The hit bars (2026-11-21: "back to last 1-5 and then last 10, and then
 * another button for L20, but two sliders for the last 5 and 10"): a
 * floor on the hits in the last 5 games, a floor on the hits in the last
 * 10, and a Last 20 button. The button has no number of its own: on, the
 * leg must hold over its last 20 the rate the Last 10 bar asks for (7+ of
 * 10 is 14+ of 20), or half of them when that bar is at Any. Settings
 * saved under the single last-20 bar this replaces (minL20) come back as
 * the same floor: half its number on the Last 10 bar, the button on.
 */
export const PARLAY_SLOTS = 3;
export const PARLAY_SETTINGS_BOOKS = ['draftkings', 'fanduel', 'caesars', 'fanatics', 'betmgm', 'prizepicks', 'hardrock', 'bet365', 'betrivers'];
const SPORT_RE = /^[a-z0-9_]{2,40}$/;
const STAT_RE = /^[A-Za-z0-9_]{1,32}$/;
const LEAGUE_LABEL = { basketball_nba: 'NBA', americanfootball_nfl: 'NFL', icehockey_nhl: 'NHL', soccer: 'Soccer', tennis: 'Tennis', mma_mixed_martial_arts: 'UFC' };
const BOOK_LABEL = { draftkings: 'DraftKings', fanduel: 'FanDuel', caesars: 'Caesars', fanatics: 'Fanatics', betmgm: 'BetMGM', prizepicks: 'PrizePicks', hardrock: 'Hard Rock', bet365: 'bet365', betrivers: 'BetRivers' };

const num = (v, lo, hi, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; };
const list = (v, re, max) => [...new Set((Array.isArray(v) ? v : v instanceof Set ? [...v] : []).map((x) => String(x ?? '')).filter((x) => re.test(x)))].slice(0, max);

/** Whatever was stored or sent, as exactly the fields a snapshot holds; null when it is not an object. */
export function cleanParlaySettings(value) {
  if (!value || typeof value !== 'object') return null;
  const sports = list(value.sports, SPORT_RE, 8);
  const odds = Array.isArray(value.odds) ? [num(value.odds[0], -100000, 100000, -800), num(value.odds[1], -100000, 100000, 800)] : [-800, 800];
  if (odds[0] > odds[1]) odds.reverse();
  return {
    sports: sports.length ? sports : ['basketball_nba'],
    book: PARLAY_SETTINGS_BOOKS.includes(String(value.book)) ? String(value.book) : 'draftkings',
    legs: Math.round(num(value.legs, 2, 25, 4)),
    ...hitBars(value),
    season: value.season === true,
    minH2H: Math.round(num(value.minH2H, 0, 1, 0) * 10) / 10,
    minScore: Math.round(num(value.minScore, 1, 5, 2) * 2) / 2,
    stats: list(value.stats, STAT_RE, 40),
    odds,
    side: ['both', 'over', 'under'].includes(value.side) ? value.side : 'both',
    starters: value.starters === true,
    // Leave out the players with a red flag (docs/parlay-flags.js); off, they stay in and are marked.
    noRed: value.noRed === true,
    ufcProps: list(value.ufcProps, STAT_RE, 30),
    amount: Math.round(num(value.amount, 0, 100000, 10) * 100) / 100,
  };
}

/** The three hit bars out of whatever was stored: today's fields, or the old single last-20 bar turned into them. */
function hitBars(value) {
  const old = Math.round(num(value.minL20, 0, 20, 0));
  const fresh = 'minL5' in value || 'minL10' in value || 'l20' in value;
  if (!fresh && old > 0) return { minL5: 0, minL10: Math.round(old / 2), l20: true };
  return { minL5: Math.round(num(value.minL5, 0, 5, 0)), minL10: Math.round(num(value.minL10, 0, 10, 0)), l20: value.l20 === true };
}

/** The rate the Last 20 button holds a leg to: the Last 10 bar's, or half when that bar is at Any. */
export const l20Floor = (s) => (s.minL10 > 0 ? s.minL10 / 10 : 0.5);

/** What a bar reads: "Any", or the floor as hits of the window with its rate ("4+ of 5 (80%)"). */
export const hitBarText = (n, of) => (n ? `${n}+ of ${of} (${Math.round((n / of) * 100)}%)` : 'Any');

/**
 * Whether a leg clears the hit bars. `windowOf(n)` gives its {hits,
 * games} over the last n games (fewer when it has played fewer, so each
 * floor is judged as a rate: 4+ of 5 passes at 3 of 3).
 */
export function passesHitBars(s, windowOf) {
  const clears = (n, rate) => { const w = windowOf(n); return w.games > 0 && w.hits / w.games >= rate - 1e-9; };
  if (s.minL5 > 0 && !clears(5, s.minL5 / 5)) return false;
  if (s.minL10 > 0 && !clears(10, s.minL10 / 10)) return false;
  if (s.l20 && !clears(20, l20Floor(s))) return false;
  return true;
}

/**
 * The score floor after a tap on star `n` (2026-11-21: "the stars should
 * have half stars too, so if I click 4 stars twice it will go to 4.5
 * stars"). A tap on another star sets that many; a second tap on the same
 * star adds the half; a third takes it off again. Five is the top: there
 * is no 5.5.
 */
export function nextMinScore(current, n) {
  const star = Math.min(5, Math.max(1, Math.round(Number(n) || 1)));
  if (Number(current) === star && star < 5) return star + 0.5;
  return star;
}

/** The builder's state as a snapshot. */
export const parlaySnapshot = (state) => cleanParlaySettings(state);

/** A snapshot laid over the builder's state; the day's choices (games, team, the built ticket) start clean. */
export function applyParlaySnapshot(state, snapshot) {
  const s = cleanParlaySettings(snapshot);
  if (!s) return state;
  Object.assign(state, { ...s, sports: new Set(s.sports), stats: new Set(s.stats), ufcProps: new Set(s.ufcProps), games: new Set(), team: '', built: null, locked: new Set(), seen: new Set(), open: null, note: '' });
  return state;
}

/** A slot's name from what it holds: "NBA + NFL · 4 legs · FanDuel". */
export function parlaySlotName(settings) {
  const s = cleanParlaySettings(settings);
  if (!s) return '';
  const leagues = s.sports.map((k) => LEAGUE_LABEL[k] ?? k).join(' + ');
  return `${leagues} · ${s.legs} legs · ${BOOK_LABEL[s.book] ?? s.book}`;
}

/** What the account and the device keep: { last, presets: [slot, slot, slot] }, each slot { name, settings, savedAt } or null. */
export function cleanParlayStore(value) {
  const presets = Array.from({ length: PARLAY_SLOTS }, (_, i) => {
    const slot = Array.isArray(value?.presets) ? value.presets[i] : null;
    const settings = cleanParlaySettings(slot?.settings);
    if (!settings) return null;
    const name = String(slot.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 48) || parlaySlotName(settings);
    return { name, settings, savedAt: Number.isFinite(slot.savedAt) ? slot.savedAt : null };
  });
  return { last: cleanParlaySettings(value?.last), presets };
}

/** The store with slot `index` filled from `settings` (or emptied with null). */
export function withParlaySlot(store, index, settings, { name = null, now = Date.now() } = {}) {
  const base = cleanParlayStore(store);
  if (!(index >= 0 && index < PARLAY_SLOTS)) return base;
  const clean = cleanParlaySettings(settings);
  base.presets[index] = clean ? { name: String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 48) || parlaySlotName(clean), settings: clean, savedAt: now } : null;
  return base;
}
