import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resultEntries, countedResults, summarize, bucketize, bucketStart, nextBucket, bucketLabel, sportOfKey, etDate, unitTicks, RESULT_BUCKETS } from '../docs/results.js';

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../docs/data/tracking/${name}.json`, import.meta.url), 'utf8'));

test('sportOfKey files every feed key under its sport', () => {
  assert.deepEqual(['basketball_nba', 'americanfootball_nfl', 'icehockey_nhl', 'soccer_epl', 'soccer_spain_la_liga', 'mma_mixed_martial_arts', 'nba', 'nfl', 'atp'].map(sportOfKey), ['nba', 'nfl', 'nhl', 'soccer', 'soccer', 'ufc', 'nba', 'nfl', 'tennis']);
  assert.equal(sportOfKey('baseball_mlb'), null);
  assert.equal(etDate(Date.parse('2026-11-23T03:30:00Z')), '2026-11-22', 'a late game belongs to the Eastern day it was played on');
});

test('resultEntries reads each record into one shape, on its side and under its sport', () => {
  const trendPicks = { history: [{ date: '2026-11-20', bets: [
    { id: 't1', sportKey: 'basketball_nba', status: 'graded', result: 'win', net: 0.91, units: 1, american: -110, book: 'FanDuel', commenceMs: 1, legs: [{ selection: 'A 4+ Reb' }, { selection: 'B 2+ Ast' }] },
    { id: 't2', sportKey: 'soccer_epl', status: 'graded', result: 'loss', net: -1, units: 1, american: -155, book: 'DraftKings', legs: [{ selection: 'C 1+ SOT' }] },
    { id: 't3', sportKey: 'basketball_nba', status: 'pending', result: null, net: null, units: 1, legs: [] },
  ] }] };
  const ufcPicks = { history: [{ eventName: 'UFC 334', lockMs: Date.parse('2026-11-14T23:00:00Z'), bets: [{ id: 'u1', status: 'graded', result: 'loss', net: -2, units: 2, american: 100, book: 'FanDuel', legs: [{ selection: 'X ML' }] }] }] };
  const tennisPicks = { history: [{ date: '2026-11-19', plays: [{ id: 'atp:1:ml', market: 'ml', selection: 'Fritz ML', a: 'Fritz', b: 'Rune', status: 'graded', result: 'win', net: 0.63, units: 1.5, american: -238, book: 'FanDuel' }, { id: 'atp:2:ml', market: 'ml', selection: 'Dup', status: 'void', result: 'void', net: 0, units: 1, duplicateOf: '2026-11-18' }] }] };
  const tennisLive = { history: [{ date: '2026-11-22', plays: [{ id: 'atp:9:live_set:2', selection: 'Alcaraz to win set 2', a: 'Alcaraz', b: 'Zverev', score: '6-2 2-1', playable: -186, units: 1, status: 'graded', result: 'win', profit: 0.54, postedAt: 5 }, { id: 'atp:9:live_ml', selection: 'Open', status: 'pending', result: null }] }] };
  const liveRecap = { games: [
    { id: 'g1', name: 'Boston Celtics at Golden State Warriors', league: 'nba', date: '2026-11-23T01:30Z', slips: [
      { bookId: 'draftkings', book: 'DraftKings', american: 170, result: 'loss', units: -1, legs: [{ player: 'Draymond Green', label: 'Pts', point: 9.5 }] },
      { bookId: 'fanduel', book: 'FanDuel', american: 150, result: 'win', units: 1.5, legs: [{ player: 'Jayson Tatum', label: 'Reb', point: 5.5 }] }] },
    { id: 'g2', name: 'Open game', league: 'nfl', date: '2026-11-23T18:00Z', slips: [{ bookId: 'fanduel', result: 'open', units: 0, legs: [] }] },
  ] };
  const es = resultEntries({ trendPicks, ufcPicks, tennisPicks, tennisLive, liveRecap, myBooks: ['fanduel'] });
  assert.deepEqual(es.map((e) => `${e.side}:${e.sport}:${e.result}`).sort(), ['live:nba:win', 'live:tennis:win', 'pre:nba:win', 'pre:soccer:loss', 'pre:tennis:void', 'pre:tennis:win', 'pre:ufc:loss'], 'pending and open plays are left out');
  assert.equal(es[0].date >= es.at(-1).date, true, 'newest first');
  const ticket = es.find((e) => e.id === 'pre:t1');
  assert.deepEqual([ticket.title, ticket.sub, ticket.american, ticket.units, ticket.net, ticket.date], ['A 4+ Reb + B 2+ Ast', '2-leg parlay at FanDuel', -110, 1, 0.91, '2026-11-20']);
  // A game counts once: the slip at the user's book, not every book's copy of it.
  const slip = es.find((e) => e.id === 'live:g1');
  assert.deepEqual([slip.book, slip.net, slip.units, slip.sub, slip.date], ['FanDuel', 1.5, 1, 'Jayson Tatum 6+ Reb', '2026-11-22']);
  assert.equal(resultEntries({ liveRecap }).find((e) => e.id === 'live:g1').book, 'DraftKings', 'no book chosen: the first slip');
  // A live play with no book carries the price it was to be taken at.
  const set = es.find((e) => e.id === 'live:tennis:atp:9:live_set:2');
  assert.deepEqual([set.american, set.orBetter, set.net, set.sub], [-186, true, 0.54, 'Alcaraz vs Zverev · posted at 6-2 2-1']);
  assert.equal(es.find((e) => e.result === 'void').note, 'Posted twice: this copy does not count');
  assert.deepEqual(resultEntries({}), []);
});

test('summarize adds up the units played, the net and the return, leaving voids and unpriced plays out of the stake', () => {
  const s = summarize([{ result: 'win', units: 1.5, net: 0.9 }, { result: 'loss', units: 1, net: -1 }, { result: 'void', units: 2, net: 0 }, { result: 'win', units: 1, net: null }, { result: 'push', units: 1, net: 0 }]);
  assert.deepEqual(s, { count: 5, wins: 2, losses: 1, pushes: 1, voids: 1, played: 3.5, net: -0.1, roi: -0.0286 });
  assert.equal(summarize([]).roi, null);
});

test('bucketize counts by day, week, month and year with no period skipped, and keeps the running total', () => {
  assert.deepEqual([bucketStart('2026-11-22', 'week'), bucketStart('2026-11-23', 'week'), bucketStart('2026-11-22', 'month'), bucketStart('2026-11-22', 'year'), bucketStart('2026-11-22', 'day')], ['2026-11-16', '2026-11-23', '2026-11-01', '2026-01-01', '2026-11-22'], 'a week starts on Monday');
  assert.deepEqual([nextBucket('2026-12-28', 'week'), nextBucket('2026-12-01', 'month'), nextBucket('2026-01-01', 'year'), nextBucket('2026-02-28', 'day')], ['2027-01-04', '2027-01-01', '2027-01-01', '2026-03-01']);
  assert.deepEqual([bucketLabel('2026-11-16', 'week'), bucketLabel('2026-11-16', 'week', { short: true }), bucketLabel('2026-11-01', 'month'), bucketLabel('2026-11-01', 'month', { short: true }), bucketLabel('2026-01-01', 'year'), bucketLabel('2026-11-05', 'day')], ['Week of Nov 16', 'Nov 16', 'Nov 2026', 'Nov', '2026', 'Nov 5']);
  const e = (date, net, result = net > 0 ? 'win' : 'loss') => ({ date, units: 1, net, result });
  const es = [e('2026-10-28', 1), e('2026-11-03', -1), e('2026-11-04', 0.5), e('2026-11-20', -1), e('2026-11-21', 2)];
  const weeks = bucketize(es, 'week', { today: '2026-11-23' });
  assert.deepEqual(weeks.map((w) => [w.start, w.net, w.total, w.count]), [['2026-10-26', 1, 1, 1], ['2026-11-02', -0.5, 0.5, 2], ['2026-11-09', 0, 0.5, 0], ['2026-11-16', 1, 1.5, 2], ['2026-11-23', 0, 1.5, 0]], 'the empty week and the current one are there');
  assert.deepEqual(bucketize(es, 'month', { today: '2026-11-23' }).map((m) => [m.label, m.net, m.wins, m.losses, m.played, m.roi]), [['Oct 2026', 1, 1, 0, 1, 1], ['Nov 2026', 0.5, 2, 2, 4, 0.125]]);
  assert.deepEqual(bucketize(es, 'year', { today: '2026-11-23' }).map((y) => [y.label, y.net]), [['2026', 1.5]]);
  const days = bucketize(es, 'day', { today: '2026-11-23' });
  assert.equal(days.length, 27); assert.equal(days.at(-1).start, '2026-11-23'); assert.equal(days.at(-1).total, 1.5);
  // Only the last few periods are drawn; the running total still counts what came before them.
  const last2 = bucketize(es, 'week', { today: '2026-11-23', max: 2 });
  assert.deepEqual(last2.map((w) => [w.start, w.total]), [['2026-11-16', 1.5], ['2026-11-23', 1.5]]);
  assert.ok(RESULT_BUCKETS.every((b) => b.max > 0));
  assert.deepEqual(bucketize([], 'week'), []);
});

test('unitTicks gives clean steps either side of zero', () => {
  assert.deepEqual(unitTicks(-1.2, 2.6), [-2, -1, 0, 1, 2, 3], 'the ticks reach past both ends');
  assert.deepEqual(unitTicks(0, 13.5), [0, 5, 10, 15]);
  assert.ok(unitTicks(-0.3, 0.2).includes(0));
  assert.ok(unitTicks(-18.5, 9).at(0) <= -18.5 && unitTicks(-18.5, 9).at(-1) >= 9);
});

test('the site\'s own records add up the way the tabs say they do', () => {
  const all = resultEntries({ trendPicks: read('trend-picks'), ufcPicks: read('ufc-picks'), tennisPicks: read('tennis-picks'), tennisLive: read('tennis-live'), liveRecap: read('live-recap') });
  // The leans are on the board (every one of them live tennis) and in no total.
  const leans = all.filter((e) => e.lean);
  assert.ok(leans.every((e) => e.side === 'live' && e.sport === 'tennis' && /^Lean/.test(e.note)));
  assert.equal(leans.filter((e) => e.result === 'win').length, read('tennis-live').record.leans?.wins ?? 0, 'the leans match the Tennis tab\'s own count');
  const of = (side, sport) => summarize(countedResults(all).filter((e) => e.side === side && (!sport || e.sport === sport)));
  const tp = read('trend-picks').record; const leagues = summarize(countedResults(all).filter((e) => e.side === 'pre' && !e.mvp && ['nba', 'nfl', 'nhl', 'soccer'].includes(e.sport))); // the MVP Picks keep a record of their own
  assert.deepEqual([leagues.wins, leagues.losses, leagues.net, leagues.played], [tp.wins, tp.losses, tp.units, tp.risked], 'the league tickets match the Pixel\'s Picks record');
  const tn = read('tennis-picks').record; const tennis = of('pre', 'tennis');
  assert.deepEqual([tennis.wins, tennis.losses, tennis.net, tennis.played], [tn.wins, tn.losses, tn.units, tn.risked], 'tennis before the match matches the Tennis tab');
  const uf = read('ufc-picks').record; const ufc = of('pre', 'ufc');
  assert.deepEqual([ufc.wins, ufc.losses, ufc.net], [uf.wins, uf.losses, uf.units]);
  const tl = read('tennis-live').record; const live = of('live', 'tennis');
  assert.equal(live.wins, tl.ml.wins + tl.sets.wins + (tl.setGames?.wins ?? 0));
  assert.ok(Math.abs(live.net - (tl.ml.units + tl.sets.units + (tl.setGames?.units ?? 0))) < 0.011);
  assert.ok(of('live', 'nba').count > 0 && of('live', 'nfl').count > 0, 'live slips for both leagues');
  assert.ok(bucketize(all.filter((e) => e.side === 'pre'), 'week').length >= 2);
});
