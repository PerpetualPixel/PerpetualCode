import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchPlayer,
  tennisInsights,
  teamInsights,
  mmaInsights,
  buildInsights,
  insightTexts,
  insightsByTier,
  isTennis,
  isMma,
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
  const text = bullets.map((b) => b.text).join(' ');

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
  const text = tennisInsights(ARCHIVE, 'Aaron Alpha', 'Ben Bravo', { now: NOW }).map((b) => b.text).join(' ');
  assert.match(text, /On hard/);
  assert.ok(!/On clay/.test(text), 'must not quote the stale surface');
});

test('retirements are surfaced as retirements, not diagnoses', () => {
  const text = tennisInsights(ARCHIVE, 'Chris Ghost', 'Aaron Alpha', { now: NOW }).map((b) => b.text).join(' ');
  assert.match(text, /retirement or walkover/);
  // No invented medical claim.
  assert.ok(!/injur(y|ed)|hamstring|knee/i.test(text));
});

test('a long layoff is disclosed rather than passed off as current form', () => {
  const stale = {
    ...ARCHIVE,
    matches: [[day('2026-01-05'), 0, 0, 0, 1, 10, 20, 0]],
  };
  const text = tennisInsights(stale, 'Aaron Alpha', 'Ben Bravo', { now: NOW }).map((b) => b.text).join(' ');
  assert.match(text, /no recorded match since/);
  assert.match(text, /predate that gap/);
});

test('rankings are dated, because a ranking is only as fresh as its last match', () => {
  const text = tennisInsights(ARCHIVE, 'Aaron Alpha', 'Ben Bravo', { now: NOW }).map((b) => b.text).join(' ');
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
  const home = teamInsights(CONTEXT, 'Baltimore Orioles').map((b) => b.text).join(' ');
  assert.match(home, /54-58 on the season and 30-29 at home/);

  const away = teamInsights(CONTEXT, 'Los Angeles Angels').map((b) => b.text).join(' ');
  assert.match(away, /43-69 on the season and 18-36 on the road/);
});

test('injured-list statuses count as unavailable and keep their own casing', () => {
  const text = teamInsights(CONTEXT, 'Baltimore Orioles').map((b) => b.text).join(' ');
  // Two on the IL; day-to-day is not "unavailable".
  assert.match(text, /2 players unavailable/);
  assert.match(text, /10-Day-IL/, 'status casing must survive');
  assert.ok(!/10-day-il/.test(text));
});

test('against-the-spread only appears on spread bets', () => {
  assert.ok(!/spread/i.test(teamInsights(CONTEXT, 'Baltimore Orioles', { marketKey: 'h2h' }).map((b) => b.text).join(' ')));
  assert.match(
    teamInsights(CONTEXT, 'Baltimore Orioles', { marketKey: 'spreads' }).map((b) => b.text).join(' '),
    /Against the spread this season: Orioles 30-28/,
  );
});

test('a season that has not started yet produces no record bullet', () => {
  const preseason = {
    ...CONTEXT,
    home: { ...CONTEXT.home, overallRecord: '0-0', homeRecord: '0-0' },
    away: { ...CONTEXT.away, overallRecord: '0-0' },
  };
  const text = teamInsights(preseason, 'Baltimore Orioles').map((b) => b.text).join(' ');
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
  const text = teamInsights(soccer, 'Arsenal').map((b) => b.text).join(' ');
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
/* MMA (UFC / PFL / Contender Series)                                 */
/* ---------------------------------------------------------------- */

// Shape matches worker/src/mma.js's fetchMmaContext output exactly, so a
// change to one that silently breaks the other shows up here.
const fighter = (name, record, history) => ({ name, record, profileUrl: '#', history });

const MMA_CONTEXT = {
  a: fighter(
    'Amanda Lemos',
    { wins: 15, losses: 6, draws: 1 },
    [
      // Newest first — matches how Sherdog itself orders the table.
      { result: 'loss', opponent: 'Gillian Robertson', event: 'UFC Fight Night 269', date: 'Mar / 14 / 2026', method: 'Decision (Unanimous)', category: 'decision' },
      { result: 'loss', opponent: 'Tatiana Suarez', event: 'UFC Fight Night 259', date: 'Sep / 13 / 2025', method: 'Decision (Unanimous)', category: 'decision' },
      { result: 'win', opponent: 'Iasmin Lucindo', event: 'UFC 313', date: 'Mar / 08 / 2025', method: 'Decision (Unanimous)', category: 'decision' },
      { result: 'loss', opponent: 'Virna Jandiroba', event: 'UFC on ESPN 60', date: 'Dec / 07 / 2024', method: 'Submission (Rear-Naked Choke)', category: 'submission' },
      { result: 'win', opponent: 'Mackenzie Dern', event: 'UFC 295', date: 'Nov / 11 / 2023', method: 'KO (Punch)', category: 'knockout' },
      { result: 'win', opponent: 'Marina Rodriguez', event: 'UFC Fight Night 214', date: 'Nov / 05 / 2022', method: 'TKO (Punches)', category: 'knockout' },
    ],
  ),
  b: fighter(
    'Alexia Thainara',
    { wins: 14, losses: 1, draws: 0 },
    [
      { result: 'win', opponent: 'Someone A', event: 'Card A', date: 'Jun / 01 / 2026', method: 'Submission (Armbar)', category: 'submission' },
      { result: 'win', opponent: 'Someone B', event: 'Card B', date: 'Feb / 01 / 2026', method: 'Submission (Guillotine)', category: 'submission' },
      { result: 'win', opponent: 'Someone C', event: 'Card C', date: 'Oct / 01 / 2025', method: 'Decision (Unanimous)', category: 'decision' },
      { result: 'win', opponent: 'Someone D', event: 'Card D', date: 'Jun / 01 / 2025', method: 'Submission (Rear-Naked Choke)', category: 'submission' },
      { result: 'win', opponent: 'Someone E', event: 'Card E', date: 'Feb / 01 / 2025', method: 'Submission (Triangle Choke)', category: 'submission' },
    ],
  ),
};

test('the record line states total, not just wins, and the finish breakdown', () => {
  const text = mmaInsights(MMA_CONTEXT, 'Amanda Lemos').map((b) => b.text).join(' ');
  assert.match(text, /15-6-1 pro \(22 fights\)/);
  // 2 KO/TKO wins + 0 submission wins = 2 of 3 wins by finish (one win, the
  // Lucindo decision, is not a finish).
  assert.match(text, /2 of 3 wins by finish \(2 KO\/TKO, 0 submission\)/);
});

test('a draw only appears in the record when there is one', () => {
  const withDraw = mmaInsights(MMA_CONTEXT, 'Amanda Lemos').map((b) => b.text).join(' ');
  assert.match(withDraw, /15-6-1/);
  const noDraw = mmaInsights(MMA_CONTEXT, 'Alexia Thainara').map((b) => b.text).join(' ');
  assert.match(noDraw, /14-1 pro/);
  assert.ok(!/14-1-0/.test(noDraw), 'a 0-draw record should not print a trailing -0');
});

test('recent form is newest-first and compares both fighters', () => {
  const text = mmaInsights(MMA_CONTEXT, 'Amanda Lemos').map((b) => b.text).join(' ');
  // Lemos: loss, loss, win, loss, win -> L-L-W-L-W
  assert.match(text, /Last 5: L-L-W-L-W \(2 wins\)/);
  assert.match(text, /Alexia Thainara: Last 5: W-W-W-W-W \(5 wins\)/);
});

test('losses are broken down by finish type — durability is not hidden', () => {
  const text = mmaInsights(MMA_CONTEXT, 'Amanda Lemos').map((b) => b.text).join(' ');
  // The count is read from the parsed history, not the header record — the
  // fixture's history has 3 losses (the header's 6 includes older fights this
  // mock doesn't bother listing), 1 of them by submission, 0 by KO/TKO.
  assert.match(text, /Of Amanda Lemos's 3 career losses, 1 loss by submission/);
});

test('a long layoff is disclosed, not silently folded into current form', () => {
  const stale = {
    a: fighter('Old Timer', { wins: 10, losses: 2, draws: 0 }, [
      { result: 'win', opponent: 'X', event: 'Y', date: 'Jan / 01 / 2023', method: 'Decision (Unanimous)', category: 'decision' },
    ]),
    b: null,
  };
  const text = mmaInsights(stale, 'Old Timer').map((b) => b.text).join(' ');
  assert.match(text, /last fight was Jan \/ 01 \/ 2023/);
  assert.match(text, /predates that layoff/);
});

test('no layoff notice for a fighter who fought recently', () => {
  const text = mmaInsights(MMA_CONTEXT, 'Alexia Thainara').map((b) => b.text).join(' ');
  assert.ok(!/predates that layoff/.test(text));
});

test('a fighter with no record on file still gets a named, honest bullet', () => {
  const noRecord = {
    a: { name: 'Brand New Prospect', profileUrl: '#', record: null, history: [] },
    b: null,
  };
  const text = mmaInsights(noRecord, 'Brand New Prospect').map((b) => b.text).join(' ');
  assert.match(text, /Brand New Prospect's pro record isn't on file/);
});

test('an unresolved subject produces no bullets, never the wrong fighter\'s stats', () => {
  assert.deepEqual(mmaInsights(MMA_CONTEXT, 'Someone Else Entirely'), []);
  assert.deepEqual(mmaInsights(null, 'Amanda Lemos'), []);
});

test('one side missing from Sherdog does not block bullets for the side that resolved', () => {
  const oneSided = { a: MMA_CONTEXT.a, b: null };
  const text = mmaInsights(oneSided, 'Amanda Lemos').map((b) => b.text).join(' ');
  assert.match(text, /15-6-1/);
  assert.ok(!/undefined/.test(text));
});

/* ---------------------------------------------------------------- */
/* Tier tagging — every bullet is { tier, text }, grouped for Play of    */
/* the Day's 4-tier write-up (worker/src/potd.js)                        */
/* ---------------------------------------------------------------- */

test('every tennis bullet is tagged personnel or situational, never supporting', () => {
  // Force both an idle-gap flag (situational) and a retirement flag
  // (situational) alongside the usual record/form/H2H (personnel).
  const stale = { ...ARCHIVE, matches: [[day('2026-01-05'), 0, 0, 0, 1, 10, 20, 0]] };
  const bullets = tennisInsights(stale, 'Aaron Alpha', 'Ben Bravo', { now: NOW });
  assert.ok(bullets.length > 0);
  for (const b of bullets) assert.ok(['personnel', 'situational'].includes(b.tier), b.tier);
  assert.ok(bullets.some((b) => b.tier === 'situational'), 'the idle-gap flag must be situational');
  assert.ok(bullets.some((b) => b.tier === 'personnel'), 'record/form must be personnel');
  // Individual sport — never a "supporting cast" bullet.
  assert.ok(!bullets.some((b) => b.tier === 'supporting'));
});

test('every MMA bullet is tagged personnel or situational, never supporting', () => {
  const stale = {
    a: fighter('Old Timer', { wins: 10, losses: 2, draws: 0 }, [
      { result: 'win', opponent: 'X', event: 'Y', date: 'Jan / 01 / 2023', method: 'Decision (Unanimous)', category: 'decision' },
    ]),
    b: null,
  };
  const bullets = mmaInsights(stale, 'Old Timer');
  assert.ok(bullets.length > 0);
  for (const b of bullets) assert.ok(['personnel', 'situational'].includes(b.tier), b.tier);
  assert.ok(bullets.some((b) => b.tier === 'situational'), 'the layoff flag must be situational');
  assert.ok(!bullets.some((b) => b.tier === 'supporting'));
});

test('team-sport bullets split personnel (record/form/H2H/ATS) from supporting (injuries)', () => {
  const bullets = teamInsights(CONTEXT, 'Baltimore Orioles', { marketKey: 'spreads' });
  const personnel = insightsByTier(bullets, 'personnel');
  const supporting = insightsByTier(bullets, 'supporting');

  assert.ok(personnel.some((t) => /on the season/.test(t)));
  assert.ok(personnel.some((t) => /have won/.test(t))); // baseball has no draws: "have won N of 5", not "Last 5 —"
  assert.ok(personnel.some((t) => /lead series/.test(t)));
  assert.ok(personnel.some((t) => /Against the spread/.test(t)));
  assert.ok(supporting.some((t) => /unavailable/.test(t)));
  // The injury bullet must not also show up as personnel — one tier each.
  assert.ok(!personnel.some((t) => /unavailable/.test(t)));
});

test('a team with no injuries produces no supporting-tier bullets at all', () => {
  const bullets = teamInsights(CONTEXT, 'Los Angeles Angels');
  assert.deepEqual(insightsByTier(bullets, 'supporting'), []);
});

test('insightTexts flattens tagged bullets back to the plain-string list compact cards render', () => {
  const bullets = teamInsights(CONTEXT, 'Baltimore Orioles');
  const flat = insightTexts(bullets);
  assert.deepEqual(flat, bullets.map((b) => b.text));
  assert.ok(flat.every((t) => typeof t === 'string'));
});

test('insightsByTier returns an empty array for a tier with nothing in it', () => {
  const bullets = tennisInsights(ARCHIVE, 'Aaron Alpha', 'Ben Bravo', { now: NOW });
  assert.deepEqual(insightsByTier(bullets, 'supporting'), []);
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

  assert.equal(isMma('mma_mixed_martial_arts'), true);
  assert.equal(isMma('baseball_mlb'), false);

  const mmaLeg = {
    sportKey: 'mma_mixed_martial_arts', marketKey: 'h2h',
    selection: 'Amanda Lemos to win', home: 'Amanda Lemos', away: 'Alexia Thainara',
  };
  assert.ok(buildInsights(mmaLeg, { mmaContext: MMA_CONTEXT }).length > 0);
  // No Sherdog data reachable — nothing invented in its place.
  assert.deepEqual(buildInsights(mmaLeg, { mmaContext: null }), []);
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
  const text = buildInsights(spreadLeg, { context: CONTEXT }).map((b) => b.text).join(' ');
  assert.match(text, /Orioles/);
  assert.match(text, /Against the spread/);
});
