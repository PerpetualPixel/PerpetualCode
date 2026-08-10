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
 * Hand-curated list of terms that should never be allowed as a
 * public-facing username: slurs (racial, ethnic, religious,
 * sexual-orientation, gender-identity) plus obscenity/profanity drawn from
 * LDNOOBW (List of Dirty, Naughty, Obscene, and Otherwise Bad Words —
 * https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words),
 * the de-facto standard wordlist a lot of platforms build their signup
 * filters on. This is a blunt, best-effort filter, not a complete
 * solution — no wordlist catches everything, and it isn't meant to
 * replace reporting/banning a genuinely abusive account after the fact.
 * It exists to stop the obvious, common case at signup rather than leave
 * it to be found later.
 *
 * Matching is substring-based (see containsBlockedTerm) against a
 * normalized form of the input (see normalizeForMatch), so simple
 * obfuscation (case, leetspeak digit substitution, repeated letters)
 * doesn't trivially defeat it. That substring approach is also why some
 * otherwise-common LDNOOBW entries are deliberately left out below: short
 * roots like "ass", "cum", "sex", or "crap" sit inside ordinary words
 * (document, badminton, essex, scrap...) and would reject legitimate
 * names — the classic "Scunthorpe problem". Multi-word LDNOOBW phrases
 * ("2 girls 1 cup") are skipped entirely since USERNAME_FORMAT already
 * forbids spaces, so they can never appear in a username to begin with.
 */
const BLOCKED_TERMS = [
  // Racial / ethnic slurs
  'nigger', 'nigga', 'chink', 'gook', 'spic', 'wetback', 'beaner',
  'towelhead', 'sandnigger', 'jap', 'paki', 'coon', 'darkie', 'porchmonkey',
  'redskin', 'gypsy', 'kike', 'zipperhead', 'negro', 'honkey', 'jigaboo',
  'jiggaboo', 'jiggerboo', 'slanteye', 'pikey',
  // Religious / ethnic hate
  'raghead',
  // Sexual orientation / gender identity slurs
  'faggot', 'fag', 'dyke', 'tranny', 'shemale', 'bulldyke',
  // Ableist slurs
  'retard', 'retarded', 'spastic',
  // Severe general profanity inappropriate for a public handle
  'cunt', 'whore', 'slut', 'fuck', 'dick', 'cock', 'penis', 'pussy',
  'vagina', 'asshole', 'bastard', 'bitch', 'motherfucker', 'shit',
  'twat', 'wank', 'bollocks', 'bullshit', 'clusterfuck', 'fucktards',
  // Explicit sexual acts / pornography terminology
  'blowjob', 'handjob', 'footjob', 'rimjob', 'deepthroat', 'cunnilingus',
  'fellatio', 'masturbat', 'ejaculat', 'cumshot', 'gangbang',
  'threesome', 'orgasm', 'ballsack', 'clitoris', 'dildo', 'anilingus',
  'bukkake', 'creampie', 'camwhore', 'camslut', 'hentai', 'bdsm',
  'bestiality', 'zoophilia', 'incest', 'pedophile', 'paedophile',
  'jailbait', 'lolita', 'shota', 'dominatrix', 'goatse', 'tubgirl',
  // Nazi/hate-group references
  'hitler', 'nazi', 'kkk', 'swastika',
  // Illegal-activity-adjacent terms with no legitimate reason to appear in a username
  'childporn', 'cp',
];

/**
 * Reserved system/impersonation names — the second common category big
 * platforms block at signup (Slack, GitHub, Shopify, etc.), separate from
 * profanity: RFC 2142 standard mailbox names, generic admin/staff titles,
 * and this app's own brand names. Unlike BLOCKED_TERMS this list is
 * checked by exact match (after stripping a trailing numeric suffix, so
 * "admin", "admin1", "admin99" are all caught) rather than substring
 * containment — a substring check would reject real words that happen to
 * contain one of these as a fragment (e.g. "admin" inside "badminton").
 */
const RESERVED_NAMES = new Set([
  // RFC 2142 standard mailbox names
  'abuse', 'ftp', 'hostmaster', 'info', 'postmaster', 'security',
  'support', 'webmaster', 'marketing', 'sales', 'noc', 'uucp',
  // Admin / staff impersonation
  'admin', 'administrator', 'root', 'sys', 'system', 'sysadmin', 'owner',
  'moderator', 'mod', 'staff', 'official', 'team', 'superuser', 'su',
  // Generic platform terms
  'help', 'api', 'www', 'null', 'undefined', 'test', 'anonymous',
  'everyone', 'here', 'channel',
  // This app's own brand names — see docs/README.md and worker/README.md
  'perpetualpicks', 'pixelpick', 'pixelpickodds',
]);

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

function isReservedName(username) {
  const normalized = normalizeForMatch(username);
  const withoutTrailingDigits = normalized.replace(/[0-9]+$/, '');
  return RESERVED_NAMES.has(normalized) || RESERVED_NAMES.has(withoutTrailingDigits);
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
  if (isReservedName(username)) {
    return { ok: false, error: 'that username is reserved — please choose another' };
  }
  return { ok: true };
}
