/**
 * Red flags in the Parlay Builder (2026-11-26, the owner: "a toggle on the
 * parlay generator to include or exclude red flagged players and if
 * someone has the toggle on, tell them how many were not included ... '7
 * players left out due to red flag indicators' ... if they have it
 * toggled off (by default), let them know by having a red flag on their
 * card and some text saying '2 out of 10 results have red flag
 * indicators' as a warning").
 *
 * A red flag is a reason to stay off a line, the kind the "Too good to be
 * true?" card calls a likely trap: a teammate back in the lineup, minutes
 * down, a change of team (docs/line-check.js, worker/src/line-check.js).
 * The worker reads them for a list of lines at a time (/trends/flags);
 * these are the pure parts: which lines can be checked, the next list to
 * ask for, and the pick of a ticket's legs with the flagged ones left out.
 */

/** The most lines, and the most teams among them, asked for in one request (the worker reads one record a team). */
export const FLAG_BATCH = 30;
export const FLAG_TEAMS = 12;
/** The most rounds of asking one build makes before it stops looking further down the list. */
export const FLAG_ROUNDS = 8;
/** How long a line's answer is kept. */
export const FLAG_TTL_MS = 10 * 60e3;

/** A line the check covers: a player prop in a league the Trends board runs (a fight or a tennis match has no such check). */
export const checkable = (row, sports = null) => Boolean(row && row.id && !row.ufc && !row.tennis && (sports == null || sports.includes(row.sportKey)));

/**
 * The next list to ask the worker for: the first lines in `rows` (the
 * order they would be picked in) with no answer yet, all of one league,
 * up to FLAG_BATCH lines across FLAG_TEAMS teams. `known(row)` says
 * whether a line already has its answer. Null when nothing is left to ask.
 */
export function nextFlagBatch(rows, known, { batch = FLAG_BATCH, teams = FLAG_TEAMS } = {}) {
  let sportKey = null;
  const ids = [];
  const seenTeams = new Set();
  for (const row of rows ?? []) {
    if (!row?.id || known(row) || ids.includes(row.id)) continue;
    if (sportKey === null) sportKey = row.sportKey;
    if (row.sportKey !== sportKey) continue;
    const team = String(row.team ?? '');
    if (!seenTeams.has(team) && seenTeams.size >= teams) continue;
    seenTeams.add(team);
    ids.push(row.id);
    if (ids.length >= batch) break;
  }
  return ids.length ? { sportKey, ids } : null;
}

/**
 * A ticket's open slots filled from `order`, the candidates best first.
 *
 * `flagsOf(c)` is a candidate's red flags: a list (empty for none), or
 * undefined when the answer is not in yet. With `noRed` on, a flagged
 * candidate is passed over and counted, and one with no answer stops the
 * walk (`pending`: ask for more and walk again) unless `skipUnknown`,
 * which passes it over uncounted. With `noRed` off every candidate is
 * taken as it comes. `chosen` is what earlier passes took; `fits(c,
 * picked)` is any other rule of the ticket (a pick'em lineup needs two
 * teams); one leg a `key` (a player, a bout).
 *
 * Returns {chosen, leftOut, pending}: the picks (the earlier ones first),
 * the flagged candidates passed over, and the first candidate still
 * waiting on its answer, if the walk stopped on one.
 */
export function pickLegs(order, want, { flagsOf = () => [], noRed = false, skipUnknown = false, chosen = [], fits = () => true } = {}) {
  const picked = [...chosen];
  const leftOut = [];
  for (const c of order ?? []) {
    if (picked.length >= want) break;
    if (picked.some((x) => x.key === c.key)) continue;
    if (!fits(c, picked)) continue;
    if (noRed) {
      const flags = flagsOf(c);
      if (flags === undefined) { if (skipUnknown) continue; return { chosen: picked, leftOut, pending: c }; }
      if (flags.length) { if (!leftOut.some((x) => x.key === c.key)) leftOut.push(c); continue; }
    }
    picked.push(c);
  }
  return { chosen: picked, leftOut, pending: null };
}

/**
 * The whole pick, the way the builder rotates its pool: first the
 * candidates not shown on an earlier build (`seen`, by line id), then,
 * when those do not fill the ticket, the whole pool again. Returns
 * {chosen, leftOut, pending, rotated}: `rotated` says the second pass ran
 * (the caller starts its `seen` over), and `leftOut` counts a player once.
 */
export function pickTicket(pool, want, seen, opts = {}) {
  const fresh = (pool ?? []).filter((c) => !seen?.has?.(c.row?.id));
  const first = pickLegs(fresh, want, opts);
  if (first.pending || first.chosen.length >= want) return { ...first, rotated: false };
  const second = pickLegs(pool, want, { ...opts, chosen: first.chosen });
  const leftOut = [...first.leftOut];
  for (const c of second.leftOut) if (!leftOut.some((x) => x.key === c.key)) leftOut.push(c);
  return { chosen: second.chosen, leftOut, pending: second.pending, rotated: true };
}

/** "7 players left out due to red flag indicators." */
export const leftOutText = (n) => `${n} player${n === 1 ? '' : 's'} left out due to red flag indicators.`;
/** "2 out of 10 results have red flag indicators." */
export const flaggedText = (flagged, total) => `${flagged} out of ${total} result${total === 1 ? '' : 's'} ${flagged === 1 ? 'has' : 'have'} red flag indicators.`;
