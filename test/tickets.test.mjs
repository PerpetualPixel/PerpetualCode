/**
 * Anchor + partner tickets (docs/tickets.js): the shape every Pixel's Pick
 * and the Play of the Day take.
 *
 * The invariants worth pinning are the ones the direction spelled out: one
 * safe leg on every ticket, two legs from two games that never argue, a
 * combined price between -200 and +100, both legs more likely than not to
 * land, and the pairs ranked by what the ticket itself is worth.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTickets,
  buildBoard,
  legEligible,
  legsConflict,
  singleEligible,
  isAnchorLeg,
  isTicketSport,
  isGameLegSport,
  isPropLegSport,
  ticketPrice,
  ticketProb,
  TICKET_BAND,
  ANCHOR_MIN_PROB,
  TICKET_MIN_PROB,
} from '../docs/tickets.js';

const leg = (id, decimal, prob, extra = {}) => ({
  id, eventId: `g-${id}`, sportKey: 'americanfootball_nfl', marketKey: 'h2h', outcomeName: id,
  decimal, consensusProb: prob, ev: prob * decimal - 1, selection: `${id} ML`, score: 70, bettable: true,
  ...extra,
});

test('game legs come from NFL, NCAA football, MMA and tennis; prop legs from NFL, WNBA and NBA', () => {
  for (const key of ['americanfootball_nfl', 'americanfootball_ncaaf', 'mma_mixed_martial_arts', 'tennis_atp_canadian_open', 'tennis_wta_us_open', 'tennis_atp_challenger_tour']) {
    assert.equal(isGameLegSport(key), true, key);
    assert.equal(isTicketSport(key), true, key);
  }
  for (const key of ['basketball_wnba', 'basketball_nba']) {
    assert.equal(isPropLegSport(key), true, key);
    assert.equal(isGameLegSport(key), false, `${key} supplies props, not moneylines`);
    assert.equal(isTicketSport(key), true, key);
  }
  assert.equal(isPropLegSport('americanfootball_nfl'), true);
  for (const key of ['baseball_mlb', 'icehockey_nhl', 'soccer_usa_mls', undefined]) {
    assert.equal(isTicketSport(key), false, String(key));
  }
  // A basketball moneyline is never a leg; a basketball prop is.
  const gates = { minEv: 0.02, minKelly: 0.005, minScore: 50 };
  assert.equal(legEligible(leg('w', 1.35, 0.78, { sportKey: 'basketball_wnba' }), gates), false);
  assert.equal(legEligible(leg('w', 1.3125, 0.81, { sportKey: 'basketball_wnba', kind: 'prop' }), gates), true);
});

test('an anchor is any leg read at 72%+ — by the market or by the game log; a light prop line is not one', () => {
  assert.equal(isAnchorLeg(leg('a', 1.3, ANCHOR_MIN_PROB)), true);
  assert.equal(isAnchorLeg(leg('a', 1.5, 0.65)), false);
  assert.equal(isAnchorLeg(leg('p', 1.2, 0.87, { kind: 'prop' })), true, 'a -500 line the player clears every night');
  assert.equal(isAnchorLeg(leg('p', 1.758, 0.62, { kind: 'prop' })), false, 'a -132 alternate is a partner or a straight play, never the anchor');
});

test('a leg must be a ticket sport, bettable, in a game market, with a real edge and a favourite-side read', () => {
  const gates = { minEv: 0.02, minKelly: 0.005, minScore: 50 };
  assert.equal(legEligible(leg('a', 1.35, 0.78), gates), true);
  assert.equal(legEligible(leg('a', 1.35, 0.78, { sportKey: 'baseball_mlb' }), gates), false, 'not a ticket sport');
  assert.equal(legEligible(leg('a', 1.35, 0.78, { bettable: false }), gates), false, 'not a price the reader can take');
  assert.equal(legEligible(leg('a', 1.35, 0.78, { marketKey: 'btts' }), gates), false, 'not a game market');
  assert.equal(legEligible(leg('a', 1.35, 0.74), gates), false, 'edge below the floor');
  assert.equal(legEligible(leg('a', 1.35, 0.78, { score: 40 }), gates), false, 'below the conviction floor');
  assert.equal(legEligible(leg('a', 2.2, 0.5), gates), false, 'a coin flip is not a partner');
  // Totals need the stricter read.
  assert.equal(legEligible(leg('t', 1.6, 0.66, { marketKey: 'totals', outcomeName: 'Over' }), gates), true);
  assert.equal(legEligible(leg('t', 1.75, 0.6, { marketKey: 'totals', outcomeName: 'Over' }), gates), false);
  // A prop leg passes on its sport, bettability and a favourite-side read — it was gated where it was built.
  assert.equal(legEligible(leg('p', 1.25, 0.86, { kind: 'prop', ev: 0, score: 0 }), gates), true);
  assert.equal(legEligible(leg('p', 1.95, 0.52, { kind: 'prop' }), gates), false, 'a coin-flip prop is not a leg either');
});

test('a ticket is two legs from two games, anchor first, priced inside -200..+100, both more likely than not to land', () => {
  const legs = [leg('A', 1.25, 0.82), leg('B', 1.45, 0.72), leg('C', 1.6, 0.66)];
  const [ticket] = buildTickets(legs, { count: 1 });
  assert.ok(ticket);
  assert.equal(ticket.type, 'combo');
  assert.equal(ticket.legs.length, 2);
  assert.ok(isAnchorLeg(ticket.legs[0]), 'the anchor leads the ticket');
  assert.notEqual(ticket.legs[0].eventId, ticket.legs[1].eventId);
  assert.ok(ticket.american >= TICKET_BAND.MIN_AMERICAN && ticket.american <= TICKET_BAND.MAX_AMERICAN, `priced ${ticket.american}`);
  assert.ok(ticket.prob >= TICKET_MIN_PROB);
  assert.match(ticket.pairReason, /Anchor: .* Partner: .*chance both land/);
});

test('tickets are ranked by expected value and never share a game or a leg', () => {
  // A+C: 2.0 at 54% -> +8.2% EV. B+D: 1.82 at 59% -> +7.7%. A+B would pay
  // 1.75 at 61% for +6.3%, so the builder prefers the two richer pairs.
  const legs = [leg('A', 1.25, 0.82), leg('B', 1.4, 0.74), leg('C', 1.6, 0.66), leg('D', 1.3, 0.8)];
  const tickets = buildTickets(legs, { count: 3 });
  assert.equal(tickets.length, 2, 'four legs make at most two disjoint tickets');
  assert.deepEqual(tickets.map((t) => t.legs.map((l) => l.id).sort().join('+')), ['A+C', 'B+D']);
  assert.ok(tickets[0].ev >= tickets[1].ev, 'best ticket first');
  const events = tickets.flatMap((t) => t.legs.map((l) => l.eventId));
  assert.equal(new Set(events).size, events.length);
});

test('two legs that would argue, or two game legs from one game, are never a ticket', () => {
  // Same game, same market, opposite sides — and the same game, different markets.
  const a = leg('A', 1.3, 0.8, { eventId: 'g-1' });
  const bOther = leg('B', 1.4, 0.74, { eventId: 'g-1', outcomeName: 'B' });
  const total = leg('T', 1.4, 0.74, { eventId: 'g-1', marketKey: 'totals', outcomeName: 'Over' });
  assert.deepEqual(buildTickets([a, bOther, total], { count: 1 }), []);
  assert.equal(legsConflict(a, total), true);
  assert.equal(legsConflict(a, leg('C', 1.4, 0.74, { eventId: 'g-2' })), false);
});

const prop = (id, decimal, prob, playerName, eventId, extra = {}) => leg(id, decimal, prob, {
  kind: 'prop', eventId, playerName, statKey: 'points', marketKey: 'player_points_alternate', outcomeName: 'Over',
  sportKey: 'basketball_wnba', selection: `${playerName} 12+ Pts`,
  profile: { games: 20, season: 0.9, l10: 0.9, l5: 1 }, ...extra,
});

test("two players' props from one game pair as a same-game parlay; one player's two stats, or a prop with its own game's side, never do", () => {
  // The slip: 2+ rebounds at -500 with 12+ points at -320, one game, -174 together.
  const astier = prop('astier-reb', 1.2, 0.87, 'Pauline Astier', 'g-1', { statKey: 'rebounds', selection: 'Pauline Astier 2+ Reb' });
  const ionescu = prop('ionescu-pts', 1.3125, 0.81, 'Sabrina Ionescu', 'g-1');
  assert.equal(legsConflict(astier, ionescu), false);
  const [ticket] = buildTickets([astier, ionescu], { count: 1 });
  assert.ok(ticket);
  assert.equal(ticket.sameGame, true);
  assert.equal(ticket.american, -174);
  assert.match(ticket.pairReason, /^Same game parlay\. Anchor: Pauline Astier 2\+ Reb/);
  assert.deepEqual(ticket.legs.map((l) => l.id), ['astier-reb', 'ionescu-pts'], 'the heavier read anchors');

  const ionescuAst = prop('ionescu-ast', 1.25, 0.84, 'Sabrina Ionescu', 'g-1', { statKey: 'assists' });
  assert.equal(legsConflict(ionescu, ionescuAst), true, 'one player twice moves together');
  assert.equal(legsConflict(ionescu, leg('liberty', 1.3, 0.8, { eventId: 'g-1' })), true, 'a prop and its own game\'s side move together');
  assert.deepEqual(buildTickets([ionescu, ionescuAst], { count: 1 }), []);
  assert.deepEqual(buildTickets([ionescu, leg('liberty', 1.3, 0.8, { eventId: 'g-1' })], { count: 1 }), []);
  // Accents and punctuation don't make two players of one.
  assert.equal(legsConflict(ionescu, prop('x', 1.25, 0.84, 'Sabrina IONESCU', 'g-1', { statKey: 'assists' })), true);
});

test('a straight play stands inside the band on its own, with a favourite-side read and an edge', () => {
  assert.equal(singleEligible(leg('ml', 1.685, 0.62)), true, '-146 moneyline');
  assert.equal(singleEligible(prop('stroud', 1.758, 0.62, 'C.J. Stroud', 'g-9')), true, '10+ alt rushing yards at -132');
  assert.equal(singleEligible(leg('chalk', 1.3, 0.8)), false, '-333 is heavier than the band');
  assert.equal(singleEligible(leg('dog', 2.2, 0.5)), false, 'past +100');
  assert.equal(singleEligible(leg('flip', 1.9, 0.53)), false, 'a coin flip');
  assert.equal(singleEligible(leg('noedge', 1.6, 0.6), { minEv: 0.02 }), false, '1.6 x .6 = 0.96 — the price beats the read');
});

test('buildBoard fills the slots tickets leave with straight plays, never sharing a game, tickets first', () => {
  const anchor = leg('A', 1.25, 0.82);
  const partner = leg('B', 1.45, 0.72);
  // Three legs that pair with nothing (each would price past +100 with any partner) but stand alone.
  const s1 = leg('S1', 1.8, 0.6);
  const s2 = leg('S2', 1.7, 0.62);
  const s3 = leg('S3', 1.9, 0.56);
  const board = buildBoard([anchor, partner, s1, s2, s3], { count: 3 });
  assert.equal(board.length, 3);
  assert.equal(board[0].type, 'combo');
  assert.deepEqual(board.slice(1).map((p) => p.type), ['single', 'single']);
  // Singles ranked by EV: S1 (1.8 x .6 = +8%) over S2 (1.7 x .62 = +5.4%) over S3 (+6.4%)... S3 beats S2.
  assert.deepEqual(board.slice(1).map((p) => p.id), ['S1', 'S3']);
  assert.deepEqual(board[1].legs.map((l) => l.id), ['S1'], 'a single carries itself as its one leg');
  assert.match(board[1].singleReason, /^Straight play: S1 ML reads 60% by the market; -125 stands inside the band/);
  const events = board.flatMap((p) => p.legs.map((l) => l.eventId));
  assert.equal(new Set(events).size, events.length);
  // A full board of tickets takes no singles at all.
  assert.equal(buildBoard([anchor, partner, s1], { count: 1 }).length, 1);
  assert.equal(buildBoard([anchor, partner, s1], { count: 1 })[0].type, 'combo');
  // A single is never a game the day already used.
  assert.deepEqual(buildBoard([s1, s2], { count: 2, usedEventIds: new Set(['g-S1']) }).map((p) => p.id), ['S2']);
});

test('a pair outside the band, or without an anchor, or not both-likely, is not a ticket', () => {
  // Two -110s: +264 combined, far outside the band.
  assert.deepEqual(buildTickets([leg('a', 1.91, 0.56), leg('b', 1.91, 0.56)], { count: 1 }), []);
  // Two -600s: -300 combined, heavier than the band's floor.
  assert.deepEqual(buildTickets([leg('a', 1.167, 0.9), leg('b', 1.167, 0.9)], { count: 1 }), []);
  // Inside the band but neither leg is anchor-grade.
  assert.deepEqual(buildTickets([leg('a', 1.4, 0.7), leg('b', 1.4, 0.7)], { count: 1 }), []);
  // An anchor with a partner the market reads too low: 1.3 x 1.5 = 1.95 in band, but .8 x .6 = 48%.
  assert.deepEqual(buildTickets([leg('a', 1.3, 0.8), leg('b', 1.5, 0.6)], { count: 1 }), []);
});

test('games the day already used are off the table', () => {
  const legs = [leg('A', 1.25, 0.82), leg('B', 1.45, 0.72), leg('C', 1.45, 0.72)];
  const [ticket] = buildTickets(legs, { count: 1, usedEventIds: new Set(['g-B']) });
  assert.deepEqual(ticket.legs.map((l) => l.id), ['A', 'C']);
});

test('the ticket EV floor is the ticket\'s own, not the legs\'', () => {
  const legs = [leg('A', 1.25, 0.82), leg('B', 1.45, 0.72)];
  assert.equal(buildTickets(legs, { count: 1, minEv: 0 }).length, 1);
  assert.equal(buildTickets(legs, { count: 1, minEv: 0.2 }).length, 0);
});

test('price and probability multiply', () => {
  const legs = [leg('A', 1.25, 0.8), leg('B', 1.6, 0.65)];
  const { decimal, american } = ticketPrice(legs);
  assert.ok(Math.abs(decimal - 2) < 1e-9);
  assert.equal(american, 100);
  assert.ok(Math.abs(ticketProb(legs) - 0.52) < 1e-9);
});
