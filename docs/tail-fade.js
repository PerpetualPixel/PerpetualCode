/**
 * Tail or Fade — the audit itself, as pure functions.
 *
 * WHY THIS EXISTS AS A REWRITE RATHER THAN A NEW FEATURE
 * -----------------------------------------------------
 * The first version of this shipped with a placeholder verdict:
 *
 *     const tail = avg > -125;
 *
 * — the average American price across the slip, against a made-up cutoff,
 * with no connection to the engine at all. That is not merely imprecise, it
 * is actively wrong in a specific and damaging way: Play of the Day is
 * selected from a -200..+150 band, so ANY Play of the Day priced heavier
 * than -125 was guaranteed to come back FADE. The app told the user to take
 * a bet and this tool told them to fade it, every single time, and the
 * disagreement carried exactly zero information about the bet.
 *
 * The fix is not a better heuristic. It is that a second opinion on this
 * app's own board has to be computed from the same evidence the board was
 * computed from. So:
 *
 *   1. A leg that IS one of the app's own posted picks returns TAIL, and
 *      says which surface posted it. Not "usually" — by construction. The
 *      app contradicting itself is now unrepresentable rather than
 *      unlikely.
 *   2. A leg that is the OPPOSITE side of one of our posted picks returns
 *      FADE, for the same reason and with the same certainty.
 *   3. Anything else is judged against the live engine numbers already in
 *      the browser — score, EV, no-vig consensus probability, form signal —
 *      using RULES, the same thresholds every other surface uses.
 *   4. A bet that matches nothing the app has priced returns NO READ. It
 *      does not return a guess. "I can't see this market" is a real answer
 *      and the honest one; inventing a verdict there is what produced the
 *      original bug.
 *
 * Everything reported traces to a number the app already holds. There are
 * no invented statistics in this module — the previous version's
 * "hit in 7 of its last 10 (70%)" and "usage up to 28.9%" were literal
 * string constants, shown to a user as if they were a read on their bet.
 *
 * Pure and synchronous — no DOM, no network, no fetches. Same contract as
 * engine.js, so it is unit-testable without a browser.
 */

import { RULES, formatAmerican, impliedProb } from './engine.js';

/** Verdicts this can return. NO_READ is a real outcome, not an error. */
export const TAIL = 'TAIL';
export const FADE = 'FADE';
export const NO_READ = 'NO READ';

/** Words that carry no identifying information when matching free text to a market. */
const STOP_WORDS = new Set([
  'the', 'to', 'win', 'at', 'vs', 'v', 'over', 'under', 'and', 'or', 'of', 'on',
  'ml', 'moneyline', 'money', 'line', 'spread', 'total', 'points', 'pts',
  'a', 'an', 'in', 'for', 'plus', 'minus',
]);

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalizeSelection(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return normalizeSelection(text).split(' ').filter((w) => w && !STOP_WORDS.has(w));
}

/**
 * How strongly a free-text leg identifies a given market, 0..1.
 *
 * Deliberately asymmetric: it measures what fraction of the TARGET's
 * identifying words the user's text covers, not the other way round. A user
 * types "Aces ML" for a market whose selection is "Las Vegas Aces to win" —
 * the user's text is shorter and that must still match. Scoring by overlap
 * over the union would penalise exactly the terse input people actually
 * type.
 */
export function matchStrength(legText, targetText) {
  const target = tokens(targetText);
  if (!target.length) return 0;
  const leg = new Set(tokens(legText));
  if (!leg.size) return 0;
  const covered = target.filter((w) => leg.has(w)).length;
  return covered / target.length;
}

/**
 * Minimum coverage before a free-text leg is treated as naming a specific
 * market. Set high on purpose: a wrong match is worse than no match here,
 * because it would attach real numbers from one bet to a different one and
 * present them as a read — the same class of error this rewrite exists to
 * remove. Below the bar the leg is simply unmatched, which is a supported,
 * honestly-reported outcome.
 */
export const MATCH_MIN = 0.6;

/** The best match for a leg among `items`, keyed by each item's own selection text. */
function bestMatch(leg, items, selectionOf) {
  let best = null;
  for (const item of items ?? []) {
    const strength = matchStrength(leg.selection, selectionOf(item));
    if (strength >= MATCH_MIN && (!best || strength > best.strength)) best = { item, strength };
  }
  return best;
}

/**
 * A posted pick this leg refers to, and whether the user is on OUR side of
 * it or the other one.
 *
 * The opposite-side test is what makes a FADE meaningful rather than
 * decorative: same game, same market, different selection means the user is
 * betting against a pick this app has published, which is the one case
 * where a confident FADE is genuinely earned.
 */
export function findPostedMatch(leg, postedPicks) {
  const same = bestMatch(leg, postedPicks, (p) => p.selection);
  if (same) return { pick: same.item, side: 'same', strength: same.strength };

  // Not our selection — but is it the same game? If the leg names both
  // teams of a game we posted, and doesn't match our selection, it's the
  // other side of it.
  for (const pick of postedPicks ?? []) {
    if (!pick.home || !pick.away) continue;
    const legTokens = new Set(tokens(leg.selection));
    const namesOther = (team) => {
      const t = tokens(team);
      return t.length > 0 && t.every((w) => legTokens.has(w));
    };
    // Only meaningful for two-outcome team markets; a prop naming a team
    // isn't the opposite of that team's moneyline.
    if (pick.marketKey !== 'h2h') continue;
    if (namesOther(pick.home) || namesOther(pick.away)) {
      return { pick, side: 'opposite', strength: 1 };
    }
  }
  return null;
}

/** The live analyzed market this leg refers to, if the board has one. */
export function findCandidateMatch(leg, candidates) {
  return bestMatch(leg, candidates, (c) => c.selection)?.item ?? null;
}

/** A 0-100 engine score onto the 1-10 confidence the card shows. */
function confidenceFromScore(score) {
  if (!Number.isFinite(score)) return 5;
  return Math.max(1, Math.min(10, Math.round(score / 10)));
}

/**
 * One leg's read. `stance` is 'tail' | 'fade' | 'unknown' — deliberately
 * three-valued, because "the board has no opinion on this" is different
 * from "the board dislikes this" and collapsing them is what the old mock
 * did.
 */
export function readLeg(leg, { postedPicks = [], candidates = [] } = {}) {
  const posted = findPostedMatch(leg, postedPicks);

  if (posted?.side === 'same') {
    return {
      leg,
      posted: posted.pick,
      side: 'same',
      candidate: findCandidateMatch(leg, candidates),
      stance: 'tail',
      confidence: confidenceFromScore(posted.pick.score),
      why: `This is our own ${posted.pick.surfaceLabel}${
        Number.isFinite(posted.pick.score) ? ` (confidence ${Math.round(posted.pick.score)}/100)` : ''
      }.`,
    };
  }

  if (posted?.side === 'opposite') {
    return {
      leg,
      posted: posted.pick,
      side: 'opposite',
      candidate: findCandidateMatch(leg, candidates),
      stance: 'fade',
      confidence: confidenceFromScore(posted.pick.score),
      why: `This is the other side of our ${posted.pick.surfaceLabel} on ${posted.pick.away} @ ${posted.pick.home}, which is on ${posted.pick.selection}.`,
    };
  }

  const candidate = findCandidateMatch(leg, candidates);
  if (!candidate) {
    return {
      leg,
      posted: null,
      side: null,
      candidate: null,
      stance: 'unknown',
      confidence: null,
      why: 'No market on the current board matches this leg, so there is nothing to check it against.',
    };
  }

  const clearsScore = Number(candidate.score) >= RULES.MIN_SCORE;
  const positiveEv = Number(candidate.ev) > 0;
  const stance = clearsScore && positiveEv ? 'tail' : 'fade';
  return {
    leg,
    posted: null,
    side: null,
    candidate,
    stance,
    confidence: confidenceFromScore(candidate.score),
    why: stance === 'tail'
      ? `Grades ${Math.round(candidate.score)}/100 with ${(candidate.ev * 100).toFixed(1)}% expected value — above the ${RULES.MIN_SCORE} bar this app takes a pick at.`
      : `Grades ${Math.round(candidate.score)}/100 with ${(candidate.ev * 100).toFixed(1)}% expected value — ${
        clearsScore ? 'no positive expected value at this price' : `below the ${RULES.MIN_SCORE} confidence bar`
      }.`,
  };
}

/** Real price facts, from numbers analyze() already computed. Never invented. */
function statisticalFor(reads) {
  const out = [];
  for (const r of reads) {
    const c = r.candidate;
    const name = r.leg.selection;
    if (!c) {
      out.push(`${name}: not on the current board, so no market read is available.`);
      continue;
    }
    out.push(
      `${name}: market's no-vig consensus makes this a ${(c.consensusProb * 100).toFixed(1)}% shot ` +
      `(fair value ${formatAmerican(c.fairAmerican)}); best price on the board is ${formatAmerican(c.american)} at ${c.book}.`,
    );
    out.push(
      `${name}: ${c.bookCount} books priced it, disagreeing by ±${(c.disagreement * 100).toFixed(1)}% — ` +
      `${c.disagreement < 0.015 ? 'a tight consensus, so an outlier price means something' : 'a soft market, so the edge is less reliable'}.`,
    );
    if (r.leg.american != null && Number.isFinite(c.american) && r.leg.american !== c.american) {
      const yours = impliedProb(r.leg.american);
      const bestAvailable = impliedProb(c.american);
      out.push(
        `${name}: you have ${formatAmerican(r.leg.american)} against ${formatAmerican(c.american)} available — ` +
        `${yours > bestAvailable ? `worse than the board's best price by ${((yours - bestAvailable) * 100).toFixed(1)} points of implied probability` : 'better than the board\'s best price'}.`,
      );
    }
  }
  return out.length ? out : ['Nothing on this slip could be matched to a priced market.'];
}

/** Context that actually exists: our own posted reasoning, and the form signal. */
function contextualFor(reads) {
  const out = [];
  for (const r of reads) {
    if (r.posted) {
      out.push(`${r.leg.selection}: ${r.why}`);
      for (const reason of (r.posted.reasons ?? []).slice(0, 3)) out.push(`${r.leg.selection}: ${reason}`);
      for (const section of (r.posted.sections ?? [])) {
        for (const bullet of (section.bullets ?? []).slice(0, 2)) out.push(`${r.leg.selection}: ${bullet}`);
      }
    }
    const c = r.candidate;
    if (c && Number.isFinite(c.formSignal)) {
      out.push(
        `${r.leg.selection}: recent form and injuries score this side ${c.formSignal > 0 ? 'ahead of' : 'behind'} ` +
        `its opponent (${c.formSignal > 0 ? '+' : ''}${c.formSignal.toFixed(2)} on a -1 to +1 scale).`,
      );
    }
    if (c && Number.isFinite(c.commenceMs)) {
      out.push(`${r.leg.selection}: ${c.marketLabel ?? c.marketKey} on ${c.away} @ ${c.home}.`);
    }
  }
  return out.length ? out : ['No contextual data is available for this bet on the current board.'];
}

/** Risks that are actually present in this specific slip, not stock copy. */
function riskFor(reads) {
  const out = [];
  const unmatched = reads.filter((r) => r.stance === 'unknown');
  if (unmatched.length) {
    out.push(
      `${unmatched.length} of ${reads.length} leg${reads.length === 1 ? '' : 's'} could not be matched to a priced market, ` +
      `so ${unmatched.length === reads.length ? 'this verdict rests on nothing' : 'the verdict only covers the legs that did match'}.`,
    );
  }
  if (reads.length > 1) {
    const priced = reads.filter((r) => r.candidate);
    if (priced.length > 1) {
      const joint = priced.reduce((p, r) => p * Number(r.candidate.consensusProb ?? 0), 1);
      out.push(
        `A ${reads.length}-leg parlay needs every leg to land: the market's own numbers put that at about ` +
        `${(joint * 100).toFixed(1)}%, so one leg going wrong loses the whole ticket.`,
      );
    }
    const sameGame = new Set(priced.map((r) => r.candidate.eventId));
    if (sameGame.size < priced.length) {
      out.push('Two or more legs are on the same game, so they are correlated — the combined price does not reflect that.');
    }
  }
  for (const r of reads) {
    const c = r.candidate;
    if (c && Number(c.consensusProb) < 0.4) {
      out.push(
        `${r.leg.selection} is a genuine underdog at ${(c.consensusProb * 100).toFixed(1)}% — this app's own record ` +
        `on long shots is why it discounts them (see the long-shot penalty in the engine).`,
      );
    }
    if (c && Number(c.disagreement) >= 0.05) {
      out.push(`${r.leg.selection} is priced across a wide spread of books, which usually means late news the market has not settled on.`);
    }
  }
  return out.length ? out : ['No specific structural risk stands out on this slip beyond the price itself.'];
}

/**
 * The audit. Returns the same shape the drawer has always rendered, so the
 * render path is unchanged — but every value in it now traces to something
 * the app actually computed.
 */
export function auditLegs(legs, { postedPicks = [], candidates = [] } = {}) {
  const reads = (legs ?? []).map((leg) => readLeg(leg, { postedPicks, candidates }));

  const anyOpposite = reads.some((r) => r.side === 'opposite');
  const matched = reads.filter((r) => r.stance !== 'unknown');
  const anyFade = matched.some((r) => r.stance === 'fade');

  let verdict;
  if (!matched.length) verdict = NO_READ;
  else if (anyOpposite || anyFade) verdict = FADE;
  else verdict = TAIL;

  // A slip is only as good as its weakest matched leg, which is also how
  // the rest of the app reasons about a parlay — so confidence is the
  // minimum across matched legs, not an average that lets one strong leg
  // paper over a weak one.
  const confidences = matched.map((r) => r.confidence).filter(Number.isFinite);
  const confidence = verdict === NO_READ ? 0 : (confidences.length ? Math.min(...confidences) : 5);

  const ourPicks = reads.filter((r) => r.side === 'same').map((r) => r.posted.surfaceLabel);
  const summary = (() => {
    if (verdict === NO_READ) {
      return 'None of these legs match a market currently on the board, so there is nothing here to check them against. '
        + 'Rather than guess, this returns no read — load the slate for the right league and day, or enter the bet as it appears on the board.';
    }
    if (anyOpposite) {
      const opp = reads.find((r) => r.side === 'opposite');
      return `This is the opposite side of our own ${opp.posted.surfaceLabel}, which is on ${opp.posted.selection}. `
        + 'Fading it means betting against a pick this app has already published, so the call here is FADE for exactly that reason.';
    }
    if (ourPicks.length) {
      return `${ourPicks.length === reads.length ? 'Every leg here is' : 'This includes'} a pick this app has already posted — `
        + `${[...new Set(ourPicks)].join(', ')} — so the verdict agrees with the board by construction rather than by coincidence. `
        + 'The confidence shown is the pick\'s own grade, not a separate opinion.';
    }
    const worst = matched.reduce((a, b) => (a.confidence <= b.confidence ? a : b));
    return verdict === TAIL
      ? `Every matched leg clears the same bar this app takes its own picks at. The weakest is ${worst.leg.selection}, which ${worst.why.toLowerCase()}`
      : `At least one leg falls short of the bar this app takes its own picks at. ${worst.leg.selection}: ${worst.why.toLowerCase()}`;
  })();

  return {
    verdict,
    confidence,
    statistical: statisticalFor(reads),
    contextual: contextualFor(reads),
    risk: riskFor(reads),
    summary,
    reads,
    unmatchedCount: reads.length - matched.length,
  };
}
