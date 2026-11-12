import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UFC_TRACKER, trackerPicks, trackerMoneyline, withTracker, TRACKER_SOURCE } from '../worker/src/ufc-tracker.js';
import { engineForBout, enginePicksForEvent, capperLine } from '../worker/src/ufc-picks.js';

const UFC334 = 600061400;
const bout = (id, a, b) => ({ id, status: 'scheduled', a: { id: `${id}a`, name: a }, b: { id: `${id}b`, name: b } });

test('the tracker\'s counts add up: every fight has a field, and each fight\'s method calls are the calls the breakdown counted', () => {
  const card = UFC_TRACKER[UFC334];
  assert.equal(card.fights.length, 13);
  for (const f of card.fights) {
    for (const k of ['channels', 'best', 'fav', 'dog']) assert.ok(f[k][0] >= 0 && f[k][0] <= f[k][1] && f[k][1] > 0, `${f.a} v ${f.b} ${k}`);
    assert.ok(f.channels[1] >= 80 && f.channels[1] <= 87);
  }
  const calls = (f) => ['a', 'b'].reduce((n, s) => n + Object.values(f.methods[s]).reduce((x, y) => x + y, 0), 0);
  assert.deepEqual(card.fights.map(calls), [54, 54, 61, 59, 60, 59, 56, 58, 65, 59, 61, 57, 55]);
});

test('trackerMoneyline weighs the field and the best predictors equally and names the side they back together', () => {
  const [elder, , , , , , , , , , borralho, nunes] = UFC_TRACKER[UFC334].fights;
  const e = trackerMoneyline(elder);
  assert.equal(e.name, 'Evan Elder'); assert.equal(e.pct, 76.8, '57 of 84 and 6 of 7'); assert.equal(e.tier, 'strong'); assert.equal(e.odds, 100);
  assert.deepEqual(e.comments.slice(0, 2), ['Prediction channels: 57 of 84 on Evan Elder', 'Best predictors (the best return over the last 50 events): 6 of 7 on Evan Elder']);
  // The underdog the field barely prefers and the best predictors clearly do.
  const n = trackerMoneyline(nunes);
  assert.equal(n.name, 'Amanda Nunes'); assert.equal(n.pct, 69.9); assert.equal(n.tier, 'lean'); assert.equal(n.odds, 150);
  assert.ok(n.comments.includes('Best favourite predictors: 7 of 8 on Amanda Nunes'));
  // A coin flip with the field is a pass, counted for the side it leans to.
  const b = trackerMoneyline(borralho);
  assert.equal(b.name, 'Yousri Belgaroui'); assert.equal(b.pct, 56.5); assert.equal(b.tier, 'pass');
  assert.ok(b.comments.includes('Prediction channels: 48 of 86 on Yousri Belgaroui'), 'the counts are turned to the side named');
  assert.equal(trackerMoneyline({ a: 'A', b: 'B' }), null);
});

test('trackerPicks is the engine feed\'s own shape, so a bout reads it as it reads the engine', () => {
  const picks = trackerPicks(UFC334);
  assert.equal(picks.filter((p) => p.market === 'moneyline').length, 13);
  assert.ok(picks.every((p) => p.source === TRACKER_SOURCE && ['strong', 'lean', 'pass'].includes(p.tier) && p.strength >= 0 && p.strength <= 10));
  const read = engineForBout(bout('8', 'Jim Miller', 'Terrance McKinney'), { picks });
  assert.equal(read.moneyline.side, 'b'); assert.equal(read.moneyline.selection, 'Terrance McKinney'); assert.equal(read.moneyline.consensusPct, 89); assert.equal(read.moneyline.tier, 'strong');
  assert.equal(read.moneyline.source, TRACKER_SOURCE); assert.equal(read.moneyline.pickCount, 86);
  const ko = read.methods.find((m) => m.side === 'b' && m.method === 'ko');
  assert.equal(ko.consensusPct, 76.3); assert.equal(ko.tier, 'strong'); assert.equal(ko.quotedOdds, 140, 'the price the breakdown quoted rides along');
  assert.ok(read.methods.some((m) => m.side === 'a' && m.method === 'sub' && m.tier === 'pass'), 'Miller by submission: under three in ten');
  assert.ok(!read.methods.some((m) => m.method === 'dec'), 'no channel has it going to the cards');
  // A method the field and the moneyline disagree on is still said.
  const dober = engineForBout(bout('7', 'Drew Dober', 'Chris Duncan'), { picks });
  assert.equal(dober.moneyline.side, 'b'); assert.ok(dober.methods.some((m) => m.side === 'a' && m.method === 'ko' && m.tier === 'lean' && m.quotedOdds === 195));
  // Accents and a single name pair with ESPN's spelling.
  assert.equal(engineForBout(bout('4', 'Kevin Holland', 'Uroš Medić'), { picks }).moneyline.side, 'b');
  assert.equal(engineForBout(bout('12', 'Alatengheili', 'Juan Diaz'), { picks }).moneyline.consensusPct, 100);
  const line = capperLine(read);
  assert.match(line, /^Capper consensus \(the MMA predictions tracker, 86 prediction channels\): 89% back Terrance McKinney/);
  assert.match(line, /Best predictors \(the best return over the last 50 events\): 7 of 7 on Terrance McKinney/);
  assert.deepEqual(trackerPicks(123), [], 'a card not entered has no picks');
});

test('withTracker gives way to the engine as soon as its feed has the card, and never dresses another card', () => {
  const event = { id: UFC334, name: 'UFC 334: Gane vs. Hokit', bouts: [bout('1', 'Josh Hokit', 'Ciryl Gane'), bout('13', 'Evan Elder', 'Samuel Sanches')] };
  const empty = { at: 5, generatedAt: null, event: null, picks: [] };
  const fed = withTracker(empty, event, 0);
  assert.equal(fed.source, TRACKER_SOURCE); assert.equal(fed.event, 'UFC 334: Gane vs. Hokit'); assert.ok(fed.generatedAt);
  assert.equal(enginePicksForEvent(event, fed).filter((p) => p.market === 'moneyline').length, 2, 'only the bouts on the card as it stands');
  const engine = { at: 5, generatedAt: '2026-11-13T07:00:00Z', event: 'UFC 334', picks: [{ fight: 'Josh Hokit vs Ciryl Gane', market: 'moneyline', selection: 'Ciryl Gane', tier: 'strong', consensusPct: 80 }] };
  assert.equal(withTracker(engine, event, enginePicksForEvent(event, engine).length), engine, 'the engine has the card: its feed stands');
  const other = { id: 600099999, name: 'UFC Fight Night', bouts: [bout('1', 'A One', 'B Two')] };
  assert.equal(withTracker(empty, other, 0), empty);
});
