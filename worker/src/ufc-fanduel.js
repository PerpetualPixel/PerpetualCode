/**
 * The UFC card at FanDuel as the runner wrote it (scripts/ufc-fanduel.mjs,
 * KV ufc:fanduel): each fight's markets with the marketId and the
 * selectionId a slip link needs. The parlay legs (worker/src/ufc-props.js)
 * take their FanDuel price and an addToBetslip link from here.
 */
import { americanToDecimal } from '../../docs/engine.js';
import { matchupFor } from './ufc-prop-odds.js';

export const UFC_FANDUEL_KEY = 'ufc:fanduel';

/**
 * The tabs of a fight's page worth reading beside the default one: the
 * method and the round markets, and the fight-stat ones the Sharp analysis
 * prices (most significant strikes, takedowns), under whatever heading
 * FanDuel files them that week. The minute specials are not legs the
 * builder makes.
 */
export const FANDUEL_TABS = [/method/i, /round/i, /strike/i, /takedown/i, /stat/i, /fight(er)? prop/i];

/** A tab's title as the page's own address for it: "Method of Victory" is method-of-victory. */
export const fanduelTabSlug = (title) => String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * One market trimmed to what a leg needs: its ids, its name and type, and each open runner's id, name, handicap and price. Null for a closed or empty market.
 *
 * A market has two ids. `marketId` ("734.199858730") is the page's own; `slipId` ("42.629110703", the page's
 * associatedMarkets[].externalMarketId) is the one the slip link takes. 2026-11-27, the owner, with the FanDuel app's
 * "Selection not added" on a tennis moneyline that was on the book: every link had been built from the page's own id,
 * while the odds feed's FanDuel links, which do open a slip, carry the other one.
 */
export function trimFanduelMarket(m) {
  if (!m?.marketId || (m.marketStatus && m.marketStatus !== 'OPEN')) return null;
  const runners = (m.runners ?? []).filter((r) => r?.selectionId != null && (!r.runnerStatus || r.runnerStatus === 'ACTIVE')).map((r) => {
    const american = Number(r.winRunnerOdds?.americanDisplayOdds?.americanOddsInt ?? r.winRunnerOdds?.americanDisplayOdds?.americanOdds);
    return { selectionId: r.selectionId, runnerName: r.runnerName ?? '', handicap: Number(r.handicap) || 0, american: Number.isFinite(american) ? american : null };
  });
  if (!runners.length) return null;
  const slipId = (m.associatedMarkets ?? []).map((x) => x?.externalMarketId).find((id) => typeof id === 'string' && id.trim());
  return { marketId: String(m.marketId), ...(slipId ? { slipId: slipId.trim() } : {}), marketName: m.marketName ?? '', marketType: m.marketType ?? '', sgm: Boolean(m.sgmMarket), runners };
}

/** The id of a trimmed market that a slip link takes: the external one, and the page's own for a market read before it was kept. */
export const fanduelSlipId = (market) => market?.slipId ?? market?.marketId ?? null;

/** The card from KV, or null. */
export async function readFanduel(env) {
  const raw = await env.POTD_KV.get(UFC_FANDUEL_KEY).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** The link that puts one selection on a FanDuel slip; several of them join into one (docs/app.js combinedSlipLink). */
export const fanduelSlipLink = (marketId, selectionId) => `https://sportsbook.fanduel.com/addToBetslip?marketId=${encodeURIComponent(marketId)}&selectionId=${encodeURIComponent(selectionId)}`;

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const FD_METHOD = { ko: 'ko/tko', sub: 'submission', dec: 'points' };
/** A market by its type, the five-round card's own variant included ("WHAT_ROUND_WILL_FIGHT_END_(5_ROUNDS)"). */
const marketOf = (fight, type) => (fight.markets ?? []).find((m) => m.marketType === type || m.marketType === `${type}_(5_ROUNDS)`) ?? null;
const runnerOf = (market, name) => (market?.runners ?? []).find((r) => norm(r.runnerName) === norm(name)) ?? null;

/**
 * FanDuel's market and runner for a leg, in FanDuel's own wording:
 *
 *   ml            Moneyline                        "<fighter>"
 *   rounds        Total Rounds                     "Over (2.5)" at the leg's own number
 *   distance      Will the fight go the distance?  "Yes" / "No"
 *   round_start   Fight To Start Round N           "Yes" / "No"
 *   method        Method of Victory                "<fighter> by KO/TKO" / "by Submission" / "by Points"
 *   end_method    How fight will End               "KO/TKO" / "Submission" / "Points"
 *   end_round     What Round will Fight End        "Round N"
 *   method_round  Method & Round Combo             "<fighter> KO/TKO & Round N"
 *   win_round     Round Betting                    "<fighter> to Win in Round N"
 *
 * `fighter` is FanDuel's name for the leg's side. Null for a leg FanDuel
 * has no market for (a fighter inside the distance by either finish).
 */
export function fanduelRunnerFor(leg, fight, fighter) {
  const k = leg.method ?? null;
  const round = Number.isFinite(leg.round) ? leg.round : Number((/Round (\d)/.exec(String(leg.selection ?? '')) ?? [])[1]) || null;
  const pick = (type, name) => { const market = marketOf(fight, type); const runner = runnerOf(market, name); return market && runner ? { market, runner } : null; };
  switch (leg.prop) {
    case 'ml': return fighter ? pick('MATCH_BETTING', fighter) : null;
    case 'rounds': return Number.isFinite(leg.point) ? pick('TOTAL_ROUNDS', `${leg.sideWord === 'under' ? 'Under' : 'Over'} (${leg.point})`) : null;
    case 'distance': return pick('WILL_THE_FIGHT_GO_THE_DISTANCE?', /does not/i.test(String(leg.selection ?? '')) ? 'No' : 'Yes');
    case 'round_start': return round ? pick(`FIGHT_TO_START_ROUND_${round}`, leg.answer === 'no' ? 'No' : 'Yes') : null;
    case 'method': return fighter && FD_METHOD[k] ? pick('METHOD_OF_VICTORY', `${fighter} by ${FD_METHOD[k]}`) : null;
    case 'end_method': return pick('HOW_FIGHT_WILL_END', k === 'dec' || /Points/.test(leg.selection ?? '') ? 'Points' : /KO/.test(leg.selection ?? '') ? 'KO/TKO' : /Submission/.test(leg.selection ?? '') ? 'Submission' : '');
    case 'end_round': return round ? pick('WHAT_ROUND_WILL_FIGHT_END', `Round ${round}`) : null;
    case 'method_round': return fighter && round && (k === 'ko' || k === 'sub') ? pick('METHOD_&_ROUND_COMBO', `${fighter} ${FD_METHOD[k]} & Round ${round}`) : null;
    case 'win_round': return fighter && round ? pick('ROUND_BETTING', `${fighter} to Win in Round ${round}`) : null;
    default: return null;
  }
}

/** FanDuel's fight for a bout and its two names for the fighters, or null when the card has no such fight. */
export function fanduelFightFor(bout, card) {
  const board = { events: [{ matchups: (card?.events ?? []).map((e) => ({ fighters: String(e.name ?? '').split(/\s+v\s+/i), fight: e })) }] };
  const hit = matchupFor(bout, board);
  if (!hit || hit.matchup.fighters.length !== 2) return null;
  return { fight: hit.matchup.fight, names: { a: hit.matchup.fighters[hit.aIndex], b: hit.matchup.fighters[1 - hit.aIndex] } };
}

/**
 * FanDuel's market and runner for one Sharp play (worker/src/ufc-sharp.js),
 * or null when it does not list the bet:
 *
 *   strikes     a market named "Most Significant Strikes"     "<fighter>"
 *   takedowns   a market naming the fighter and "Takedowns"   "Over" at the play's number
 *   distance, round_start   as fanduelRunnerFor has them
 *
 * The two stat markets are found by name, not by type: FanDuel posts them
 * in fight week only, and their type codes were not on any page read when
 * this was written.
 */
export function fanduelSharpRunner(play, fight, names) {
  if (play.prop === 'distance' || play.prop === 'round_start') return fanduelRunnerFor(play, fight, null);
  const fighter = play.side ? names[play.side] : null;
  if (!fighter) return null;
  const surname = norm(fighter).split(' ').at(-1);
  const markets = fight.markets ?? [];
  if (play.key === 'strikes') {
    const market = markets.find((m) => /most significant strikes/i.test(m.marketName) && !/round/i.test(m.marketName));
    const runner = runnerOf(market, fighter) ?? (market?.runners ?? []).find((r) => norm(r.runnerName).split(' ').at(-1) === surname) ?? null;
    return market && runner ? { market, runner } : null;
  }
  if (play.family === 'takedowns' && Number.isFinite(play.line)) {
    const market = markets.find((m) => /takedown/i.test(m.marketName) && norm(m.marketName).includes(surname));
    const runner = (market?.runners ?? []).find((r) => /^over\b/i.test(r.runnerName) && (r.handicap === play.line || r.runnerName.includes(String(play.line)))) ?? null;
    return market && runner ? { market, runner } : null;
  }
  return null;
}

/** The plays with FanDuel's price and slip link on those it lists (`quote`), and none on the rest. Changes the plays in place. */
export function quoteSharpPlays(plays, bout, card) {
  const hit = fanduelFightFor(bout, card);
  for (const play of plays ?? []) {
    const found = hit ? fanduelSharpRunner(play, hit.fight, hit.names) : null;
    if (found && Number.isFinite(found.runner.american)) {
      play.quote = { bookId: 'fanduel', book: 'FanDuel', american: found.runner.american, link: fanduelSlipLink(fanduelSlipId(found.market), found.runner.selectionId) };
    } else {
      delete play.quote;
    }
  }
  return plays;
}

/**
 * The legs with FanDuel's own price and slip link: a leg FanDuel lists
 * gets a FanDuel quote that opens its slip with the selection on it, in
 * place of any FanDuel price the board or the feed gave (those link to a
 * page, not a slip). Returns {legs, matched, linked}.
 */
export function priceLegsFromFanduel(legs, bout, card) {
  const board = { events: [{ matchups: (card?.events ?? []).map((e) => ({ fighters: String(e.name ?? '').split(/\s+v\s+/i), fight: e })) }] };
  const hit = matchupFor(bout, board);
  if (!hit || hit.matchup.fighters.length !== 2) return { legs, matched: false, linked: 0 };
  const fight = hit.matchup.fight;
  const names = { a: hit.matchup.fighters[hit.aIndex], b: hit.matchup.fighters[1 - hit.aIndex] };
  let linked = 0;
  const out = legs.map((leg) => {
    const found = fanduelRunnerFor(leg, fight, leg.side ? names[leg.side] : null);
    if (!found || !Number.isFinite(found.runner.american)) return leg;
    const quote = { bookId: 'fanduel', book: 'FanDuel', american: found.runner.american, decimal: americanToDecimal(found.runner.american), link: fanduelSlipLink(fanduelSlipId(found.market), found.runner.selectionId), source: 'fanduel', sgm: found.market.sgm };
    const quotes = [...(leg.quotes ?? []).filter((q) => q.bookId !== 'fanduel' && q.bookId !== 'engine'), quote].sort((x, y) => y.american - x.american);
    linked++;
    return { ...leg, quotes, priced: true, note: null };
  });
  return { legs: out, matched: true, linked };
}
