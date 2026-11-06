/**
 * Slip Check (2026-11-06: "importing slips where a user can upload a bet
 * and the app analyzes the percentage of each leg on its last 5, 10, 20
 * game hit rate and H2H, scores each leg 0-100 on confidence, an overall
 * rating for the parlay, lotto tickets called out, and suggestions: drop
 * a leg, move a line").
 *
 * The pure half: a slip's text into legs, a leg onto the data the app
 * already holds (the Trends rows and their game logs, a player's log from
 * the Players tab, the tennis legs, the odds), the hit rates at the
 * slip's own number, the confidence, the ticket's rating, and what to
 * change. No DOM, no network: docs/app.js feeds it and renders it.
 */
import { hitFlags, hitRate } from './trends.js';

/** Lowercase ASCII words. */
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[−–]/g, '-').replace(/[^a-z0-9+.-]+/g, ' ').replace(/\s+/g, ' ').trim();
const nameFold = (s) => fold(s).replace(/[+.\-]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The stat words a slip uses, to the app's stat keys by league. The first
 * league listed is the usual one; the match tries each until a player is
 * found under it.
 */
export const STAT_WORDS = [
  [/\b(pts|points)\s*\+\s*(reb|rebounds)\s*\+\s*(ast|assists)\b|\bpra\b|\bp\s*\+\s*r\s*\+\s*a\b/, { key: 'pra', label: 'Pts + Reb + Ast', leagues: ['basketball_nba'] }],
  [/\b(pts|points)\s*\+\s*(reb|rebounds)\b|\bp\s*\+\s*r\b/, { key: 'pr', label: 'Pts + Reb', leagues: ['basketball_nba'] }],
  [/\b(pts|points)\s*\+\s*(ast|assists)\b|\bp\s*\+\s*a\b/, { key: 'pa', label: 'Pts + Ast', leagues: ['basketball_nba'] }],
  [/\b(reb|rebounds)\s*\+\s*(ast|assists)\b|\br\s*\+\s*a\b/, { key: 'ra', label: 'Reb + Ast', leagues: ['basketball_nba'] }],
  [/\b(blk|blocks)\s*\+\s*(stl|steals)\b|\bstocks\b/, { key: 'stocks', label: 'Blk + Stl', leagues: ['basketball_nba'] }],
  [/\b(3pt|3-pt|3 pt|three|threes|3pm|3-pointers|3 pointers|three pointers|three-pointers|3s)( made)?\b/, { key: 'threes', label: 'Threes', leagues: ['basketball_nba'] }],
  [/\b(rebounds|rebs|reb)\b/, { key: 'rebounds', label: 'Rebounds', leagues: ['basketball_nba'] }],
  [/\b(assists|asts|ast)\b/, { key: 'assists', label: 'Assists', leagues: ['basketball_nba', 'icehockey_nhl', 'soccer'] }],
  [/\b(steals|stl)\b/, { key: 'steals', label: 'Steals', leagues: ['basketball_nba'] }],
  [/\b(blocks|blk)\b/, { key: 'blocks', label: 'Blocks', leagues: ['basketball_nba'] }],
  [/\b(turnovers|to)\b/, { key: 'turnovers', label: 'Turnovers', leagues: ['basketball_nba'] }],
  [/\b(passing|pass) (yards|yds)\b/, { key: 'passYds', label: 'Passing yards', leagues: ['americanfootball_nfl'] }],
  [/\b(rushing|rush) (yards|yds)\b/, { key: 'rushYds', label: 'Rushing yards', leagues: ['americanfootball_nfl'] }],
  [/\b(receiving|rec) (yards|yds)\b/, { key: 'recYds', label: 'Receiving yards', leagues: ['americanfootball_nfl'] }],
  [/\b(receptions|rec|catches)\b/, { key: 'receptions', label: 'Receptions', leagues: ['americanfootball_nfl'] }],
  [/\b(pass|passing) (completions|comp)\b|\bcompletions\b/, { key: 'passCompletions', label: 'Completions', leagues: ['americanfootball_nfl'] }],
  [/\b(pass|passing) (attempts|att)\b/, { key: 'passAttempts', label: 'Pass attempts', leagues: ['americanfootball_nfl'] }],
  [/\b(pass|passing) (tds|td|touchdowns)\b/, { key: 'passTds', label: 'Passing TDs', leagues: ['americanfootball_nfl'] }],
  [/\b(rush|rushing) (attempts|att)\b|\bcarries\b/, { key: 'rushAttempts', label: 'Rush attempts', leagues: ['americanfootball_nfl'] }],
  [/\b(shots on goal|sog)\b/, { key: 'shots', label: 'Shots on goal', leagues: ['icehockey_nhl'] }],
  [/\b(shots on target|sot)\b/, { key: 'shotsOnTarget', label: 'Shots on target', leagues: ['soccer'] }],
  [/\b(saves|sv)\b/, { key: 'saves', label: 'Saves', leagues: ['icehockey_nhl'] }],
  [/\bshots\b/, { key: 'shots', label: 'Shots', leagues: ['icehockey_nhl', 'soccer'] }],
  [/\b(goals|goal)\b/, { key: 'goals', label: 'Goals', leagues: ['icehockey_nhl', 'soccer'] }],
  [/\baces\b/, { key: 'aces', label: 'Aces', leagues: ['tennis'] }],
  [/\b(games won)\b/, { key: 'games_won', label: 'Games won', leagues: ['tennis'] }],
  [/\b(total games|games)\b/, { key: 'games_total', label: 'Total games', leagues: ['tennis'] }],
  [/\bsets\b/, { key: 'set_spread', label: 'Sets', leagues: ['tennis'] }],
  [/\b(pts|points)\b/, { key: 'points', label: 'Points', leagues: ['basketball_nba', 'icehockey_nhl'] }],
];
/** Lines on a slip that are not legs. */
const NOISE = /^(parlay|same game parlay|sgp|wager|stake|risk|to win|win|payout|potential payout|total odds|odds|bet|boost|profit boost|cash out|placed|share|bet id|power play|flex play|entry|lineup|settled|open|pending)\b.*$|^\$?\d+(\.\d+)?$|^[+-]\d{3,5}$|^\d+ ?(legs?|picks?)\b.*$|^\d+-leg.*$|^.*\d{1,2}:\d{2}\s*(am|pm)?.*$/i;
const TEAM_WORDS = /\b(ml|moneyline|money line|to win|spread|total|team total|puck line|run line|handicap|both teams|btts|draw)\b/i;

/** American odds in a line: "+105", "-115", "(−118)"; the last one on the line, which is the leg's price when a combined price heads the slip. */
export function parseAmerican(text) {
  const all = [...String(text).replace(/[−–]/g, '-').matchAll(/(?:^|[\s(@])([+-]\d{3,5})(?![\d.])/g)].map((m) => Number(m[1]));
  const n = all.at(-1);
  return Number.isFinite(n) && Math.abs(n) >= 100 ? n : null;
}

/**
 * One slip line into a leg: {raw, selection, american, kind ('prop' |
 * 'team' | 'total' | 'unknown'), player, stat ({key, label, leagues} or
 * null), side ('over' | 'under' | null), point, team}. The forms a slip
 * takes: "Jayson Tatum Over 27.5 Points -115", "Tatum O 27.5 Pts",
 * "Jayson Tatum 25+ Points" (25 or more: over 24.5), "Points: Over 27.5
 * Jayson Tatum", "Lakers ML", "Lakers -3.5", "Over 224.5", "Lakers/Celtics
 * Over 224.5", PrizePicks' "More 27.5 Points".
 */
export function parseLeg(line, structured = null) {
  const raw = String(line ?? '').trim();
  if (!raw || NOISE.test(raw)) return null;
  const american = structured?.american ?? parseAmerican(raw);
  let text = raw.replace(/[−–]/g, '-').replace(/(?:^|[\s(@])[+-]\d{3,5}(?![\d.])\)?\s*$/, '').replace(/\(\s*[+-]\d{3,5}\s*\)/g, '').trim();
  text = text.replace(/\s*[-–]\s*(?:sgp|same game parlay|boosted?)\s*$/i, '').trim();
  const f = fold(text);
  let side = null; let point = null;
  // "over 27.5", "o 27.5", "o27.5", "more 27.5", "27.5 or more", "25+".
  let m = f.match(/\b(over|under|o|u|more|less|more than|less than|at least)\s*(\d+(?:\.\d+)?)\b/);
  if (m) { side = /^(over|o|more|more than|at least)$/.test(m[1]) ? 'over' : 'under'; point = Number(m[2]); if (m[1] === 'at least' || m[1] === 'more than') point = m[1] === 'more than' ? point : Math.ceil(point) - 0.5; }
  if (!m) { m = f.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*(?:\+|or more|plus)(?=\s|$)/); if (m) { side = 'over'; point = Number(m[1]) - 0.5; } }
  if (!m) { m = f.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*(?:or fewer|or less)(?=\s|$)/); if (m) { side = 'under'; point = Number(m[1]) + 0.5; } }
  if (!m) { m = f.match(/\b(\d+(?:\.\d+)?)\s+(over|under)\b/); if (m) { side = m[2]; point = Number(m[1]); } }
  let stat = null;
  for (const [re, def] of STAT_WORDS) { if (re.test(f)) { stat = def; break; } }
  if (structured?.stat) { const sf = fold(structured.stat); for (const [re, def] of STAT_WORDS) { if (re.test(sf)) { stat = def; break; } } }
  if (structured?.side) side = /under|less/i.test(structured.side) ? 'under' : /over|more/i.test(structured.side) ? 'over' : side;
  if (Number.isFinite(Number(structured?.line))) point = Number(structured.line);
  // A spread: "Lakers -3.5", "Lakers +6", "Fritz +3.5 games" when no over/under word.
  const spread = !side ? f.match(/(?:^|\s)([+-]\d+(?:\.\d+)?)(?=\s|$)/) : null;
  const teamish = TEAM_WORDS.test(f) || (!stat && !side && Boolean(spread));
  // The player: the words left once the number, the side and the stat are gone.
  let player = structured?.player ? nameFold(structured.player) : null;
  if (!player) {
    let rest = f;
    if (m) rest = rest.replace(m[0], ' ');
    for (const [re] of STAT_WORDS) rest = rest.replace(re, ' ');
    rest = rest.replace(/\b(over|under|more|less|o|u|alt|alternate|player|props?|made|total|totals|first|1st|half|quarter|qtr|period|anytime|to record|to score|ml|moneyline|money line|to win|spread|puck line|run line|handicap)\b/g, ' ').replace(/(?:^|\s)[+-]?\d+(?:\.\d+)?(?=\s|$)/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/[+.:\-]/g, ' ').replace(/\s+/g, ' ').trim();
    player = rest;
  }
  const isTotal = /\b(over|under)\b/.test(f) && !stat && (!player || /\//.test(text) || /\b(total|game total)\b/.test(f));
  const kind = isTotal ? 'total' : teamish && !stat ? 'team' : stat && point != null && side ? 'prop' : stat && side ? 'prop' : spread ? 'team' : 'unknown';
  return { raw, selection: text || raw, american, kind, player: kind === 'prop' ? player : null, team: kind !== 'prop' ? (structured?.team ? nameFold(structured.team) : player) : null, stat, side: kind === 'team' ? null : side, point: kind === 'team' && spread ? Number(spread[1]) : point, structured: Boolean(structured) };
}

/** Every leg in pasted text, one per line. */
export function parseSlipText(text) {
  return String(text ?? '').split(/\r?\n/).map((l) => parseLeg(l)).filter(Boolean);
}

/** Whether a slip name fits a data name: the same, or the surname with the first initial, or one contains the other. */
export function sameName(a, b) {
  const x = nameFold(a); const y = nameFold(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const xa = x.split(' '); const ya = y.split(' ');
  const sx = xa.at(-1); const sy = ya.at(-1);
  return sx === sy && sx.length >= 3 && xa[0][0] === ya[0][0];
}

/** Whether any word of the slip's team text (four letters and up) is in the data's team name. */
export const teamFits = (name, text) => { const n = nameFold(name); return nameFold(text).split(' ').some((w) => w.length >= 4 && n.includes(w)); };

/** The hit rates at the slip's number over a game log ([{value, opponent}], newest first): {l5, l10, l20, h2h, n}. */
export function ratesAt(rows, point, side, { opponent = null } = {}) {
  const flags = hitFlags(rows ?? [], point, side);
  const at = (n) => { const slice = flags.slice(0, n); const counted = slice.filter((f) => f !== null); return counted.length ? { rate: hitRate(flags, n), hits: counted.reduce((s, f) => s + f, 0), games: counted.length } : null; };
  const h2hRows = opponent ? (rows ?? []).map((r, i) => [r, flags[i]]).filter(([r]) => r.opponent && String(r.opponent).toUpperCase() === String(opponent).toUpperCase()) : [];
  const h2hFlags = h2hRows.map(([, f]) => f).filter((f) => f !== null);
  return { l5: at(5), l10: at(10), l20: at(20), h2h: h2hFlags.length ? { rate: Math.round((h2hFlags.reduce((s, f) => s + f, 0) / h2hFlags.length) * 1000) / 1000, hits: h2hFlags.reduce((s, f) => s + f, 0), games: h2hFlags.length } : null, n: (rows ?? []).length };
}

export const impliedOf = (american) => (!Number.isFinite(american) ? null : american < 0 ? -american / (-american + 100) : 100 / (american + 100));
export const decimalOf = (american) => (!Number.isFinite(american) ? null : american < 0 ? 1 + 100 / -american : 1 + american / 100);
export const americanOf = (decimal) => (!Number.isFinite(decimal) || decimal <= 1 ? null : decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1)));

/**
 * One leg's confidence, 0 to 100, from its hit rates: the last 20 weighs
 * most, then the last 10, the last 5 and the head-to-head; a thin log
 * counts for less; an injury listing cuts it; the price, when the slip
 * carries one, is a quarter of the read. Returns {confidence, prob, parts,
 * notes, warnings, source}.
 */
export function scoreLeg(leg, match) {
  const notes = []; const warnings = [];
  const implied = impliedOf(leg.american);
  const vig = implied != null ? Math.min(0.97, implied * 0.96) : null;
  if (!match || match.source === 'none') {
    if (vig != null) return { confidence: Math.round(vig * 100), prob: vig, parts: { implied }, notes: ['No game log matched this leg: the price alone sets this number.'], warnings: ['Unmatched: check the player, stat and league spelling.'], source: 'market' };
    return { confidence: null, prob: null, parts: {}, notes: [], warnings: ['No game log matched this leg and it carries no price, so it is not scored.'], source: 'none' };
  }
  if (match.source === 'market') {
    const p = match.prob ?? vig;
    return { confidence: p != null ? Math.round(p * 100) : null, prob: p, parts: { implied, market: match.prob ?? null }, notes: [match.note ?? 'A team line: the market price sets this number; the hit-rate model reads player props.'], warnings: [], source: 'market' };
  }
  if (match.source === 'tennis') {
    const p = match.prob;
    const cons = match.consistency;
    return { confidence: Math.round(p * 100), prob: p, parts: { model: p, implied, l10: cons ? { rate: cons.rate, hits: cons.hits, games: cons.n } : null }, notes: [...(match.why ?? []).slice(0, 2), cons ? `Last ${cons.n}: ${Math.round(cons.rate * 100)}% at ${cons.line}` : null].filter(Boolean), warnings: (match.flags ?? []).map((f) => `${match.name ?? 'The player'} is flagged for ${f}.`), source: 'tennis' };
  }
  const r = match.rates;
  const parts = [[r.l20?.rate, 0.35, r.l20], [r.l10?.rate, 0.3, r.l10], [r.l5?.rate, 0.15, r.l5], [r.h2h && r.h2h.games >= 2 ? r.h2h.rate : null, 0.2, r.h2h]].filter(([x]) => x != null && Number.isFinite(x));
  if (!parts.length) return { confidence: vig != null ? Math.round(vig * 100) : null, prob: vig, parts: { implied }, notes: ['The game log carries no games at this number yet.'], warnings: [], source: match.source };
  const w = parts.reduce((s, [, x]) => s + x, 0);
  let base = parts.reduce((s, [x, wt]) => s + x * wt, 0) / w;
  const games = r.l20?.games ?? 0;
  if (games < 5) { base *= 0.6; warnings.push(`Only ${games} game${games === 1 ? '' : 's'} on the log: a thin read.`); }
  else if (games < 10) { base *= 0.85; notes.push(`${games} games on the log; the read firms up past ten.`); }
  const inj = match.injury;
  if (inj?.level === 'out') { warnings.push(`${match.name} is listed OUT${inj.detail ? ` (${inj.detail})` : ''}: this leg loses or voids.`); base = 0.05; }
  else if (inj?.level === 'doubtful') { warnings.push(`${match.name} is doubtful${inj.detail ? ` (${inj.detail})` : ''}.`); base *= 0.6; }
  else if (inj?.level === 'questionable') { warnings.push(`${match.name} is questionable${inj.detail ? ` (${inj.detail})` : ''}.`); base -= 0.1; }
  let p = vig != null ? 0.75 * base + 0.25 * vig : base;
  p = Math.max(0.02, Math.min(0.98, p));
  const say = (k, label) => (r[k] ? `${label} ${Math.round(r[k].rate * 100)}% (${r[k].hits} of ${r[k].games})` : null);
  notes.push([say('l5', 'L5'), say('l10', 'L10'), say('l20', 'L20'), r.h2h ? `vs ${match.opponent ?? 'opp'} ${Math.round(r.h2h.rate * 100)}% (${r.h2h.hits} of ${r.h2h.games})` : null].filter(Boolean).join(' · '));
  if (match.avg != null) notes.push(`Averages ${match.avg} over the last ${Math.min(10, games)}; the line sits ${leg.point > match.avg ? 'above' : 'below'} it by ${Math.abs(Math.round((leg.point - match.avg) * 10) / 10)}.`);
  const fixable = !inj?.level && leg.point != null && leg.side && (r.l20?.rate ?? 0) < 0.8 && betterLines(match.rows ?? [], leg.point, leg.side).length > 0;
  return { confidence: Math.round(p * 100), prob: p, parts: { l5: r.l5, l10: r.l10, l20: r.l20, h2h: r.h2h, implied }, notes, warnings, source: match.source, fixable };
}

/**
 * The ticket: the chance every leg lands (the legs read as independent),
 * the combined price (the legs' own, else the slip's, else the fair price
 * from the chance), the strength (the geometric mean of the confidences),
 * a grade A to F, and the category: a straight, a parlay, a long shot
 * (+500 and up) or a lotto ticket (+1500 and up, or six legs and more).
 */
/**
 * The ticket types (2026-11-06: "toggle on if this is a builder, regular,
 * or lotto type ticket ... grade and recommend different things"):
 *   builder  legs built for profit, ideally four or fewer, six at most; every leg has to clear
 *            BUILDER_BAR or be fixed (a lower number, a different leg) or the play is off
 *   regular  one to six legs of varied risk and a decent payout; drop a leg or two to find the profit
 *   lotto    high risk for a high payout, two legs or more or very long legs; one soft leg is
 *            the one to drop, the rest can stand
 */
export const TICKET_TYPES = {
  builder: { label: 'Builder', legs: [2, 6], ideal: 4, bar: 70, blurb: 'Legs picked to hit: four or fewer ideally, six at most. Every leg has to clear the bar or get fixed, or the play is off.' },
  regular: { label: 'Regular', legs: [1, 6], ideal: 4, bar: 55, blurb: 'One to six legs of varied risk with a decent payout. A leg or two may come off to find the profit.' },
  lotto: { label: 'Lotto', legs: [2, 20], ideal: 6, bar: 45, blurb: 'High risk for a high payout: two legs or more, or very long odds. One soft leg gets named; the rest can stand.' },
};
export const BUILDER_BAR = 70;
export const REGULAR_BAR = 55;
export const LOTTO_BAR = 45;

/** The ticket's verdict for its type: {state: 'play' | 'fix' | 'pass', title, text}. */
export function verdictFor(type, scored, slip) {
  const spec = TICKET_TYPES[type];
  if (!spec) return null;
  const known = scored.filter((s) => s.score.confidence != null);
  const weak = known.filter((s) => s.score.confidence < spec.bar);
  const unread = scored.length - known.length;
  const n = scored.length;
  if (type === 'builder') {
    if (n > spec.legs[1]) return { state: 'pass', title: 'Too many legs for a builder', text: `${n} legs: a builder is four legs ideally and six at most. Cut it to the strongest four to six before anything else.` };
    if (!weak.length && !unread && (slip.edge == null || slip.edge >= -2)) return { state: 'play', title: n > spec.ideal ? 'Make the play, but it is long for a builder' : 'Make the play', text: `Every leg clears ${spec.bar}% on its log${n > spec.ideal ? `; ${n} legs is past the ideal four, so the payout is carrying more risk than a builder should` : ''}. ${slip.lands != null ? `About ${Math.round(slip.lands * 100)}% to land` : ''}${slip.edge != null ? `, ${slip.edge >= 0 ? '+' : ''}${slip.edge} points against the price` : ''}.` };
    const fixable = weak.filter((s) => s.score.fixable);
    const good = known.length - weak.length;
    if (good + fixable.length >= 2 && (weak.length - fixable.length) <= 1) return { state: 'fix', title: 'Fix it before you play it', text: `${weak.length + unread} leg${weak.length + unread === 1 ? ' does' : 's do'} not clear ${spec.bar}%${unread ? ` (${unread} with no read)` : ''}. ${fixable.length ? `${fixable.length} can move to a number the player clears; ` : ''}the rest come off or get replaced with the legs below. Play it only once every leg clears.` };
    return { state: 'pass', title: 'Do not make this play', text: `${weak.length} of ${known.length} read legs sit under ${spec.bar}%${unread ? ` and ${unread} found no log` : ''}: there is no value here as built. Start again from the replacement legs below, or pick a different ticket.` };
  }
  if (type === 'regular') {
    if (n > spec.legs[1]) return { state: 'fix', title: 'Long for a regular ticket', text: `${n} legs: a regular ticket runs one to six. Cut to the six strongest, or call it a lotto.` };
    if (!weak.length && (slip.edge == null || slip.edge >= 0)) return { state: 'play', title: 'Playable as it is', text: `No leg under ${spec.bar}% and the price is fair${slip.edge != null ? ` (${slip.edge >= 0 ? '+' : ''}${slip.edge} points)` : ''}.` };
    if (weak.length <= 2) return { state: 'fix', title: `Trim ${weak.length === 1 ? 'one leg' : 'two legs'} to find the profit`, text: `${weak.map((s) => s.leg.selection).join(' and ')} ${weak.length === 1 ? 'reads' : 'read'} under ${spec.bar}%. The ticket without ${weak.length === 1 ? 'it' : 'them'} is below.` };
    return { state: 'pass', title: 'Too many soft legs', text: `${weak.length} legs read under ${spec.bar}%: trimming would leave a different ticket. Rebuild it from the legs that clear.` };
  }
  // Lotto.
  const lottoish = slip.category === 'lotto' || slip.category === 'long shot' || (slip.combined != null && slip.combined >= 500) || n >= 5;
  if (weak.length === 0) return { state: 'play', title: lottoish ? 'A sound lotto' : 'Sound, but not priced like a lotto', text: lottoish ? `No leg reads under ${spec.bar}%: every leg is defensible for a long-odds ticket${slip.lands != null ? `, about ${slip.lands * 100 < 1 ? 'under 1' : Math.round(slip.lands * 100)}% to land` : ''}. Stake what you would not miss.` : `Every leg holds up, but at ${slip.combined != null ? `${slip.combined > 0 ? '+' : ''}${slip.combined}` : 'these odds'} this is a regular ticket, not a lotto: either add the long legs or grade it as regular.` };
  if (weak.length === 1) return { state: 'fix', title: 'One leg to drop, the rest is sound', text: `${weak[0].leg.selection} (${weak[0].score.confidence}%) is the leg to drop. Everything else holds up for a lotto ticket.` };
  return { state: 'pass', title: 'Too many soft legs, even for a lotto', text: `${weak.length} legs read under ${spec.bar}% (${weak.map((s) => s.leg.selection).join(', ')}). A lotto can carry one, not ${weak.length}: drop them and the ticket is a different one.` };
}

export function scoreSlip(scored, { combinedAmerican = null, type = null } = {}) {
  const known = scored.filter((s) => s.score.confidence != null);
  const lands = known.length ? known.reduce((p, s) => p * s.score.prob, 1) : null;
  const strength = known.length ? Math.round(Math.exp(known.reduce((s, x) => s + Math.log(Math.max(1, x.score.confidence)), 0) / known.length)) : null;
  const allPriced = scored.length && scored.every((s) => Number.isFinite(s.leg.american));
  const legsDecimal = allPriced ? scored.reduce((d, s) => d * decimalOf(s.leg.american), 1) : null;
  const combined = scored.length === 1 && Number.isFinite(scored[0].leg.american) ? scored[0].leg.american : legsDecimal ? americanOf(legsDecimal) : combinedAmerican ?? (lands ? americanOf(1 / lands) : null);
  const fair = lands ? americanOf(1 / lands) : null;
  const weakest = known.length ? [...known].sort((a, b) => a.score.confidence - b.score.confidence)[0] : null;
  const grade = strength == null ? null : strength >= 75 ? 'A' : strength >= 65 ? 'B' : strength >= 55 ? 'C' : strength >= 45 ? 'D' : 'F';
  const category = scored.length === 1 ? 'straight' : (combined != null && combined >= 1500) || scored.length >= 6 ? 'lotto' : combined != null && combined >= 500 ? 'long shot' : 'parlay';
  const edge = lands != null && combined != null ? Math.round((lands - 1 / decimalOf(combined)) * 1000) / 10 : null;
  const slip = { legs: scored.length, known: known.length, lands: lands != null ? Math.round(lands * 1000) / 1000 : null, combined, fair, strength, grade, category, weakest: weakest ? scored.indexOf(weakest) : null, edge, type: TICKET_TYPES[type] ? type : null };
  slip.verdict = slip.type ? verdictFor(slip.type, scored, slip) : null;
  return slip;
}

export const CATEGORY_LABEL = { straight: 'Straight bet', parlay: 'Parlay', 'long shot': 'Long shot', lotto: 'Lotto ticket' };

/** The other number for a prop: the lines around the slip's at which the last 20 clear 80%, nearest first. */
export function betterLines(rows, point, side, { bar = 0.8, steps = 8 } = {}) {
  const step = Number.isInteger(point * 2) && !Number.isInteger(point) ? 1 : 1;
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const p = side === 'over' ? point - i * step : point + i * step;
    if (p < 0.5) break;
    const r = ratesAt(rows, p, side).l20;
    if (r && r.rate >= bar) { out.push({ point: p, rate: r.rate, hits: r.hits, games: r.games }); break; }
  }
  return out;
}

/**
 * What to do about the ticket: drop the weakest legs (with the ticket's
 * chance and price without them), move a line to a number the player
 * clears, flip a side the log runs the other way, mind an injury, mind two
 * legs off one game, and call a lotto a lotto. Each: {type, text, legs?}.
 */
/**
 * Replacement legs off the Trends board for a builder: the same league
 * (the same game first), a player not already on the ticket, the last 20
 * and the last 10 at 80% or better, no injury listing, priced; the
 * user's books first for the link. [{selection, player, rate, l10,
 * american, book, bookId, link, game}].
 */
export function replacementsFor(scored, data, { books = [], limit = 3, forLeg = null, exclude = new Set() } = {}) {
  const taken = new Set([...scored.map((s) => nameFold(s.match?.name ?? s.leg.player ?? '')).filter(Boolean), ...exclude]);
  const leagues = forLeg?.match?.sportKey ? [forLeg.match.sportKey] : [...new Set(scored.map((s) => s.match?.sportKey).filter(Boolean))];
  const game = forLeg?.match?.gameId ?? null;
  const out = [];
  for (const sportKey of leagues.length ? leagues : Object.keys(data.trendsRows ?? {})) {
    for (const r of data.trendsRows?.[sportKey] ?? []) {
      if (!r.periods?.l20 || r.periods.l20.rate < 0.8 || (r.periods.l10?.rate ?? 0) < 0.8 || (r.periods.l20.games ?? 0) < 10) continue;
      if (r.injury?.level) continue;
      if (taken.has(nameFold(r.playerName))) continue;
      if (!(r.commenceMs > Date.now())) continue;
      const quotes = (r.quotes ?? []).filter((q) => Number.isFinite(q.american));
      const mine = quotes.filter((q) => books.includes(q.bookKey) || books.includes(q.bookId));
      const q = [...(mine.length ? mine : quotes)].sort((x, y) => y.american - x.american)[0];
      if (!q) continue;
      out.push({ selection: r.selection ?? `${r.playerName} ${r.side} ${r.point} ${r.marketLabel ?? r.statLabel ?? ''}`.trim(), player: r.playerName, rate: r.periods.l20.rate, l10: r.periods.l10?.rate ?? null, american: q.american, book: q.book ?? q.bookKey, bookId: q.bookId ?? q.bookKey ?? null, link: q.link ?? null, game: `${r.away ?? ''} @ ${r.home ?? ''}`, sameGame: game != null && r.eventId === game, rowId: r.id ?? null });
    }
  }
  const seen = new Set();
  return out.sort((a, b) => Number(b.sameGame) - Number(a.sameGame) || b.rate - a.rate || (b.l10 ?? 0) - (a.l10 ?? 0)).filter((x) => { const k = nameFold(x.player); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit);
}

export function suggestions(scored, slip, { data = {}, books = [] } = {}) {
  const out = [];
  const type = slip.type ?? null;
  const spec = TICKET_TYPES[type] ?? null;
  const bar = spec?.bar ?? REGULAR_BAR;
  const known = scored.filter((s) => s.score.confidence != null);
  for (const s of scored) for (const w of s.score.warnings ?? []) out.push({ type: /OUT|doubtful|questionable|flagged/i.test(w) ? 'injury' : 'warn', text: `${s.leg.selection}: ${w}`, legs: [scored.indexOf(s)] });
  // The legs under the type's bar, weakest first; what each can move to.
  const weak = known.filter((s) => s.score.confidence < bar).sort((a, b) => a.score.confidence - b.score.confidence);
  const moveFor = (s) => { const m = s.match; if (!m?.rows?.length || s.leg.point == null || !s.leg.side) return null; const here = m.rates?.l20; if (here && here.rate >= 0.8) return null; const better = betterLines(m.rows, s.leg.point, s.leg.side); return better.length ? { ...better[0], here } : null; };
  const flipFor = (s) => { const m = s.match; if (!m?.rows?.length || s.leg.point == null || !s.leg.side) return null; const here = m.rates?.l20; const flip = ratesAt(m.rows, s.leg.point, s.leg.side === 'over' ? 'under' : 'over').l20; return here && flip && flip.rate >= 0.7 && here.rate <= 0.4 ? flip : null; };
  const withoutText = (s) => { const rest = scored.filter((x) => x !== s); if (!rest.length) return 'it is the only leg: a pass, or a smaller stake'; const w = scoreSlip(rest, { combinedAmerican: null }); return `the ticket without it lands ${w.lands != null ? `${Math.round(w.lands * 100)}%` : 'more often'}${w.combined != null ? ` at about ${w.combined > 0 ? '+' : ''}${w.combined}` : ''}${slip.lands != null ? `, from ${Math.round(slip.lands * 100)}%` : ''}`; };
  if (type === 'builder') {
    // Strict: every leg under the bar moves to a number that clears, or comes off for a replacement with its price and link.
    const offered = new Set();
    for (const s of weak) {
      const mv = moveFor(s);
      if (mv) { out.push({ type: 'move', text: `Lower ${s.match.name} ${s.leg.side} ${s.leg.point} to ${s.leg.side} ${mv.point}: the last 20 clear it ${Math.round(mv.rate * 100)}% (${mv.hits} of ${mv.games}) against ${mv.here ? `${Math.round(mv.here.rate * 100)}%` : 'less'} at ${s.leg.point}. Take the alternate line where the book prices it.`, legs: [scored.indexOf(s)] }); continue; }
      const reps = replacementsFor(scored, data, { books, forLeg: s, exclude: offered });
      for (const r of reps) offered.add(nameFold(r.player));
      const why = s.score.source === 'market' ? `a team line reads from its price alone (${s.score.confidence}%), and a builder wants legs with a log behind them` : s.score.source === 'none' ? 'it found no game log to read' : 'no number on its log clears the bar';
      out.push({ type: 'replace', text: `Take ${s.leg.selection} (${s.score.confidence}%) off: ${why}${reps.length ? '. In its place, the legs below clear 80% of their last 20 and last 10' : offered.size ? '. The legs offered above are the board\'s best today' : ', and nothing on the board today replaces it'}.`, legs: [scored.indexOf(s)], props: reps });
    }
    for (const s of scored) { const f = flipFor(s); if (f) out.push({ type: 'flip', text: `${s.match.name} ${s.leg.side} ${s.leg.point} runs the wrong way: the ${s.leg.side === 'over' ? 'under' : 'over'} lands ${Math.round(f.rate * 100)}% of the last 20.`, legs: [scored.indexOf(s)] }); }
    if (scored.length > TICKET_TYPES.builder.legs[1]) { const keep = [...known].sort((a, b) => b.score.confidence - a.score.confidence).slice(0, TICKET_TYPES.builder.ideal); out.push({ type: 'drop', text: `Cut to the strongest ${keep.length}: ${keep.map((s) => s.leg.selection).join(', ')}.`, legs: keep.map((s) => scored.indexOf(s)) }); }
    if (!weak.length && slip.edge != null && slip.edge < -2) out.push({ type: 'drop', text: `The legs hold but the price does not: ${slip.edge} points under fair. Shop the price, or it is not a builder worth making.` });
    if (slip.verdict?.state === 'pass') { const reps = replacementsFor(scored, data, { books, limit: 4, exclude: offered }); if (reps.length) out.push({ type: 'replace', text: 'A builder from the board instead: the legs clearing 80% of their last 20 and last 10 today.', props: reps }); }
  } else if (type === 'lotto') {
    if (weak.length === 1) { const s = weak[0]; const mv = moveFor(s); out.push({ type: 'drop', text: `This is the leg to drop: ${s.leg.selection} (${s.score.confidence}%)${mv ? `, or lower it to ${s.leg.side} ${mv.point} where the last 20 clear ${Math.round(mv.rate * 100)}%` : ''}; ${withoutText(s)}. Everything else is sound.`, legs: [scored.indexOf(s)] }); }
    else if (weak.length > 1) for (const s of weak) out.push({ type: 'drop', text: `${s.leg.selection} reads ${s.score.confidence}%: ${withoutText(s)}.`, legs: [scored.indexOf(s)] });
    for (const s of scored) { const f = flipFor(s); if (f) out.push({ type: 'flip', text: `${s.match.name} ${s.leg.side} ${s.leg.point} runs the wrong way: the ${s.leg.side === 'over' ? 'under' : 'over'} lands ${Math.round(f.rate * 100)}% of the last 20.`, legs: [scored.indexOf(s)] }); }
    if (slip.verdict?.state === 'play' && /not priced/.test(slip.verdict.title)) out.push({ type: 'lotto', text: 'To make it a lotto worth the name, add a long leg or two or take the alternate numbers; as it stands grade it as a regular ticket.' });
  } else {
    // Regular (and no type): one or two legs to drop, lines to move, sides to flip.
    for (const s of weak.slice(0, 2)) out.push({ type: 'drop', text: `Drop ${s.leg.selection} (${s.score.confidence}%): ${withoutText(s)}.`, legs: [scored.indexOf(s)] });
    for (const s of scored) {
      const mv = moveFor(s);
      if (mv) out.push({ type: 'move', text: `Move ${s.match.name} ${s.leg.side} ${s.leg.point} to ${s.leg.side} ${mv.point}: the last 20 clear it ${Math.round(mv.rate * 100)}% (${mv.hits} of ${mv.games}) against ${mv.here ? `${Math.round(mv.here.rate * 100)}%` : 'less'} at ${s.leg.point}. Take the alternate line where the book prices it.`, legs: [scored.indexOf(s)] });
      const f = flipFor(s);
      if (f) out.push({ type: 'flip', text: `${s.match.name} ${s.leg.side} ${s.leg.point} runs the wrong way: the ${s.leg.side === 'over' ? 'under' : 'over'} lands ${Math.round(f.rate * 100)}% of the last 20.`, legs: [scored.indexOf(s)] });
    }
    if (scored.length > TICKET_TYPES.regular.legs[1]) out.push({ type: 'drop', text: `${scored.length} legs is past a regular ticket's six: cut to the strongest six or grade it as a lotto.` });
    if (!type && slip.category === 'lotto') out.push({ type: 'lotto', text: `A lotto ticket: ${slip.lands != null ? `about ${slip.lands * 100 < 1 ? 'under 1' : Math.round(slip.lands * 100)}% to land` : 'long odds'}${slip.combined != null ? ` at +${slip.combined}` : ''}. Stake what you would not miss; the ${Math.min(3, known.length)} strongest legs as their own ticket is the version worth real money.` });
  }
  // Two legs off one game.
  const byGame = new Map();
  for (const s of scored) { const g = s.match?.gameId; if (!g) continue; if (!byGame.has(g)) byGame.set(g, []); byGame.get(g).push(scored.indexOf(s)); }
  for (const [, idx] of byGame) if (idx.length > 1) out.push({ type: 'same-game', text: `${idx.length} legs come off the same game: a book prices them as a same-game parlay, and one team's blowout or a benching moves them together.`, legs: idx });
  const unmatched = scored.filter((s) => s.score.source === 'none' || (s.score.source === 'market' && s.leg.kind === 'prop'));
  if (unmatched.length) out.push({ type: 'unmatched', text: `${unmatched.length} leg${unmatched.length === 1 ? '' : 's'} found no game log (${unmatched.map((s) => s.leg.selection).join('; ')}): the player may be off the board today, or the name and stat need the spelling the app uses.${type === 'builder' ? ' A builder does not carry a leg it cannot read.' : ''}`, legs: unmatched.map((s) => scored.indexOf(s)) });
  if (!out.length && known.length) out.push({ type: 'ok', text: slip.verdict?.state === 'play' ? slip.verdict.text : slip.grade === 'A' || slip.grade === 'B' ? 'Nothing to change: every leg clears the bar on its log.' : 'No single leg stands out to drop; the ticket is as strong as its weakest leg.' });
  return out;
}

/**
 * The best data for a leg among what the app holds:
 *   trends: a Trends row for the player and stat (its series is the log, its opponent the game)
 *   player: a Players-tab log ({rows, player}) when the player is off the board
 *   tennis: a tennis builder leg (model share and consistency)
 *   market: a team line priced on the slate, or the leg's own price
 * Returns {source, name, rows, rates, opponent, injury, avg, gameId, sportKey, ...}.
 */
export function matchLeg(leg, { trendsRows = {}, playerLogs = {}, tennisLegs = [], slateGames = [] } = {}) {
  if (leg.kind === 'prop' && leg.stat) {
    if (leg.stat.leagues.includes('tennis') || leg.stat.key === 'aces') {
      const t = tennisLegs.find((l) => l.name && sameName(l.name, leg.player) && (l.market === leg.stat.key || (leg.stat.key === 'games_total' && l.market === 'games_total') || (leg.stat.key === 'set_spread' && l.market === 'set_spread')) && (leg.point == null || l.point === leg.point || l.market === 'ml'));
      if (t) return { source: 'tennis', name: t.name, prob: t.prob, consistency: t.consistency, flags: t.flags, why: t.why, gameId: t.matchId, sportKey: 'tennis' };
    }
    for (const sportKey of leg.stat.leagues) {
      const rows = (trendsRows[sportKey] ?? []).filter((r) => r.statKey === leg.stat.key && sameName(r.playerName, leg.player));
      if (rows.length) {
        const row = rows[0];
        const log = (row.series ?? []).map((g) => ({ value: g.value, opponent: g.opponent ?? null, date: g.date ?? null }));
        const rates = ratesAt(log, leg.point ?? row.point, leg.side ?? row.side, { opponent: row.opponent });
        const last = log.slice(0, 10).map((g) => g.value).filter((v) => Number.isFinite(v));
        return { source: 'trends', name: row.playerName, rows: log, rates, opponent: row.opponent ?? null, injury: row.injury ?? null, avg: last.length ? Math.round((last.reduce((s, v) => s + v, 0) / last.length) * 10) / 10 : null, gameId: row.eventId ?? null, sportKey, row, team: row.team ?? null };
      }
      const pl = playerLogs[`${sportKey}:${leg.stat.key}:${nameFold(leg.player)}`];
      if (pl?.rows?.length) {
        const log = pl.rows.map((g) => ({ value: g.value, opponent: g.opponent ?? null, date: g.date ?? null }));
        const rates = ratesAt(log, leg.point, leg.side, { opponent: pl.opponent ?? null });
        const last = log.slice(0, 10).map((g) => g.value).filter((v) => Number.isFinite(v));
        const inj = pl.player?.injury ?? null;
        return { source: 'player', name: pl.player?.name ?? leg.player, rows: log, rates, opponent: pl.opponent ?? null, injury: inj, avg: last.length ? Math.round((last.reduce((s, v) => s + v, 0) / last.length) * 10) / 10 : null, gameId: pl.gameId ?? null, sportKey, team: pl.player?.team ?? null };
      }
    }
    return { source: 'none' };
  }
  if (leg.kind === 'team' || leg.kind === 'total') {
    // A tennis moneyline or spread by player name.
    const t = tennisLegs.find((l) => l.name && leg.team && sameName(l.name, leg.team) && (leg.kind === 'team' ? (leg.point == null ? l.market === 'ml' : l.market === 'games_spread' && l.point === leg.point) : false));
    if (t) return { source: 'tennis', name: t.name, prob: t.prob, consistency: t.consistency, flags: t.flags, why: t.why, gameId: t.matchId, sportKey: 'tennis' };
    for (const g of slateGames) {
      const market = leg.kind === 'total' ? 'totals' : leg.point != null ? 'spreads' : 'h2h';
      const sides = g[market] ?? {};
      for (const side of ['away', 'home']) {
        const c = sides[side]; if (!c) continue;
        const name = g[side] ?? '';
        const hit = leg.kind === 'total' ? (leg.side && new RegExp(`\\b${leg.side}\\b`, 'i').test(c.selection ?? '') && (leg.point == null || c.point === leg.point) && (!leg.team || teamFits(g.away, leg.team) || teamFits(g.home, leg.team))) : leg.team && (sameName(name, leg.team) || teamFits(name, leg.team) || sameName(c.selection ?? '', leg.team)) && (leg.point == null || c.point === leg.point);
        if (!hit) continue;
        const other = sides[side === 'away' ? 'home' : 'away'];
        const p = impliedOf(c.american); const q = other ? impliedOf(other.american) : null;
        const prob = p != null && q != null ? p / (p + q) : p != null ? Math.min(0.97, p * 0.96) : null;
        return { source: 'market', prob, note: `${c.selection} at ${c.american > 0 ? '+' : ''}${c.american} on the slate: ${Math.round((prob ?? 0) * 100)}% by the de-vigged price; team lines are priced, not hit-rated.`, gameId: g.id ?? `${g.away}@${g.home}`, sportKey: g.sportKey ?? null };
      }
    }
    return { source: 'market', prob: null, note: 'A team line: the hit-rate model reads player props, so the price sets this number.' };
  }
  return { source: 'none' };
}

/** The whole read: legs matched, scored, the ticket graded, the suggestions. */
export function checkSlip(legs, data, { combinedAmerican = null, type = null, books = [] } = {}) {
  const scored = legs.map((leg) => { const match = matchLeg(leg, data); return { leg, match, score: scoreLeg(leg, match) }; });
  const slip = scoreSlip(scored, { combinedAmerican, type });
  return { scored, slip, suggestions: suggestions(scored, slip, { data, books }) };
}
