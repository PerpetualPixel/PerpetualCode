/**
 * The Results tab's arithmetic (2026-11-23, the owner: "Move the results to
 * its own tab. Have it separated by sport and pregame and live ... showing
 * units played, net of units, ROI % and a graph showing the results and
 * able to show by day, week and month and year").
 *
 * Every tracked record the site keeps is read into one shape, a settled
 * result: {id, side, sport, at, date, title, sub, american, orBetter, book,
 * units, net, result}. `side` is 'pre' (posted before the game: the league
 * tickets, the UFC picks, the tennis plays) or 'live' (posted in play: the
 * live slips, the live tennis plays). `units` is the stake, `net` the units
 * won or lost (null for a play that had no price), `date` the Eastern day
 * it belongs to. Nothing here fetches or draws; docs/app.js does both.
 */

export const RESULT_SIDES = [
  { key: 'pre', label: 'Pregame', long: "Pixel's Picks", note: 'Posted before the game. A price with a * is the price the pick said to take, not a book\'s.' },
  { key: 'live', label: 'Live', long: 'Live plays', note: 'Posted during the game. A price with a * is the price the play said to take: no book had one when it posted.' },
];
export const RESULT_SPORTS = [
  { key: 'nba', label: 'NBA' }, { key: 'nfl', label: 'NFL' }, { key: 'nhl', label: 'NHL' },
  { key: 'soccer', label: 'Soccer' }, { key: 'ufc', label: 'UFC' }, { key: 'tennis', label: 'Tennis' },
];
export const RESULT_BUCKETS = [
  { key: 'day', label: 'Day', max: 30 }, { key: 'week', label: 'Week', max: 26 },
  { key: 'month', label: 'Month', max: 24 }, { key: 'year', label: 'Year', max: 20 },
];

/** The sport a feed key belongs to ('basketball_nba' is the NBA; every soccer league is soccer). */
export function sportOfKey(sportKey) {
  const k = String(sportKey ?? '').toLowerCase();
  if (k.includes('nba')) return 'nba';
  if (k.includes('nfl')) return 'nfl';
  if (k.includes('nhl')) return 'nhl';
  if (k.startsWith('soccer')) return 'soccer';
  if (k.startsWith('mma') || k.includes('ufc')) return 'ufc';
  if (k.startsWith('tennis') || k === 'atp' || k === 'wta') return 'tennis';
  return null;
}

const etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
/** The Eastern calendar day of an instant, YYYY-MM-DD. */
export const etDate = (ms) => (Number.isFinite(ms) ? etFmt.format(new Date(ms)) : null);

const SETTLED = new Set(['win', 'loss', 'push', 'void']);
const num = (x) => (Number.isFinite(Number(x)) && x != null ? Number(x) : null);

/**
 * Every settled result, newest first. Each argument is the body of a route
 * the app already reads, any of them null:
 *   trendPicks   /trend-picks   the league tickets, a unit each, and under `mvp` the tracked MVP Picks
 *   ufcPicks     /ufc/picks     the UFC picks, each at its own stake
 *   tennisPicks  /tennis/picks  the tennis plays before the match
 *   tennisLive   /tennis/live   the live tennis plays
 *   liveRecap    /live/results  the live slips against the final box score, every finished game kept
 * A game's live slip is built at every book that prices one, the same bet
 * several times over, so a game counts once: the slip at one of `myBooks`
 * when there is one, else the first. A unit a slip.
 * A live tennis lean comes back marked `lean: true`: the board shows it in
 * a card of its own and no total counts it (countedResults).
 */
/** The other side of a match, when the title already names one player ("vs Hercog"); both names otherwise. */
const versus = (title, a, b) => {
  const t = String(title ?? '');
  if (a && b && t.startsWith(a)) return `vs ${b}`;
  if (a && b && t.startsWith(b)) return `vs ${a}`;
  return [a, b].filter(Boolean).join(' vs ');
};

export function resultEntries({ trendPicks = null, ufcPicks = null, tennisPicks = null, tennisLive = null, liveRecap = null, myBooks = [] } = {}) {
  const out = [];
  const add = (e) => { if (e.sport && e.date && SETTLED.has(e.result)) out.push(e); };

  for (const day of trendPicks?.history ?? []) for (const b of day.bets ?? []) {
    add({ id: `pre:${b.id}`, side: 'pre', sport: sportOfKey(b.sportKey), at: num(b.commenceMs) ?? num(b.postedAt), date: day.date,
      title: (b.legs ?? []).map((l) => l.selection).join(' + ') || 'Ticket', sub: [(b.legs ?? []).length > 1 ? `${b.legs.length} legs` : null, b.book].filter(Boolean).join(' · '),
      american: num(b.american), book: b.book ?? null, units: num(b.units) ?? 1, net: num(b.net), result: b.result });
  }
  // The MVP Picks (worker/src/mvp-picks.js) ride the same answer as the league tickets: the tracked ones, each at the price it said to take.
  for (const day of trendPicks?.mvp?.history ?? []) for (const p of day.picks ?? []) {
    if (!p.tracked || !p.bet) continue;
    const b = p.bet;
    add({ id: `pre:${b.id}`, side: 'pre', sport: 'nba', at: num(b.commenceMs) ?? num(b.postedAt), date: day.date, mvp: true,
      title: (b.legs ?? []).map((l) => l.selection).join(' + ') || 'MVP pick', sub: ['MVP', b.book].filter(Boolean).join(' · '),
      american: num(b.american), orBetter: true, book: b.book ?? null, units: num(b.units) ?? 1, net: num(b.net), result: b.result });
  }
  for (const card of ufcPicks?.history ?? []) for (const b of card.bets ?? []) {
    const at = num(b.settledAt) ?? num(card.eventDate != null ? Date.parse(card.eventDate) || card.eventDate : null) ?? num(card.lockMs);
    add({ id: `pre:ufc:${b.id}`, side: 'pre', sport: 'ufc', at, date: etDate(num(card.lockMs) ?? at),
      title: (b.legs ?? []).map((l) => l.selection).join(' + ') || 'UFC pick', sub: `${card.eventName ?? 'UFC'}${b.book ? ` · ${b.book}` : ''}`,
      american: num(b.american), book: b.book ?? null, units: num(b.units) ?? 1, net: num(b.net), result: b.result });
  }
  for (const rec of tennisPicks?.history ?? []) for (const p of rec.plays ?? []) {
    add({ id: `pre:tennis:${rec.date}:${p.id}`, side: 'pre', sport: 'tennis', at: num(p.commenceMs) ?? num(p.postedAt), date: rec.date,
      title: p.selection ?? (p.legs ?? []).map((l) => l.selection).join(' + ') ?? 'Tennis play', sub: p.market === 'ml_parlay' ? 'Parlay' : versus(p.selection, p.a, p.b),
      american: num(p.american), book: p.book ?? null, units: num(p.units) ?? 1, net: num(p.net), result: p.result, note: p.duplicateOf ? 'Duplicate, not counted' : null });
  }
  for (const rec of tennisLive?.history ?? []) for (const p of rec.plays ?? []) {
    const priced = num(p.american) != null;
    add({ id: `live:tennis:${p.id}`, side: 'live', sport: 'tennis', at: num(p.postedAt), date: rec.date,
      title: p.selection ?? 'Live play', sub: [versus(p.selection, p.a, p.b), p.score ? `at ${p.score}` : null].filter(Boolean).join(' · '),
      american: priced ? num(p.american) : num(p.playable), orBetter: !priced && num(p.playable) != null, book: p.book ?? null,
      units: num(p.units) ?? 1, net: p.result === 'void' ? 0 : num(p.profit), result: p.result,
      // A lean (the best call on a match when nothing clears the bar for a tracked play) is on the board with its result and kept out of every total.
      // It sits under the Leans heading in its sport's card, which says what it is: the row does not repeat it.
      ...(p.lean ? { lean: true } : {}) });
  }
  for (const g of liveRecap?.games ?? []) {
    const slips = (g.slips ?? []).filter((s) => s.result === 'win' || s.result === 'loss');
    const slip = slips.find((s) => (myBooks ?? []).includes(s.bookId)) ?? slips[0];
    if (!slip) continue;
    const at = Date.parse(g.date);
    add({ id: `live:${g.id}`, side: 'live', sport: sportOfKey(g.league), at: Number.isFinite(at) ? at : null, date: etDate(at),
      title: g.name ?? 'Live slip', sub: (slip.legs ?? []).map((l) => `${l.player} ${Number.isFinite(l.point) ? `${Math.ceil(l.point)}+ ` : ''}${l.label ?? l.stat ?? ''}`.trim()).join(' · '),
      american: num(slip.american), book: slip.book ?? null, units: 1, net: num(slip.units), result: slip.result });
  }
  return out.sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : (b.at ?? 0) - (a.at ?? 0)));
}

/** The results a record counts: everything but the leans. */
export const countedResults = (entries) => (entries ?? []).filter((e) => !e.lean);

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * The record of a list of results: {count, wins, losses, pushes, voids,
 * played, net, roi}. `played` is the units risked on what settled as a win,
 * a loss or a push with a price; `roi` is net over played as a fraction
 * (0.125 is +12.5%), null with nothing played.
 */
export function summarize(entries) {
  const out = { count: 0, wins: 0, losses: 0, pushes: 0, voids: 0, played: 0, net: 0, roi: null };
  for (const e of entries ?? []) {
    out.count++;
    if (e.result === 'win') out.wins++; else if (e.result === 'loss') out.losses++; else if (e.result === 'push') out.pushes++; else out.voids++;
    if (e.result !== 'void' && e.net != null) { out.played += e.units ?? 0; out.net += e.net; }
  }
  out.played = round2(out.played); out.net = round2(out.net);
  out.roi = out.played > 0 ? Math.round((out.net / out.played) * 10000) / 10000 : null;
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utc = (date) => new Date(`${date}T00:00:00Z`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The period a day falls in, as the period's first day (a week starts on Monday): the key the buckets are counted by. */
export function bucketStart(date, bucket) {
  const d = utc(date);
  if (bucket === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  else if (bucket === 'month') d.setUTCDate(1);
  else if (bucket === 'year') { d.setUTCMonth(0); d.setUTCDate(1); }
  return ymd(d);
}
/** The first day of the period after the one starting on `start`. */
export function nextBucket(start, bucket) {
  const d = utc(start);
  if (bucket === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else if (bucket === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else if (bucket === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return ymd(d);
}
/** A period in words: "Nov 21", "Week of Nov 17", "November 2026" is too long for an axis, so "Nov 2026", "2026". `short` is the axis tick. */
export function bucketLabel(start, bucket, { short = false } = {}) {
  const d = utc(start); const md = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (bucket === 'day') return md;
  if (bucket === 'week') return short ? md : `Week of ${md}`;
  if (bucket === 'month') return short ? MONTHS[d.getUTCMonth()] : `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return String(d.getUTCFullYear());
}

/**
 * The results counted by period, oldest first, with no period skipped
 * between the first result and today: [{start, label, tick, count, wins,
 * losses, pushes, voids, played, net, roi, total, entries}]. `total` is the
 * running net through that period, from the very first result. Only the
 * last `max` periods are returned (RESULT_BUCKETS' own by default); `total`
 * still counts what came before them.
 */
export function bucketize(entries, bucket = 'week', { today = etDate(Date.now()), max = null } = {}) {
  const list = (entries ?? []).filter((e) => e.date);
  if (!list.length) return [];
  const by = new Map();
  for (const e of list) { const k = bucketStart(e.date, bucket); if (!by.has(k)) by.set(k, []); by.get(k).push(e); }
  const first = [...by.keys()].sort()[0];
  const lastKey = [...by.keys()].sort().at(-1);
  const end = bucketStart(today && today > lastKey ? today : lastKey, bucket);
  const out = []; let total = 0;
  for (let k = first, guard = 0; k <= end && guard < 5000; k = nextBucket(k, bucket), guard++) {
    const es = by.get(k) ?? [];
    const s = summarize(es);
    total = round2(total + s.net);
    out.push({ start: k, label: bucketLabel(k, bucket), tick: bucketLabel(k, bucket, { short: true }), ...s, total, entries: es });
  }
  const cap = max ?? RESULT_BUCKETS.find((b) => b.key === bucket)?.max ?? 30;
  return out.slice(-cap);
}

/** Clean axis ticks around zero for a range of units: [min, ..., 0, ..., max] in steps of 1, 2, 5 times a power of ten, at most `count` steps a side. */
export function unitTicks(min, max, count = 3) {
  const top = Math.max(Math.abs(min), Math.abs(max), 0.5);
  const raw = top / count; const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const ticks = [];
  for (let v = -Math.ceil(Math.abs(Math.min(min, 0)) / step) * step; v <= Math.ceil(Math.max(max, 0) / step) * step + 1e-9; v += step) ticks.push(Math.round(v * 1000) / 1000 || 0);
  return ticks;
}
