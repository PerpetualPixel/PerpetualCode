import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchPlayer,
  tennisInsights,
  teamInsights,
  buildInsights,
  isTennis,
} from '../docs/insights.js';

const NOW = Date.parse('2026-08-04T12:00:00Z');
const EPOCH = Date.UTC(2000, 0, 1);
const day = (iso) => Math.round((Date.parse(iso) - EPOCH) / 86400000);

/* ---------------------------------------------------------------- */
/* Name matching                                                      */
/* ---------------------------------------------------------------- */

const PLAYERS = [
  'Ruse E.G.', 'Potapova A.', 'De Minaur A.', 'Van De Zandschulp B.',
  'Mpetshi Perricard G.', 'Cerundolo J.M.', 'Cerundolo F.', 'Chwalinska M.',
  'Keys M.', 'Draper J.',
];

test('archive names resolve from the odds feed spelling', () => {
  const cases = [
    ['Elena Gabriela Ruse', 'Ruse E.G.'],
    ['Anastasia Potapova', 'Potapova A.'],
    ['Alex de Minaur', 'De Minaur A.'],
    ['Botic van de Zandschulp', 'Van De Zandschulp B.'],
    ['Giovanni Mpetshi Perricard', 'Mpetshi Perricard G.'],
    ['Madison Keys', 'Keys M.'],
  ];
  for (const [oddsName, expected] of cases) {
    assert.equal(matchPlayer(oddsName, PLAYERS)?.name, expected, oddsName);
  }
});

test('initials disambiguate players who share a surname', () => {
  assert.equal(matchPlayer('Juan Manuel Cerundolo', PLAYERS)?.name, 'Cerundolo J.M.');
  assert.equal(matchPlayer('Francisco Cerundolo', PLAYERS)?.name, 'Cerundolo F.');
});

test('accents fold away', () => {
  assert.equal(matchPlayer('Maja Chwalińska', PLAYERS)?.name, 'Chwalinska M.');
});

test('a name with no counterpart returns null rather than a guess', () => {
  // The board mixes sports: cricket sides arrive through the same field, and
  // attaching someone else's head-to-head record to them would be worse than
  // showing nothing at all.
  for (const name of ['West Indies', 'Sunrisers Leeds', 'Pakistan', '']) {
    assert.equal(matchPlayer(name, PLAYERS), null, name);
  }
});

/* ---------------------------------------------------------------- */
/* Tennis                                                             */
/* ---------------------------------------------------------------- */

/** Small deterministic archive: A beats B twice, B beats A once. */
const ARCHIVE = {
  tour: 'test',
  seasons: [2025, 2026],
  surfaces: ['Hard', 'Clay'],
  rounds: ['1st Round', 'The Final'],
  players: ['Alpha A.', 'Bravo B.', 'Ghost G.'],
  matches: [
    [day('2026-05-01'), 1, 0, 1, 0, 20, 10, 0], // Bravo beats Alpha on clay
    [day('2026-07-01'), 0, 0, 0, 1, 10, 20, 0], // Alpha beats Bravo on hard
    [day('2026-07-10'), 0, 0, 0, 1, 10, 20, 0], // Alpha beats Bravo on hard
    [day('2026-07-15'), 0, 0, 0, 2, 10, 90, 0],
    [day('2026-07-20'), 0, 0, 2, 0, 90, 10, 1], // retirement
    [day('2026-07-25'), 0, 0, 0, 2, 10, 90, 0],
    [day('2026-07-28'), 0, 0, 1, 2, 20, 90, 0],
    [day('2026-08-01'), 0, 0, 1, 2, 20, 90, 0],
  ],
};

test('tennis bullets report the actual head-to-head and form', () => {
  const bullets = tennisInsights(ARCHIVE, 'Aaron Alpha', 'Ben Bravo', { now: NOW });
  const text = bullets.join(' ');

  // Alpha leads the series 2-1 and took the most recent meeting, on hard.
  assert.match(text, /Alpha 2, Bravo 1/);
  assert.match(text, /hard/);
  // Overall: Alpha 6 matches for 4-2, Bravo 5 for 3-2.
  assert.match(text, /Alpha 4-2/);
  assert.match(text, /Bravo 3-2/);
  // On hard alone Alpha is 4-1 — the clay defeat belongs to a different surface
  // and must not be folded into the hard-court line.
  assert.match(text, /On hard, Alpha is 4-1 \(80%\)/);
});

test('the surface quoted is the one the tour is currently playing', () => {
  // Alpha's only clay match is a loss, but every recent match in the archive is
  // on hard. Quoting a clay record next to a hard-court fixture would be true
  // and still misleading, so the current surface wins.
  const text = tennisInsights(ARCHIVE, 'Aaron Alpha', 'Ben Bravo', { now: NOW }).join(' ');
  assert.match(text, /On hard/);
  assert.ok(!/On clay/.test(text), 'must not quote the stale surface');
});

test('retirements are surfaced as retirements, not diagnoses', () => {
  const text = tennisInsights(ARCHIVE, 'Chris Ghost', 'Aaron Alpha', { now: NOW }).join(' ');
  assert.match(text, /retirement or walkover/);
  // No invented medical claim.
  assert.ok(!/injur(y|ed)|hamstring|knee/i.test(text));
});

test('a long layoff is disclosed rather than passed off as current form', () => {
  const stale = {
    ...ARCHIVE,
    matches: [[day('2026-01-05'), 0, 0, 0, 1, 10, 20, 0]],
  };
  const text = tennisInsights(stale, 'Aaron Alpha', 'Ben Bravo', { now: NOW }).join(' ');
  assert.match(text, /no recorded match since/);
  assert.match(text, /predate that gap/);
});

test('rankings are dated, because a ranking is only as fresh as its last match', () => {
  const text = tennisInsights(ARCHIVE, 'Aaron Alpha', 'Ben Bravo', { now: NOW }).join(' ');
  assert.match(text, /Ranked 10 as of \w{3} \d+/);
});

test('an unknown player produces no bullets at all', () => {
  assert.deepEqual(tennisInsights(ARCHIVE, 'Nobody At All', 'Ben Bravo', { now: NOW }), []);
  assert.deepEqual(tennisInsights(null, 'Aaron Alpha', 'Ben Bravo', { now: NOW }), []);
  assert.deepEqual(
    tennisInsights({ ...ARCHIVE, matches: [] }, 'Aaron Alpha', 'Ben Bravo', { now: NOW }),
    [],
  );
});

/* ---------------------------------------------------------------- */
/* Team sports                                                        */
/* ---------------------------------------------------------------- */

const CONTEXT = {
  seriesSummary: 'LAA lead series 2-1',
  home: {
    name: 'Baltimore Orioles', shortName: 'Orioles', isHome: true,
    overallRecord: '54-58', homeRecord: '30-29', awayRecord: '24-29',
    lastFive: 'LWWLL'.split('').map((result) => ({ result })),
    atsRecord: '30-28', injuries: [
      { name: 'Samuel Basallo', status: '10-Day-IL' },
      { name: 'Chris Bassitt', status: '60-Day-IL' },
      { name: 'Someone Fine', status: 'Day-To-Day' },
    ],
  },
  away: {
    name: 'Los Angeles Angels', shortName: 'Angels', isHome: false,
    overallRecord: '43-69', homeRecord: '25-33', awayRecord: '18-36',
    lastFive: 'LLLLW'.split('').map((result) => ({ result })),
    atsRecord: '52-58', injuries: [],
  },
};

test('team bullets use the venue split that matches the side being bet', () => {
  const home = teamInsights(CONTEXT, 'Baltimore Orioles').join(' ');
  assert.match(home, /54-58 on the season and 30-29 at home/);

  const away = teamInsights(CONTEXT, 'Los Angeles Angels').join(' ');
  assert.match(away, /43-69 on the season and 18-36 on the road/);
});

test('injured-list statuses count as unavailable and keep their own casing', () => {
  const text = teamInsights(CONTEXT, 'Baltimore Orioles').join(' ');
  // Two on the IL; day-to-day is not "unavailable".
  assert.match(text, /2 players unavailable/);
  assert.match(text, /10-Day-IL/, 'status casing must survive');
  assert.ok(!/10-day-il/.test(text));
});

test('against-the-spread only appears on spread bets', () => {
  assert.ok(!/spread/i.test(teamInsights(CONTEXT, 'Baltimore Orioles', { marketKey: 'h2h' }).join(' ')));
  assert.match(
    teamInsights(CONTEXT, 'Baltimore Orioles', { marketKey: 'spreads' }).join(' '),
    /Against the spread this season: Orioles 30-28/,
  );
});

test('a season that has not started yet produces no record bullet', () => {
  const preseason = {
    ...CONTEXT,
    home: { ...CONTEXT.home, overallRecord: '0-0', homeRecord: '0-0' },
    away: { ...CONTEXT.away, overallRecord: '0-0' },
  };
  const text = teamInsights(preseason, 'Baltimore Orioles').join(' ');
  assert.ok(!/on the season/.test(text), '0-0 is true and worthless');
});

test('draws are counted, not folded into losses', () => {
  const soccer = {
    seriesSummary: null,
    home: {
      name: 'Arsenal', shortName: 'Arsenal', isHome: true,
      overallRecord: '4-4-10', lastFive: 'LDDLL'.split('').map((result) => ({ result })),
      injuries: [],
    },
    away: {
      name: 'Coventry City', shortName: 'Coventry', isHome: false,
      overallRecord: '9-3-5', lastFive: 'DDWWW'.split('').map((result) => ({ result })),
      injuries: [],
    },
  };
  const text = teamInsights(soccer, 'Arsenal').join(' ');
  assert.match(text, /0W-2D-3L/);
  // One format per sentence — never "0 of 5" alongside "3W-2D-0L".
  assert.match(text, /3W-2D-0L/);
  assert.ok(!/ of 5 /.test(text));
});

test('no context means no bullets, never filler', () => {
  assert.deepEqual(teamInsights(null, 'Baltimore Orioles'), []);
  assert.deepEqual(teamInsights(CONTEXT, 'Some Team Not Playing'), []);
});

/* ---------------------------------------------------------------- */
/* Dispatch                                                           */
/* ---------------------------------------------------------------- */

test('tennis is routed to the archive and team sports to the context bundle', () => {
  assert.equal(isTennis('tennis_atp_canadian_open'), true);
  assert.equal(isTennis('baseball_mlb'), false);

  const tennisLeg = {
    sportKey: 'tennis_wta_canadian_open', marketKey: 'h2h',
    selection: 'Aaron Alpha to win', home: 'Aaron Alpha', away: 'Ben Bravo',
  };
  assert.ok(buildInsights(tennisLeg, { tennisData: ARCHIVE, now: NOW }).length > 0);
  // Without the archive there is nothing to say, and nothing is what it says.
  assert.deepEqual(buildInsights(tennisLeg, { tennisData: null, now: NOW }), []);

  const mlbLeg = {
    sportKey: 'baseball_mlb', marketKey: 'h2h',
    selection: 'Baltimore Orioles to win',
    home: 'Baltimore Orioles', away: 'Los Angeles Angels',
  };
  assert.ok(buildInsights(mlbLeg, { context: CONTEXT }).length > 0);
});

test('a total has no side to profile, so it gets no team bullets', () => {
  const totalLeg = {
    sportKey: 'baseball_mlb', marketKey: 'totals',
    selection: 'Under 8.5 — Los Angeles Angels @ Baltimore Orioles',
    home: 'Baltimore Orioles', away: 'Los Angeles Angels',
  };
  assert.deepEqual(buildInsights(totalLeg, { context: CONTEXT }), []);
});

test('a spread selection still resolves to its team', () => {
  const spreadLeg = {
    sportKey: 'baseball_mlb', marketKey: 'spreads',
    selection: 'Baltimore Orioles -1.5',
    home: 'Baltimore Orioles', away: 'Los Angeles Angels',
  };
  const text = buildInsights(spreadLeg, { context: CONTEXT }).join(' ');
  assert.match(text, /Orioles/);
  assert.match(text, /Against the spread/);
});
