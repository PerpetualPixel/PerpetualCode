/**
 * The Sharp analysis on a UFC fight: what to look at besides the moneyline,
 * the method of victory and the double chance (2026-11-18: "besides taking
 * a moneyline, there is usually a stat or prop that can be exploited").
 *
 * Worked out from the two stat lines (worker/src/ufc-stats.js) and the two
 * fight histories, not written by a model: every sentence in it is a number
 * off the page, so it can be checked.
 *
 *   strikes     who lands more significant strikes: each fighter's output met
 *               with what the other absorbs, less the time a wrestler
 *               takes off the feet ("most significant strikes for fighters
 *               who put out more volume and their opponents absorb more")
 *   takedowns   a fighter's takedowns per 15 minutes against how many the
 *               other stops, over the fight's length
 *   duration    whether it goes the distance, and whether it sees round two,
 *               from how both fighters' bouts have ended
 *   knockdown   a puncher who scores knockdowns against an opponent who has been
 *               stopped by strikes
 *
 * One play a family at most, the strongest three, and only those that
 * clear SHARP_MIN. A fight where nothing does says so, and names an
 * alternate to the main pick instead ("if there is nothing that stands
 * out to look for, say so and provide an alternate play vs the main pick").
 */

/** What a play must score to be worth naming (of 100). */
export const SHARP_MIN = 62;
export const SHARP_MAX_PLAYS = 3;

/** The share of significant strikes below which there is nothing to say (a lead this side of it and the bar is the fight's "nearest thing"). */
const STRIKE_SHARE = 0.53;
/**
 * Fights in the UFC (or on the Contender Series) below which a stat line is
 * thin: per-minute rates off one or two short fights swing wildly (the
 * first live card had a debutant "landing 9.7 a minute and absorbing
 * 10.4"). A play resting on a thin line loses THIN_COST and says so.
 */
const THIN_FIGHTS = 3;
const THIN_COST = 12;
/** The UFC's long-run share of takedown attempts that are stopped, the yardstick a takedown average was earned against. */
const AVG_TD_DEFENSE = 60;
const METHOD_WORD = { ko: 'KO/TKO', sub: 'submission', dec: 'decision' };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => Math.round(v * 10) / 10;
const pct = (v) => `${Math.round(v * 100)}%`;
const last = (name) => String(name ?? '').trim().split(/\s+/).at(-1) ?? '';
const has = (v) => Number.isFinite(v);

/** Whether a fighter's stat line rests on too few UFC fights to lean on: fewer than THIN_FIGHTS on the history, or rates no settled fighter posts. */
export function thinLine(f) {
  if (!f?.stats) return false;
  const inUfc = (f.history ?? []).filter((x) => /\bUFC\b|contender series/i.test(String(x.event ?? ''))).length;
  const known = (f.history ?? []).some((x) => x.event);
  return (known && inUfc < THIN_FIGHTS) || f.stats.slpm > 9 || f.stats.sapm > 9 || (has(f.stats.avgFightSec) && f.stats.avgFightSec < 150);
}
const thinNote = (fighters) => { const names = fighters.filter(([, f]) => thinLine(f)).map(([n]) => last(n.name)); return names.length ? `${names.join(' and ')}'s UFC numbers come from very little cage time, so this one is marked down` : null; };

/** How a fighter's fights have ended: the share by decision, the share over inside round one, and how many fights that rests on. */
export function endings(f) {
  const w = f?.methods?.wins ?? {}; const l = f?.methods?.losses ?? {};
  const dec = (w.dec ?? 0) + (l.dec ?? 0);
  const total = dec + (w.ko ?? 0) + (w.sub ?? 0) + (l.ko ?? 0) + (l.sub ?? 0);
  const timed = (f?.history ?? []).filter((h) => (h.category === 'ko' || h.category === 'sub' || h.category === 'dec') && (h.category === 'dec' || has(h.round)));
  const firstRound = timed.filter((h) => h.category !== 'dec' && h.round === 1).length;
  return {
    fights: total,
    decShare: total ? dec / total : null,
    r1Share: timed.length >= 4 ? firstRound / timed.length : null,
    koLosses: l.ko ?? 0,
    losses: (l.ko ?? 0) + (l.sub ?? 0) + (l.dec ?? 0),
  };
}

/** The minutes a fight is likely to last: the two fighters' average fight times where on file, the schedule otherwise, never past the schedule. */
function expectedMinutes(a, b, rounds) {
  const scheduled = (rounds || 3) * 5;
  const times = [a?.stats?.avgFightSec, b?.stats?.avgFightSec].filter((t) => has(t) && t > 0).map((t) => t / 60);
  if (!times.length) return scheduled * 0.75;
  // Averages are mostly three-rounders: a five-round fight runs longer than either average says.
  const mean = times.reduce((n, t) => n + t, 0) / times.length;
  return clamp(mean * (rounds === 5 ? 1.35 : 1), 4, scheduled);
}

/** The takedowns a fighter is likely to land per 15 minutes on this opponent: the fighter's own average, scaled by how much better or worse than usual the opponent is at stopping them. */
function takedownRate(f, opp) {
  const avg = f?.stats?.tdAvg;
  if (!has(avg)) return null;
  const def = has(opp?.stats?.tdDef) ? opp.stats.tdDef : AVG_TD_DEFENSE;
  return avg * clamp((100 - def) / (100 - AVG_TD_DEFENSE), 0.35, 1.8);
}

function strikesPlay(bout, a, b) {
  const sa = a?.stats; const sb = b?.stats;
  if (!has(sa?.slpm) || !has(sb?.slpm) || !(sa.slpm + sb.slpm > 0)) return null;
  const bothAbsorb = has(sa.sapm) && has(sb.sapm);
  // Each fighter's output met with what the other lets through.
  let xa = (sa.slpm + (has(sb.sapm) ? sb.sapm : sa.slpm)) / 2;
  let xb = (sb.slpm + (has(sa.sapm) ? sa.sapm : sb.slpm)) / 2;
  // Time on the mat is time not striking: a fighter taken down often lands less than the average says.
  const dragOn = (rate) => (has(rate) ? clamp(0.08 * rate, 0, 0.3) : 0);
  const dragA = dragOn(takedownRate(b, a)); const dragB = dragOn(takedownRate(a, b));
  xa *= 1 - dragA; xb *= 1 - dragB;
  if (!(xa + xb > 0)) return null;
  const share = xa / (xa + xb);
  const lead = share >= 0.5 ? 'a' : 'b';
  const leadShare = Math.max(share, 1 - share);
  if (leadShare < STRIKE_SHARE) return null;
  const [w, l, sw, sl, xw, xl, dragL] = lead === 'a' ? [bout.a, bout.b, sa, sb, xa, xb, dragB] : [bout.b, bout.a, sb, sa, xb, xa, dragA];
  const dragW = lead === 'a' ? dragA : dragB;
  const why = [
    `${w.name} lands ${sw.slpm} significant strikes a minute to ${last(l.name)}'s ${sl.slpm}`,
    bothAbsorb ? `${last(l.name)} absorbs ${sl.sapm} a minute, ${last(w.name)} ${sw.sapm}` : null,
    `Each fighter's output against what the other lets through: about ${round1(xw)} to ${round1(xl)} a minute, ${pct(leadShare)} of the strikes to ${last(w.name)}`,
    dragL >= 0.1 ? `${last(w.name)}'s takedowns put ${last(l.name)} on the mat for part of it, which is counted in` : null,
    dragW >= 0.1 ? `${last(l.name)}'s takedowns cost ${last(w.name)} some of that volume, which is counted in` : null,
    thinNote([[bout.a, a], [bout.b, b]]),
  ].filter(Boolean);
  let strength = 45 + (leadShare - 0.5) * 250;
  if (!bothAbsorb) strength -= 8;
  if (thinLine(a) || thinLine(b)) strength -= THIN_COST;
  return {
    key: 'strikes', family: 'strikes', side: lead,
    market: 'Most significant strikes',
    selection: `${w.name} most significant strikes`,
    strength: Math.round(clamp(strength, 0, 95)),
    why,
    note: 'Settles on the official count, so a fight that ends early goes to whoever was ahead when it did.',
  };
}

function takedownPlays(bout, a, b, minutes) {
  const one = (side, f, opp, me, them) => {
    const rate = takedownRate(f, opp);
    if (!has(rate) || !(f.stats.tdAvg >= 1.5)) return null;
    const expected = rate * (minutes / 15);
    if (expected < 1.6) return null;
    const line = expected >= 4.2 ? 2.5 : expected >= 2.6 ? 1.5 : 0.5;
    let strength = 56 + (expected - line - 1) * 12;
    if (has(opp?.stats?.tdDef) && opp.stats.tdDef >= 75) strength -= 8;
    if (!has(opp?.stats?.tdDef)) strength -= 6;
    if (thinLine(f) || thinLine(opp)) strength -= THIN_COST;
    return {
      key: `takedowns_${side}`, family: 'takedowns', side,
      market: 'Fighter takedowns',
      selection: `${me.name} over ${line} takedowns`,
      line,
      strength: Math.round(clamp(strength, 0, 92)),
      why: [
        `${me.name} lands ${f.stats.tdAvg} takedowns per 15 minutes${has(f.stats.tdAcc) && f.stats.tdAcc > 0 ? `, ${Math.round(f.stats.tdAcc)}% of the attempts` : ''}`,
        has(opp?.stats?.tdDef) ? `${last(them.name)} stops ${Math.round(opp.stats.tdDef)}% of takedown attempts (the UFC average is about ${AVG_TD_DEFENSE}%)` : `No takedown defence figure on file for ${last(them.name)}, so the UFC average stands in`,
        `Over a fight of about ${Math.round(minutes)} minutes that is roughly ${round1(expected)} takedowns`,
        thinNote([[me, f], [them, opp]]),
      ].filter(Boolean),
      note: `Take the highest number the price still makes sense at; ${line} is the one the projection clears with room.`,
    };
  };
  return [one('a', a, b, bout.a, bout.b), one('b', b, a, bout.b, bout.a)].filter(Boolean);
}

function durationPlays(bout, a, b) {
  const ea = endings(a); const eb = endings(b);
  if (!(ea.fights >= 5) || !(eb.fights >= 5) || ea.decShare == null || eb.decShare == null) return [];
  const five = bout.rounds === 5;
  // Two more rounds are two more chances to be finished.
  const pDec = ((ea.decShare + eb.decShare) / 2) * (five ? 0.85 : 1);
  const out = [];
  const ends = (f, e, n) => `${last(n)}: ${Math.round(e.decShare * 100)}% of ${e.fights} fights went to the cards`;
  let distance = null;
  if (pDec >= 0.6) {
    out.push(distance = {
      key: 'distance_yes', family: 'duration', side: null, market: 'Fight goes the distance', selection: 'Fight goes the distance: Yes',
      prop: 'distance', strength: Math.round(clamp(50 + (pDec - 0.5) * 120, 0, 92)),
      why: [ends(a, ea, bout.a.name), ends(b, eb, bout.b.name), five ? 'Five rounds, so two more chances of a finish than either record was built on: counted in' : null].filter(Boolean),
      note: 'The over on the rounds total is the same read at a shorter price.',
    });
  } else if (pDec <= 0.3) {
    out.push(distance = {
      key: 'distance_no', family: 'duration', side: null, market: 'Fight goes the distance', selection: 'Fight does not go the distance',
      prop: 'distance', strength: Math.round(clamp(50 + (0.5 - pDec) * 120, 0, 92)),
      why: [ends(a, ea, bout.a.name), ends(b, eb, bout.b.name)],
      note: 'The under on the rounds total is the same read; take whichever is priced better.',
    });
  }
  if (ea.r1Share != null && eb.r1Share != null) {
    const pR1 = (ea.r1Share + eb.r1Share) / 2;
    const r1 = (e, n) => `${last(n)}: ${Math.round(e.r1Share * 100)}% of recent fights were over inside the first round`;
    if (pR1 <= 0.15 && pDec >= 0.4) {
      out.push({
        key: 'round2_yes', family: 'duration', side: null, market: 'Round 2 to start', selection: 'Round 2 to start: Yes',
        prop: 'round_start', round: 2, answer: 'yes', strength: Math.round(clamp(60 + (0.15 - pR1) * 120 + (pDec - 0.4) * 30, 0, 90)),
        why: [r1(ea, bout.a.name), r1(eb, bout.b.name)],
        note: 'A short price on its own; it earns its place as a parlay leg.',
      });
    } else if (pR1 >= 0.45) {
      out.push({
        key: 'round2_no', family: 'duration', side: null, market: 'Round 2 to start', selection: 'Round 2 to start: No',
        prop: 'round_start', round: 2, answer: 'no', strength: Math.round(clamp(50 + (pR1 - 0.3) * 110, 0, 88)),
        why: [r1(ea, bout.a.name), r1(eb, bout.b.name)],
        note: 'The under 1.5 rounds is close to the same bet and usually pays a little less.',
      });
    }
  }
  // The distance is the bet with a price worth having; the round to start is its short-priced cousin. Where both hold, the distance leads and says so.
  if (distance && distance.strength >= SHARP_MIN) {
    const cousin = out.find((p) => p.prop === 'round_start');
    if (cousin) distance.note = `${distance.note} ${cousin.selection} is the safer leg of the same read for a parlay.`;
    return [distance];
  }
  return out.sort((x, y) => y.strength - x.strength).slice(0, 1);
}

function knockdownPlays(bout, a, b) {
  const one = (side, f, opp, me, them) => {
    const kd = f?.stats?.kdAvg; const e = endings(opp);
    if (!has(kd) || kd < 0.8 || e.losses < 2 || e.koLosses < 2) return null;
    const koShare = e.koLosses / e.losses;
    if (koShare < 0.4) return null;
    return {
      key: `knockdown_${side}`, family: 'knockdown', side, market: 'Fighter to score a knockdown', selection: `${me.name} to score a knockdown`,
      strength: Math.round(clamp(48 + (kd - 0.8) * 22 + (koShare - 0.4) * 30 - (thinLine(f) ? THIN_COST : 0), 0, 85)),
      why: [`${me.name} scores ${kd} knockdowns per 15 minutes`, `${last(them.name)} has been stopped by strikes in ${e.koLosses} of ${e.losses} losses`, thinNote([[me, f]])].filter(Boolean),
      note: `Not every book lists it; where none does, the price on ${last(me.name)} by KO/TKO is the nearest thing.`,
    };
  };
  return [one('a', a, b, bout.a, bout.b), one('b', b, a, bout.b, bout.a)].filter(Boolean);
}

/**
 * Another way to play the main pick, for a fight with no stat angle: the
 * lean's usual way of winning when the pick is the moneyline, the
 * moneyline when the pick is already a method. Null with no lean.
 */
export function alternatePlay(bout, a, b, breakdown) {
  const lean = breakdown?.lean;
  if (lean !== 'a' && lean !== 'b') return null;
  const f = lean === 'a' ? a : b; const me = lean === 'a' ? bout.a : bout.b;
  const straight = breakdown?.straight ?? { market: 'h2h' };
  if (straight.market !== 'h2h') {
    return { selection: `${me.name} moneyline`, why: 'The main pick names the way the fight is won; the moneyline is the same lean without that condition, at a shorter price.' };
  }
  const w = f?.methods?.wins ?? {};
  const ranked = ['ko', 'sub', 'dec'].map((k) => [k, w[k] ?? 0]).sort((x, y) => y[1] - x[1]);
  const wins = ranked.reduce((n, [, c]) => n + c, 0);
  if (wins < 4) return { selection: `${me.name} moneyline, smaller`, why: `Too few wins on record to say how ${last(me.name)} usually gets them, so there is no method worth naming: the moneyline at a reduced stake is the alternative.` };
  if (ranked[0][1] / wins >= 0.6) {
    return { selection: `${me.name} by ${METHOD_WORD[ranked[0][0]]}`, why: `${ranked[0][1]} of ${last(me.name)}'s ${wins} wins came that way, and it pays more than the moneyline does.` };
  }
  return { selection: `${me.name} by ${METHOD_WORD[ranked[0][0]]} or ${METHOD_WORD[ranked[1][0]]}`, why: `${ranked[0][1] + ranked[1][1]} of ${last(me.name)}'s ${wins} wins came one of those two ways; the double chance pays more than the moneyline and gives up only the least likely way of winning.` };
}

/**
 * The Sharp analysis for one bout.
 *
 * `a` and `b` are the two fighter profiles (the runner's, with `stats`
 * when a stat line was found); `breakdown` is the bout's read (its lean
 * and its straight), for the alternate.
 */
export function sharpRead({ bout, a = null, b = null, breakdown = null, now = Date.now() } = {}) {
  const minutes = expectedMinutes(a, b, bout?.rounds);
  const candidates = [
    strikesPlay(bout, a, b),
    ...takedownPlays(bout, a, b, minutes),
    ...durationPlays(bout, a, b),
    ...knockdownPlays(bout, a, b),
  ].filter(Boolean).sort((x, y) => y.strength - x.strength);
  // One play a family: the strongest of each.
  const seen = new Set();
  const plays = [];
  for (const c of candidates) {
    if (c.strength < SHARP_MIN || seen.has(c.family)) continue;
    seen.add(c.family); plays.push(c);
    if (plays.length === SHARP_MAX_PLAYS) break;
  }
  const missing = [[bout?.a, a], [bout?.b, b]].filter(([, f]) => !f?.stats || !has(f.stats.slpm)).map(([x]) => x?.name).filter(Boolean);
  const none = plays.length === 0;
  const near = none ? candidates[0] ?? null : null;
  return {
    at: now,
    plays,
    none,
    // The closest thing to an angle on a fight with none, said as what it is.
    near: near ? { selection: near.selection, strength: near.strength, why: near.why[0] } : null,
    alternate: none ? alternatePlay(bout, a, b, breakdown) : null,
    missing,
    minutes: Math.round(minutes),
  };
}
