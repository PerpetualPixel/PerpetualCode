/**
 * The UFC card at FanDuel as the runner wrote it (scripts/ufc-fanduel.mjs,
 * KV ufc:fanduel): each fight's markets with the marketId and the
 * selectionId a slip link needs. The parlay legs (worker/src/ufc-props.js)
 * take their FanDuel price and an addToBetslip link from here.
 */
export const UFC_FANDUEL_KEY = 'ufc:fanduel';

/** The tabs of a fight's page worth reading beside the default one: the method and the round markets. The minute specials are not legs the builder makes. */
export const FANDUEL_TABS = [/method/i, /round/i];

/** A tab's title as the page's own address for it: "Method of Victory" is method-of-victory. */
export const fanduelTabSlug = (title) => String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** One market trimmed to what a leg needs: its ids, its name and type, and each open runner's id, name, handicap and price. Null for a closed or empty market. */
export function trimFanduelMarket(m) {
  if (!m?.marketId || (m.marketStatus && m.marketStatus !== 'OPEN')) return null;
  const runners = (m.runners ?? []).filter((r) => r?.selectionId != null && (!r.runnerStatus || r.runnerStatus === 'ACTIVE')).map((r) => {
    const american = Number(r.winRunnerOdds?.americanDisplayOdds?.americanOddsInt ?? r.winRunnerOdds?.americanDisplayOdds?.americanOdds);
    return { selectionId: r.selectionId, runnerName: r.runnerName ?? '', handicap: Number(r.handicap) || 0, american: Number.isFinite(american) ? american : null };
  });
  if (!runners.length) return null;
  return { marketId: String(m.marketId), marketName: m.marketName ?? '', marketType: m.marketType ?? '', sgm: Boolean(m.sgmMarket), runners };
}
