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

async function searchFighter(name, ctx) {
  const url = `${SHERDOG}/stats/fightfinder?SearchTxt=${encodeURIComponent(name)}`;
  const html = await cachedText(url, SEARCH_TTL, ctx);
  if (!html) return null;

  const candidates = parseSearchResults(html);
  let best = null;
  for (const c of candidates) {
    const score = scoreCandidate(c.name, name);
    if (score > 0 && (!best || score > best.score)) best = { ...c, score };
  }
  // A weak, ambiguous match (surname-only overlap on a common name) is worse
  // than admitting no match — this app has no way to verify it picked the
  // right person among fighters who share a name.
  return best && best.score >= 2 ? best : null;
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

    const opponent = row.match(/<a href="\/fighter\/[^"]+">([^<]+)<\/a>/)?.[1]?.trim() ?? null;
    // The event name is the text of whichever tag sits inside the /events/
    // link — direct text for a normal card, an inner <span itemprop="award">
    // for a title fight — so strip tags rather than assume either shape.
    const eventBlock = row.match(/<a href="\/events\/[^"]+">([\s\S]*?)<\/a>/)?.[1];
    const event = eventBlock?.replace(/<[^>]+>/g, '').trim() || null;
    const date = row.match(/class="sub_line">([^<]+)<\/span>/)?.[1]?.trim() ?? null;
    const method = row.match(/class="winby"><b>([^<]+)<\/b>/)?.[1]?.trim() ?? null;

    rows.push({
      result,
      opponent,
      event,
      date,
      method,
      category: method ? METHOD_CATEGORY(method) : null,
    });
  }
  return rows;
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

  const history = parseFightHistory(html);
  const record = parseHeaderRecord(html, found.href) ?? deriveRecordFromHistory(history);

  return {
    name: found.name,
    profileUrl,
    record,
    history,
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
  const [a, b] = await Promise.all([
    fetchFighter(fighterA, ctx),
    fetchFighter(fighterB, ctx),
  ]);
  if (!a && !b) return null;
  return { a, b };
}
