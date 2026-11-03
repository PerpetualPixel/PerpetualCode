import test from 'node:test';
import assert from 'node:assert/strict';
import { poisson, remainingRate, hockeyOutcomes, chance, impliedChance, gameReads, NHL_GOALS_PER_TEAM, MIN_EDGE } from '../worker/src/live-game.js';

test('goals to the whistle: Poisson at a rate that blends the league with the game, over the time left', () => {
  assert.ok(Math.abs(poisson(2, 0) - Math.exp(-2)) < 1e-12);
  assert.ok(Math.abs(poisson(2, 2) - 2 * Math.exp(-2)) < 1e-12);
  assert.equal(remainingRate(0, 1), 0, 'nothing left at the whistle');
  assert.ok(Math.abs(remainingRate(1, 0.5) - 0.5 * (0.65 * NHL_GOALS_PER_TEAM + 0.35 * 2)) < 1e-9, 'half left: half of the blended rate');
  assert.ok(Math.abs(remainingRate(0, 0.1) - 0.9 * NHL_GOALS_PER_TEAM) < 1e-9, 'too early for pace: the league rate alone');
  assert.ok(remainingRate(6, 0.5) < 0.5 * NHL_GOALS_PER_TEAM * 2.5, 'a wild pace is capped');
});

test('the moneyline, puck line and total read from the score and the clock, and move the right way', () => {
  const late = hockeyOutcomes({ homeGoals: 3, awayGoals: 1, elapsed: 0.83 });
  const pHome = chance(late, 'h2h', 'home');
  assert.ok(pHome > 0.9 && pHome < 1, `up two with ten minutes left: ${pHome}`);
  assert.ok(Math.abs(chance(late, 'h2h', 'home') + chance(late, 'h2h', 'away') - 1) < 1e-6, 'the moneyline sums to one, the tie split in overtime');
  assert.ok(chance(late, 'spreads', 'home', -1.5) > 0.7, 'the puck line needs the two-goal margin to hold');
  assert.ok(Math.abs(chance(late, 'spreads', 'home', -1.5) + chance(late, 'spreads', 'away', 1.5) - 1) < 1e-6);
  assert.ok(chance(late, 'spreads', 'home', -1.5) < chance(late, 'h2h', 'home'), 'covering -1.5 is harder than winning');
  const over = chance(late, 'totals', 'over', 4.5); const under = chance(late, 'totals', 'under', 4.5);
  assert.ok(Math.abs(over + under - 1) < 1e-6);
  assert.ok(over > 0.4 && over < 0.75, `four goals in, ten minutes left: the fifth is a coin flip or so (${over})`);
  const early = hockeyOutcomes({ homeGoals: 0, awayGoals: 0, elapsed: 0.1 });
  assert.ok(Math.abs(chance(early, 'h2h', 'home') - 0.5) < 0.01, 'level early: a coin flip');
  assert.ok(chance(early, 'totals', 'over', 4.5) > 0.5 && chance(early, 'totals', 'over', 6.5) < 0.5, 'the league scores five and a half or six');
  const tied = hockeyOutcomes({ homeGoals: 2, awayGoals: 2, elapsed: 0.97 });
  assert.ok(chance(tied, 'spreads', 'home', 1.5) > 0.97, 'level late: +1.5 covers unless two go in');
  assert.ok(chance(tied, 'totals', 'over', 4.5) > 0.85, 'level late: overtime adds the fifth goal');
});

test('the book price is de-vigged against its other side, and only lines the model beats at the price are read, best EV first', () => {
  assert.ok(Math.abs(impliedChance(1.9091, 1.9091) - 0.5) < 1e-4, 'a -110 both ways is a coin flip');
  assert.ok(Math.abs(impliedChance(1.5) - 0.6667) < 1e-3, 'no other side: the raw price');
  const game = { home: 'Seattle Kraken', away: 'Chicago Blackhawks', homeAbbr: 'SEA', awayAbbr: 'CHI', score: { SEA: 3, CHI: 1 }, elapsed: 0.83 };
  const payload = { bookmakers: [
    { key: 'fanduel', markets: [
      { key: 'h2h', outcomes: [{ name: 'Seattle Kraken', price: -240, link: 'fd-ml' }, { name: 'Chicago Blackhawks', price: 190 }] },
      { key: 'spreads', outcomes: [{ name: 'Seattle Kraken', point: -1.5, price: 120 }, { name: 'Chicago Blackhawks', point: 1.5, price: -150 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 4.5, price: -105 }, { name: 'Under', point: 4.5, price: -115 }] },
    ] },
    { key: 'draftkings', markets: [{ key: 'h2h', outcomes: [{ name: 'Seattle Kraken', price: -210 }, { name: 'Chicago Blackhawks', price: 175 }] }] },
  ] };
  const reads = gameReads(payload, game);
  const ml = reads.find((r) => r.market === 'h2h' && r.side === 'home');
  assert.ok(ml, 'the home moneyline has the edge: the model is past 90%, the price near 70%');
  assert.equal(ml.best.bookId, 'draftkings', 'the better price is the better EV');
  assert.equal(ml.lines.length, 2);
  assert.ok(ml.best.edge >= MIN_EDGE && ml.best.ev > 0);
  assert.ok(ml.selection === 'Seattle Kraken to win' && /SEA up 2, 10 min left/.test(ml.why), ml.why);
  assert.ok(!reads.some((r) => r.side === 'away'), 'the side behind has no edge');
  assert.ok(reads.every((r) => r.best.ev > 0), 'nothing with negative EV');
  assert.deepEqual(reads.map((r) => r.best.ev), [...reads.map((r) => r.best.ev)].sort((a, b) => b - a), 'best EV first');
  assert.deepEqual(gameReads(payload, { ...game, elapsed: 0.05 }), [], 'too early to read');
  assert.deepEqual(gameReads(payload, { ...game, elapsed: 0.97 }), [], 'too late to read');
});

test('soccer: the draw is its own side, nothing goes to overtime, and both teams to score and draw no bet read off the same outcomes', () => {
  const o = hockeyOutcomes({ homeGoals: 1, awayGoals: 0, elapsed: 0.72, sport: 'soccer' });
  const opts = { overtime: false };
  const home = chance(o, 'h2h', 'home', null, opts); const draw = chance(o, 'h2h', 'draw', null, opts); const away = chance(o, 'h2h', 'away', null, opts);
  assert.ok(Math.abs(home + draw + away - 1) < 1e-6, 'three ways sum to one');
  assert.ok(home > 0.65 && home < 0.9, `a goal up with twenty-five minutes left: ${home}`);
  assert.ok(draw > 0.1 && draw < 0.3, `the equaliser is live: ${draw}`);
  assert.ok(Math.abs(chance(o, 'totals', 'over', 1.5, opts) + chance(o, 'totals', 'under', 1.5, opts) - 1) < 1e-6);
  assert.ok(chance(o, 'totals', 'over', 1.5, opts) > 0.4 && chance(o, 'totals', 'over', 1.5, opts) < 0.7);
  assert.ok(Math.abs(chance(o, 'btts', 'yes', null, opts) + chance(o, 'btts', 'no', null, opts) - 1) < 1e-6);
  assert.ok(chance(o, 'btts', 'yes', null, opts) < 0.5, 'the side behind has to score for both to');
  const dnb = chance(o, 'draw_no_bet', 'home', null, opts);
  assert.ok(Math.abs(dnb - home / (home + away)) < 1e-9, 'draw no bet is the win chance with the draw taken out');
  const game = { home: 'Arsenal', away: 'Slavia Prague', homeAbbr: 'ARS', awayAbbr: 'SLP', score: { ARS: 1, SLP: 0 }, elapsed: 0.72, sport: 'soccer', minutes: 90 };
  const payload = { bookmakers: [{ key: 'fanduel', markets: [
    { key: 'h2h', outcomes: [{ name: 'Arsenal', price: -170 }, { name: 'Draw', price: 320 }, { name: 'Slavia Prague', price: 900 }] },
    { key: 'totals', outcomes: [{ name: 'Over', point: 1.5, price: -120 }, { name: 'Under', point: 1.5, price: -110 }] },
    { key: 'btts', outcomes: [{ name: 'Yes', price: 180 }, { name: 'No', price: -240 }] },
    { key: 'draw_no_bet', outcomes: [{ name: 'Arsenal', price: -280 }, { name: 'Slavia Prague', price: 210 }] },
  ] }] };
  const reads = gameReads(payload, game);
  assert.ok(reads.every((r) => r.best.ev > 0 && r.best.edge >= MIN_EDGE));
  const ml = reads.find((r) => r.market === 'h2h' && r.side === 'home');
  assert.ok(ml && /ARS up 1, 25 min left/.test(ml.why) && ml.selection === 'Arsenal to win', ml && ml.why);
  assert.ok(!reads.some((r) => r.market === 'spreads'), 'no puck line in soccer');
});
