import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hardRockSelections, hardRockSlipLink, hardRockCombined, prizePicksPicks, prizePicksCombined, PRIZEPICKS_MAX_PICKS, phoneSlipLink, isPhone, pickText, HARDROCK_SHARE, withState, needsState, cleanState } from '../docs/book-links.js';
import { SPORTSBOOKS, pricedBooks, bookIdFor } from '../docs/engine.js';

const FEED = 'https://app.hardrock.bet/?deep_link_value=betslip/5962328190182621608';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test('a Hard Rock slip link gives up its selections; an event page and another book do not', () => {
  assert.deepEqual(hardRockSelections(FEED), ['5962328190182621608']);
  assert.deepEqual(hardRockSelections('https://app.hardrock.bet/?deep_link_value=betslip/11,22,33'), ['11', '22', '33']);
  assert.deepEqual(hardRockSelections('https://app.hardrock.bet/?utm_source=x&deep_link_value=betslip/11&af=1'), ['11']);
  assert.equal(hardRockSelections('https://app.hardrock.bet/home/competition/ufc/8357726630690554274'), null);
  assert.equal(hardRockSelections('https://sportsbook.draftkings.com/?outcomes=1'), null);
  assert.equal(hardRockSelections('https://evil.example/?deep_link_value=betslip/11'), null);
  assert.equal(hardRockSelections('https://app.hardrock.bet/?deep_link_value=betslip/11<script>'), null, 'anything but digits and commas is not a slip link');
  assert.equal(hardRockSelections(null), null);
});

test('on a phone the link is the one Hard Rock\'s own slip shares, which its app opens', () => {
  assert.equal(phoneSlipLink(FEED), `${HARDROCK_SHARE}?deep_link_value=hardrock://betslip/5962328190182621608`);
  assert.equal(phoneSlipLink('https://app.hardrock.bet/?deep_link_value=betslip/11,22'), 'https://share.hardrock.bet/Pt0T/bet?deep_link_value=hardrock://betslip/11,22');
  // Everything else is left alone: an event page (nothing to put on a slip), other books, nothing at all.
  for (const u of ['https://app.hardrock.bet/home/competition/ufc/8357726630690554274', 'https://sportsbook.fanduel.com/addToBetslip?marketId[0]=1&selectionId[0]=2', null]) assert.equal(phoneSlipLink(u), u);
  assert.equal(phoneSlipLink(phoneSlipLink(FEED)), phoneSlipLink(FEED), 'rewriting twice changes nothing');
});

test('a whole Hard Rock ticket is one link, the selections joined by commas', () => {
  assert.equal(hardRockCombined([FEED, 'https://app.hardrock.bet/?deep_link_value=betslip/7410750502996148628']), 'https://app.hardrock.bet/?deep_link_value=betslip/5962328190182621608,7410750502996148628');
  assert.equal(phoneSlipLink(hardRockCombined([FEED, 'https://app.hardrock.bet/?deep_link_value=betslip/7'])), 'https://share.hardrock.bet/Pt0T/bet?deep_link_value=hardrock://betslip/5962328190182621608,7');
  assert.equal(hardRockCombined([FEED, 'https://app.hardrock.bet/home/competition/ufc/1']), null, 'a leg with no selection: no one link');
  assert.equal(hardRockCombined([]), null);
  assert.equal(hardRockSlipLink(['x', '']), null);
});

test('isPhone knows a phone, a tablet and an iPad that says it is a Mac', () => {
  assert.equal(isPhone(IPHONE), true);
  assert.equal(isPhone('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36'), true);
  assert.equal(isPhone('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 5), true);
  assert.equal(isPhone('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 0), false);
  assert.equal(isPhone('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0', 0), false);
});

test('Onyx is a book with a link and no prices: it is never a price filter', () => {
  assert.equal(SPORTSBOOKS.onyx.noPrices, true);
  assert.match(SPORTSBOOKS.onyx.url, /^https:\/\/onyxodds\.com\//);
  assert.deepEqual(pricedBooks(['fanduel', 'onyx', 'hardrock']), ['fanduel', 'hardrock']);
  assert.deepEqual(pricedBooks(['onyx']), [], 'Onyx alone filters nothing: every line still shows');
  assert.deepEqual(pricedBooks(null), []);
  assert.equal(bookIdFor('onyx'), 'onyx', 'and the day a feed lists it, its prices land under it');
  assert.equal(Object.values(SPORTSBOOKS).filter((b) => b.noPrices).length, 1, 'no other book lost its prices');
});

test('pickText writes a pick out to paste: a line a leg, the selection and its game', () => {
  assert.equal(pickText([{ selection: 'Kyshawn George Over 9.5 Pts', game: 'BOS @ WSH' }]), 'Kyshawn George Over 9.5 Pts (BOS @ WSH)');
  assert.equal(pickText([{ selection: 'A  Over 1.5 Reb', game: '' }, { selection: 'B Under 20.5 Pts', game: 'PHX @ HOU' }, { selection: '' }, null]), 'A Over 1.5 Reb\nB Under 20.5 Pts (PHX @ HOU)');
  assert.equal(pickText([]), '');
  assert.equal(pickText(null), '');
});

test('a Caesars or BetMGM link gets the user\'s state written in; without one it is not opened half-made', () => {
  const czr = 'https://sportsbook.caesars.com/us/{state}/bet?selectionIds=abc-123&dl=betslip';
  const mgm = 'https://sports.{state}.betmgm.com/en/sports?options=6:1:2&type=Single';
  assert.equal(withState(czr, 'NJ'), 'https://sportsbook.caesars.com/us/nj/bet?selectionIds=abc-123&dl=betslip');
  assert.equal(withState(mgm, 'az'), 'https://sports.az.betmgm.com/en/sports?options=6:1:2&type=Single');
  assert.equal(withState('https://sportsbook.caesars.com/us/%7Bstate%7D/bet?selectionIds=a,b', 'US-PA'), 'https://sportsbook.caesars.com/us/pa/bet?selectionIds=a,b', 'the braces as a browser writes them, and a region as "US-PA"');
  assert.equal(withState(czr, null), null); assert.equal(withState(czr, 'ZZ'), null, 'no state, or not a state: no link to a page with braces in it');
  assert.equal(withState('https://sportsbook.fanduel.com/addToBetslip?marketId=1', null), 'https://sportsbook.fanduel.com/addToBetslip?marketId=1', 'a link with no placeholder is left alone');
  assert.deepEqual([needsState(czr), needsState(mgm), needsState('https://sportsbook.draftkings.com/'), needsState(null)], [true, true, false, false]);
  assert.deepEqual([cleanState('nj'), cleanState('US-NY'), cleanState('Ontario'), cleanState('')], ['NJ', 'NY', null, null]);
});

test('PrizePicks: a lineup\'s picks ride one link, joined by commas', () => {
  const A = 'https://app.prizepicks.com/?projections=17335581-o-67.5';
  const B = 'https://app.prizepicks.com/?projections=17335491-o-95.5';
  const C = 'https://app.prizepicks.com/?projections=17473792-u-2';
  assert.deepEqual(prizePicksPicks(A), ['17335581-o-67.5']);
  assert.deepEqual(prizePicksPicks(C), ['17473792-u-2']);
  // The link the owner opened on 2026-11-26: both picks landed on the lineup.
  assert.equal(prizePicksCombined([A, B]), 'https://app.prizepicks.com/?projections=17335581-o-67.5,17335491-o-95.5');
  assert.equal(prizePicksCombined([A, B, C]), 'https://app.prizepicks.com/?projections=17335581-o-67.5,17335491-o-95.5,17473792-u-2');
  // A link that already carries a list joins the same way, and a pick listed twice is kept once.
  assert.equal(prizePicksCombined([prizePicksCombined([A, B]), C, A]), 'https://app.prizepicks.com/?projections=17335581-o-67.5,17335491-o-95.5,17473792-u-2');
  assert.equal(prizePicksCombined([A]), A, 'one pick: its own link');
});

test('PrizePicks: no one link when a leg has no pick, the same projection is taken both ways, or the lineup is too long', () => {
  const A = 'https://app.prizepicks.com/?projections=17335581-o-67.5';
  for (const bad of [null, '', 'https://app.prizepicks.com/', 'https://app.prizepicks.com/?projections=', 'https://app.prizepicks.com/?projections=abc', 'https://app.prizepicks.com/?projections=1-x-2',
    'https://app.prizepicks.com/?projections=1-o-2.5%22onload', 'http://app.prizepicks.com/?projections=1-o-2.5', 'https://app.prizepicks.com.evil.example/?projections=1-o-2.5',
    'https://sportsbook.draftkings.com/?outcomes=1']) {
    assert.equal(prizePicksPicks(bad), null, String(bad));
    assert.equal(prizePicksCombined([A, bad]), null, String(bad));
  }
  assert.equal(prizePicksCombined([]), null);
  assert.equal(prizePicksCombined([A, 'https://app.prizepicks.com/?projections=17335581-u-67.5']), null, 'More and Less on one projection');
  const many = Array.from({ length: PRIZEPICKS_MAX_PICKS + 1 }, (_, n) => `https://app.prizepicks.com/?projections=${100 + n}-o-1.5`);
  assert.ok(prizePicksCombined(many.slice(0, PRIZEPICKS_MAX_PICKS)));
  assert.equal(prizePicksCombined(many), null);
});

// --- a book whose app an iPhone will not open from a link ---
import { opensInBrowser, isApple, IPHONE_BROWSER_BOOKS } from '../docs/book-links.js';
test('BetMGM on an iPhone is a book that opens in the browser, and nowhere else', () => {
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 Version/19.1 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 };
  const ipad = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/19.1 Safari/605.1.15', maxTouchPoints: 5 };
  const mac = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/19.1 Safari/605.1.15', maxTouchPoints: 0 };
  const android = { userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36', maxTouchPoints: 5 };
  assert.deepEqual(IPHONE_BROWSER_BOOKS, ['betmgm']);
  assert.equal(isApple(iphone), true);
  assert.equal(isApple(ipad), true);
  assert.equal(isApple(mac), false);
  assert.equal(isApple(android), false);
  assert.equal(opensInBrowser('betmgm', iphone), true);
  assert.equal(opensInBrowser('BetMGM', ipad), true);
  // Untested on Android, and a desktop has no app to open: neither is told anything.
  assert.equal(opensInBrowser('betmgm', android), false);
  assert.equal(opensInBrowser('betmgm', mac), false);
  assert.equal(opensInBrowser('fanduel', iphone), false);
  assert.equal(opensInBrowser(null, iphone), false);
});
