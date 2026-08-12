/**
 * Finished-game result detail: the /boxscore extraction (worker/src/
 * boxscore.js), the tennis set-score settlement detail (docs/
 * tennis-results.js), and the MMA winner/method detail (worker/src/
 * ufc-events.js) — the three data paths behind the finished cards'
 * box-score grids and result lines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxFromScoreboard, etDay, hasBoxScore } from '../worker/src/boxscore.js';
import { gradeTennisMatchWinner, gradeTennisGameMarket } from '../docs/tennis-results.js';
import { mmaFinishMethod, gradeMmaPickWithFallback } from '../worker/src/ufc-events.js';

const MLB_LEAGUE = { kind: 'innings', periods: 9, path: 'mlb' };

/** A completed MLB scoreboard event shaped like ESPN's cdn payload. */
function mlbScoreboard({ completed = true } = {}) {
  const side = (abbr, displayName, homeAway, runs, perInning, hits, errors, winner) => ({
    homeAway,
    winner,
    score: String(runs),
    hits,
    errors,
    linescores: perInning.map((v) => ({ value: v })),
    records: [{ type: 'total', summary: '64-54' }],
    team: { abbreviation: abbr, displayName, shortDisplayName: displayName.split(' ').pop(), name: displayName.split(' ').pop() },
  });
  return {
    events: [{
      date: '2026-08-10T23:07Z',
      competitions: [{
        status: { type: { completed } },
        venue: { fullName: 'Rogers Centre', address: { city: 'Toronto', state: 'ON' } },
        competitors: [
          side('TOR', 'Toronto Blue Jays', 'home', 2, [0, 0, 0, 0, 1, 1, 0, 0, 0], 7, 0, true),
          side('BOS', 'Boston Red Sox', 'away', 1, [0, 0, 0, 0, 0, 0, 1, 0, 0], 6, 1, false),
        ],
      }],
    }],
  };
}

test('boxFromScoreboard extracts innings, R/H/E, venue, and winner for a matched completed game', () => {
  const { box, reason } = boxFromScoreboard(mlbScoreboard(), {
    home: 'Toronto Blue Jays', away: 'Boston Red Sox', league: MLB_LEAGUE,
  });
  assert.equal(reason, 'ok');
  assert.ok(box);
  assert.equal(box.kind, 'innings');
  assert.equal(box.venue, 'Rogers Centre – Toronto – ON');
  assert.equal(box.home.abbr, 'TOR');
  assert.equal(box.home.total, 2);
  assert.equal(box.home.hits, 7);
  assert.equal(box.home.errors, 0);
  assert.equal(box.home.winner, true);
  assert.deepEqual(box.away.linescores, [0, 0, 0, 0, 0, 0, 1, 0, 0]);
  assert.equal(box.away.errors, 1);
  assert.equal(box.away.winner, false);
});

test('boxFromScoreboard refuses an unmatched fixture', () => {
  assert.deepEqual(
    boxFromScoreboard(mlbScoreboard(), { home: 'Arizona Diamondbacks', away: 'Colorado Rockies', league: MLB_LEAGUE }),
    { box: null, reason: 'unmatched' },
    'a fixture not on this scoreboard must never borrow another game\'s box',
  );
});

test('boxFromScoreboard serves a statusless payload once linescores exist', () => {
  // Regression for the live-cards bug: a payload with no readable state but
  // real linescore entries was refused as "unreadable", which is exactly how
  // every live card stayed grid-less while finished ones (completed: true)
  // rendered. Linescores only exist once play has started — that IS the
  // signal, so it serves, as in-progress.
  const { box, reason } = boxFromScoreboard(
    mlbScoreboard({ completed: false }),
    { home: 'Toronto Blue Jays', away: 'Boston Red Sox', league: MLB_LEAGUE },
  );
  assert.equal(reason, 'ok');
  assert.ok(box);
  assert.equal(box.status.completed, false);
  assert.equal(box.home.total, 2);
});

test('boxFromScoreboard refuses a game with nothing to show', () => {
  // No status anywhere and no linescore entries: hasn't started.
  const sb = mlbScoreboard({ completed: false });
  for (const c of sb.events[0].competitions[0].competitors) {
    delete c.linescores;
    delete c.winner;
  }
  assert.deepEqual(
    boxFromScoreboard(sb, { home: 'Toronto Blue Jays', away: 'Boston Red Sox', league: MLB_LEAGUE }),
    { box: null, reason: 'not_started' },
  );
});

test('boxFromScoreboard reads status from the event when the competition lacks one', () => {
  // Some leagues' scoreboard pages hang status off the event rather than the
  // competition (the WNBA finished-card case) — both spots are read.
  const sb = mlbScoreboard({ completed: false });
  delete sb.events[0].competitions[0].status;
  sb.events[0].status = { period: 4, type: { state: 'post', completed: true, shortDetail: 'Final' } };
  const { box, reason } = boxFromScoreboard(sb, { home: 'Toronto Blue Jays', away: 'Boston Red Sox', league: MLB_LEAGUE });
  assert.equal(reason, 'ok');
  assert.equal(box.status.completed, true);
  assert.equal(box.status.detail, 'Final');
});

// -- live (in-progress) boxes ------------------------------------------------

/** An MLB scoreboard mid-game: 5 innings played, ESPN reporting "Top 5th". */
function liveMlbScoreboard({ state = 'in', detail = 'Top 5th', period = 5 } = {}) {
  const sb = mlbScoreboard({ completed: false });
  const competition = sb.events[0].competitions[0];
  competition.status = { period, type: { state, completed: false, shortDetail: detail } };
  // Only the innings actually played are reported while a game is live.
  competition.competitors[0].linescores = [{ value: 0 }, { value: 1 }, { value: 0 }, { value: 0 }, { value: 1 }];
  competition.competitors[0].score = '2';
  competition.competitors[1].linescores = [{ value: 1 }, { value: 0 }, { value: 0 }, { value: 0 }];
  competition.competitors[1].score = '1';
  return sb;
}

test('boxFromScoreboard serves an in-progress game with its status and partial line', () => {
  const { box, reason } = boxFromScoreboard(liveMlbScoreboard(), {
    home: 'Toronto Blue Jays', away: 'Boston Red Sox', league: MLB_LEAGUE,
  });
  assert.equal(reason, 'ok');
  assert.ok(box, 'a live game must return a box — the inning is the whole point');
  assert.equal(box.status.state, 'in');
  assert.equal(box.status.completed, false);
  assert.equal(box.status.detail, 'Top 5th');
  assert.equal(box.status.period, 5);
  assert.equal(box.home.total, 2);
  // Innings not yet played pad as null (rendered "—"), never as a fabricated 0.
  assert.deepEqual(box.home.linescores, [0, 1, 0, 0, 1, null, null, null, null]);
  assert.deepEqual(box.away.linescores, [1, 0, 0, 0, null, null, null, null, null]);
});

test('boxFromScoreboard returns null before first pitch, even over stray linescores', () => {
  // A scheduled game has no line to show, and the card's pregame layout is
  // already the right one — a grid of nine em dashes would be noise. An
  // explicit 'pre' from ESPN outranks every other started-signal: this
  // fixture even carries linescore entries, and 'pre' still wins.
  const sb = liveMlbScoreboard({ state: 'pre', detail: '7:07 PM ET', period: 0 });
  assert.deepEqual(
    boxFromScoreboard(sb, { home: 'Toronto Blue Jays', away: 'Boston Red Sox', league: MLB_LEAGUE }),
    { box: null, reason: 'not_started' },
  );
});

test('boxFromScoreboard carries a completed status through for a finished game', () => {
  // The finished card's grid keeps working, and gains the flag the renderer
  // reads to decide whether dimming the loser is allowed yet.
  const sb = mlbScoreboard();
  sb.events[0].competitions[0].status = { period: 9, type: { state: 'post', completed: true, shortDetail: 'Final' } };
  const { box } = boxFromScoreboard(sb, { home: 'Toronto Blue Jays', away: 'Boston Red Sox', league: MLB_LEAGUE });
  assert.ok(box);
  assert.equal(box.status.completed, true);
  assert.equal(box.status.state, 'post');
  assert.equal(box.status.detail, 'Final');
});

test('boxFromScoreboard pads a shortened linescore to the standard period count with nulls, never zeros', () => {
  const sb = mlbScoreboard();
  sb.events[0].competitions[0].competitors[0].linescores = [{ value: 0 }, { value: 2 }]; // rain-shortened report
  const { box } = boxFromScoreboard(sb, { home: 'Toronto Blue Jays', away: 'Boston Red Sox', league: MLB_LEAGUE });
  assert.equal(box.home.linescores.length, 9);
  assert.equal(box.home.linescores[2], null, 'a missing inning is unknown, not a fabricated 0');
});

test('hasBoxScore covers exactly the sports with a per-period source', () => {
  assert.equal(hasBoxScore('baseball_mlb'), true);
  assert.equal(hasBoxScore('americanfootball_nfl'), true);
  assert.equal(hasBoxScore('basketball_wnba'), true);
  assert.equal(hasBoxScore('icehockey_nhl'), false, 'NHL has no scoreboard on the reachable ESPN host');
  assert.equal(hasBoxScore('tennis_atp_canadian_open'), false);
  assert.equal(hasBoxScore('mma_mixed_martial_arts'), false);
});

/* ── Tennis set-score detail ────────────────────────────────────── */

const TENNIS_PICK = {
  marketKey: 'h2h', home: 'Elena Rybakina', away: 'Naomi Osaka',
  outcomeName: 'Elena Rybakina', decimal: 1.9, suggested_stake: 20,
};

test('gradeTennisMatchWinner attaches winner-oriented set-score detail', () => {
  const outcome = gradeTennisMatchWinner(TENNIS_PICK, {
    participantNames: ['Elena Rybakina', 'Naomi Osaka'],
    score: '7-5,6-3',
    status: 'Ended',
  });
  assert.equal(outcome.won, true);
  assert.equal(outcome.detail.winner, 'Elena Rybakina');
  assert.equal(outcome.detail.setScore, '7-5, 6-3');
});

test('tennis set detail reads winner-first even when the API listed the winner second', () => {
  const outcome = gradeTennisMatchWinner(TENNIS_PICK, {
    participantNames: ['Naomi Osaka', 'Elena Rybakina'],
    score: '5-7,3-6', // Osaka-first orientation: Rybakina won the same 7-5, 6-3
    status: 'Ended',
  });
  assert.equal(outcome.won, true);
  assert.equal(outcome.detail.winner, 'Elena Rybakina');
  assert.equal(outcome.detail.setScore, '7-5, 6-3', 'scoreline reads from the winner\'s perspective regardless of API order');
});

test('gradeTennisGameMarket carries the same detail on spreads/totals settlements', () => {
  const outcome = gradeTennisGameMarket(
    { ...TENNIS_PICK, marketKey: 'totals', outcomeName: 'Over', point: 18.5 },
    { participantNames: ['Elena Rybakina', 'Naomi Osaka'], score: '7-5,6-3', status: 'Ended' },
  );
  assert.equal(outcome.won, true); // 21 games > 18.5
  assert.equal(outcome.detail.setScore, '7-5, 6-3');
});

/* ── MMA winner + method detail ─────────────────────────────────── */

test('mmaFinishMethod reads the method across ESPN field variants and never invents one', () => {
  assert.equal(mmaFinishMethod({ status: { result: { displayName: 'Decision - Unanimous' } } }), 'Decision - Unanimous');
  assert.equal(mmaFinishMethod({ status: { result: { description: 'KO/TKO' } } }), 'KO/TKO');
  assert.equal(mmaFinishMethod({ competitors: [{ result: { displayName: 'Submission' } }] }), 'Submission');
  assert.equal(mmaFinishMethod({ status: { result: { displayName: 'Final' } } }), null, 'a generic completion state is not a finish method');
  assert.equal(mmaFinishMethod({}), null);
});

test('gradeMmaPickWithFallback attaches winner + method detail to a graded fight', () => {
  const pick = {
    marketKey: 'h2h', home: 'Mateusz Gamrot', away: 'Charles Oliveira',
    outcomeName: 'Mateusz Gamrot', decimal: 2.1, suggested_stake: 20,
    eventId: 'f1',
  };
  const results = [{
    a: 'mateusz gamrot', b: 'charles oliveira', aWon: true, bWon: false,
    displayA: 'Mateusz Gamrot', displayB: 'Charles Oliveira', method: 'Decision - Unanimous',
  }];
  const outcome = gradeMmaPickWithFallback(pick, null, results);
  assert.ok(outcome);
  assert.equal(outcome.won, true);
  assert.equal(outcome.detail.winner, 'Mateusz Gamrot');
  assert.equal(outcome.detail.method, 'Decision - Unanimous');
});

// -- the wrong-day guard -----------------------------------------------------

test('etDay converts a UTC instant to its ET calendar day', () => {
  // 01:45Z on Aug 12 is 9:45 PM ET on Aug 11 — the exact boundary this
  // guard exists for: West Coast night games are "tomorrow" in UTC.
  assert.equal(etDay('2026-08-12T01:45Z'), '20260811');
  assert.equal(etDay('2026-08-12T16:00Z'), '20260812');
  assert.equal(etDay('not a date'), null);
  assert.equal(etDay(undefined), null);
});

test('boxFromScoreboard refuses a matched event from a different ET day', () => {
  // The failure this prevents was observed live: late in the evening ESPN's
  // dated cdn page rolls to the NEXT day's schedule — same matchups, all
  // pregame. Teams in a series are a perfect findEvent match on consecutive
  // nights; only the date tells tonight's live game from tomorrow's fixture.
  const sb = mlbScoreboard();
  sb.events[0].date = '2026-08-12T23:00Z'; // ET Aug 12
  assert.deepEqual(
    boxFromScoreboard(sb, {
      home: 'Toronto Blue Jays', away: 'Boston Red Sox', league: MLB_LEAGUE, expectedDay: '20260811',
    }),
    { box: null, reason: 'wrong_day' },
  );
});

test('boxFromScoreboard serves the matched event when its ET day agrees', () => {
  const sb = mlbScoreboard();
  sb.events[0].date = '2026-08-12T01:45Z'; // 9:45 PM ET Aug 11
  const { box, reason } = boxFromScoreboard(sb, {
    home: 'Toronto Blue Jays', away: 'Boston Red Sox', league: MLB_LEAGUE, expectedDay: '20260811',
  });
  assert.equal(reason, 'ok');
  assert.ok(box);
});

test('boxFromScoreboard skips the day check when no expectedDay or event date exists', () => {
  // No expectedDay: caller didn't pin a day, nothing to enforce. No event
  // date: nothing to compare against — refusing there would break every
  // payload that omits the field, for no correctness gain.
  const noExpected = boxFromScoreboard(mlbScoreboard(), {
    home: 'Toronto Blue Jays', away: 'Boston Red Sox', league: MLB_LEAGUE,
  });
  assert.equal(noExpected.reason, 'ok');

  const sb = mlbScoreboard();
  delete sb.events[0].date;
  const noEventDate = boxFromScoreboard(sb, {
    home: 'Toronto Blue Jays', away: 'Boston Red Sox', league: MLB_LEAGUE, expectedDay: '20260811',
  });
  assert.equal(noEventDate.reason, 'ok');
});
