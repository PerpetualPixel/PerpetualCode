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
 * Normalize whatever the client sent into exactly the shape we store.
 * Whitelisted field by field rather than spread, so a client can't grow the
 * record with arbitrary keys.
 */
function normalize(input) {
  const bankroll = input?.bankroll ?? {};
  return {
    version: SETTINGS_VERSION,
    bankroll: {
      amount: cleanAmount(bankroll.amount),
      unit: cleanAmount(bankroll.unit),
      displayMode: bankroll.displayMode === 'units' ? 'units' : 'dollars',
      confirmed: bankroll.confirmed === true,
    },
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
  const record = normalize(input);
  await env.POTD_KV.put(settingsKey(identity), JSON.stringify(record));
  return record;
}
