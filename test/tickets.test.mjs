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
  legEligible,
  isAnchorLeg,
  isTicketSport,
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

test('the sports are the ones the direction named: NFL, NCAA football, MMA, tennis', () => {
  for (const key of ['americanfootball_nfl', 'americanfootball_ncaaf', 'mma_mixed_martial_arts', 'tennis_atp_canadian_open', 'tennis_wta_us_open', 'tennis_atp_challenger_tour']) {
    assert.equal(isTicketSport(key), true, key);
  }
  for (const key of ['baseball_mlb', 'basketball_nba', 'basketball_wnba', 'icehockey_nhl', 'soccer_usa_mls', undefined]) {
    assert.equal(isTicketSport(key), false, String(key));
  }
});

test('an anchor is a gated prop line or a side the market reads at 72%+', () => {
  assert.equal(isAnchorLeg(leg('a', 1.3, ANCHOR_MIN_PROB)), true);
  assert.equal(isAnchorLeg(leg('a', 1.5, 0.65)), false);
  assert.equal(isAnchorLeg(leg('p', 1.25, 0.6, { kind: 'prop' })), true, 'a prop leg earned its place through the hit-rate gates');
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
  // A prop leg passes on its sport and bettability alone — it was gated where it was built.
  assert.equal(legEligible(leg('p', 1.25, 0.86, { kind: 'prop', ev: 0, score: 0 }), gates), true);
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

test('two legs that would argue, or two from one game, are never a ticket', () => {
  // Same game, same market, opposite sides — and the same game, different markets.
  const a = leg('A', 1.3, 0.8, { eventId: 'g-1' });
  const bOther = leg('B', 1.4, 0.74, { eventId: 'g-1', outcomeName: 'B' });
  const total = leg('T', 1.4, 0.74, { eventId: 'g-1', marketKey: 'totals', outcomeName: 'Over' });
  assert.deepEqual(buildTickets([a, bOther, total], { count: 1 }), []);
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
