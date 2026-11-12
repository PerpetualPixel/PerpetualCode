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
 * starters only and the stake. The games and the team are the day's and
 * are left out.
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
    minL20: Math.round(num(value.minL20, 0, 20, 0)),
    season: value.season === true,
    minH2H: Math.round(num(value.minH2H, 0, 1, 0) * 10) / 10,
    minScore: Math.round(num(value.minScore, 1, 5, 2)),
    stats: list(value.stats, STAT_RE, 40),
    odds,
    side: ['both', 'over', 'under'].includes(value.side) ? value.side : 'both',
    starters: value.starters === true,
    ufcProps: list(value.ufcProps, STAT_RE, 30),
    amount: Math.round(num(value.amount, 0, 100000, 10) * 100) / 100,
  };
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
