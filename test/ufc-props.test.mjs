import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ufcPropLegs, recordRead, winChance, starsFor, UFC_PROPS, UFC_PROP_KEYS, ufcCardProps, NO_LINE_NOTE, NO_STATS_NOTE, NO_SPREAD_NOTE } from '../worker/src/ufc-props.js';

const f = (id, name) => ({ id, name });
const bout = (id, a, b, rounds = 3) => ({ id, a, b, rounds, weightClass: 'Lightweight', date: 1 });
const q = (american, bookId = 'draftkings') => ({ bookId, book: 'DraftKings', american, decimal: american > 0 ? 1 + american / 100 : 1 + 100 / -american, link: null });
const fighter = (wins, { ko = 0, sub = 0, dec = 0, history = [] } = {}) => ({ methods: { wins: { ko, sub, dec, other: 0 }, losses: { ko: 0, sub: 0, dec: 0, other: 0 } }, lastFive: ['win', 'win', 'win', 'win', 'win'], history });
const r1ko = (n) => Array.from({ length: n }, () => ({ result: 'win', method: 'KO/TKO', round: 1 }));

test('recordRead: shares by method, by round and by method and round, from the history with the tally as the floor', () => {
  const r = recordRead(fighter(8, { ko: 8, history: [...r1ko(6), { result: 'win', method: 'KO/TKO', round: 2 }, { result: 'win', method: 'Submission', round: 1 }, { result: 'loss', method: 'Decision', round: 3 }] }));
  assert.equal(r.wins, 8);
  assert.deepEqual(r.byMethod, { ko: 8, sub: 1, dec: 0 }, 'the tally floors the KO count; the history adds the submission');
  assert.deepEqual([r.roundShare(1), r.methodRoundCount('ko', [1]), r.methodRoundCount('ko', [1, 2]), r.finishShare], [7 / 8, 6, 7, 9 / 8 > 1 ? r.finishShare : r.finishShare]);
  assert.deepEqual(recordRead(null).wins, 0);
});

test('winChance: the market no-vig blended with the lean; the lean alone without a line; stars by band', () => {
  const odds = { a: [q(-200)], b: [q(170)] };
  const c = winChance(odds, { lean: 'a', confidence: 5 });
  assert.ok(c.a > 0.6 && c.a < 0.8 && Math.abs(c.a + c.b - 1) < 1e-9);
  assert.ok(winChance(null, { lean: 'b', confidence: 4 }).b > 0.8);
  assert.equal(winChance(null, null).a, 0.5);
  assert.deepEqual([0.7, 0.55, 0.4, 0.3, 0.1].map(starsFor), [5, 4, 3, 2, 1]);
});

test('ufcPropLegs: an 8-for-8 first-round knockout artist who is favoured gets a five-star R1 KO leg, unpriced with the note; the moneyline is priced; the fight reads follow both records', () => {
  const b = bout('1', f('a1', 'Kayla Finisher'), f('b1', 'Pat Grinder'));
  const profiles = { a: fighter(8, { ko: 8, history: r1ko(8) }), b: fighter(10, { dec: 8, ko: 2, history: [{ result: 'win', method: 'Decision (unanimous)', round: 3 }, { result: 'win', method: 'Decision (split)', round: 3 }, { result: 'win', method: 'KO/TKO', round: 3 }] }) };
  const legs = ufcPropLegs(b, { odds: { a: [q(-250)], b: [q(200)], totals: [{ point: 1.5, over: [q(-130)], under: [q(100)] }], spreads: [] }, breakdown: { lean: 'a', confidence: 5 }, engine: { methods: [{ side: 'a', method: 'ko', quotedOdds: 120, consensusPct: 70 }] }, profiles });
  const by = (prop, sel) => legs.find((l) => l.prop === prop && (!sel || l.selection === sel));
  const ml = by('ml', 'Kayla Finisher to win');
  assert.deepEqual([ml.score, ml.priced, ml.quotes[0].american, ml.note], [5, true, -250, null]);
  assert.equal(by('ml', 'Pat Grinder to win').score, 1, 'the other side carries what the confidence leaves');
  const r1 = by('method_round', 'Kayla Finisher by KO/TKO in Round 1');
  assert.ok(r1, legs.map((l) => l.selection).join(' | '));
  assert.deepEqual([r1.score, r1.priced, r1.note, r1.fighterId], [5, false, NO_LINE_NOTE, 'a1']);
  assert.ok(r1.why.some((w) => /8 of 8 wins by KO\/TKO in Round 1/.test(w)));
  const method = by('method', 'Kayla Finisher by KO/TKO');
  assert.deepEqual([method.priced, method.quotes[0].book, method.quotes[0].american], [true, 'cappers quote', 120], 'a method call prices off the cappers quote');
  assert.ok(by('double', 'Pat Grinder by Decision or KO/TKO'), 'the grinder goes the distance or lands late');
  const under = by('rounds', 'Under 1.5 rounds');
  assert.ok(under.priced && under.quotes[0].american === 100 && under.chance > 0.6, 'the favourite ends it in Round 1 most of the time');
  assert.ok(by('end_round', 'Fight ends in Round 1').chance > 0.6);
  assert.ok(by('distance', 'Fight does not go the distance').chance > by('distance', 'Fight goes the distance').chance);
  assert.ok(by('round_start', 'Round 2 to start').chance < 0.4);
  assert.ok(by('end_method', 'Fight ends by KO/TKO').chance > 0.6);
  assert.equal(legs.filter((l) => l.prop === 'spread').length, 0, 'no spread without a feed line');
  assert.ok(legs.every((l) => UFC_PROP_KEYS.includes(l.prop) && l.label === UFC_PROPS[l.prop]));
});

test('ufcPropLegs: a leg against a pending Pixel\'s Pick is pinned to one star; thin records make no fight reads; the spread rides the feed', () => {
  const b = bout('2', f('a2', 'A Two'), f('b2', 'B Two'));
  const profiles = { a: fighter(6, { ko: 3, sub: 3, history: [...r1ko(3), { result: 'win', method: 'Submission', round: 2 }, { result: 'win', method: 'Submission', round: 2 }, { result: 'win', method: 'Submission', round: 1 }] }), b: fighter(6, { dec: 6 }) };
  const legs = ufcPropLegs(b, { odds: { a: [q(-120)], b: [q(100)], totals: [], spreads: [{ point: { a: -3.5, b: 3.5 }, a: [q(150)], b: [q(-180)] }] }, breakdown: { lean: 'a', confidence: 4 }, profiles, against: new Set(['b2']) });
  assert.equal(legs.find((l) => l.selection === 'B Two to win').score, 1);
  assert.ok(legs.find((l) => l.selection === 'B Two by Decision').why.some((w) => /against a Pixel/.test(w)));
  const sp = legs.find((l) => l.prop === 'spread' && l.selection === 'B Two +3.5');
  assert.ok(sp && sp.priced && sp.quotes[0].american === -180);
  assert.ok(legs.some((l) => l.prop === 'rounds' && l.selection === 'Over 1.5 rounds' && !l.priced), 'no total on the feed: the usual number, unpriced');
  const thin = ufcPropLegs(bout('3', f('a3', 'New Kid'), f('b3', 'Debutant')), { profiles: { a: fighter(1, { ko: 1 }), b: fighter(0) } });
  assert.deepEqual([...new Set(thin.map((l) => l.prop))], ['ml'], 'two thin records: the moneyline only');
});

test('ufcCardProps: every bout read, with the notes for the props without stats and, with no feed spread, the spread', () => {
  const bouts = [bout('1', f('a1', 'A'), f('b1', 'B')), bout('2', f('a2', 'C'), f('b2', 'D'))];
  const out = ufcCardProps(bouts, (b) => (b.id === '1' ? { profiles: { a: fighter(5, { ko: 5, history: r1ko(5) }), b: fighter(5, { dec: 5 }) } } : null), { now: 7 });
  assert.equal(out.builtAt, 7);
  assert.ok(out.legs.length > 5 && out.legs.every((l) => l.boutId === '1'));
  assert.deepEqual([out.notes.strikes, out.notes.takedowns, out.notes.knockdowns, out.notes.spread], [NO_STATS_NOTE, NO_STATS_NOTE, NO_STATS_NOTE, NO_SPREAD_NOTE]);
});

test('the cappers move the grades once the MMA Engine has read the card: a strong call for the side lifts a star, one against costs a star, a method call lifts the method leg; the card says whether the engine is in', () => {
  const b = bout('9', f('a9', 'Fav Fighter'), f('b9', 'Dog Fighter'));
  const profiles = { a: fighter(6, { ko: 3, dec: 3, history: [...r1ko(3)] }), b: fighter(6, { sub: 4, dec: 2, history: [{ result: 'win', method: 'Submission', round: 1 }, { result: 'win', method: 'Submission', round: 2 }] }) };
  const base = { odds: { a: [q(-150)], b: [q(130)], totals: [], spreads: [] }, breakdown: { lean: 'a', confidence: 3 }, profiles };
  const without = ufcPropLegs(b, base);
  const withEngine = ufcPropLegs(b, { ...base, engine: { moneyline: { side: 'b', tier: 'strong', consensusPct: 72 }, methods: [{ side: 'b', method: 'sub', tier: 'lean', consensusPct: 61, quotedOdds: null }] } });
  const pick = (legs, sel) => legs.find((l) => l.selection === sel);
  assert.equal(pick(withEngine, 'Dog Fighter to win').score, pick(without, 'Dog Fighter to win').score + 1, 'the cappers on the dog lift the dog');
  assert.ok(pick(withEngine, 'Dog Fighter to win').why.some((w) => /cappers 72% on Dog Fighter/.test(w)));
  assert.equal(pick(withEngine, 'Fav Fighter by KO/TKO').score, Math.max(1, pick(without, 'Fav Fighter by KO/TKO').score - 1), 'the cappers against the favourite cost his legs a star');
  assert.ok(pick(withEngine, 'Dog Fighter by Submission').score >= pick(without, 'Dog Fighter by Submission').score + 1, 'the method call lifts the method leg on top');
  const card = ufcCardProps([b], () => ({ ...base, engine: { moneyline: { side: 'b', tier: 'strong', consensusPct: 72 }, methods: [] } }), { now: 1, engine: { generatedAt: '2026-11-04T10:00:00Z' } });
  assert.deepEqual(card.cappers, { read: true, bouts: 1, generatedAt: '2026-11-04T10:00:00Z' });
  assert.deepEqual(ufcCardProps([b], () => base, { now: 1 }).cappers, { read: false, bouts: 0, generatedAt: null });
});
