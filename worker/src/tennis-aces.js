/**
 * Match aces from tennis.com (2026-11-12: four aces plays sat at
 * "awaiting serve stats" for a week because nothing wrote the ace log the
 * grader reads). ESPN carries no serve statistics and the stats sites
 * behind the serve profiles publish only yearly totals; tennis.com's
 * match pages carry a statistics table with each player's aces in the
 * page's own HTML, under a link that follows from the two names and the
 * date. Pure: the runner (scripts/tennis-aces.mjs) does the fetching.
 */
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (s) => fold(s).replace(/[^a-z0-9 -]/g, ' ').split(/[\s]+/).filter(Boolean);

export const TENNIS_COM = 'https://www.tennis.com';

/** A tournament's page slugs to try, from ESPN's name: the whole name, then without a leading sponsor word, then without a trailing "presented by" tail. */
export function tournamentSlugs(eventName) {
  const w = words(String(eventName ?? '').replace(/\b(presented by|presentado por|powered by)\b.*$/i, ''));
  if (!w.length) return [];
  const slug = (list) => list.join('-').replace(/-+/g, '-');
  const out = [slug(w)];
  if (w.length > 2) out.push(slug(w.slice(1)));
  if (w.length > 3) out.push(slug(w.slice(2)));
  return [...new Set(out)];
}

/** The last word of a name, as a match link carries it: "Alex de Minaur" is minaur, "Tomás Macháč" is machac. */
export const surnameToken = (name) => words(name).at(-1) ?? '';

/** A player as a match link names him: the first initial, a hyphen, the family name ("c-alcaraz"); a two-word name's second word on is the family name. */
export function playerToken(name) {
  const w = words(name);
  if (w.length < 2) return w[0] ?? '';
  return `${w[0][0]}-${w.slice(1).join('-')}`;
}

/** The match links on a tournament page: [{href, a, b, date}] from /tournaments/<slug>/matches/<a>-vs-<b>-<YYYY-MM-DD>. */
export function matchLinks(html) {
  const out = new Map();
  const re = /href="(\/tournaments\/[a-z0-9-]+\/matches\/([a-z0-9-]+)-vs-([a-z0-9-]+)-(\d{4}-\d{2}-\d{2}))"/g;
  let m;
  while ((m = re.exec(String(html ?? '')))) if (!out.has(m[1])) out.set(m[1], { href: m[1], a: m[2], b: m[3], date: m[4] });
  return [...out.values()];
}

/** The link for a match between two players on or beside a day: both family names in it, the nearest date within a day either side. Null when the page does not list it. */
export function matchLinkFor(links, nameA, nameB, dayMs) {
  const sa = surnameToken(nameA); const sb = surnameToken(nameB);
  if (!sa || !sb) return null;
  const has = (token, s) => token === s || token.endsWith(`-${s}`);
  const fits = (links ?? []).filter((l) => (has(l.a, sa) && has(l.b, sb)) || (has(l.a, sb) && has(l.b, sa)))
    .map((l) => ({ ...l, gap: Math.abs(Date.parse(`${l.date}T12:00:00Z`) - dayMs) }))
    .filter((l) => l.gap <= 1.6 * 864e5)
    .sort((x, y) => x.gap - y.gap);
  return fits[0] ?? null;
}

/**
 * The aces on a match page: {left, right, aces: [left's, right's]} from
 * the statistics table (a header row naming the two players either side
 * of "Statistic", then a row labelled Aces with a number either side).
 * Null when the page carries no such table (a match not played, a page
 * that did not load).
 */
export function parseMatchAces(html) {
  const page = String(html ?? '');
  const head = /<th scope="col"[^>]*>([^<]+)<\/th>\s*<th scope="col"[^>]*>\s*Statistic\s*<\/th>\s*<th scope="col"[^>]*>([^<]+)<\/th>/i.exec(page);
  const row = /<td[^>]*>\s*(\d+)\s*<\/td>\s*<th scope="row"[^>]*>\s*Aces\s*<\/th>\s*<td[^>]*>\s*(\d+)\s*<\/td>/i.exec(page);
  if (!head || !row) return null;
  const clean = (s) => s.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").trim();
  return { left: clean(head[1]), right: clean(head[2]), aces: [Number(row[1]), Number(row[2])] };
}

/** A player's aces out of a parsed page, by his family name against the table's two headers ("C. Alcaraz"). Null when neither header is his. */
export function acesFor(parsed, name) {
  if (!parsed) return null;
  const s = surnameToken(name);
  const side = (header) => words(header).at(-1) === s;
  return side(parsed.left) ? parsed.aces[0] : side(parsed.right) ? parsed.aces[1] : null;
}

/** The ace log's entries for a match, both ways round, so the grader finds a player whichever side won: {'date|me|other': {wAces: mine, lAces: his, mirrored: true}}. */
export function aceLogEntries(date, keyA, keyB, acesA, acesB) {
  return {
    [`${date}|${keyA}|${keyB}`]: { wAces: acesA, lAces: acesB, mirrored: true, source: 'tennis.com' },
    [`${date}|${keyB}|${keyA}`]: { wAces: acesB, lAces: acesA, mirrored: true, source: 'tennis.com' },
  };
}
