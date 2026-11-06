/**
 * The Tennis tab's read of a player beyond the serve numbers (2026-11-06:
 * "recent form of the player versus the other player's form, their play
 * style matchup, surface type, and possible injury and possible player
 * fatigue"). Pure: the card's results in, a form line and the flags out,
 * and the two players' win share from all of it.
 *
 *   formOf(player, results, now)   the last six weeks of one player
 *   styleOf(rates, tour)           what the serve and return numbers say the player is
 *   matchupProb(...)               the model's win share for A: Elo and the serve
 *                                  simulation, then form, fatigue, injury, rust and
 *                                  the style-on-surface read, with the reasons
 */
import { TOUR_AVG } from './tennis-model.js';

/**
 * A match in the last FATIGUE_DAYS days counts as load; FATIGUE_MATCHES of
 * them, or a marathon yesterday, flags fatigue. Five, not four: a
 * quarterfinalist at a Masters has four in the week by Friday, which is the
 * ordinary run of a tournament, while five means a final last Sunday on
 * top of it, or qualifying.
 */
export const FATIGUE_DAYS = 7;
export const FATIGUE_MATCHES = 5;
export const MARATHON_GAMES = 30;
/** A retirement or a walkover given inside INJURY_DAYS flags an injury doubt. */
export const INJURY_DAYS = 21;
/** No match in RUST_DAYS flags rust. */
export const RUST_DAYS = 28;
export const FORM_MATCHES = 10;

const retiredLike = (r) => /retire|walkover/i.test(String(r.statusName ?? '')) || /ret\.|retired|w\/o|walkover/i.test(String(r.note ?? ''));
const walkoverLike = (r) => /walkover/i.test(String(r.statusName ?? '')) || /w\/o|walkover/i.test(String(r.note ?? ''));

/** Whether `player` ({id, key}) is side a or b of a result, by ESPN id first and the name key second; null when neither. */
export function sideOf(player, r) {
  if (!player) return null;
  if (player.id && r.a?.id === player.id) return 'a';
  if (player.id && r.b?.id === player.id) return 'b';
  if (player.key && r.a?.key === player.key) return 'a';
  if (player.key && r.b?.key === player.key) return 'b';
  return null;
}

/**
 * One player's last six weeks from the card's completed results:
 * {matches, last: [{date, won, gamesDiff, sets, opponent, retiredLike}],
 * wins, losses, gamesDiff (per match), straightSetWins, loadWeek, daysSince,
 * marathonYesterday, retiredRecently, rust, fatigue, injury, score}.
 * `score` runs about -1 (losing everything, badly) to +1 (winning everything
 * comfortably); a player with no results scores 0 with `matches` 0.
 */
export function formOf(player, results, now = Date.now()) {
  const mine = [];
  for (const r of results ?? []) {
    if (!r?.completed) continue;
    const side = sideOf(player, r); if (!side) continue;
    const ms = Date.parse(r.date); if (!Number.isFinite(ms) || ms > now) continue;
    const other = side === 'a' ? 'b' : 'a';
    const sets = r.sets ?? [];
    const gA = sets.reduce((n, s) => n + (s[side === 'a' ? 0 : 1] ?? 0), 0); const gB = sets.reduce((n, s) => n + (s[side === 'a' ? 1 : 0] ?? 0), 0);
    const won = r.winner ? r.winner === side : gA > gB;
    const setsWon = sets.filter((s) => s[side === 'a' ? 0 : 1] > s[side === 'a' ? 1 : 0]).length; const setsLost = sets.filter((s) => s[side === 'a' ? 1 : 0] > s[side === 'a' ? 0 : 1]).length;
    mine.push({ date: r.date, ms, won, gamesDiff: gA - gB, games: gA + gB, setsWon, setsLost, opponent: r[other]?.name ?? null, event: r.eventName ?? null, retiredLike: retiredLike(r), walkover: walkoverLike(r), gaveUp: !won && retiredLike(r) });
  }
  mine.sort((x, y) => y.ms - x.ms);
  const last = mine.slice(0, FORM_MATCHES);
  const wins = last.filter((m) => m.won).length; const losses = last.length - wins;
  const played = last.filter((m) => !m.walkover);
  const gamesDiff = played.length ? played.reduce((n, m) => n + m.gamesDiff, 0) / played.length : 0;
  const straightSetWins = last.filter((m) => m.won && m.setsLost === 0 && !m.retiredLike).length;
  const week = mine.filter((m) => now - m.ms < FATIGUE_DAYS * 864e5 && !m.walkover);
  const loadWeek = week.length;
  const yesterday = mine.filter((m) => now - m.ms < 36 * 3600e3 && !m.walkover);
  const marathonYesterday = yesterday.some((m) => m.games >= MARATHON_GAMES || (m.setsWon + m.setsLost >= 3 && m.games >= 26));
  const daysSince = mine.length ? Math.floor((now - mine[0].ms) / 864e5) : null;
  const retiredRecently = mine.some((m) => m.gaveUp && now - m.ms < INJURY_DAYS * 864e5);
  const rust = mine.length > 0 && daysSince != null && daysSince >= RUST_DAYS;
  const fatigue = loadWeek >= FATIGUE_MATCHES || marathonYesterday;
  // The score: the win share against even, and the games margin against even, half each; recent losses by retirement count double.
  const winPart = last.length ? (wins / last.length - 0.5) * 2 : 0;
  const diffPart = Math.max(-1, Math.min(1, gamesDiff / 6));
  const score = last.length ? Math.round(((winPart + diffPart) / 2 - (retiredRecently ? 0.25 : 0)) * 100) / 100 : 0;
  return { matches: mine.length, last, wins, losses, gamesDiff: Math.round(gamesDiff * 10) / 10, straightSetWins, loadWeek, daysSince, marathonYesterday, retiredRecently, rust, fatigue, injury: retiredRecently, score };
}

/** A one-line form read for the tab. */
export function formLine(name, f) {
  if (!f || !f.last.length) return `${name}: no result on the card in six weeks`;
  const parts = [`${name}: ${f.wins}-${f.losses} in the last ${f.last.length}`, `${f.gamesDiff >= 0 ? '+' : ''}${f.gamesDiff} games a match`];
  if (f.straightSetWins >= 3) parts.push(`${f.straightSetWins} straight-set wins`);
  if (f.fatigue) parts.push(f.marathonYesterday ? 'a marathon yesterday' : `${f.loadWeek} matches in ${FATIGUE_DAYS} days`);
  if (f.injury) parts.push('retired or gave a walkover inside three weeks');
  if (f.rust) parts.push(`first match in ${f.daysSince} days`);
  return parts.join(', ');
}

/**
 * The style the numbers describe: 'server' (aces and holds well above the
 * tour), 'returner' (breaks well above the tour, serve ordinary), 'complete'
 * (both), 'grinder' (neither stands out), with the margins over the tour.
 */
export function styleOf(rates, tour = 'atp') {
  const avg = TOUR_AVG[tour] ?? TOUR_AVG.atp;
  const serveEdge = (rates?.serve ?? avg.serve) - avg.serve;
  const aceEdge = (rates?.ace ?? avg.ace) - avg.ace;
  const returnEdge = (rates?.return ?? (1 - avg.serve)) - (1 - avg.serve);
  const bigServe = serveEdge >= 0.03 || aceEdge >= 0.03;
  const bigReturn = returnEdge >= 0.03;
  const style = bigServe && bigReturn ? 'complete' : bigServe ? 'server' : bigReturn ? 'returner' : 'grinder';
  return { style, serveEdge: Math.round(serveEdge * 1000) / 1000, aceEdge: Math.round(aceEdge * 1000) / 1000, returnEdge: Math.round(returnEdge * 1000) / 1000 };
}

export const STYLE_LABEL = { server: 'big server', returner: 'returner', complete: 'complete player', grinder: 'baseliner' };

/** Elo's win share for A. Null without both numbers. */
export const eloShare = (eloA, eloB) => (Number.isFinite(eloA) && Number.isFinite(eloB) ? 1 / (1 + 10 ** ((eloB - eloA) / 400)) : null);
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clamp = (p) => Math.min(0.97, Math.max(0.03, p));

/**
 * The model's win share for A and why: the surface Elo (overall Elo when
 * the surface line is thin) and the serve simulation's share, half each,
 * then on the log-odds: the form gap, fatigue, an injury doubt, rust, and
 * the style on the surface (a big server on grass or a hard court, a
 * returner on clay). Returns {p, pElo, pSim, adj, reasons, flags: {a, b}}.
 */
export function matchupProb({ pSim, eloA, eloB, formA, formB, styleA, styleB, surface, nameA = 'A', nameB = 'B' }) {
  const pElo = eloShare(eloA, eloB);
  const base = pElo != null && pSim != null ? 0.5 * pElo + 0.5 * pSim : pElo ?? pSim ?? 0.5;
  let adj = 0; const reasons = [];
  const fa = formA ?? formOf(null, []); const fb = formB ?? formOf(null, []);
  const formGap = (fa.score ?? 0) - (fb.score ?? 0);
  if (Math.abs(formGap) >= 0.15 && (fa.last.length >= 3 || fb.last.length >= 3)) { adj += 0.6 * formGap; reasons.push(`form favours ${formGap > 0 ? nameA : nameB} (${fa.wins}-${fa.losses} vs ${fb.wins}-${fb.losses} in the last ${FORM_MATCHES})`); }
  if (fa.fatigue !== fb.fatigue) { adj += fa.fatigue ? -0.25 : 0.25; reasons.push(`${fa.fatigue ? nameA : nameB} carries a heavy week (${(fa.fatigue ? fa : fb).marathonYesterday ? 'a marathon yesterday' : `${(fa.fatigue ? fa : fb).loadWeek} matches in ${FATIGUE_DAYS} days`})`); }
  if (fa.injury !== fb.injury) { adj += fa.injury ? -0.4 : 0.4; reasons.push(`${fa.injury ? nameA : nameB} retired or gave a walkover inside three weeks: an injury doubt`); }
  if (fa.rust !== fb.rust) { adj += fa.rust ? -0.1 : 0.1; reasons.push(`${fa.rust ? nameA : nameB} has not played in ${(fa.rust ? fa : fb).daysSince} days`); }
  const fast = surface === 'grass' || surface === 'hard';
  const styleEdge = (s) => (!s ? 0 : fast && (s.style === 'server' || s.style === 'complete') ? 0.08 : surface === 'clay' && (s.style === 'returner' || s.style === 'complete') ? 0.08 : surface === 'clay' && s.style === 'server' ? -0.05 : 0);
  const styleGap = styleEdge(styleA) - styleEdge(styleB);
  if (styleGap !== 0) { adj += styleGap; reasons.push(`${styleGap > 0 ? nameA : nameB}'s game (${STYLE_LABEL[(styleGap > 0 ? styleA : styleB).style]}) fits ${surface === 'clay' ? 'clay' : surface === 'grass' ? 'grass' : 'a hard court'} better than ${styleGap > 0 ? nameB : nameA}'s (${STYLE_LABEL[(styleGap > 0 ? styleB : styleA)?.style ?? 'grinder']})`); }
  const p = clamp(sigmoid(logit(clamp(base)) + adj));
  return { p: Math.round(p * 1000) / 1000, pElo: pElo != null ? Math.round(pElo * 1000) / 1000 : null, pSim: pSim != null ? Math.round(pSim * 1000) / 1000 : null, adj: Math.round(adj * 100) / 100, reasons, flags: { a: flagsOf(fa), b: flagsOf(fb) } };
}

/** The flags a form read raises, as words. */
export const flagsOf = (f) => [f?.injury ? 'injury' : null, f?.fatigue ? 'fatigue' : null, f?.rust ? 'rust' : null].filter(Boolean);
