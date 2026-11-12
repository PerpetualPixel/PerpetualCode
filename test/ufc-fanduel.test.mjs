import test from 'node:test';
import assert from 'node:assert/strict';
import { trimFanduelMarket, fanduelTabSlug, FANDUEL_TABS, fanduelRunnerFor, priceLegsFromFanduel, fanduelSlipLink } from '../worker/src/ufc-fanduel.js';
import { ufcCardProps } from '../worker/src/ufc-props.js';

let sel = 1000;
const market = (marketType, marketName, runners, extra = {}) => ({ marketId: `734.${marketType.length}${runners.length}${marketName.length}`, marketName, marketType, sgm: false, runners: runners.map(([runnerName, american]) => ({ selectionId: sel++, runnerName, handicap: 0, american })), ...extra });
// FanDuel's wording as read from its page data on 2026-11-12: a five-round main event and a three-round fight.
const gane = { eventId: 36094809, name: 'Ciryl Gane v Josh Hokit', openDate: '2026-11-15T04:30:00.000Z', markets: [
  market('MATCH_BETTING', 'Moneyline', [['Ciryl Gane', -188], ['Josh Hokit', 144]], { sgm: true }),
  market('WILL_THE_FIGHT_GO_THE_DISTANCE?', 'Will the fight go the distance?', [['Yes', 210], ['No', -280]], { sgm: true }),
  market('HOW_FIGHT_WILL_END', 'How fight will End', [['KO/TKO', -145], ['Submission', 480], ['Points', 195]]),
  market('METHOD_OF_VICTORY', 'Method of Victory', [['Ciryl Gane by KO/TKO', 145], ['Ciryl Gane by Points', 380], ['Josh Hokit by KO/TKO', 410], ['Josh Hokit by Points', 600], ['Josh Hokit by Submission', 850], ['Ciryl Gane by Submission', 1000], ['Draw', 5000]]),
  market('METHOD_&_ROUND_COMBO_(5_ROUNDS)', 'Method & Round Combo (5 Rounds)', [['Ciryl Gane KO/TKO & Round 1', 500], ['Ciryl Gane KO/TKO & Round 2', 900], ['Josh Hokit Submission & Round 1', 2200]]),
  market('FIGHT_TO_START_ROUND_3', 'Fight To Start Round 3', [['Yes', -164], ['No', 128]]),
  market('TOTAL_ROUNDS', 'Total Rounds', [['Over (2.5)', -124], ['Under (2.5)', 102]]),
  market('WHAT_ROUND_WILL_FIGHT_END_(5_ROUNDS)', 'What Round will Fight End (5 Rounds)', [['Round 1', 240], ['Round 2', 470], ['Round 3', 600], ['Round 4', 850], ['Round 5', 1100]]),
] };
const elder = { eventId: 36298471, name: 'Evan Elder v Samuel Sanches', openDate: '2026-11-14T23:00:00.000Z', markets: [
  market('MATCH_BETTING', 'Moneyline', [['Evan Elder', 102], ['Samuel Sanches', -130]]),
  market('ROUND_BETTING', 'Round Betting', [['Evan Elder to Win in Round 1', 800], ['Samuel Sanches to Win in Round 2', 600], ['Draw', 5000]]),
  market('WHAT_ROUND_WILL_FIGHT_END', 'What Round will Fight End', [['Round 1', 260], ['Round 2', 350], ['Round 3', 500]]),
  market('METHOD_&_ROUND_COMBO', 'Method & Round Combo', [['Samuel Sanches KO/TKO & Round 1', 550]]),
] };
const card = { at: 1, source: 'fanduel', events: [gane, elder] };
const leg = (prop, extra = {}) => ({ id: `b:${prop}:${JSON.stringify(extra)}`, prop, side: null, selection: '', quotes: [], ...extra });

test('trimFanduelMarket keeps what a slip link needs and drops a closed market; the tab slug is the page\'s own', () => {
  const raw = { marketId: '734.1', marketName: 'Moneyline', marketType: 'MATCH_BETTING', sgmMarket: true, marketStatus: 'OPEN', eventId: 9, runners: [
    { selectionId: 26525711, handicap: 0, runnerName: 'Ciryl Gane', runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOdds: -188, americanOddsInt: -188 }, trueOdds: {} }, previousWinRunnerOdds: [] },
    { selectionId: 2, runnerName: 'Josh Hokit', runnerStatus: 'SUSPENDED', winRunnerOdds: { americanDisplayOdds: { americanOddsInt: 144 } } },
    { selectionId: 3, runnerName: 'No Price', runnerStatus: 'ACTIVE' }] };
  assert.deepEqual(trimFanduelMarket(raw), { marketId: '734.1', marketName: 'Moneyline', marketType: 'MATCH_BETTING', sgm: true, runners: [{ selectionId: 26525711, runnerName: 'Ciryl Gane', handicap: 0, american: -188 }, { selectionId: 3, runnerName: 'No Price', handicap: 0, american: null }] });
  assert.equal(trimFanduelMarket({ ...raw, marketStatus: 'SUSPENDED' }), null);
  assert.equal(trimFanduelMarket({ marketId: '1', runners: [] }), null);
  assert.equal(fanduelTabSlug('Method of Victory'), 'method-of-victory');
  assert.equal(fanduelTabSlug('Round Props'), 'round-props');
  assert.deepEqual(['Popular', 'Method of Victory', 'Round Props', 'Time Props', 'Specials'].filter((t) => FANDUEL_TABS.some((re) => re.test(t))), ['Method of Victory', 'Round Props']);
});

test('fanduelRunnerFor finds each leg\'s market and runner in FanDuel\'s wording, the five-round variants included', () => {
  const name = (l, fighter = null, fight = gane) => { const f = fanduelRunnerFor(l, fight, fighter); return f ? `${f.market.marketName} | ${f.runner.runnerName} | ${f.runner.american}` : null; };
  assert.equal(name(leg('ml', { side: 'a' }), 'Ciryl Gane'), 'Moneyline | Ciryl Gane | -188');
  assert.equal(name(leg('rounds', { point: 2.5, sideWord: 'over' })), 'Total Rounds | Over (2.5) | -124');
  assert.equal(name(leg('rounds', { point: 2.5, sideWord: 'under' })), 'Total Rounds | Under (2.5) | 102');
  assert.equal(name(leg('rounds', { point: 3.5, sideWord: 'over' })), null, 'a number FanDuel does not hang');
  assert.equal(name(leg('distance', { selection: 'Fight goes the distance' })), 'Will the fight go the distance? | Yes | 210');
  assert.equal(name(leg('distance', { selection: 'Fight does not go the distance' })), 'Will the fight go the distance? | No | -280');
  assert.equal(name(leg('round_start', { round: 3, answer: 'yes' })), 'Fight To Start Round 3 | Yes | -164');
  assert.equal(name(leg('round_start', { round: 3, answer: 'no' })), 'Fight To Start Round 3 | No | 128');
  assert.equal(name(leg('round_start', { round: 4, answer: 'yes' })), null);
  assert.equal(name(leg('method', { side: 'a', method: 'ko' }), 'Ciryl Gane'), 'Method of Victory | Ciryl Gane by KO/TKO | 145');
  assert.equal(name(leg('method', { side: 'b', method: 'dec' }), 'Josh Hokit'), 'Method of Victory | Josh Hokit by Points | 600');
  assert.equal(name(leg('method', { side: 'b', method: 'sub' }), 'Josh Hokit'), 'Method of Victory | Josh Hokit by Submission | 850');
  assert.equal(name(leg('end_method', { selection: 'Fight ends by KO/TKO' })), 'How fight will End | KO/TKO | -145');
  assert.equal(name(leg('end_method', { selection: 'Fight ends by Submission' })), 'How fight will End | Submission | 480');
  assert.equal(name(leg('end_method', { method: 'dec', selection: 'Fight ends on Points' })), 'How fight will End | Points | 195');
  assert.equal(name(leg('end_round', { round: 4 })), 'What Round will Fight End (5 Rounds) | Round 4 | 850');
  assert.equal(name(leg('end_round', { selection: 'Fight ends in Round 2' }), null, elder), 'What Round will Fight End | Round 2 | 350');
  assert.equal(name(leg('method_round', { side: 'a', method: 'ko', round: 2 }), 'Ciryl Gane'), 'Method & Round Combo (5 Rounds) | Ciryl Gane KO/TKO & Round 2 | 900');
  assert.equal(name(leg('method_round', { side: 'b', method: 'ko', round: 1 }), 'Samuel Sanches', elder), 'Method & Round Combo | Samuel Sanches KO/TKO & Round 1 | 550');
  assert.equal(name(leg('win_round', { side: 'a', round: 1 }), 'Evan Elder', elder), 'Round Betting | Evan Elder to Win in Round 1 | 800');
  assert.equal(name(leg('win_round', { side: 'a', round: 1 }), 'Ciryl Gane'), null, 'no round betting on this five-rounder');
  assert.equal(name(leg('double', { side: 'a', methods: ['ko', 'sub'] }), 'Ciryl Gane'), null, 'FanDuel has no inside-the-distance market');
});

test('priceLegsFromFanduel puts FanDuel\'s price and slip link on the legs it lists, whichever way round the fight is named', () => {
  const bout = { id: 'b1', a: { name: 'Josh Hokit' }, b: { name: 'Ciryl Gane' } };
  const boardQuote = { bookId: 'fanduel', book: 'FanDuel', american: 140, decimal: 2.4, link: 'https://www.bestfightodds.com/events/x', source: 'bestfightodds' };
  const dk = { bookId: 'draftkings', book: 'DraftKings', american: 150, decimal: 2.5, link: 'https://sportsbook.draftkings.com/event/1?outcomes=9' };
  const legs = [leg('ml', { side: 'a', quotes: [boardQuote, dk] }), leg('method', { side: 'b', method: 'ko', quotes: [{ bookId: 'engine', book: 'cappers quote', american: 120 }] }), leg('double', { side: 'b', methods: ['ko', 'sub'], note: 'unpriced' })];
  const out = priceLegsFromFanduel(legs, bout, card);
  assert.deepEqual([out.matched, out.linked], [true, 2]);
  const ml = out.legs[0];
  assert.deepEqual(ml.quotes.map((q) => [q.bookId, q.american]), [['draftkings', 150], ['fanduel', 144]], 'our side a is FanDuel\'s second fighter; its own price replaces the board\'s FanDuel one');
  const fd = ml.quotes.find((q) => q.bookId === 'fanduel');
  const mlMarket = gane.markets[0];
  assert.equal(fd.link, `https://sportsbook.fanduel.com/addToBetslip?marketId=${mlMarket.marketId}&selectionId=${mlMarket.runners[1].selectionId}`);
  assert.equal(fd.sgm, true);
  const method = out.legs[1];
  assert.deepEqual(method.quotes.map((q) => q.bookId), ['fanduel'], 'the cappers\' quote gives way to a real price');
  assert.equal(method.quotes[0].american, 145);
  assert.equal(method.priced, true);
  assert.equal(out.legs[2], legs[2], 'a leg FanDuel does not list is left as it was');
  // Every linked leg's link carries the two ids the app joins into one slip link.
  for (const l of out.legs.slice(0, 2)) { const u = new URL(l.quotes.find((q) => q.bookId === 'fanduel').link); assert.ok(u.searchParams.get('marketId') && u.searchParams.get('selectionId')); }
  assert.deepEqual(priceLegsFromFanduel(legs, { id: 'x', a: { name: 'Jon Jones' }, b: { name: 'Tom Aspinall' } }, card), { legs, matched: false, linked: 0 });
  assert.equal(fanduelSlipLink('734.1', 5), 'https://sportsbook.fanduel.com/addToBetslip?marketId=734.1&selectionId=5');
});

test('ufcCardProps reports how many bouts and legs FanDuel linked', () => {
  const bouts = [{ id: 'b1', rounds: 5, a: { id: '1', name: 'Ciryl Gane' }, b: { id: '2', name: 'Josh Hokit' } }];
  const props = ufcCardProps(bouts, () => ({ odds: { a: [], b: [], books: [] }, breakdown: null, engine: null, profiles: {} }), { now: 5, fanduel: card });
  assert.deepEqual([props.fanduel.at, props.fanduel.bouts], [1, 1]);
  assert.ok(props.fanduel.linked >= 2, `linked ${props.fanduel.linked}`);
  const ml = props.legs.find((l) => l.prop === 'ml' && l.side === 'a');
  assert.match(ml.quotes.find((q) => q.bookId === 'fanduel').link, /addToBetslip\?marketId=/);
  assert.equal(ufcCardProps(bouts, () => ({ odds: null, breakdown: null, engine: null, profiles: {} }), { now: 5 }).fanduel, null);
});
