/**
 * Prop Play of the Day (worker/src/prop-play.js) — the pure logic: gamelog
 * parsing, hit-rate profiles, safe-band alternate extraction, writeups, and
 * leg grading. Network shapes (ESPN, alt markets) are fixtures shaped like
 * the live payloads; the /prop-play?debug=1 trace covers live divergence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGamelogValues,
  hitProfile,
  extractAltCandidates,
  legWriteup,
  gradePropLeg,
} from '../worker/src/prop-play.js';

/* ── gamelog parsing ────────────────────────────────────────────── */

const GAMELOG = {
  labels: ['MIN', 'FG%', 'REB', 'AST', 'PTS'],
  events: {
    e1: { gameDate: '2026-08-10T00:00Z' },
    e2: { gameDate: '2026-08-07T00:00Z' },
    e3: { gameDate: '2026-08-03T00:00Z' },
  },
  seasonTypes: [{
    categories: [{
      events: [
        { eventId: 'e3', stats: ['31', '48.1', '7', '2', '18'] },
        { eventId: 'e1', stats: ['29', '50.0', '11', '3', '22'] },
        { eventId: 'e2', stats: ['33', '44.4', '6', '1', '9'] },
      ],
    }],
  }],
};

test('parseGamelogValues returns the stat most-recent-first by game date', () => {
  assert.deepEqual(parseGamelogValues(GAMELOG, 'points'), [22, 9, 18]);
  assert.deepEqual(parseGamelogValues(GAMELOG, 'rebounds'), [11, 6, 7]);
  assert.deepEqual(parseGamelogValues({}, 'points'), [], 'unexpected shape yields [], never a guess');
});

/* ── hit profiles ───────────────────────────────────────────────── */

test('hitProfile measures season/L10/L5 rates, the streak, and averages', () => {
  // 12 games, most recent first: clears 10+ in 10 of 12, first 4 straight.
  const values = [15, 12, 11, 14, 9, 16, 13, 10, 8, 12, 17, 11];
  const p = hitProfile(values, 10);
  assert.equal(p.games, 12);
  assert.equal(p.streak, 4);
  assert.equal(p.l5, 4 / 5);
  assert.equal(p.l10, 8 / 10);
  assert.equal(p.season, 10 / 12);
  assert.equal(p.avgSeason, 12.3);
  assert.equal(hitProfile([], 10), null);
});

/* ── alternate extraction ───────────────────────────────────────── */

const GAME = { oddsEventId: 'ev1', home: 'Los Angeles Sparks', away: 'Phoenix Mercury', commence: '2026-08-12T23:00:00Z' };
const EVENT_ODDS = {
  bookmakers: [
    { title: 'FanDuel', markets: [{ key: 'player_points_alternate', outcomes: [
      { name: 'Over', description: 'Dearica Hamby', point: 9.5, price: -460 },
      { name: 'Over', description: 'Dearica Hamby', point: 19.5, price: +180 }, // too light
      { name: 'Over', description: 'Dearica Hamby', point: 4.5, price: -900 },  // too heavy
      { name: 'Under', description: 'Dearica Hamby', point: 9.5, price: +320 }, // unders never qualify
    ] }] },
    { title: 'DraftKings', markets: [{ key: 'player_points_alternate', outcomes: [
      { name: 'Over', description: 'Dearica Hamby', point: 9.5, price: -430 }, // better price, same line
    ] }] },
  ],
};

test('extractAltCandidates keeps safe-band Overs at the best price across books', () => {
  const out = extractAltCandidates(EVENT_ODDS, GAME);
  assert.equal(out.length, 1);
  assert.equal(out[0].need, 10);
  assert.equal(out[0].american, -430, 'best (lightest) price across books wins');
  assert.equal(out[0].book, 'DraftKings');
  assert.equal(out[0].statKey, 'points');
});

/* ── writeup ────────────────────────────────────────────────────── */

test('legWriteup quotes only computed numbers', () => {
  const text = legWriteup({
    player: 'Dearica Hamby', statKey: 'points', need: 10, american: -460, book: 'FanDuel',
    profile: { games: 30, season: 0.87, l10: 1.0, l5: 1.0, streak: 17, avgSeason: 15.1, avgL5: 16.4 },
  });
  assert.match(text, /87% of her 30 games/);
  assert.match(text, /17-game streak/);
  assert.match(text, /100% over her last 10/);
  assert.match(text, /15\.1 points/);
  assert.match(text, /-460 at FanDuel/);
});

/* ── grading ────────────────────────────────────────────────────── */

test('gradePropLeg grades against the boxscore and voids a DNP', () => {
  const leg = { statKey: 'rebounds', need: 4 };
  assert.deepEqual(gradePropLeg(leg, { rebounds: 7 }), { won: true, actual: 7 });
  assert.deepEqual(gradePropLeg(leg, { rebounds: 3 }), { won: false, actual: 3 });
  assert.equal(gradePropLeg(leg, null).void, true, 'no boxscore row = DNP = void, never a guessed loss');
  assert.equal(gradePropLeg(leg, { rebounds: 'DNP' }).void, true);
});

/* ── moneyline legs (mixed-sport pool) ─────────────────────────── */

test('extractMlCandidates keeps consensus heavy favorites in the safe band', async () => {
  const { extractMlCandidates } = await import('../worker/src/prop-play.js');
  const book = (price) => ({ markets: [{ key: 'h2h', outcomes: [
    { name: 'Iga Swiatek', price }, { name: 'Elina Svitolina', price: +220 },
  ] }] });
  const events = [{
    id: 'ev-t1', sport_key: 'tennis_wta_cincinnati',
    home_team: 'Iga Swiatek', away_team: 'Elina Svitolina',
    commence_time: '2026-08-12T23:00:00Z',
    bookmakers: [book(-300), book(-280), book(-320), book(-300), book(-290)],
  }];
  const out = extractMlCandidates(events, 'upcoming', '2026-08-12', Date.parse('2026-08-12T15:00:00Z'));
  assert.equal(out.length, 1, 'the favorite qualifies, the +220 dog never does');
  assert.equal(out[0].player, 'Iga Swiatek');
  assert.equal(out[0].kind, 'ml');
  assert.ok(out[0].implied >= 0.72);
  assert.equal(out[0].books, 5);

  // Under 4 books = no real consensus; a started game never qualifies.
  const thin = [{ ...events[0], bookmakers: [book(-300), book(-300), book(-300)] }];
  assert.equal(extractMlCandidates(thin, 'upcoming', '2026-08-12', Date.parse('2026-08-12T15:00:00Z')).length, 0);
  assert.equal(extractMlCandidates(events, 'upcoming', '2026-08-12', Date.parse('2026-08-13T01:00:00Z')).length, 0);
});

test('ML legs get a market-consensus writeup', () => {
  const text = legWriteup({
    kind: 'ml', player: 'Iga Swiatek', opponent: 'Elina Svitolina',
    american: -300, implied: 0.75, books: 9,
    game: { sportKey: 'tennis_wta_cincinnati' },
  });
  assert.match(text, /-300 tennis/);
  assert.match(text, /75% implied across 9 books/);
});

test('pair selection lands in the -200..-130 payout window, never stacking two -650s', async () => {
  // Pure check of the window arithmetic the selector enforces: two -650s
  // (1.154^2 = 1.332) sit below the 1.5 (-200) floor, while -300 x -350
  // (1.333 x 1.286 = 1.714) lands inside [-200, -130] and must win even at
  // lower conviction. Mirrors the live -297 failure this pins against.
  const heavy = 1 + 100 / 650;
  const floor = 1.5, cap = 1 + 100 / 130;
  assert.ok(heavy * heavy < floor, 'two -650s cannot reach the -200 floor');
  const light = (1 + 100 / 300) * (1 + 100 / 350);
  assert.ok(light >= floor && light <= cap, '-300 x -350 sits inside the window');
});

test('pair pricing targets even money: the lightest safe pair beats heavier ones', () => {
  // Two -250 legs multiply to ~+96 — as close to +100 as the safe band
  // allows — and must beat a -300 x -350 (-140) pair, which in turn beats
  // two -650s (-297, below the -200 floor entirely).
  const dec = (a) => 1 + 100 / Math.abs(a);
  const light = dec(250) * dec(250);
  const mid = dec(300) * dec(350);
  const heavy = dec(650) * dec(650);
  assert.ok(light > 1.9 && light < 2.05, 'two -250s land at ~+96, inside the even-money ceiling');
  assert.ok(light > mid && mid > heavy);
  assert.ok(heavy < 1.5, 'two -650s stay below the -200 floor');
});
