/**
 * MMA fighter research, scraped from Sherdog.
 *
 * The odds feed carries only two fighter names for an MMA bout — no
 * promotion tag, no weight class, no record. UFC, PFL, and Dana White's
 * Contender Series all arrive through the same bundled Odds API key
 * (mma_mixed_martial_arts), so there is nothing upstream to distinguish them
 * by; a fighter's own Sherdog history is the only place that shows up (an
 * "Upcoming Fights" entry naming the actual card).
 *
 * Sherdog rather than ESPN: ESPN has no MMA pages at all on cdn.espn.com (the
 * host that works for the other sports) — confirmed 404 on every path this
 * app tried. Sherdog's robots.txt explicitly allows crawling (`Allow: /`),
 * and it was confirmed reachable from a live Cloudflare Worker before this
 * was built — ESPN's site API taught the hard way that "reachable from my
 * machine" doesn't imply "reachable from Cloudflare's IP range."
 *
 * This is HTML scraping, not an API — meaningfully more fragile than
 * everything else in this app. A Sherdog redesign can silently break every
 * selector here. Every extractor is written to fail toward an empty result,
 * never a wrong one: a torn-up parse returns fewer fields, not fabricated
 * ones. Records for very new fighters (a Contender Series prospect on their
 * first appearance) may be thin or entirely absent from Sherdog — that is a
 * true "no data" case, not a bug, and the pick card should say less rather
 * than reach for the fighter's amateur record or invent one.
 */

import { fetchUfcProfile } from './ufc.js';
import { parseSherdogDate } from '../../docs/insights.js';

const SHERDOG = 'https://www.sherdog.com';
const SEARCH_TTL = 3600 * 6;   // a name resolves to the same fighter for months
const PROFILE_TTL = 3600 * 6;  // a record only changes after that fighter's next fight

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cache-through HTML fetch, keyed on the upstream URL. */
async function cachedText(url, ttl, ctx) {
  const cacheKey = new Request(`https://pixel-pick.cache/sherdog/${encodeURIComponent(url)}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit.text();

  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
  });
  if (!response.ok) return null;

  const body = await response.text();
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(body, {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': `max-age=${ttl}` },
      }),
    ),
  );
  return body;
}

/**
 * Resolve a fighter name to their Sherdog profile URL slug.
 *
 * The search page's "FIGHTER RESULTS" table is what to read; a sidebar of
 * "TRENDING FIGHTERS" links appears on every page regardless of query and
 * must not be mistaken for a match, which is why extraction starts only
 * after the `fightfinder_result` marker rather than scanning the whole page.
 */
function parseSearchResults(html) {
  const marker = html.indexOf('fightfinder_result');
  if (marker < 0) return [];

  const scoped = html.slice(marker);
  const rows = [...scoped.matchAll(
    /document\.location='(\/fighter\/[^']+)'[\s\S]*?<a href="\/fighter\/[^"]+">([^<]+)<\/a>/g,
  )];
  return rows.map(([, href, name]) => ({ href, name: name.trim() }));
}

function scoreCandidate(candidateName, wanted) {
  const a = fold(candidateName);
  const b = fold(wanted);
  if (!a || !b) return 0;
  if (a === b) return 3;
  const aw = new Set(a.split(' '));
  const bw = b.split(' ');
  const overlap = bw.filter((w) => w.length > 1 && aw.has(w)).length;
  return overlap ? 2 + overlap / bw.length : 0;
}

/**
 * Best-scoring candidate against `wanted`, or null if there isn't a clear
 * winner. Ties at the top score are treated the same as no match — if two
 * different Sherdog fighters score identically against the query, this app
 * has no further signal to pick the right one, and a wrong guess is worse
 * than admitting no data (see this module's own file-level comment on
 * failing toward empty, never fabricated).
 */
function pickBest(candidates, wanted) {
  let best = null;
  let bestCount = 0;
  for (const c of candidates) {
    const score = scoreCandidate(c.name, wanted);
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { ...c, score };
      bestCount = 1;
    } else if (score === best.score) {
      bestCount++;
    }
  }
  return best && best.score >= 2 && bestCount === 1 ? best : null;
}

/**
 * Resolve a fighter name to a Sherdog search-result candidate, from the
 * full-name query only.
 *
 * A surname-only retry was tried here and reverted: widening what Sherdog's
 * search returns raises real cross-person collision risk that scoring alone
 * doesn't catch — confirmed live, "Carlos Diego Ferreira" (a real UFC
 * lightweight, whose full-name query returns zero Sherdog rows) matched
 * "Alan Carlos Ferreira Rodrigues" via a surname-widened search: a
 * completely different person who merely shares "Carlos" and "Ferreira" as
 * words, uniquely (no tie) out-scoring every other same-surname candidate.
 * pickBest's tie-check only catches an exact score tie, not a confidently
 * wrong single winner — and a wrong fighter's stats attributed to the real
 * one is strictly worse than admitting no data (this module's own governing
 * rule, see the file-level comment above). Full-name-only is a real, if
 * narrower, coverage gap for a genuine name-variant mismatch, but that gap
 * is the honest "no data" case this app is designed to show rather than
 * paper over with a guess.
 */
async function searchFighter(name, ctx) {
  const url = `${SHERDOG}/stats/fightfinder?SearchTxt=${encodeURIComponent(name)}`;
  const html = await cachedText(url, SEARCH_TTL, ctx);
  return html ? pickBest(parseSearchResults(html), name) : null;
}

/** win/loss/draw/nc totals from the fighter's own upcoming-fight record badge. */
function parseHeaderRecord(html, slug) {
  // Sherdog ties each fighter's name link to their own record span immediately
  // after it inside the fight-card-preview widget — reading by proximity to
  // this fighter's own slug avoids guessing which of the two records shown
  // (both fighters in the upcoming bout) belongs to them.
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `href="${escaped}"[\\s\\S]{0,300}?class="record">(\\d+)-(\\d+)-(\\d+)`,
  );
  const m = html.match(re);
  if (!m) return null;
  return { wins: +m[1], losses: +m[2], draws: +m[3] };
}

const METHOD_CATEGORY = (method) => {
  if (/^(KO|TKO)/i.test(method)) return 'knockout';
  if (/^(Submission|Technical Submission)/i.test(method)) return 'submission';
  if (/^Decision/i.test(method)) return 'decision';
  return 'other';
};

/**
 * The fight history table, newest result first — matches Sherdog's own order.
 *
 * Split into row chunks first, then read each field from its own chunk with a
 * small independent regex. A title-fight row wraps its event name in an extra
 * `<span itemprop="award">` that a non-title row doesn't; an all-in-one regex
 * spanning the whole row broke on that mismatch and then mis-aligned every
 * row after it. Parsing field-by-field means one odd row loses a field or two,
 * never drags its neighbors down with it.
 */
function parseFightHistory(html) {
  const marker = html.indexOf('fight_history');
  if (marker < 0) return [];

  const tableEnd = html.indexOf('</table>', marker);
  const scoped = html.slice(marker, tableEnd > 0 ? tableEnd : undefined);

  const rowChunks = scoped.split('<tr>').slice(1).map((chunk) => chunk.split('</tr>')[0]);

  const rows = [];
  for (const row of rowChunks) {
    const result = row.match(/class="final_result (win|loss|draw|nc)"/)?.[1];
    if (!result) continue; // the header row has no final_result span

    const opponentLink = row.match(/<a href="(\/fighter\/[^"]+)">([^<]+)<\/a>/);
    const opponentHref = opponentLink?.[1] ?? null;
    const opponent = opponentLink?.[2]?.trim() ?? null;
    // The event name is the text of whichever tag sits inside the /events/
    // link — direct text for a normal card, an inner <span itemprop="award">
    // for a title fight — so strip tags rather than assume either shape.
    const eventBlock = row.match(/<a href="\/events\/[^"]+">([\s\S]*?)<\/a>/)?.[1];
    const event = eventBlock?.replace(/<[^>]+>/g, '').trim() || null;
    const date = row.match(/class="sub_line">([^<]+)<\/span>/)?.[1]?.trim() ?? null;
    const method = row.match(/class="winby"><b>([^<]+)<\/b>/)?.[1]?.trim() ?? null;

    // Round and time are the two plain <td> cells right after the winby
    // block — confirmed against a live profile page before writing this,
    // rather than assumed from the fight-history table's general shape.
    const winbyEnd = row.indexOf('</td>', row.indexOf('class="winby"'));
    const trailer = winbyEnd >= 0 ? row.slice(winbyEnd) : '';
    const trailingCells = [...trailer.matchAll(/<td>([^<]*)<\/td>/g)].map((m) => m[1].trim());
    const round = trailingCells[0] ? Number(trailingCells[0]) : null;
    const time = trailingCells[1] || null;

    rows.push({
      result,
      opponent,
      opponentHref,
      event,
      date,
      method,
      category: method ? METHOD_CATEGORY(method) : null,
      round: Number.isFinite(round) ? round : null,
      time,
    });
  }
  return rows;
}

/**
 * Age, height, weight, weight class, and association from the profile's
 * "bio-holder" info box. Reach and stance are read the same defensive way
 * but genuinely absent for most fighters on Sherdog — not every field below
 * exists for every fighter, and a missing one is left null rather than
 * guessed at from weight class norms or anything else.
 */
function parseBio(html) {
  const marker = html.indexOf('bio-holder');
  if (marker < 0) return null;
  const scoped = html.slice(marker, marker + 2000);

  const age = scoped.match(/AGE<\/td>\s*<td><b>(\d+)<\/b>/)?.[1];
  const height = scoped.match(/itemprop="height">([^<]+)</)?.[1];
  const weight = scoped.match(/itemprop="weight">([^<]+)</)?.[1];
  const weightClass = scoped.match(/weightclass=[^"]*"[^>]*>([^<]+)<\/a>/)?.[1];
  const association = scoped.match(/itemprop="name">([^<]+)</)?.[1];
  // Not present in the bio-holder table on every fighter's page — read
  // defensively from wherever Sherdog does carry it when it's there.
  const reach = html.match(/REACH<\/td>\s*<td><b>([^<]+)<\/b>/)?.[1];
  const stance = html.match(/STANCE<\/td>\s*<td><b>([^<]+)<\/b>/)?.[1];

  const bio = {
    age: age ? Number(age) : null,
    height: height ?? null,
    weight: weight ?? null,
    weightClass: weightClass?.trim() ?? null,
    association: association?.trim() ?? null,
    reach: reach?.trim() ?? null,
    stance: stance?.trim() ?? null,
  };
  // Every field null means the box itself didn't parse the way expected —
  // report that as "no bio", not a bio full of nulls.
  return Object.values(bio).some((v) => v != null) ? bio : null;
}

/**
 * The fighter's profile photo — confirmed live against Jon Jones' actual
 * Sherdog page before writing this: an `itemprop="image"` tag with a
 * `/image_crop/...` relative path sits just before the bio-holder box.
 * Missing for very new or obscure fighters; null rather than a placeholder
 * image, same "no data" honesty as everything else here.
 */
function parsePhoto(html) {
  const src = html.match(/itemprop="image"\s+src="([^"]+)"/)?.[1];
  return src ? `${SHERDOG}${src}` : null;
}

/**
 * A fighter's nickname, if Sherdog has one on file — many don't (a real,
 * common "no data" case, not a parse failure). Confirmed live: a fighter
 * with no nickname carries `<span class="nickname_empty">`; one with a
 * nickname carries `<span class="nickname">"<em>The Butcher</em>"</span>`
 * inside an `<h1>` right after the fighter's own name.
 */
export function parseNickname(html) {
  if (html.includes('nickname_empty')) return null;
  const raw = html.match(/class="nickname">"?<em>([^<]+)<\/em>"?/)?.[1];
  return raw?.trim() || null;
}

/**
 * Nationality and hometown/region from the profile header's
 * `fighter-nationality` block. Sherdog carries exactly one location per
 * fighter here — confirmed live it doesn't reliably distinguish "born in"
 * from "fights out of" the way some other sites do (Bryan Battle's own page
 * lists "Charlotte, North Carolina" here, his current camp city, not his
 * birth city) — so this is surfaced honestly as a single "based in" fact
 * rather than asserting a birth-vs-training distinction Sherdog's own markup
 * doesn't actually make.
 */
export function parseNationalityLocation(html) {
  const marker = html.indexOf('fighter-nationality');
  if (marker < 0) return { nationality: null, location: null };
  const scoped = html.slice(marker, marker + 700);
  const nationality = scoped.match(/itemprop="nationality">([^<]+)</)?.[1]?.trim() ?? null;
  const location = scoped.match(/itemprop="addressLocality"[^>]*>([^<]+)</)?.[1]?.trim() ?? null;
  return { nationality, location };
}

/**
 * How many fights in a row (from most recent) share the same result — "3
 * Win" or "1 Loss" — computed from the same history array already parsed,
 * no extra fetch. Null when history is empty (nothing to compute a streak
 * from) rather than a misleading "0".
 */
export function computeCurrentStreak(history) {
  if (!history.length) return null;
  const result = history[0].result;
  let count = 0;
  for (const fight of history) {
    if (fight.result !== result) break;
    count++;
  }
  return { result, count };
}

// Bounds how many of a fighter's history rows get an opponent's
// record-at-the-time attached — each one costs a real extra fetch (the
// opponent's own Sherdog page), so this is capped to the fights a reader is
// actually likely to look at rather than a whole 30-fight veteran's career.
const OPPONENT_RECORD_LOOKBACK = 10;

/**
 * Reconstructs what an opponent's own record was heading into one specific
 * past fight — not their current record, which is what today's Sherdog
 * profile would otherwise show and would be actively misleading for an old
 * fight (e.g. showing a now-veteran opponent's 20-3 record for a bout that
 * happened when they were 4-1). Fetches that opponent's own profile (already
 * have their Sherdog href from the history row, no name-search needed) and
 * counts wins/losses/draws among fights on THEIR history dated on or before
 * `beforeMs`.
 */
async function fetchOpponentRecordAtDate(opponentHref, beforeMs, ctx) {
  if (!opponentHref || !Number.isFinite(beforeMs)) return null;
  const html = await cachedText(`${SHERDOG}${opponentHref}`, PROFILE_TTL, ctx);
  if (!html) return null;

  const history = parseFightHistory(html);
  const tally = { wins: 0, losses: 0, draws: 0 };
  let counted = 0;
  for (const fight of history) {
    const ms = parseSherdogDate(fight.date);
    if (ms == null || ms > beforeMs) continue;
    counted++;
    if (fight.result === 'win') tally.wins++;
    else if (fight.result === 'loss') tally.losses++;
    else if (fight.result === 'draw') tally.draws++;
  }
  return counted > 0 ? tally : null;
}

/**
 * Attaches `opponentRecordAtTime` to each of a fighter's most recent
 * `OPPONENT_RECORD_LOOKBACK` history rows, fetched in parallel. Rows beyond
 * the lookback simply don't get one (still shown, just without that one
 * field) rather than fetching a whole career's worth of opponent profiles.
 */
async function attachOpponentRecords(history, ctx) {
  const recent = history.slice(0, OPPONENT_RECORD_LOOKBACK);
  const records = await Promise.all(
    recent.map((fight) => {
      const beforeMs = parseSherdogDate(fight.date);
      return fetchOpponentRecordAtDate(fight.opponentHref, beforeMs, ctx);
    }),
  );
  return history.map((fight, i) => (
    i < recent.length ? { ...fight, opponentRecordAtTime: records[i] } : fight
  ));
}

/**
 * Full fighter research bundle, or null if Sherdog has no confident match —
 * a real outcome for a brand-new prospect, not a failure to handle specially.
 */
async function fetchFighter(name, ctx) {
  const found = await searchFighter(name, ctx);
  if (!found) return null;

  const profileUrl = `${SHERDOG}${found.href}`;
  const html = await cachedText(profileUrl, PROFILE_TTL, ctx);
  if (!html) return null;

  const rawHistory = parseFightHistory(html);
  const history = await attachOpponentRecords(rawHistory, ctx);
  const record = parseHeaderRecord(html, found.href) ?? deriveRecordFromHistory(history);
  const bio = parseBio(html);
  const photo = parsePhoto(html);
  const nickname = parseNickname(html);
  const { nationality, location } = parseNationalityLocation(html);
  const streak = computeCurrentStreak(history);

  return {
    name: found.name,
    profileUrl,
    record,
    history,
    bio,
    photo,
    nickname,
    nationality,
    location,
    streak,
  };
}

/** Fallback when there's no upcoming-fight preview to read a record badge from. */
function deriveRecordFromHistory(history) {
  if (!history.length) return null;
  const tally = { wins: 0, losses: 0, draws: 0 };
  for (const fight of history) {
    if (fight.result === 'win') tally.wins++;
    else if (fight.result === 'loss') tally.losses++;
    else if (fight.result === 'draw') tally.draws++;
  }
  return tally;
}

/**
 * Research for one MMA matchup. Each side is resolved independently and a
 * miss on one side doesn't block the other — a pick can still carry research
 * on the fighter Sherdog does have, with nothing invented for the one it
 * doesn't.
 */
export async function fetchMmaContext({ fighterA, fighterB }, ctx) {
  if (!fighterA || !fighterB) return null;
  const [a, b, ufcA, ufcB] = await Promise.all([
    fetchFighter(fighterA, ctx),
    fetchFighter(fighterB, ctx),
    fetchUfcProfile(fighterA, ctx),
    fetchUfcProfile(fighterB, ctx),
  ]);
  if (!a && !b) return null;
  // ufc.com only has a page for someone who's actually fought in the UFC —
  // null here is a real, common outcome (a PFL or Bellator-only fighter),
  // not a failed lookup. Attached alongside Sherdog's own bio/history rather
  // than replacing any of it: Sherdog has cross-promotion history no other
  // source carries, ufc.com has the career rate stats Sherdog doesn't.
  return {
    a: a ? { ...a, ufc: ufcA } : a,
    b: b ? { ...b, ufc: ufcB } : b,
  };
}
