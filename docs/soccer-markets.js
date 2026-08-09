/**
 * MLS's low-variance alternative markets — Both Teams to Score (BTTS) and
 * Double Chance — as a substitute for a plain 3-way soccer moneyline, which
 * is high-variance specifically because of the draw outcome.
 *
 * Both settle straight from the same final home/away score every other
 * market in docs/learning.js already uses (gradeGeneric passes its already-
 * extracted homeScore/awayScore straight through) — unlike the player-prop
 * markets elsewhere in this app, this needed no new data source at all.
 *
 * Pure functions only, same boundary as every other docs/ module.
 */

function voidResult(reason) {
  return { void: true, reason, payout: 0 };
}

/** Case/punctuation/diacritic-insensitive containment check — same technique as docs/mlb-props.js's normalizeName. */
function normalize(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Yes/No — did both teams score at least once. No push is possible: a final
 * score always answers this cleanly. Returns just `{won}`, matching
 * docs/learning.js's gradeGeneric sibling branches (h2h/spreads/totals) —
 * that function's own caller (gradePick) computes payout once, uniformly,
 * for all of them.
 */
export function gradeBtts(pick, homeScore, awayScore) {
  const bothScored = homeScore >= 1 && awayScore >= 1;
  return { won: pick.outcomeName === 'Yes' ? bothScored : !bothScored };
}

/**
 * Double Chance covers two of the three 1X2 outcomes (e.g. "home win or
 * draw"). The Odds API's exact outcome-name wording for this market wasn't
 * confirmed against a live response before this shipped (only that the
 * market key itself, `double_chance`, exists) — so rather than assume one
 * exact string format, this detects which two outcomes a label covers by
 * checking whether it mentions the home team's name, the away team's name,
 * and/or the word "draw", which holds across the common label conventions
 * ("Team A or Draw", "Team A/Draw", etc.). Any label that doesn't clearly
 * resolve to exactly two of the three outcomes returns null — fail closed,
 * consistent with every other settlement path in this app — rather than
 * guess at a format that turns out to be wrong.
 */
export function gradeDoubleChance(pick, homeScore, awayScore) {
  const label = normalize(pick.outcomeName);
  const home = normalize(pick.home);
  const away = normalize(pick.away);
  const hasHome = home.length > 0 && label.includes(home);
  const hasAway = away.length > 0 && label.includes(away);
  const hasDraw = /\bdraw\b/.test(label) || /\btie\b/.test(label);

  const covers = { home: false, draw: false, away: false };
  if (hasHome && hasDraw && !hasAway) { covers.home = true; covers.draw = true; }
  else if (hasAway && hasDraw && !hasHome) { covers.away = true; covers.draw = true; }
  else if (hasHome && hasAway && !hasDraw) { covers.home = true; covers.away = true; }
  // Couldn't confidently resolve this label to exactly two outcomes — voids
  // rather than leaving the pick pending forever (a parsing gap, unlike a
  // genuinely undecided match, is never going to resolve itself on a later
  // tick), and rather than guessing at a label format that turns out wrong.
  else return voidResult('double chance label did not resolve to two recognized outcomes');

  const homeWin = homeScore > awayScore;
  const awayWin = awayScore > homeScore;
  const draw = homeScore === awayScore;
  const won = (covers.home && homeWin) || (covers.away && awayWin) || (covers.draw && draw);
  return { won };
}
