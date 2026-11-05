/**
 * UFC parlay pieces by prop type (2026-11-04: "the criteria for filtering
 * a UFC parlay to be its own thing": moneyline, method of victory, double
 * chance, rounds over/under, ends in round, method + round, goes the
 * distance, round to start, ends by, strikes, takedowns, knockdowns, and
 * the spread).
 *
 * Every leg is graded from the two records and Pixel's read of the bout:
 * a fighter's chance to win (the market's no-vig read blended with the
 * lean and its confidence), times how often that fighter's wins come the
 * way the leg says (by method, in the round, inside the distance), gives
 * the leg's chance, and the chance gives its stars. A leg on the side
 * Pixel leans gets a nudge; one against a pending Pixel's Pick is capped
 * at one star, so the grading shapes the pieces.
 *
 * Prices come from the feed where it posts the market (the moneyline,
 * the rounds total, the spread) and from the cappers' quote for a method
 * call; the rest ride unpriced with a note that the lines are not out
 * yet. Strikes, takedowns and knockdowns need per-fight stats the runner
 * does not pull yet, so those chips carry a note and no legs.
 */
import { americanToDecimal, decimalToAmerican } from '../../docs/engine.js';
import { priceLegsFromBoard } from './ufc-prop-odds.js';

/** Pixel's fair price for a chance: the odds the leg would be worth with no vig, in American form, or null. */
export const fairAmerican = (p) => (p > 0 && p < 1 ? decimalToAmerican(1 / p) : null);

export const UFC_PROPS = {
  ml: 'Moneyline',
  method: 'Method of victory',
  double: 'Double chance',
  rounds: 'Total rounds',
  end_round: 'Ends in round',
  method_round: 'Method & round combo',
  method_rounds: 'Method round combos',
  win_round: 'Round betting',
  distance: 'Will the fight go the distance?',
  round_start: 'Fight to start round',
  end_method: 'How fight will end',
  method_either: 'Either-fighter specials',
  win_round_start: 'Win & round to start',
  special: 'Specials',
  spread: 'Spread',
  strikes: 'Strikes',
  takedowns: 'Takedowns',
  knockdowns: 'Knockdowns',
};
export const UFC_PROP_KEYS = Object.keys(UFC_PROPS);
/** The props that need fight stats the profiles do not carry yet. */
export const UFC_PROPS_WITHOUT_STATS = ['strikes', 'takedowns', 'knockdowns'];
export const NO_STATS_NOTE = 'No per-fight stats on file for strikes, takedowns or knockdowns yet; those legs come once the runner pulls fight stats.';
export const NO_LINE_NOTE = 'Our odds feed carries no fight props for MMA (moneyline, round totals and spreads only), so this leg rides unpriced; the price is on the fight page at your book.';
export const NO_SPREAD_NOTE = 'No spread lines on this card yet.';

const METHOD_LABEL = { ko: 'KO/TKO', sub: 'Submission', dec: 'Decision' };
/** The "How fight will end" options as FanDuel names them: a decision is "Points" there. */
const END_LABEL = { ko: 'KO/TKO', sub: 'Submission', dec: 'Points' };
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** Seconds into the round from ESPN's clock at the stoppage ("2:34" is 154), or null. */
export function clockSeconds(t) { const m = String(t ?? '').match(/^(\d+):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
const round3 = (x) => Math.round(x * 1000) / 1000;

/** The way a result came, from its text: ko, sub, dec, or null. */
export function methodKind(method) {
  const m = String(method ?? '').toLowerCase();
  if (/\b(ko|tko|knock)|strikes|punch|kick/.test(m)) return 'ko';
  if (/sub|choke|lock|tap/.test(m)) return 'sub';
  if (/dec|unanimous|split|majority|points/.test(m)) return 'dec';
  return null;
}

/**
 * A fighter's record as shares: how the wins come (ko, sub, dec), how
 * often they finish, and the finishes by round and by method and round,
 * from the history (every fight on file) with the method tally as the
 * floor when the history is thin.
 */
export function recordRead(f) {
  const w = f?.methods?.wins ?? {};
  const wins = Math.max(n(w.ko) + n(w.sub) + n(w.dec) + n(w.other), (f?.history ?? []).filter((h) => h.result === 'win').length);
  const hWins = (f?.history ?? []).filter((h) => h.result === 'win');
  const byMethod = { ko: n(w.ko), sub: n(w.sub), dec: n(w.dec) };
  for (const k of ['ko', 'sub', 'dec']) byMethod[k] = Math.max(byMethod[k], hWins.filter((h) => methodKind(h.method) === k).length);
  const byRound = {}; const byMethodRound = {};
  for (const h of hWins) {
    const k = methodKind(h.method); const r = Number(h.round);
    if (!k || k === 'dec' || !Number.isFinite(r)) continue;
    byRound[r] = (byRound[r] ?? 0) + 1;
    byMethodRound[`${k}:${r}`] = (byMethodRound[`${k}:${r}`] ?? 0) + 1;
  }
  const share = (k) => (wins ? byMethod[k] / wins : 0);
  const finishes = byMethod.ko + byMethod.sub;
  // Every finish with its round and the seconds into that round it came (ESPN's clock at the stoppage), for the
  // minute specials; a decision never lands in a time window.
  const timed = hWins.map((h) => ({ k: methodKind(h.method), round: Number(h.round), secs: clockSeconds(h.time) })).filter((x) => x.k && x.k !== 'dec' && Number.isFinite(x.round) && Number.isFinite(x.secs));
  return {
    wins, byMethod, byRound, byMethodRound, timed,
    // The share of wins that land in a window, shrunk toward the league's base rate so one early stoppage on a short
    // record does not read as a habit: (count + 2 × base) / (wins + 2).
    timeShare: (pred, base) => (wins ? (timed.filter(pred).length + 2 * base) / (wins + 2) : base),
    timeCount: (pred) => timed.filter(pred).length,
    share: { ko: share('ko'), sub: share('sub'), dec: share('dec') },
    finishShare: wins ? finishes / wins : 0,
    roundShare: (r) => (wins ? (byRound[r] ?? 0) / wins : 0),
    methodRoundShare: (k, rounds) => (wins ? rounds.reduce((s, r) => s + (byMethodRound[`${k}:${r}`] ?? 0), 0) / wins : 0),
    methodRoundCount: (k, rounds) => rounds.reduce((s, r) => s + (byMethodRound[`${k}:${r}`] ?? 0), 0),
    roundCount: (rounds) => rounds.reduce((s, r) => s + (byRound[r] ?? 0), 0),
    lastFive: (f?.lastFive ?? []).filter((x) => x === 'win').length,
  };
}

/** The chance of each side, from the market (no-vig, best prices) blended with Pixel's lean and confidence; the lean alone when the feed has no line. */
export function winChance(odds, breakdown) {
  const dec = (q) => (Number.isFinite(q?.decimal) ? q.decimal : Number.isFinite(q?.american) ? americanToDecimal(q.american) : null);
  const qa = dec(odds?.a?.[0]); const qb = dec(odds?.b?.[0]);
  const market = qa && qb ? (1 / qa) / (1 / qa + 1 / qb) : null;
  const conf = Number(breakdown?.confidence) || 0;
  const model = breakdown?.lean === 'a' ? 0.5 + 0.08 * conf : breakdown?.lean === 'b' ? 0.5 - 0.08 * conf : 0.5;
  const a = market == null ? model : conf ? 0.65 * market + 0.35 * model : market;
  return { a: Math.min(0.95, Math.max(0.05, a)), b: 1 - Math.min(0.95, Math.max(0.05, a)), market };
}

/** Stars from a leg's chance: the bands a bettor would call strong, good, fair, thin, a flyer. */
export const starsFor = (p) => (p >= 0.62 ? 5 : p >= 0.5 ? 4 : p >= 0.38 ? 3 : p >= 0.25 ? 2 : 1);
const pct = (p) => `${Math.round(p * 100)}%`;
const ordinal = (r) => `${r}${r === 1 ? 'st' : r === 2 ? 'nd' : r === 3 ? 'rd' : 'th'}`;

/**
 * Every candidate leg for one bout, by prop. `bout` carries a and b;
 * `odds` is boutOdds (or null); `breakdown` the read; `engine` the
 * cappers' read (engineForBout); `profiles` { a, b } the fighter records;
 * `against` the fighter ids a pending Pixel's Pick is against.
 */
export function ufcPropLegs(bout, { odds = null, breakdown = null, engine = null, profiles = {}, against = new Set(), rounds = bout?.rounds ?? 3 } = {}) {
  const legs = [];
  if (!bout?.a?.name || !bout?.b?.name) return legs;
  const read = { a: recordRead(profiles.a), b: recordRead(profiles.b) };
  const chance = winChance(odds, breakdown);
  const name = { a: bout.a.name, b: bout.b.name };
  const other = (s) => (s === 'a' ? 'b' : 'a');
  const lean = breakdown?.lean ?? null; const conf = Number(breakdown?.confidence) || 0;
  // `order` is the card's: 1 is the main event, higher numbers come earlier in the night, so a chronological list runs it downward.
  const base = { boutId: bout.id, weightClass: bout.weightClass ?? null, boutDate: bout.date ?? null, rounds, order: bout.order ?? null, segment: bout.segment ?? null };
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // A side's grade: its chance to stars, nudged with the lean, capped against it, moved by the cappers (the MMA Engine's
  // consensus, once its run has read this card: a strong call for the side lifts a star, one against it costs a star), and
  // pinned to one star against a pending pick.
  const cappers = engine?.moneyline && engine.moneyline.tier !== 'pass' && Number.isFinite(engine.moneyline.consensusPct) ? engine.moneyline : null;
  // The cappers' shift on a side: +1 with a strong call for it, -1 with one against, else 0; the line says which.
  const capperShift = (side, why) => {
    if (!side || !cappers?.side) return 0;
    const strong = cappers.consensusPct >= 65 || cappers.tier === 'strong';
    if (!strong) return 0;
    why.push(`cappers ${Math.round(cappers.consensusPct)}% on ${cappers.side === side ? name[side] : name[other(side)]}`);
    return cappers.side === side ? 1 : -1;
  };
  const grade = (side, p, why, { method = null } = {}) => {
    let stars = starsFor(p);
    if (side && lean === side && conf >= 4) stars = Math.min(5, stars + 1);
    if (side && lean && lean !== side) stars = Math.min(stars, Math.max(1, 5 - conf));
    stars = Math.max(1, Math.min(5, stars + capperShift(side, why)));
    if (side && method) {
      const call = (engine?.methods ?? []).find((m) => m.side === side && m.method === method && m.tier !== 'pass');
      if (call && !why.some((w) => /on this call/.test(w))) why.push(`cappers ${Math.round(call.consensusPct)}% on this call`);
      if (call && (call.tier === 'strong' || call.consensusPct >= 60)) stars = Math.min(5, stars + 1);
    }
    if (side && against.has(bout[side]?.id)) { stars = 1; why.push("goes against a Pixel's Pick on the other side"); }
    return stars;
  };
  const push = (prop, side, selection, p, why, quotes = [], extra = {}) => {
    const w = [...why];
    const score = grade(side, p, w, { method: extra.method ?? null });
    const priced = quotes.some((q) => Number.isFinite(q.american));
    legs.push({ ...base, books: odds?.books ?? [], id: `${bout.id}:${prop}:${slug(selection)}`, prop, label: UFC_PROPS[prop], side, fighterId: side ? bout[side]?.id ?? null : null, name: side ? name[side] : null, opponent: side ? name[other(side)] : null, fight: `${name.a} vs ${name.b}`, selection, chance: round3(p), fairAmerican: fairAmerican(p), score, why: w, quotes, priced, note: priced ? null : NO_LINE_NOTE, ...extra });
  };
  const sides = ['a', 'b'];
  // Moneyline: the lean side at its confidence, the other side at what is left, as the Card tab reads it.
  for (const s of sides) {
    const q = odds?.[s] ?? [];
    const why = [`${pct(chance[s])} to win${chance.market != null ? ' on the market' : " on Pixel's read"}`];
    if (lean === s) why.push(`Pixel leans ${name[s]}, ${conf} of 5`);
    const leg = { prop: 'ml', side: s, selection: `${name[s]} to win`, p: chance[s], why, quotes: q };
    push(leg.prop, leg.side, leg.selection, leg.p, leg.why, leg.quotes);
    const ml = legs[legs.length - 1];
    // Pixel's confidence sets the moneyline's stars (as the Card tab reads it); the cappers' shift and a pending pick still apply.
    if (conf && !against.has(bout[s]?.id)) ml.score = Math.max(1, Math.min(5, (lean === s ? conf : Math.max(1, 5 - conf)) + capperShift(s, [])));
  }
  // Method of victory: each way a fighter's wins come often enough, priced off the cappers' quote when there is one.
  for (const s of sides) {
    const r = read[s];
    if (r.wins < 3) continue;
    for (const k of ['ko', 'sub', 'dec']) {
      if (r.share[k] < 0.25) continue;
      const p = chance[s] * r.share[k];
      const quoted = (engine?.methods ?? []).find((m) => m.side === s && m.method === k && Number.isFinite(m.quotedOdds));
      const quotes = quoted ? [{ bookId: 'engine', book: 'cappers quote', american: quoted.quotedOdds, decimal: americanToDecimal(quoted.quotedOdds), link: null }] : [];
      push('method', s, `${name[s]} by ${METHOD_LABEL[k]}`, p, [`${r.byMethod[k]} of ${r.wins} wins by ${METHOD_LABEL[k]} (${pct(r.share[k])})`, `${pct(chance[s])} to win`], quotes, { method: k });
    }
    // Double chance: the two likeliest ways.
    const top = ['ko', 'sub', 'dec'].sort((x, y) => r.share[y] - r.share[x]).slice(0, 2);
    if (r.share[top[0]] + r.share[top[1]] >= 0.6) {
      const p = chance[s] * (r.share[top[0]] + r.share[top[1]]);
      push('double', s, `${name[s]} by ${METHOD_LABEL[top[0]]} or ${METHOD_LABEL[top[1]]}`, p, [`${r.byMethod[top[0]] + r.byMethod[top[1]]} of ${r.wins} wins came one of these two ways`, `${pct(chance[s])} to win`], [], { methods: top.sort() });
    }
  }
  // Fight-level reads: the chance the fight ends in a round, by a way, or goes the distance, from both records weighted by who wins.
  const endIn = (rs) => sides.reduce((sum, s) => sum + chance[s] * (read[s].wins ? read[s].roundCount(rs) / read[s].wins : 0), 0);
  const endBy = (k) => sides.reduce((sum, s) => sum + chance[s] * read[s].share[k], 0);
  const thin = sides.every((s) => read[s].wins < 3);
  const allRounds = Array.from({ length: rounds }, (_, i) => i + 1);
  const fightWhy = () => sides.map((s) => `${name[s]} finishes ${pct(read[s].finishShare)} of wins (${read[s].wins} on file)`);
  if (!thin) {
    const pDist = endBy('dec');
    push('distance', null, 'Fight goes the distance', pDist, fightWhy());
    push('distance', null, 'Fight does not go the distance', 1 - pDist, fightWhy());
    for (const r of allRounds) {
      const p = endIn([r]);
      if (p >= 0.12) push('end_round', null, `Fight ends in Round ${r}`, p, [...fightWhy(), `${pct(p)} of the finishes land in Round ${r} across both records`], [], { round: r });
    }
    for (const r of [2, 3].filter((x) => x <= rounds)) {
      const p = 1 - endIn(allRounds.filter((x) => x < r));
      push('round_start', null, `Round ${r} to start`, p, [`${pct(1 - p)} chance the fight is over before Round ${r}`, ...fightWhy()], [], { round: r, answer: 'yes' });
    }
    for (const k of ['ko', 'sub', 'dec']) {
      const p = endBy(k);
      // FanDuel's market name and options (2026-11-05): "How fight will end", KO/TKO, Submission, Points.
      if (p >= 0.15) push('end_method', null, `How fight will end: ${END_LABEL[k]}`, p, sides.map((s) => `${name[s]}: ${pct(read[s].share[k])} of wins by ${METHOD_LABEL[k]}`), [], { method: k });
    }
    // Rounds over/under: every total the feed posts, or the usual number unpriced.
    const totals = (odds?.totals ?? []).length ? odds.totals : [{ point: rounds === 5 ? 2.5 : 1.5, over: [], under: [] }];
    for (const t of totals) {
      const pOver = 1 - endIn(allRounds.filter((x) => x <= Math.floor(t.point)));
      push('rounds', null, `Over ${t.point} rounds`, pOver, [`${pct(pOver)} to pass ${t.point} rounds`, ...fightWhy()], t.over ?? [], { point: t.point, sideWord: 'over' });
      push('rounds', null, `Under ${t.point} rounds`, 1 - pOver, [`${pct(1 - pOver)} to end inside ${t.point} rounds`, ...fightWhy()], t.under ?? [], { point: t.point, sideWord: 'under' });
    }
  }
  // FanDuel's combos (2026-11-05 screenshots): "Method & Round Combo" is a fighter, a way and one round; the
  // "Submission Round Combos" (and KO) are a fighter, a way and a two-round window; "Round Betting" is a fighter and
  // a round. One finish that way is enough for a leg (the long ones are what the sprinkle wants), two for a window.
  for (const s of sides) {
    const r = read[s];
    if (r.wins < 3) continue;
    for (const k of ['ko', 'sub']) {
      for (const rr of allRounds) {
        const c = r.methodRoundCount(k, [rr]);
        if (c >= 1 && c / r.wins >= 0.1) push('method_round', s, `${name[s]} ${METHOD_LABEL[k]} & Round ${rr}`, chance[s] * (c / r.wins), [`${c} of ${r.wins} wins by ${METHOD_LABEL[k]} in Round ${rr} (${pct(c / r.wins)})`, `${pct(chance[s])} to win`], [], { method: k, round: rr });
      }
      for (const rs of allRounds.slice(0, -1).map((x) => [x, x + 1])) {
        const c = r.methodRoundCount(k, rs);
        if (c >= 2 && c / r.wins >= 0.2) push('method_rounds', s, `${name[s]} to win by ${METHOD_LABEL[k]} in Rounds ${rs.join(' or ')}`, chance[s] * (c / r.wins), [`${c} of ${r.wins} wins by ${METHOD_LABEL[k]} in Rounds ${rs.join(' or ')} (${pct(c / r.wins)})`, `${pct(chance[s])} to win`], [], { method: k, rounds: rs });
      }
    }
    for (const rr of allRounds) {
      const c = r.roundCount([rr]);
      if (c >= 1 && c / r.wins >= 0.1) push('win_round', s, `${name[s]} to win in Round ${rr}`, chance[s] * (c / r.wins), [`${c} of ${r.wins} wins came in Round ${rr}`, `${pct(chance[s])} to win`], [], { round: rr });
    }
    // "Fighter to Win & Round 2 to Start": the win comes after the first round (a later finish or the cards).
    if (rounds >= 2) {
      const after = 1 - r.roundShare(1);
      push('win_round_start', s, `${name[s]} to win & Round 2 to start`, chance[s] * after, [`${pct(after)} of ${name[s]}'s wins come after Round 1`, `${pct(chance[s])} to win`], [], { round: 2 });
    }
  }
  // "Fight to start Round N": both answers, as the book lists them.
  if (!thin) {
    for (const r of [2, 3].filter((x) => x <= rounds)) {
      const p = 1 - endIn(allRounds.filter((x) => x < r));
      push('round_start', null, `Fight to start Round ${r}: No`, 1 - p, [`${pct(1 - p)} chance the fight is over before Round ${r}`, ...fightWhy()], [], { round: r, answer: 'no' });
    }
    // "Match specials": one fighter by one way or the other by another ("A by Submission or B by KO/TKO"), the three likeliest cross pairs.
    const cross = [];
    for (const ka of ['ko', 'sub', 'dec']) for (const kb of ['ko', 'sub', 'dec']) {
      if (ka === kb) continue;
      const p = chance.a * read.a.share[ka] + chance.b * read.b.share[kb];
      if (p >= 0.05) cross.push({ ka, kb, p });
    }
    for (const x of cross.sort((u, v) => v.p - u.p).slice(0, 3)) {
      push('method_either', null, `${name.a} by ${END_LABEL[x.ka]} or ${name.b} by ${END_LABEL[x.kb]}`, x.p, [`${name.a}: ${pct(read.a.share[x.ka])} of wins by ${METHOD_LABEL[x.ka]}`, `${name.b}: ${pct(read.b.share[x.kb])} of wins by ${METHOD_LABEL[x.kb]}`], [], { methods: [x.ka, x.kb] });
    }
    // The minute specials (FanDuel's "MMA Match Specials" and "UFC Specials: +2000 and above"), from the clock at each
    // finish on file; a window's share is shrunk toward its base rate across the sport. A fighter's own special
    // needs at least one finish in the window on file; the either-fighter ones read both records.
    const final = rounds;
    const W = {
      first30: { pred: (x) => x.round === 1 && x.secs <= 30, base: 0.02, text: 'the 1st 30 seconds of the fight' },
      first2min: { pred: (x) => x.round === 1 && x.secs <= 120, base: 0.07, text: 'the 1st 2 minutes of the fight' },
      first3min: { pred: (x) => x.round === 1 && x.secs <= 180, base: 0.1, text: 'the 1st 3 minutes of the fight' },
      min4any: { pred: (x) => x.secs > 180 && x.secs <= 240, base: 0.07, text: 'the 4th minute of any round' },
      last30final: { pred: (x) => x.round === final && x.secs >= 270, base: 0.015, text: `the last 30 seconds of the ${ordinal(final)} round` },
      last2final: { pred: (x) => x.round === final && x.secs >= 180, base: 0.04, text: `the last 2 minutes of the ${ordinal(final)} round` },
      r1min1OrLast: { pred: (x) => (x.round === 1 && x.secs <= 60) || (x.round === final && x.secs >= 240), base: 0.055, text: `the 1st minute of Round 1 or the last minute of the ${ordinal(final)} round` },
      subFirst3R1: { pred: (x) => x.k === 'sub' && x.round === 1 && x.secs <= 180, base: 0.03, text: 'by Submission in the 1st 3 minutes of Round 1' },
      koFirst30R1: { pred: (x) => x.k === 'ko' && x.round === 1 && x.secs <= 30, base: 0.012, text: 'by KO/TKO in the 1st 30 seconds of Round 1' },
    };
    const winWhy = (s, w) => `${name[s]}: ${read[s].timeCount(w.pred)} of ${read[s].wins} wins in ${w.text}`;
    for (const s of sides) {
      for (const key of ['first30', 'first2min', 'first3min', 'koFirst30R1']) {
        const w = W[key];
        if (!read[s].timeCount(w.pred)) continue;
        push('special', s, `${name[s]} to win in ${w.text}`.replace(' in by ', ' by '), chance[s] * read[s].timeShare(w.pred, w.base), [winWhy(s, w), `${pct(chance[s])} to win`], [], { window: key });
      }
    }
    for (const key of ['first30', 'min4any', 'last30final', 'last2final', 'r1min1OrLast', 'subFirst3R1']) {
      const w = W[key];
      if (!sides.some((s) => read[s].timeCount(w.pred))) continue; // a base rate alone is no read: one finish in the window on file, either side
      const p = sides.reduce((sum, s) => sum + chance[s] * read[s].timeShare(w.pred, w.base), 0);
      const label = key === 'min4any' || key === 'r1min1OrLast' ? `Fight to be won in ${w.text}` : `Either fighter to win in ${w.text}`.replace(' in by ', ' by ');
      push('special', null, label, p, sides.map((s) => winWhy(s, w)), [], { window: key });
    }
  }
  // The spread, only when the feed posts one.
  for (const sp of odds?.spreads ?? []) {
    for (const s of sides) {
      const q = sp[s] ?? [];
      if (!q.length || !Number.isFinite(sp.point?.[s])) continue;
      const pt = sp.point[s];
      push('spread', s, `${name[s]} ${pt > 0 ? '+' : ''}${pt}`, pt > 0 ? Math.min(0.9, chance[s] + 0.25) : Math.max(0.05, chance[s] - 0.25), [`${pct(chance[s])} to win`, pt > 0 ? 'the spread covers a close loss on the cards' : 'the spread needs a clear win'], q, { point: pt });
    }
  }
  return legs;
}

/**
 * The sprinkles (2026-11-05: "a Sprinkle button for super high odds props
 * worth sprinkling a couple of dollars on for a high payout"): the long
 * shots the records back best. A leg is a sprinkle when its fair price is
 * long (a chance inside SPRINKLE_BAND) and it is a real prop, not a side,
 * a total or a yes/no; the likeliest long shots come first, at most two
 * a bout and SPRINKLE_MAX a card. Each carries its fair price; the book's
 * own number is on its fight page.
 */
export const SPRINKLE_BAND = [0.012, 0.12];
export const SPRINKLE_MAX = 8;
const SPRINKLE_PROPS = new Set(['method', 'method_round', 'method_rounds', 'win_round', 'end_round', 'method_either', 'win_round_start', 'special']);
export function sprinklePicks(legs, { perBout = 2, max = SPRINKLE_MAX } = {}) {
  const perBoutCount = new Map(); const out = [];
  // The combo props first on a tie, so "Submission & Round 2" is taken over "to win in Round 2" when every Round 2 win
  // came by submission: the same chance, the longer price at the book.
  const rank = { method_round: 0, method_rounds: 1, special: 2, method_either: 3, win_round_start: 4, end_round: 5, win_round: 6, method: 7 };
  const pool = (legs ?? []).filter((l) => SPRINKLE_PROPS.has(l.prop) && l.chance >= SPRINKLE_BAND[0] && l.chance <= SPRINKLE_BAND[1]).sort((x, y) => y.chance - x.chance || (rank[x.prop] ?? 9) - (rank[y.prop] ?? 9) || String(x.id).localeCompare(String(y.id)));
  const same = (x, y) => x.boutId === y.boutId && (x.side ?? null) === (y.side ?? null) && x.round != null && x.round === y.round;
  for (const l of pool) {
    if (out.length >= max) break;
    const c = perBoutCount.get(l.boutId) ?? 0;
    if (c >= perBout) continue;
    if (out.some((o) => same(o, l))) continue; // the same fighter in the same round is one bet, not two
    perBoutCount.set(l.boutId, c + 1);
    out.push(l);
  }
  return out;
}

/** The card's pieces: every bout's legs, with the notes for the props that have no lines or no stats. */
export function ufcCardProps(bouts, readBy, { now = Date.now(), engine = null, board = null } = {}) {
  const legs = [];
  let cappersRead = 0; let boutsOnBoard = 0; let pricedFromBoard = 0;
  for (const bout of bouts ?? []) {
    const r = readBy(bout);
    if (!r) continue;
    if (r.engine?.moneyline || r.engine?.methods?.length) cappersRead++;
    let mine = ufcPropLegs(bout, r);
    // The fight props' prices from the BestFightOdds board the runner writes (worker/src/ufc-prop-odds.js), where it lists the bout.
    if (board) { const priced = priceLegsFromBoard(mine, bout, board); mine = priced.legs; if (priced.matched) { boutsOnBoard++; pricedFromBoard += priced.priced ?? 0; } }
    legs.push(...mine);
  }
  const notes = { strikes: NO_STATS_NOTE, takedowns: NO_STATS_NOTE, knockdowns: NO_STATS_NOTE };
  if (!legs.some((l) => l.prop === 'spread')) notes.spread = NO_SPREAD_NOTE;
  // Whether the MMA Engine's run has read this card: its consensus moves the grades, so the ticket can change when it lands.
  const cappers = { read: cappersRead > 0, bouts: cappersRead, generatedAt: cappersRead ? engine?.generatedAt ?? null : null };
  const sprinkles = sprinklePicks(legs);
  sprinkles.forEach((l, i) => { l.sprinkle = true; l.sprinkleRank = i + 1; });
  const boardRead = board ? { at: board.at ?? null, source: board.source ?? 'bestfightodds', events: (board.events ?? []).map((e) => ({ title: e.title, url: e.url })), bouts: boutsOnBoard, priced: pricedFromBoard } : null;
  return { builtAt: now, legs, notes, cappers, board: boardRead, sprinkles: sprinkles.map((l) => l.id) };
}
