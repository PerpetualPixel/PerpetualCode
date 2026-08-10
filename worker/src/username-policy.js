/**
 * Username validation shared by registration (auth-handlers.js) and the
 * account settings username change (account-handlers.js) — one place so
 * the two paths can never silently drift apart on what's allowed.
 *
 * Format: letters and numbers only, 3-20 characters. No underscores,
 * hyphens, spaces, or other punctuation — deliberately narrower than a
 * typical "alphanumeric + underscore" pattern, since this username is
 * also what outbound emails greet the person by (see auth-handlers.js's
 * EMAIL_LOGO_HTML-based templates) and shows up read-only in a few other
 * people-facing spots; keeping it to a single word of plain characters
 * avoids awkward rendering in a greeting sentence.
 */
const USERNAME_FORMAT = /^[a-zA-Z0-9]{3,20}$/;

/**
 * A deliberately small, hand-curated list of terms that should never be
 * allowed as a public-facing username: slurs (racial, ethnic, religious,
 * sexual-orientation, gender-identity), and a short list of severe general
 * profanity. This is a blunt, best-effort filter, not a complete solution —
 * no wordlist catches everything, and it isn't meant to replace reporting/
 * banning a genuinely abusive account after the fact. It exists to stop the
 * obvious, common case at signup rather than leave it to be found later.
 *
 * Lowercase, no separators — matching happens against a normalized form of
 * the input (see normalizeForMatch) so simple obfuscation (case, leetspeak
 * digit substitution, repeated letters) doesn't trivially defeat it.
 */
const BLOCKED_TERMS = [
  // Racial / ethnic slurs
  'nigger', 'nigga', 'chink', 'gook', 'spic', 'wetback', 'beaner',
  'towelhead', 'sandnigger', 'jap', 'paki', 'coon', 'darkie', 'porchmonkey',
  'redskin', 'gypsy', 'kike', 'zipperhead',
  // Religious / ethnic hate
  'raghead',
  // Sexual orientation / gender identity slurs
  'faggot', 'fag', 'dyke', 'tranny', 'shemale',
  // Ableist slurs
  'retard', 'retarded',
  // Severe general profanity / sexual terms inappropriate for a public handle
  'cunt', 'whore', 'slut', 'fuck', 'dick', 'cock', 'penis', 'pussy',
  'vagina', 'asshole', 'bastard', 'bitch', 'motherfucker',
  // Nazi/hate-group references
  'hitler', 'nazi', 'kkk',
  // Illegal-activity-adjacent terms with no legitimate reason to appear in a username
  'childporn', 'cp',
];

/** Lowercase, strip everything but letters/digits, and fold the handful of
 * leetspeak substitutions common enough to matter (0->o, 1->i, 3->e, 4->a,
 * 5->s, 7->t, @->a, $->s) — enough to catch the obvious "n1gg3r"-style
 * evasion without trying to be a complete leetspeak decoder. */
function normalizeForMatch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/[^a-z0-9]/g, '');
}

function containsBlockedTerm(username) {
  const normalized = normalizeForMatch(username);
  return BLOCKED_TERMS.some((term) => normalized.includes(term));
}

/**
 * The one entry point both auth-handlers.js and account-handlers.js call.
 * Returns { ok: true } or { ok: false, error } — error is safe to return
 * directly to the client (no internal detail, just "not allowed").
 */
export function validateUsername(username) {
  if (!username || !USERNAME_FORMAT.test(username)) {
    return { ok: false, error: 'username must be 3-20 characters: letters and numbers only' };
  }
  if (containsBlockedTerm(username)) {
    return { ok: false, error: 'that username isn\'t allowed — please choose another' };
  }
  return { ok: true };
}
