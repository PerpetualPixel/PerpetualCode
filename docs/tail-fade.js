/**
 * Tail or Fade — matching a typed bet to this app's board, and dispatching
 * it to the grading engine (docs/take-or-fade.js) as either a slate of
 * independent bets or one parlay ticket.
 *
 * WHY THE ENGINE IS A SEPARATE FILE
 * ---------------------------------
 * This file answers "which market is the user talking about". take-or-fade.js
 * answers "is that bet any good". They fail in completely different ways — a
 * bad match attaches the right numbers to the wrong bet, a bad grade attaches
 * wrong numbers to the right one — so each is tested against its own failure
 * mode rather than through the other.
 *
 * WHAT THIS REPLACED, AND WHY IT MATTERS
 * --------------------------------------
 * The first version graded with `const tail = avg > -125` — the mean American
 * price against a made-up cutoff. Play of the Day is drawn from a -200..+150
 * band, so every Play of the Day heavier than -125 came back FADE,
 * deterministically, while the app itself was recommending it. The evidence
 * sections beneath were hardcoded strings, identical for every bet.
 *
 * Two structural properties now make that class of bug unrepresentable
 * rather than merely fixed:
 *
 *   1. A leg matching one of our own posted picks cannot grade below TAKE,
 *      and its opposite side cannot grade above FADE (the floors in
 *      take-or-fade.js's evaluateLeg). The selection pipeline already applied
 *      every gate that engine re-derives, to the same numbers.
 *   2. A bet matching nothing on the board returns NO READ with no
 *      confidence number, rather than a verdict invented from nothing.
 *
 * Pure and synchronous — no DOM, no network.
 */

import {
  evaluateLeg,
  evaluateSlate,
  evaluateParlay,
  CORRELATION_CONFLICT,
  CORRELATION_CANNIBAL,
  NO_READ,
  STRONG_TAKE,
  TAKE,
  LEAN_PASS,
  FADE,
  STRONG_FADE,
  isTakeSide,
  isFadeSide,
} from './take-or-fade.js';

export {
  NO_READ, STRONG_TAKE, TAKE, LEAN_PASS, FADE, STRONG_FADE, isTakeSide, isFadeSide,
};

/** The two ways a multi-leg entry can be meant. */
export const MODE_SLATE = 'slate';
export const MODE_PARLAY = 'parlay';

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

  for (const pick of postedPicks ?? []) {
    if (!pick.home || !pick.away) continue;
    // Only meaningful for two-outcome team markets; a prop naming a team
    // isn't the opposite of that team's moneyline.
    if (pick.marketKey !== 'h2h') continue;
    const legTokens = new Set(tokens(leg.selection));
    const namesOther = (team) => {
      const t = tokens(team);
      return t.length > 0 && t.every((w) => legTokens.has(w));
    };
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

/**
 * Grade every leg individually, then judge the ticket as a whole under the
 * chosen mode.
 *
 * Per-leg grading happens in BOTH modes and the per-leg reads are always
 * returned. That is the point of a mode toggle rather than two tools: a
 * parlay that grades FADE on one bad leg still has to say which of its other
 * legs were fine and worth betting straight, and a slate still has to say
 * which of its legs could reasonably be parlayed together. Discarding the
 * per-leg detail in parlay mode would leave the verdict actionable only as
 * "don't", which is the least useful true thing it could say.
 */
export function auditLegs(legs, {
  postedPicks = [],
  candidates = [],
  mode = MODE_SLATE,
  now = Date.now(),
} = {}) {
  const reads = (legs ?? []).map((leg, index) => {
    const posted = findPostedMatch(leg, postedPicks);
    const candidate = findCandidateMatch(leg, candidates);
    return {
      ...evaluateLeg(leg, {
        candidate,
        postedSide: posted?.side ?? null,
        postedLabel: posted?.pick?.surfaceLabel ?? null,
        now,
      }),
      posted: posted?.pick ?? null,
      index,
    };
  });

  const result = mode === MODE_PARLAY ? evaluateParlay(reads) : evaluateSlate(reads);
  const unmatchedCount = reads.filter((r) => r.verdict === NO_READ).length;

  return { ...result, mode, unmatchedCount, summary: summarize(result, unmatchedCount) };
}

/**
 * The executive summary — written from the result rather than from a
 * template, so it says what actually happened to these legs.
 */
function summarize(result, unmatchedCount) {
  const { reads } = result;
  if (result.verdict === NO_READ) {
    return 'None of these legs match a market currently on the board, so there is nothing here to check them against. '
      + 'Rather than guess, this returns no read — load the slate for the right league and day, or enter the bet as it appears on the board.';
  }

  const ours = reads.filter((r) => r.postedSide === 'same');
  const against = reads.filter((r) => r.postedSide === 'opposite');
  const parts = [];

  if (against.length) {
    parts.push(
      `${against.length === 1 ? 'One leg is' : `${against.length} legs are`} the opposite side of a bet this app has published today `
      + `(${[...new Set(against.map((r) => r.postedLabel))].join(', ')}), which is a fade on its own.`,
    );
  }
  if (ours.length) {
    parts.push(
      `${ours.length === 1 ? 'One leg is' : `${ours.length} legs are`} already on our own board `
      + `(${[...new Set(ours.map((r) => r.postedLabel))].join(', ')}), so the grade there agrees with the app by construction.`,
    );
  }

  if (result.mode === MODE_PARLAY) {
    const bad = result.badLegs?.length ?? 0;
    const solid = result.solidLegs?.length ?? 0;
    if (result.findings?.some((f) => f.kind === CORRELATION_CONFLICT)) {
      parts.push('Two legs are opposite sides of the same game, so this ticket cannot win as constructed — that alone is a strong fade.');
    } else if (bad) {
      parts.push(
        `${bad} of ${reads.length} legs fall short, and a parlay needs every one of them, so the ticket is a fade as built.`
        + (solid
          ? ` The ${solid} that do clear the bar are worth taking straight instead — they're marked above.`
          // Nothing clearing the bar is the common case for a slip taken at
          // one book, and "all of them fall short" on its own is a dead end.
          // The legs are not equal, so say which ones are carrying it.
          : (result.bestLegs?.length > 1
            ? ` None clear the bar, but they are not equal: ${result.bestLegs.slice(0, 2).map((r) => r.leg.selection).join(' and ')} `
              + `grade highest of the ${reads.length}, and a ticket cut down to those is a smaller mistake than this one.`
            : '')),
      );
    } else if (result.findings?.some((f) => f.kind === CORRELATION_CANNIBAL)) {
      parts.push('The legs are individually fine, but two of them draw from the same pool of possessions, so the real joint probability is lower than the combined price implies.');
    } else if (Number.isFinite(result.ev) && Number.isFinite(result.jointProb)) {
      parts.push(
        `Every leg clears the bar. At the market's own numbers the ticket lands about ${(result.jointProb * 100).toFixed(1)}% of the time, `
        + `worth ${(result.ev * 100).toFixed(1)}% expected value per unit.`,
      );
    }
  } else {
    const s = result.straights?.length ?? 0;
    const a = result.avoid?.length ?? 0;
    const m = result.marginal?.length ?? 0;
    parts.push(
      `Of ${reads.length} leg${reads.length === 1 ? '' : 's'}, ${s} ${s === 1 ? 'clears' : 'clear'} the bar this app takes its own picks at`
      + `${m ? `, ${m} ${m === 1 ? 'is' : 'are'} marginal` : ''}${a ? `, and ${a} should be avoided` : ''}.`,
    );
    if (result.suggestedTicket) {
      parts.push(
        `The ${result.suggestedTicket.legCount} best are in different games, so they can be parlayed without correlation — `
        + `about ${(result.suggestedTicket.jointProb * 100).toFixed(1)}% to land together.`,
      );
    } else if (s === 1) {
      parts.push('Only one leg clears, so there is no parlay worth building here — bet it straight.');
    }
  }

  if (unmatchedCount) {
    parts.push(
      `${unmatchedCount} leg${unmatchedCount === 1 ? '' : 's'} could not be matched to a priced market and ${unmatchedCount === 1 ? 'is' : 'are'} not covered by this.`,
    );
  }

  return parts.join(' ');
}
