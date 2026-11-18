import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ufcComSlug, parseUfcComStats, parseEspnStats, mergeFighterStats } from '../worker/src/ufc-stats.js';
import { sharpRead, alternatePlay, endings, thinLine, SHARP_MIN } from '../worker/src/ufc-sharp.js';
import { fanduelSharpRunner, quoteSharpPlays, FANDUEL_TABS } from '../worker/src/ufc-fanduel.js';

// UFC.com's athlete page as it is laid out (read 2026-11-18, Ciryl Gane): the number in the element before its label.
const group = (n, label, suffix = '', percent = false) => `<div class="c-stat-compare__group c-stat-compare__group-1 "> <div class="c-stat-compare__number">${n} ${percent ? '<div class="c-stat-compare__percent">%</div>' : ''}</div> <div class="c-stat-compare__label">${label}</div>${suffix ? ` <div class="c-stat-compare__label-suffix">${suffix}</div>` : ''} </div>`;
const PAGE = `<html><head><title>Ciryl Gane | UFC</title></head><body>
  <title>Striking accuracy 59%</title><title>Takedown Accuracy 21%</title>
  <div class="c-stat-compare c-stat-compare--no-bar">${group('5.11', 'Sig. Str. Landed', 'Per Min')}${group('2.74', 'Sig. Str. Absorbed', 'Per Min')}</div>
  <div class="c-stat-compare c-stat-compare--no-bar">${group('0.58', 'Takedown avg', 'Per 15 Min')}${group('0.51', 'Submission avg', 'Per 15 Min')}</div>
  <div class="c-stat-compare c-stat-compare--no-bar">${group('58', 'Sig. Str. Defense', '', true)}${group('74', 'Takedown Defense', '', true)}</div>
  <div class="c-stat-compare c-stat-compare--no-bar">${group('0.29', 'Knockdown Avg')}${group('13:48', 'Average fight time')}</div>
</body></html>`;

test('a fighter is found on UFC.com by name, and the page reads as a stat line', () => {
  assert.equal(ufcComSlug('Ciryl Gane'), 'ciryl-gane');
  assert.equal(ufcComSlug('Jiří Procházka'), 'jiri-prochazka');
  assert.equal(ufcComSlug("Sean O'Malley"), 'sean-omalley');
  assert.equal(ufcComSlug('Benoît Saint Denis'), 'benoit-saint-denis');
  assert.equal(ufcComSlug(' Kai Kara-France '), 'kai-kara-france');

  assert.deepEqual(parseUfcComStats(PAGE, { name: 'Ciryl Gane' }), { slpm: 5.11, sapm: 2.74, strAcc: 59, strDef: 58, tdAvg: 0.58, tdAcc: null, tdDef: 74, subAvg: 0.51, kdAvg: 0.29, avgFightSec: 828 });
  // Somebody else's page under that address is not his line; a page with no numbers is no line at all.
  assert.equal(parseUfcComStats(PAGE, { name: 'Josh Hokit' }), null);
  assert.equal(parseUfcComStats('<html><title>Page not found | UFC</title></html>', { name: 'Ciryl Gane' }), null);
  assert.equal(parseUfcComStats(null), null);
  // A fighter yet to fight in the UFC: the page prints zeros and no fight time.
  const debut = PAGE.replace('5.11', '0.00').replace('2.74', '0.00').replace('13:48', '');
  assert.equal(parseUfcComStats(debut, { name: 'Ciryl Gane' }), null);
});

test('ESPN fills what UFC.com lacks, and UFC.com wins where both have a number', () => {
  const espn = parseEspnStats({ splits: { categories: [{ name: 'general', stats: [
    { name: 'takedownAccuracy', value: 52.56 }, { name: 'strikeLPM', value: 4.36 }, { name: 'strikeAccuracy', value: 58.22 },
    { name: 'takedownAvg', value: 2.66 }, { name: 'submissionAvg', value: 0.65 }, { name: 'koPercentage', value: 27.59 },
  ] }] } });
  assert.deepEqual(espn, { slpm: 4.36, strAcc: 58.22, tdAvg: 2.66, tdAcc: 52.56, subAvg: 0.65 });
  assert.equal(parseEspnStats({}), null); assert.equal(parseEspnStats(null), null);

  const both = mergeFighterStats(parseUfcComStats(PAGE), espn, 123);
  assert.deepEqual([both.slpm, both.sapm, both.tdAvg, both.sources, both.at], [5.11, 2.74, 0.58, ['ufc.com', 'espn'], 123]);
  assert.deepEqual([both.strAcc, both.tdAcc], [58.22, 52.56], 'the accuracies are ESPN\'s, which states them outright');
  const espnOnly = mergeFighterStats(null, espn, 1);
  assert.deepEqual([espnOnly.slpm, espnOnly.sapm, espnOnly.tdDef, espnOnly.sources], [4.36, null, null, ['espn']]);
  assert.equal(mergeFighterStats(null, null), null);
});

const f = (stats, wins, losses, history = []) => ({ stats, methods: { wins, losses }, history });
const h = (category, round) => ({ category, round });
const bout = (a, b, rounds = 3) => ({ id: '1', a: { id: 'a', name: a }, b: { id: 'b', name: b }, rounds });

test('the volume striker against a man who absorbs a lot: most significant strikes', () => {
  const read = sharpRead({
    bout: bout('Yousri Belgaroui', 'Caio Borralho'),
    a: f({ slpm: 6.1, sapm: 3.0, tdAvg: 0.3, tdDef: 80, kdAvg: 0.5, avgFightSec: 600 }, { ko: 6, sub: 0, dec: 3 }, { ko: 0, sub: 1, dec: 2 }),
    b: f({ slpm: 3.3, sapm: 4.6, tdAvg: 1.2, tdDef: 60, kdAvg: 0.2, avgFightSec: 780 }, { ko: 5, sub: 4, dec: 8 }, { ko: 0, sub: 0, dec: 2 }),
    breakdown: { lean: 'a', straight: { market: 'h2h' } }, now: 5,
  });
  assert.equal(read.none, false); assert.equal(read.alternate, null); assert.deepEqual(read.missing, []); assert.equal(read.at, 5);
  const p = read.plays[0];
  assert.deepEqual([p.key, p.side, p.selection, p.market], ['strikes', 'a', 'Yousri Belgaroui most significant strikes', 'Most significant strikes']);
  assert.ok(p.strength >= SHARP_MIN);
  assert.match(p.why[0], /lands 6\.1 significant strikes a minute to Borralho's 3\.3/);
  assert.match(p.why[1], /Borralho absorbs 4\.6 a minute, Belgaroui 3/);
  assert.match(p.why[2], /about 5\.1 to 3\.1 a minute, 62% of the strikes to Belgaroui/);
  // The same numbers the other way round name the other fighter.
  const flipped = sharpRead({ bout: bout('Caio Borralho', 'Yousri Belgaroui'), a: f({ slpm: 3.3, sapm: 4.6 }, {}, {}), b: f({ slpm: 6.1, sapm: 3.0 }, {}, {}) });
  assert.deepEqual([flipped.plays[0].side, flipped.plays[0].selection], ['b', 'Yousri Belgaroui most significant strikes']);
  // Close in volume: no strikes play.
  const close = sharpRead({ bout: bout('A One', 'B Two'), a: f({ slpm: 4.2, sapm: 3.9 }, {}, {}), b: f({ slpm: 4.0, sapm: 4.0 }, {}, {}) });
  assert.equal(close.plays.some((x) => x.key === 'strikes'), false);
});

test('a wrestler takes volume off the striker he keeps on the mat', () => {
  const striker = f({ slpm: 5.0, sapm: 3.6, tdAvg: 0.2, tdDef: 45, avgFightSec: 800 }, {}, {});
  const boxer = f({ slpm: 3.4, sapm: 4.4, tdAvg: 0.1, tdDef: 60, avgFightSec: 800 }, {}, {});
  const wrestler = f({ slpm: 3.4, sapm: 4.4, tdAvg: 5.0, tdAcc: 50, tdDef: 60, avgFightSec: 800 }, {}, {});
  const standing = sharpRead({ bout: bout('S Striker', 'B Boxer'), a: striker, b: boxer }).plays.find((p) => p.key === 'strikes');
  const grounded = sharpRead({ bout: bout('S Striker', 'W Wrestler'), a: striker, b: wrestler }).plays.find((p) => p.key === 'strikes');
  assert.ok(standing && standing.side === 'a');
  assert.ok(!grounded || grounded.strength < standing.strength, 'the same striker leads by less, or not at all, against the wrestler');
  // And the wrestler's takedowns are a play of their own: 5 per 15 against 45% defence over a 13-minute fight.
  const td = sharpRead({ bout: bout('S Striker', 'W Wrestler'), a: striker, b: wrestler }).plays.find((p) => p.family === 'takedowns');
  assert.deepEqual([td.side, td.selection, td.line], ['b', 'W Wrestler over 2.5 takedowns', 2.5]);
  assert.match(td.why[0], /lands 5 takedowns per 15 minutes, 50% of the attempts/);
  assert.match(td.why[1], /Striker stops 45% of takedown attempts \(the UFC average is about 60%\)/);
  // Against a man who stops most of them, the same wrestler is no takedown play.
  const stuffed = sharpRead({ bout: bout('W Wrestler', 'D Defender'), a: wrestler, b: f({ slpm: 3.5, sapm: 3.5, tdAvg: 0.2, tdDef: 92, avgFightSec: 800 }, {}, {}) });
  assert.equal(stuffed.plays.some((p) => p.family === 'takedowns'), false);
});

test('how the fights have ended: the distance, and the round to start', () => {
  const decider = (extra = {}) => f({ slpm: 4.0, sapm: 4.0, tdAvg: 0.8, tdDef: 66, avgFightSec: 800, ...extra }, { ko: 2, sub: 1, dec: 9 }, { ko: 1, sub: 0, dec: 4 }, [h('dec'), h('dec'), h('dec'), h('ko', 3), h('dec')]);
  assert.deepEqual(endings(decider()), { fights: 17, decShare: 13 / 17, r1Share: 0, koLosses: 1, losses: 5 });
  const yes = sharpRead({ bout: bout('A One', 'B Two'), a: decider(), b: decider() });
  assert.deepEqual(yes.plays.map((p) => p.selection), ['Fight goes the distance: Yes']);
  assert.equal(yes.plays[0].prop, 'distance');
  assert.match(yes.plays[0].note, /Round 2 to start: Yes is the safer leg/);
  // Five rounds are two more chances of a finish: the same two fighters score lower.
  const five = sharpRead({ bout: bout('A One', 'B Two', 5), a: decider(), b: decider() });
  assert.ok((five.plays[0]?.strength ?? 0) < yes.plays[0].strength);

  const finisher = () => f({ slpm: 4.0, sapm: 4.0, tdAvg: 0.5, tdDef: 60, avgFightSec: 300 }, { ko: 9, sub: 3, dec: 1 }, { ko: 3, sub: 1, dec: 0 }, [h('ko', 1), h('ko', 1), h('sub', 1), h('ko', 2), h('ko', 1)]);
  const no = sharpRead({ bout: bout('C Three', 'D Four'), a: finisher(), b: finisher() });
  assert.equal(no.plays[0].selection, 'Fight does not go the distance');
  // Too few fights on either side to say how they end: no duration play.
  const green = f(null, { ko: 2, sub: 0, dec: 1 }, { ko: 0, sub: 0, dec: 0 });
  assert.equal(sharpRead({ bout: bout('C Three', 'D Four'), a: finisher(), b: green }).plays.some((p) => p.family === 'duration'), false);
});

test('nothing stands out: it says so, names the nearest thing, and gives an alternate to the main pick', () => {
  const even = (wins) => f({ slpm: 4.0, sapm: 4.0, tdAvg: 1.0, tdDef: 60, kdAvg: 0.3, avgFightSec: 620 }, wins, { ko: 2, sub: 1, dec: 2 }, [h('dec'), h('ko', 1), h('dec'), h('ko', 2), h('dec')]);
  const a = even({ ko: 4, sub: 1, dec: 5 }); const b = even({ ko: 3, sub: 3, dec: 4 });
  const read = sharpRead({ bout: bout('C Three', 'D Four'), a, b, breakdown: { lean: 'a', straight: { market: 'h2h' } } });
  assert.equal(read.none, true); assert.deepEqual(read.plays, []);
  // The moneyline is the pick: the alternate is the two ways he usually wins.
  assert.equal(read.alternate.selection, 'C Three by decision or KO/TKO');
  assert.match(read.alternate.why, /9 of Three's 10 wins/);
  // One way dominates: that method alone.
  assert.equal(alternatePlay(bout('C Three', 'D Four'), f(null, { ko: 9, sub: 1, dec: 2 }, {}), b, { lean: 'a', straight: { market: 'h2h' } }).selection, 'C Three by KO/TKO');
  // The pick is already a method: the alternate is the moneyline.
  assert.equal(alternatePlay(bout('C Three', 'D Four'), a, b, { lean: 'b', straight: { market: 'method', methods: ['dec'] } }).selection, 'D Four moneyline');
  // Too few wins to name a method; no lean, no alternate.
  assert.match(alternatePlay(bout('C Three', 'D Four'), f(null, { ko: 1, sub: 1, dec: 1 }, {}), b, { lean: 'a', straight: { market: 'h2h' } }).selection, /moneyline, smaller/);
  assert.equal(alternatePlay(bout('C Three', 'D Four'), a, b, { lean: null }), null);

  // A fighter with no stat line is named, and the strikes and takedown reads are not made on a guess.
  const blind = sharpRead({ bout: bout('C Three', 'New Guy'), a, b: f(null, { ko: 3, sub: 3, dec: 4 }, { ko: 2, sub: 1, dec: 2 }), breakdown: { lean: 'a', straight: { market: 'h2h' } } });
  assert.deepEqual(blind.missing, ['New Guy']);
  assert.equal(blind.plays.some((p) => p.family === 'strikes' || p.family === 'takedowns'), false);
  // One play a family, three at most, strongest first.
  const busy = sharpRead({
    bout: bout('W Wrestler', 'P Puncher', 5),
    a: f({ slpm: 5.5, sapm: 2.0, tdAvg: 5.0, tdAcc: 55, tdDef: 85, kdAvg: 0.2, avgFightSec: 500 }, { ko: 6, sub: 8, dec: 2 }, { ko: 0, sub: 0, dec: 1 }, [h('sub', 1), h('ko', 1), h('sub', 2), h('ko', 1), h('sub', 1)]),
    b: f({ slpm: 3.0, sapm: 5.0, tdAvg: 0.2, tdDef: 40, kdAvg: 1.4, avgFightSec: 400 }, { ko: 12, sub: 0, dec: 1 }, { ko: 3, sub: 2, dec: 0 }, [h('ko', 1), h('ko', 1), h('sub', 1), h('ko', 2), h('ko', 1)]),
  });
  assert.ok(busy.plays.length <= 3);
  assert.equal(new Set(busy.plays.map((p) => p.family)).size, busy.plays.length);
  assert.deepEqual(busy.plays.map((p) => p.strength), [...busy.plays.map((p) => p.strength)].sort((x, y) => y - x));
});

test('FanDuel\'s price and slip link go on the plays it lists, found by the market\'s name', () => {
  assert.ok(['Fight Props', 'Fighter Props', 'Strikes', 'Takedowns', 'Stats', 'Method of Victory', 'Rounds'].every((t) => FANDUEL_TABS.some((re) => re.test(t))));
  assert.ok(!FANDUEL_TABS.some((re) => re.test('Popular')));
  const card = { events: [{ name: 'Caio Borralho v Yousri Belgaroui', markets: [
    { marketId: '734.1', marketName: 'Moneyline', marketType: 'MATCH_BETTING', runners: [{ selectionId: 1, runnerName: 'Caio Borralho', american: 110 }, { selectionId: 2, runnerName: 'Yousri Belgaroui', american: -130 }] },
    { marketId: '734.2', marketName: 'Most Significant Strikes', marketType: 'MOST_SIGNIFICANT_STRIKES', runners: [{ selectionId: 11, runnerName: 'Caio Borralho', american: 100 }, { selectionId: 12, runnerName: 'Yousri Belgaroui', american: -128 }] },
    { marketId: '734.3', marketName: 'Most Significant Strikes - Round 1', marketType: 'X', runners: [{ selectionId: 13, runnerName: 'Yousri Belgaroui', american: -110 }] },
    { marketId: '734.4', marketName: 'Caio Borralho Total Takedowns', marketType: 'Y', runners: [{ selectionId: 21, runnerName: 'Over', handicap: 1.5, american: 120 }, { selectionId: 22, runnerName: 'Under', handicap: 1.5, american: -150 }] },
    { marketId: '734.5', marketName: 'Will the fight go the distance?', marketType: 'WILL_THE_FIGHT_GO_THE_DISTANCE?', runners: [{ selectionId: 31, runnerName: 'Yes', american: -140 }, { selectionId: 32, runnerName: 'No', american: 115 }] },
  ] }] };
  const b = bout('Yousri Belgaroui', 'Caio Borralho');
  const plays = [
    { key: 'strikes', family: 'strikes', side: 'a', selection: 'Yousri Belgaroui most significant strikes' },
    { key: 'takedowns_b', family: 'takedowns', side: 'b', line: 1.5, selection: 'Caio Borralho over 1.5 takedowns' },
    { key: 'takedowns_a', family: 'takedowns', side: 'a', line: 0.5, selection: 'Yousri Belgaroui over 0.5 takedowns' },
    { key: 'distance_no', family: 'duration', side: null, prop: 'distance', selection: 'Fight does not go the distance' },
    { key: 'knockdown_a', family: 'knockdown', side: 'a', selection: 'Yousri Belgaroui to score a knockdown', quote: { american: 1 } },
  ];
  quoteSharpPlays(plays, b, card);
  assert.deepEqual(plays[0].quote, { bookId: 'fanduel', book: 'FanDuel', american: -128, link: 'https://sportsbook.fanduel.com/addToBetslip?marketId=734.2&selectionId=12' });
  assert.deepEqual([plays[1].quote.american, plays[1].quote.link], [120, 'https://sportsbook.fanduel.com/addToBetslip?marketId=734.4&selectionId=21']);
  assert.equal(plays[2].quote, undefined, 'no takedown market for him: no price');
  assert.equal(plays[3].quote.american, 115);
  assert.equal(plays[4].quote, undefined, 'a price left from an earlier read is taken off when the market is gone');
  // A card without the fight prices nothing.
  const lone = [{ key: 'strikes', family: 'strikes', side: 'a' }];
  quoteSharpPlays(lone, bout('Nobody Here', 'Someone Else'), card);
  assert.equal(lone[0].quote, undefined);
  assert.equal(fanduelSharpRunner({ key: 'strikes', family: 'strikes', side: null }, card.events[0], { a: 'x', b: 'y' }), null);
});

test('a stat line off very little cage time is marked down, and a lead short of the bar is the nearest thing', () => {
  const ufc = (n) => Array.from({ length: n }, (_, i) => ({ category: 'dec', event: `UFC Fight Night ${i}` }));
  const settled = { ...f({ slpm: 5.19, sapm: 2.81, tdAvg: 0.5, tdDef: 60, kdAvg: 0.4, avgFightSec: 700 }, {}, {}), history: ufc(6) };
  // One short UFC fight: 9.71 landed and 10.4 absorbed a minute (the first live card's debutant).
  const green = { ...f({ slpm: 9.71, sapm: 10.4, tdAvg: 0, tdDef: 50, avgFightSec: 140 }, {}, {}), history: [{ category: 'ko', round: 1, event: 'UFC Fight Night 1' }, { category: 'ko', round: 1, event: 'Regional Show 12' }] };
  assert.equal(thinLine(settled), false); assert.equal(thinLine(green), true);
  assert.equal(thinLine(f(null, {}, {})), false, 'no stat line is not a thin one');
  assert.equal(thinLine(f({ slpm: 4, sapm: 4, avgFightSec: 700 }, {}, {})), false, 'a history with no event names says nothing about cage time');
  const vsGreen = sharpRead({ bout: bout('S Settled', 'G Green'), a: settled, b: green });
  const vsTwin = sharpRead({ bout: bout('S Settled', 'T Twin'), a: settled, b: { ...green, history: ufc(6), stats: { ...green.stats, slpm: 8.5, sapm: 8.9, avgFightSec: 600 } } });
  const strikes = (r) => [...r.plays, r.near].filter(Boolean).find((p) => /most significant strikes/.test(p.selection));
  assert.ok(strikes(vsTwin).strength - (strikes(vsGreen)?.strength ?? 0) >= 5, 'the same lead scores lower off a thin line');
  const marked = vsGreen.plays.find((p) => p.key === 'strikes');
  if (marked) assert.match(marked.why.at(-1), /Green's UFC numbers come from very little cage time/);

  // A lead that is real but short of the bar: no play, and it is the fight's nearest thing.
  const near = sharpRead({ bout: bout('B Ortega', 'D Hooker'), a: f({ slpm: 3.84, sapm: 6.38, tdAvg: 0.93, tdDef: 55, avgFightSec: 829 }, {}, {}), b: f({ slpm: 4.82, sapm: 4.94, tdAvg: 0.67, tdDef: 77, avgFightSec: 590 }, {}, {}), breakdown: { lean: 'a', straight: { market: 'h2h' } } });
  assert.equal(near.none, true);
  assert.equal(near.near.selection, 'D Hooker most significant strikes');
  assert.ok(near.near.strength < SHARP_MIN);
});
