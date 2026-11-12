/**
 * Whether a prop is viable, beyond its hit rates (2026-11-12 direction:
 * "not only look at hit rates but whether the prop is viable. Will they
 * have minute restrictions, snap count restrictions, are they not
 * starting or the primary player for that position. Is there blowout
 * potential for the game, check all variables that could hinder the
 * prop").
 *
 * Each check reads something the app already holds for the leg's player
 * and game and says, in plain words, whether it helps or hurts the side
 * the slip took:
 *
 *   role      today's posted lineup, or who started the team's last game
 *   depth     the NFL depth chart: the place at his position
 *   injury    the report, and any limit its note mentions
 *   layoff    a first game back after a gap (a minutes or snap limit)
 *   minutes   NBA minutes over the last 3 against the last 10
 *   workload  NFL volume over the last 3 against the last 10 (the feed
 *             carries no snap counts; a player's own volume stands in)
 *   blowout   the game's spread, and how the line has done in his own
 *             lopsided games
 *   rest      the second night of a back-to-back
 *   teammates who is out beside him
 *   started   a game already under way
 *
 * An over needs the minutes and the volume; an under is helped by their
 * loss, so most checks read the other way for an under.
 *
 * Pure and deterministic: the worker and the tests can run it too.
 */
import { hitFlags } from './trends.js';

const DAY = 864e5;
const NBA = 'basketball_nba';
const NFL = 'americanfootball_nfl';
const NHL = 'icehockey_nhl';

/** The spread, in points, from which a game reads as a likely blowout; and the final margin that counts as one on the log. */
export const BLOWOUT = { [NBA]: { spread: 10, heavy: 14, margin: 15 }, [NFL]: { spread: 10, heavy: 14, margin: 17 } };
/** Days without a game, mid-season, after which the next one reads as a return. */
export const LAYOFF_DAYS = { [NBA]: 9, [NHL]: 9, [NFL]: 20 };
/**
 * How many deep at a position still reads as a primary player on an NFL
 * depth chart. ESPN lists each receiver spot (wr1, wr2, wr3) as its own
 * slot with its own order, so the first name at any of them is a starter
 * and the second is that spot's backup.
 */
export const PRIMARY_DEPTH = { QB: 1, RB: 1, TE: 1, FB: 1, PK: 1, K: 1, WR: 1 };
const POSITION_WORD = { QB: 'quarterback', RB: 'running back', TE: 'tight end', WR: 'wide receiver', FB: 'fullback', PK: 'kicker', K: 'kicker' };
const NFL_PASS = new Set(['passYds', 'passAttempts', 'passCompletions', 'passTds', 'recYds', 'receptions']);
const NFL_RUSH = new Set(['rushYds', 'rushAttempts']);
const NFL_CATCH = new Set(['recYds', 'receptions', 'rushRecYds', 'anyTd']);
const LIMIT_WORDS = /\b(minutes? (restriction|limit)|restricted minutes|limited (minutes|snaps|basis|role)|snap (count|limit)|pitch count|load management|ramp(ing|ed)? up|eased? (back )?in|workload)\b/i;

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const round1 = (n) => Math.round(n * 10) / 10;
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
const dateMs = (d) => (Number.isFinite(d) ? d : Number.isFinite(Date.parse(d)) ? Date.parse(d) : null);

/** The final margin of a logged game from its score ("127-121"), or null. */
export function marginOf(score) {
  const m = /^\s*(\d+)\s*-\s*(\d+)/.exec(String(score ?? ''));
  return m ? Math.abs(Number(m[1]) - Number(m[2])) : null;
}

/**
 * How a line has done in the player's own lopsided games: {games, hits,
 * rate, rest: {games, hits, rate}} over the log, or null when fewer than
 * three were lopsided.
 */
export function blowoutSplit(rows, point, side, margin) {
  const flags = hitFlags(rows ?? [], point, side);
  const inBlowout = []; const rest = [];
  (rows ?? []).forEach((r, i) => { if (flags[i] === null) return; const m = marginOf(r.score); if (m === null) return; (m >= margin ? inBlowout : rest).push(flags[i] ? 1 : 0); });
  if (inBlowout.length < 3) return null;
  const tally = (xs) => ({ games: xs.length, hits: xs.reduce((s, x) => s + x, 0), rate: xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null });
  return { ...tally(inBlowout), rest: tally(rest) };
}

/**
 * The checks for one leg. `match` is the Slip Check's match with what
 * the board knows beside the log: role, mins, depth, line ({spread,
 * total, opp} for his team; a negative spread is a favorite), injury,
 * teammatesOut ([{name, pos}]), commenceMs, sportKey. Returns {level:
 * 'viable' | 'risky' | 'avoid', checks: [{key, level: 'ok' | 'info' |
 * 'warn' | 'bad', text}], penalty: {factor, points}}, or null for a leg
 * with nothing to read (a team line, an unmatched leg).
 */
export function viabilityOf(leg, match, { now = Date.now() } = {}) {
  if (!match || !['trends', 'player'].includes(match.source) || !leg?.side) return null;
  const over = leg.side === 'over';
  const sport = match.sportKey ?? null;
  const rows = match.rows ?? [];
  const who = match.name ?? leg.player ?? 'The player';
  const checks = [];
  const add = (key, level, text) => checks.push({ key, level, text });
  const tip = Number.isFinite(match.commenceMs) ? match.commenceMs : null;

  // Role: today's lineup, or the last game's box score.
  const role = match.role;
  if (role && typeof role.starter === 'boolean') {
    const posted = role.today && role.source === 'lineup';
    const when = dateMs(role.date) ? dayFmt.format(dateMs(role.date)) : 'his last game';
    if (!role.starter) {
      if (posted) add('role', over ? 'bad' : 'ok', over ? `${who} is not in today's starting lineup: an over needs starter's minutes.` : `${who} comes off the bench today, which helps an under.`);
      else add('role', over ? 'warn' : 'ok', over ? `${who} came off the bench in his last game (${when}): confirm he starts before taking an over.` : `${who} came off the bench in his last game (${when}).`);
    } else add('role', 'ok', posted ? `${who} is in today's starting lineup.` : `${who} started his last game (${when}); today's lineup is not posted yet.`);
  }

  // The NFL depth chart: the primary player at his position, or not.
  const depth = match.depth;
  if (depth?.pos && Number.isFinite(depth.rank)) {
    const pos = String(depth.pos).toUpperCase();
    const word = POSITION_WORD[pos] ?? pos;
    const primary = depth.rank <= (PRIMARY_DEPTH[pos] ?? 1);
    if (primary) add('depth', 'ok', pos === 'WR' ? 'Listed as a starting wide receiver on the depth chart.' : `Listed as the starting ${word} on the depth chart.`);
    else if (pos === 'QB') add('depth', over ? 'bad' : 'ok', `Listed as the ${ordinal(depth.rank)} quarterback on the depth chart: he plays only if the starter does not.`);
    else add('depth', over ? 'warn' : 'ok', `Listed ${ordinal(depth.rank)} at ${pos === 'WR' ? 'his wide receiver spot' : word} on the depth chart: not the primary player there${over ? ', so the volume an over needs is not his by default' : ''}.`);
  }

  // The injury report, and any limit its note mentions.
  const inj = match.injury;
  if (inj?.level === 'out') add('injury', 'bad', `${who} is listed out${inj.detail ? ` (${inj.detail})` : ''}.`);
  else if (inj?.level === 'doubtful') add('injury', 'bad', `${who} is doubtful${inj.detail ? ` (${inj.detail})` : ''}.`);
  else if (inj?.level === 'questionable') add('injury', 'warn', `${who} is questionable${inj.detail ? ` (${inj.detail})` : ''}: if he plays, a limit is possible.`);
  const note = [inj?.detail, inj?.status].filter(Boolean).join(' ');
  if (note && LIMIT_WORDS.test(note)) add('limit', over ? 'warn' : 'info', `The injury report mentions a limit: "${String(inj.detail ?? inj.status).slice(0, 140)}".`);

  // A first game back after a gap.
  const last = rows.map((r) => dateMs(r.date)).find((d) => d !== null) ?? null;
  const gapDays = last !== null ? ((tip ?? now) - last) / DAY : null;
  const layoff = LAYOFF_DAYS[sport];
  if (layoff && gapDays !== null && gapDays > layoff && gapDays < 200) {
    add('layoff', over ? 'warn' : 'info', `${who} has not played since ${dayFmt.format(last)} (${Math.round(gapDays)} days): a first game back often carries a ${sport === NFL ? 'snap count' : 'minutes limit'}.`);
  }

  // NBA minutes: the last three against the last ten.
  const mins = match.mins;
  if (mins && Number.isFinite(mins.l3) && Number.isFinite(mins.l10) && mins.l10 > 0) {
    const ratio = mins.l3 / mins.l10;
    const say = `${round1(mins.l3)} minutes a game over the last 3 against ${round1(mins.l10)} over the last 10`;
    if (ratio <= 0.85) add('minutes', over ? 'warn' : 'ok', `Minutes are down: ${say}${over ? '. An over needs them back.' : ', which helps an under.'}`);
    else if (ratio >= 1.15) add('minutes', over ? 'ok' : 'warn', `Minutes are up: ${say}${over ? '.' : ', which works against an under.'}`);
    else add('minutes', 'ok', `Minutes are steady: ${say}.`);
    if (over && mins.l10 < 20) add('bench', 'info', `He plays ${round1(mins.l10)} minutes a night: a small swing in the rotation moves this number a lot.`);
  } else if (sport === NFL) {
    // The NFL feed carries no snap counts: the player's own volume stands in.
    const vals = rows.map((r) => r.value).filter((v) => Number.isFinite(v));
    if (vals.length >= 8) {
      const l3 = avg(vals.slice(0, 3)); const l10 = avg(vals.slice(0, 10));
      const label = String(leg.stat?.label ?? 'this stat').toLowerCase();
      if (l10 > 0 && l3 / l10 <= 0.6) add('workload', over ? 'warn' : 'ok', `Workload is down: ${round1(l3)} ${label} a game over the last 3 against ${round1(l10)} over the last 10 (snap counts are not in the feed; his own volume stands in).`);
      else if (l10 > 0 && l3 / l10 >= 1.5) add('workload', over ? 'ok' : 'warn', `Workload is up: ${round1(l3)} ${label} a game over the last 3 against ${round1(l10)} over the last 10.`);
    }
  }

  // Blowout potential: the spread, and the line in his own lopsided games.
  const line = match.line;
  const shape = BLOWOUT[sport];
  if (shape && Number.isFinite(line?.spread) && Math.abs(line.spread) >= shape.spread) {
    const size = Math.abs(line.spread);
    const favorite = line.spread < 0;
    const split = Number.isFinite(leg.point) ? blowoutSplit(rows, leg.point, leg.side, shape.margin) : null;
    const splitText = split ? ` In his ${split.games} games decided by ${shape.margin} or more, this line landed ${split.hits} of ${split.games}${split.rest.games ? `, against ${split.rest.hits} of ${split.rest.games} in the rest` : ''}.` : '';
    const holdsUp = split && split.rest.games && split.rate >= split.rest.rate - 0.05 && split.rate >= 0.6;
    if (sport === NBA) {
      if (over && holdsUp) add('blowout', 'info', `His team is a ${size}-point ${favorite ? 'favorite' : 'underdog'}, but this line has held in his lopsided games.${splitText}`);
      else if (over) add('blowout', size >= shape.heavy ? 'bad' : 'warn', `Blowout risk: his team is a ${size}-point ${favorite ? 'favorite' : 'underdog'}, and starters sit late in a game that gets away.${splitText}`);
      else add('blowout', 'ok', `A ${size}-point spread helps an under: starters sit late in a game that gets away.${splitText}`);
    } else {
      const stat = leg.stat?.key;
      const passing = NFL_PASS.has(stat); const rushing = NFL_RUSH.has(stat);
      // Ahead big, a team runs the clock; behind big, it throws.
      const hurts = favorite ? (passing && over) || (rushing && !over) : (rushing && over) || (passing && !over);
      const helps = favorite ? (rushing && over) || (passing && !over) : (passing && over) || (rushing && !over);
      const script = favorite ? `his team is a ${size}-point favorite, and a team that far ahead runs the ball and the clock late` : `his team is a ${size}-point underdog, and a team that far behind throws and leaves the run`;
      if (hurts && holdsUp) add('blowout', 'info', `Game script leans against this (${script}), but the line has held in his lopsided games.${splitText}`);
      else if (hurts) add('blowout', 'warn', `Game script works against this: ${script}.${splitText}`);
      else if (helps) add('blowout', 'ok', `Game script helps this: ${script}.${splitText}`);
      else add('blowout', 'info', `A lopsided game is likely: ${script}.${splitText}`);
    }
  }

  // The second night of a back-to-back.
  if ((sport === NBA || sport === NHL) && tip !== null && last !== null) {
    const hours = (tip - last) / 3600e3;
    if (hours > 0 && hours <= 36) add('rest', over ? 'warn' : 'info', `Second night of a back-to-back (he played ${dayFmt.format(last)}): rest or trimmed minutes are in play.`);
  }

  // Who is out beside him.
  const out = (match.teammatesOut ?? []).filter((t) => t?.name);
  if (out.length) {
    const qb = out.find((t) => String(t.pos ?? '').toUpperCase() === 'QB' && (t.rank ?? 1) === 1);
    if (sport === NFL && qb && NFL_CATCH.has(leg.stat?.key)) add('teammates', over ? 'warn' : 'info', `${qb.name}, the starting quarterback, is out: the passes come from a backup.`);
    else if (sport === NBA) {
      const names = out.slice(0, 3).map((t) => t.name).join(', ');
      add('teammates', over ? 'ok' : 'warn', `${names} ${out.length === 1 ? 'is' : 'are'} out for his team: more of the offense falls to the players left${over ? '.' : ', which works against an under.'}`);
    }
  }

  // A game already under way.
  if (tip !== null && tip <= now) add('started', 'warn', 'The game has started: the pregame number and price are gone.');

  const bad = checks.filter((c) => c.level === 'bad');
  const warn = checks.filter((c) => c.level === 'warn');
  // The injury listing is already priced into the leg's confidence by the scorer; the rest cut it here.
  const counted = (c) => c.key !== 'injury';
  const factor = bad.some(counted) ? 0.7 : 1;
  const points = Math.min(0.15, warn.filter(counted).length * 0.05);
  return { level: bad.length ? 'avoid' : warn.length ? 'risky' : 'viable', checks, penalty: { factor, points } };
}

export const VIABILITY_LABEL = { viable: 'Viable', risky: 'Risky', avoid: 'Avoid' };

/**
 * The play to make instead (2026-11-12 direction: "a suggested deep link
 * to play"): the ticket's legs that hold up, each at a number the player
 * clears where the slip's does not, priced at one book with the book's
 * link. A leg comes off when its checks say avoid, when it has no read,
 * or when it sits under the bar with no better number on the board.
 *
 *   scored  the Slip Check's legs ({leg, match, score})
 *   rows    the Trends rows by league ({sportKey: [row]})
 *   books   the user's books, preferred for the price and the link
 *   bar     the confidence a leg has to clear to stay (the type's bar)
 *
 * Returns {legs: [{selection, player, game, change: 'kept' | 'moved',
 * from, point, side, confidence, level, american, book, bookId, link, rowId,
 * manual}] (manual: a leg with no board price, to add by hand),
 * dropped: [{selection, why}], bookId, book, american, decimal, priced},
 * or null when no leg survives.
 */
export function suggestedPlay(scored, { rows = {}, books = [], bar = 55, now = Date.now() } = {}) {
  const keep = []; const dropped = [];
  const rowAt = (m, statKey, side, point) => (rows[m.sportKey] ?? []).find((r) => r.statKey === statKey && r.athleteId === m.row?.athleteId && r.side === side && r.point === point && r.commenceMs > now) ?? null;
  for (const s of scored ?? []) {
    const { leg, match, score } = s;
    const v = score.viability;
    if (score.confidence == null) { dropped.push({ selection: leg.selection, why: 'no game log or price to read' }); continue; }
    if (match?.source !== 'trends') {
      // A team line, a tennis leg or a player off today's board: it stays when it clears the bar, to be added by hand.
      if (score.confidence >= bar && v?.level !== 'avoid') keep.push({ row: null, change: 'kept', from: null, confidence: score.confidence, leg, match, level: v?.level ?? null });
      else dropped.push({ selection: leg.selection, why: v?.level === 'avoid' ? v.checks.find((c) => c.level === 'bad')?.text ?? 'the checks say avoid' : `reads ${score.confidence}%, under the ${bar}% bar` });
      continue;
    }
    if (v?.level === 'avoid') { dropped.push({ selection: leg.selection, why: v.checks.find((c) => c.level === 'bad')?.text ?? 'the checks say avoid' }); continue; }
    const statKey = leg.stat?.key ?? match.row?.statKey;
    const side = leg.side ?? match.row?.side;
    const point = leg.point ?? match.row?.point;
    let row = rowAt(match, statKey, side, point);
    let change = 'kept'; let from = null; let confidence = score.confidence;
    if (score.confidence < bar) {
      const better = score.better ?? null;
      const moved = better ? rowAt(match, statKey, side, better.point) : null;
      if (!moved) { dropped.push({ selection: leg.selection, why: better ? `reads ${score.confidence}%, and no book on the board prices the ${side} ${better.point} that clears` : `reads ${score.confidence}%, under the ${bar}% bar, with no better number on his log` }); continue; }
      // The new number's rate, less what the checks take off: a minutes cut follows the player to any line.
      row = moved; change = 'moved'; from = point; confidence = Math.round(Math.max(0.02, Math.min(0.98, better.rate * (v?.penalty.factor ?? 1) - (v?.penalty.points ?? 0))) * 100);
    }
    if (!row) { dropped.push({ selection: leg.selection, why: 'no book on the board prices this exact number today' }); continue; }
    keep.push({ row, change, from, confidence, leg, match, level: v?.level ?? null });
  }
  if (!keep.length) return dropped.length ? { legs: [], dropped, bookId: null, book: null, american: null, decimal: null, priced: false } : null;
  // One book for the slip: the user's book that prices the most legs, then any book that does.
  const quotesOf = (row) => (row.quotes ?? []).filter((q) => Number.isFinite(q.american));
  const idOf = (q) => q.bookId ?? q.bookKey ?? null;
  const tally = new Map();
  for (const k of keep) for (const q of k.row ? quotesOf(k.row) : []) { const id = idOf(q); if (!id) continue; const t = tally.get(id) ?? { id, name: q.book ?? id, n: 0, mine: books.includes(id) || books.includes(q.bookKey) }; t.n++; tally.set(id, t); }
  const best = [...tally.values()].sort((a, b) => Number(b.mine) - Number(a.mine) || b.n - a.n)[0] ?? null;
  const legs = keep.map(({ row, change, from, confidence, leg, level }) => {
    if (!row) return { level, selection: leg.selection, player: leg.player ?? null, game: '', change, from, point: leg.point ?? null, side: leg.side ?? null, confidence, american: Number.isFinite(leg.american) ? leg.american : null, book: null, bookId: null, link: null, rowId: null, manual: true };
    const qs = quotesOf(row);
    const q = (best && qs.find((x) => idOf(x) === best.id)) ?? [...qs].sort((a, b) => b.american - a.american)[0] ?? null;
    return {
      selection: row.selection ?? `${row.playerName} ${row.side} ${row.point} ${row.statLabel ?? ''}`.trim(), player: row.playerName, game: row.away && row.home ? `${row.away} @ ${row.home}` : '',
      change, from, point: row.point, side: row.side, confidence, level,
      american: q?.american ?? null, book: q?.book ?? q?.bookKey ?? null, bookId: q ? idOf(q) : null, link: q?.link ?? null, rowId: row.id ?? null,
    };
  });
  const oneBook = best && legs.every((l) => l.manual || l.bookId === best.id);
  const decimal = legs.every((l) => Number.isFinite(l.american)) ? legs.reduce((d, l) => d * (l.american < 0 ? 1 + 100 / -l.american : 1 + l.american / 100), 1) : null;
  const american = decimal && decimal > 1 ? (decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1))) : null;
  return { legs, dropped, bookId: oneBook ? best.id : null, book: oneBook ? best.name : null, american, decimal, priced: decimal !== null };
}
