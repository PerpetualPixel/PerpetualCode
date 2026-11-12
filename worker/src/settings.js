/**
 * Durable per-account settings — today, bankroll and unit size.
 *
 * These lived in the browser's localStorage, which meant they died with a
 * cleared cache and never followed the user to a second device. They're
 * stored in KV instead, with the client keeping its localStorage copy purely
 * as an offline fallback (see docs/app.js's loadSettings).
 *
 * ── Identity ───────────────────────────────────────────────────────────
 * One record per authenticated account, keyed by the D1 user id (see
 * worker/src/index.js's /settings route: identity is payload.userId from
 * the request's JWT). settingsKey() is the only place that identity -> KV
 * key mapping lives. The stored value is an extensible object with a
 * `version` field, not two bare numbers, so adding displayName/preferences
 * later is additive.
 *
 * authorize() below (a single owner-passphrase check, X-Owner-Key) predates
 * accounts and is no longer used by /settings — it's kept for the two
 * algo-health admin routes (/algo-health/resume, /algo-health/reset), which
 * are genuinely single-owner actions rather than per-user settings.
 */

import { cleanParlayStore } from '../../docs/parlay-presets.js';

/** Bumped only on a breaking shape change; readers tolerate older records. */
const SETTINGS_VERSION = 1;

/**
 * KV key for one identity's settings. The sole identity -> key mapping in
 * the app — see the module header. `owner` is the only identity that exists
 * while the app is single-user.
 */
function settingsKey(identity = 'owner') {
  return `settings:${identity}`;
}

/**
 * Timing-safe string compare, so a wrong passphrase can't be narrowed down
 * byte by byte. Iterates a fixed number of times regardless of where the
 * first mismatch is, and folds the length difference into the result rather
 * than returning early on it. An empty string never matches.
 */
function safeEqual(a, b) {
  const aStr = String(a ?? '');
  const bStr = String(b ?? '');
  if (!aStr.length || !bStr.length) return false;

  const len = Math.max(aStr.length, bStr.length);
  let diff = aStr.length ^ bStr.length;
  for (let i = 0; i < len; i++) {
    // charCodeAt past the end is NaN; `|| 0` makes the XOR well-defined.
    diff |= (aStr.charCodeAt(i) || 0) ^ (bStr.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Whether this request may read/write the owner's settings.
 *
 * Fails closed when OWNER_PASSPHRASE isn't configured: without it there is no
 * way to tell the owner apart from any other visitor, and defaulting to
 * "allow" would publish the bankroll to everyone. The client treats that
 * refusal as "sync unavailable" and stays on its local copy, which is exactly
 * the pre-existing behavior — so an unconfigured deploy degrades to what the
 * app already did rather than breaking.
 */
export function authorize(request, env) {
  // Both sides are trimmed because HTTP strips leading/trailing whitespace
  // from header values in transit (confirmed: a header sent as "abc " reads
  // back as "abc"). Without trimming the configured side too, a secret set
  // with a stray trailing space could never be matched by any request — a
  // silent, near-undiagnosable lockout. Edge whitespace is therefore not
  // significant in the passphrase.
  const configured = String(env.OWNER_PASSPHRASE ?? '').trim();
  if (!configured) return { ok: false, status: 503, error: 'Settings sync is not configured on this deployment' };

  const supplied = String(request.headers.get('X-Owner-Key') ?? '').trim();
  if (!safeEqual(supplied, configured)) return { ok: false, status: 401, error: 'Invalid or missing owner key' };

  return { ok: true };
}

/** A finite, non-negative number, or 0 — never NaN/Infinity/negative into KV. */
function cleanAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The sportsbooks a user plays at (2026-10-27 direction: the books the
 * user selects, per profile, filter the Trends tab to what those books
 * offer): registry ids from docs/engine.js's SPORTSBOOKS, or a feed's own
 * bookmaker key for a book the registry doesn't list. Short lowercase
 * tokens, at most 30. Null when the client sent no list at all, so a
 * bankroll-only save leaves the books alone.
 */
function cleanBooks(value) {
  if (!Array.isArray(value)) return null;
  const keys = value.map((v) => String(v ?? '').toLowerCase().trim()).filter((v) => /^[a-z0-9_]{2,32}$/.test(v));
  return [...new Set(keys)].slice(0, 30);
}

/** The books a live slip can be at (worker/src/live-probe.js's LIVE_BOOKMAKERS, by registry id): the user's live list is a subset, empty for all of them. */
export const LIVE_BOOKS = ['draftkings', 'fanduel', 'caesars', 'fanatics', 'betmgm', 'prizepicks', 'hardrock', 'bet365', 'betrivers', 'espnbet'];
const cleanLiveBooks = (value) => { const list = cleanBooks(value); return list ? list.filter((b) => LIVE_BOOKS.includes(b)) : null; };

/** The books a personal ticket may be drawn at: the Parlay Builder's list (docs/app.js's PARLAY_BOOKS). */
/**
 * The user's Playbook setup (docs/playbook.js; 2026-11-07: "I use Playbook's
 * bot on Discord to create the links for Fanatics and other books"): the
 * Discord link of the channel they tag the bot in, and the bot's user id
 * when they have copied it (a pasted "@Playbook" pings nothing; <@id> does).
 * Null until saved; a field left blank clears it.
 */
export function cleanPlaybook(value) {
  if (!value || typeof value !== 'object') return null;
  const channel = String(value.channel ?? '').trim().slice(0, 300);
  let channelOk = '';
  try { const u = new URL(channel); const host = u.hostname.toLowerCase().replace(/^www\./, ''); if (u.protocol === 'https:' && ['discord.com', 'discordapp.com', 'discord.gg', 'ptb.discord.com', 'canary.discord.com'].includes(host)) channelOk = u.toString(); } catch { channelOk = ''; }
  const m = String(value.mention ?? '').trim().match(/^(?:<@!?)?(\d{5,25})>?$/);
  return { channel: channelOk, mention: m ? m[1] : '', updatedAt: Date.now() };
}

export const PICK_PREF_BOOKS = ['draftkings', 'fanduel', 'caesars', 'fanatics', 'betmgm', 'prizepicks', 'hardrock', 'bet365', 'betrivers'];
export const PICK_PREF_DEFAULTS = { book: 'draftkings', minScore: 4, legs: 2 };

/**
 * The user's own Pixel's Picks settings (2026-10-31 direction: "let a
 * user set their own confidence floor or book for a personal ticket
 * draw, saved per user"): the book the ticket is priced at, the Pixel
 * score a leg must reach (2 to 5 stars, by halves) and the legs on the
 * ticket (1 is a straight; PrizePicks lineups are 2 to 6). Null until
 * the user has saved them once; a field left out keeps what is stored.
 */
export function cleanPicks(value, existing = null) {
  if (!value || typeof value !== 'object') return existing ?? null;
  const base = existing ?? PICK_PREF_DEFAULTS;
  const book = String(value.book ?? base.book).toLowerCase();
  const score = Number(value.minScore ?? base.minScore);
  const legs = Number(value.legs ?? base.legs);
  return {
    book: PICK_PREF_BOOKS.includes(book) ? book : base.book,
    minScore: Number.isFinite(score) ? Math.min(5, Math.max(2, Math.round(score * 2) / 2)) : base.minScore,
    legs: Number.isFinite(legs) ? Math.min(6, Math.max(1, Math.round(legs))) : base.legs,
    updatedAt: Date.now(),
  };
}

/**
 * Normalize whatever the client sent into exactly the shape we store.
 * Whitelisted field by field rather than spread, so a client can't grow the
 * record with arbitrary keys. A field the client left out keeps what
 * `existing` holds — the bankroll panel and the Trends tab each save their
 * own field without wiping the other's.
 */
/**
 * The user's sportsbooks (2026-11-06: "for new users, ask them what book
 * they use and set preferences to show those books only unless they
 * choose other in the settings, keep this selection persistent per
 * user"): one list the tabs follow. Null until the user has answered;
 * an empty list means every book. When the client sends it, the Trends
 * books, the Live books and the personal ticket's book follow it unless
 * the same save sets them itself.
 */
function normalize(input, existing = null) {
  const bankroll = input?.bankroll ?? existing?.bankroll ?? {};
  const myBooks = cleanBooks(input?.myBooks);
  const follow = myBooks != null;
  // The personal ticket's book follows the list when the stored one is not on it (or nothing is stored yet).
  let picksInput = input?.picks ?? null;
  if (!picksInput && follow && myBooks.length) {
    const first = myBooks.find((b) => PICK_PREF_BOOKS.includes(b));
    const current = existing?.picks?.book ?? null;
    if (first && (!current || !myBooks.includes(current))) picksInput = { book: first };
  }
  return {
    myBooks: myBooks ?? cleanBooks(existing?.myBooks) ?? null,
    version: SETTINGS_VERSION,
    bankroll: {
      amount: cleanAmount(bankroll.amount),
      unit: cleanAmount(bankroll.unit),
      displayMode: bankroll.displayMode === 'units' ? 'units' : 'dollars',
      confirmed: bankroll.confirmed === true,
    },
    trendBooks: cleanBooks(input?.trendBooks) ?? (follow ? myBooks : null) ?? cleanBooks(existing?.trendBooks) ?? [],
    // The books the Live tab shows slips for and imports to; empty means every book.
    liveBooks: cleanLiveBooks(input?.liveBooks) ?? (follow ? cleanLiveBooks(myBooks) : null) ?? cleanLiveBooks(existing?.liveBooks) ?? [],
    picks: cleanPicks(picksInput, existing?.picks ?? null),
    playbook: input?.playbook !== undefined ? cleanPlaybook(input.playbook) : (existing?.playbook ?? null),
    // The Parlay Builder's last settings and three saved slots (docs/parlay-presets.js); null until the user has built once.
    parlay: input?.parlay !== undefined ? (input.parlay ? cleanParlayStore(input.parlay) : null) : (existing?.parlay ? cleanParlayStore(existing.parlay) : null),
    updatedAt: Date.now(),
  };
}

/** The stored settings for an identity, or null when nothing has been saved yet. */
export async function getSettings(env, identity = 'owner') {
  const raw = await env.POTD_KV.get(settingsKey(identity));
  if (!raw) return null;
  try {
    return normalize(JSON.parse(raw));
  } catch {
    return null; // a corrupt record reads as "unset" rather than failing the request
  }
}

/** Replace an identity's settings. Returns exactly what was stored. */
export async function putSettings(env, input, identity = 'owner') {
  const record = normalize(input, await getSettings(env, identity));
  await env.POTD_KV.put(settingsKey(identity), JSON.stringify(record));
  return record;
}
