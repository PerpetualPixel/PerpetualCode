/**
 * The Live tab's slips, one card a bet (2026-11-24, the owner: "instead of
 * having it expand for each [sportsbook], have the button on the bottom so
 * that when you click it, it's not proprietary to any book, but then it
 * opens up a bubble that allows you to pick your app of choice ... all the
 * icons for all the available sports books for that bet").
 *
 * The board builds the same live slip at every book that prices it, so a
 * game used to show the bet once a book. Here the slips on the same players
 * and stats are one bet: the best-priced book's slip leads the card (its
 * legs and numbers are the ones drawn), and every book that has it is a
 * choice under the one button.
 */

const legKey = (l) => `${String(l?.player ?? '').toLowerCase()}|${String(l?.stat ?? l?.label ?? '').toLowerCase()}`;
/** What makes two slips the same bet: the same players on the same stats, whatever the order and whatever each book's number. */
export const slipKey = (slip) => (slip?.legs ?? []).map(legKey).sort().join('+');
/** A slip's numbers in a line: "9.5+ Pts · 2.5+ Reb". */
export const slipNumbers = (slip) => (slip?.legs ?? []).map((l) => `${l.point}+ ${l.label ?? l.stat ?? ''}`.trim()).join(' · ');

/**
 * The slips as bets: [{key, lead, slips}], in the order the board gave
 * them (its best first). `slips` is every book's version, best price
 * first; `lead` is the first of them. A book whose numbers differ from the
 * lead's carries `differs: true` on its entry so the choice can say so.
 */
export function groupLiveSlips(slips) {
  const groups = new Map();
  for (const s of slips ?? []) {
    const key = slipKey(s);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return [...groups.entries()].map(([key, list]) => {
    const sorted = [...list].sort((a, b) => (Number(b.american) || 0) - (Number(a.american) || 0));
    const lead = sorted[0];
    const leadPoints = new Map(lead.legs.map((l) => [legKey(l), l.point]));
    return { key, lead, slips: sorted.map((s) => ({ ...s, differs: s !== lead && s.legs.some((l) => leadPoints.get(legKey(l)) !== l.point) })) };
  });
}

/**
 * The link from a Discord post straight to one slip on the Live tab (2026-11-25, the owner: "one click from
 * discord ... and import the live play fast"): app.html#live/<league>/<ESPN event id>/<slip key>. The app opens the
 * Live tab on that league, unfolds the game, opens the slip's "Add to sportsbook" picker and scrolls to it, so the
 * reader's next tap is their book. The slip is named by its key (the players and stats), which is the same at every
 * book and outlives a price change; a slip the board no longer has lands the reader on the game instead.
 */
export const LIVE_HASH_PREFIX = '#live/';
export function liveSlipHash(league, gameId, slipOrKey) {
  const key = typeof slipOrKey === 'string' ? slipOrKey : slipKey(slipOrKey);
  if (!league || !gameId || !key) return '';
  return `${LIVE_HASH_PREFIX}${encodeURIComponent(String(league))}/${encodeURIComponent(String(gameId))}/${encodeURIComponent(key)}`;
}
/** {league, gameId, key} from a hash liveSlipHash made, or null for any other hash. */
export function parseLiveHash(hash) {
  const m = String(hash ?? '').match(/^#live\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  try { return { league: decodeURIComponent(m[1]), gameId: decodeURIComponent(m[2]), key: decodeURIComponent(m[3]) }; } catch { return null; }
}
