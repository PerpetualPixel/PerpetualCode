import test from 'node:test';
import assert from 'node:assert/strict';
import { boxKey, boxLegKey, findBoxEvent, eventFinal, boxLine, boxActual } from '../worker/src/box-grading.js';

const NBA_KEYS = ['minutes', 'points', 'fieldGoalsMade-fieldGoalsAttempted', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'freeThrowsMade-freeThrowsAttempted', 'rebounds', 'assists', 'turnovers', 'steals', 'blocks', 'offensiveRebounds', 'defensiveRebounds', 'fouls', 'plusMinus'];
const nbaSummary = {
  boxscore: {
    players: [
      { team: { abbreviation: 'POR' }, statistics: [{ keys: NBA_KEYS, athletes: [
        { athlete: { id: '3995', displayName: 'Jrue Holiday' }, didNotPlay: false, stats: ['24', '6', '2-7', '2-5', '0-0', '6', '4', '2', '1', '0', '1', '5', '0', '-16'] },
        { athlete: { id: '4066211', displayName: 'Robert Williams III' }, didNotPlay: true, reason: 'INJURY', stats: [] },
      ] }] },
      { team: { abbreviation: 'MEM' }, statistics: [{ keys: NBA_KEYS, athletes: [
        { athlete: { id: '4277961', displayName: 'Ja Morant' }, didNotPlay: false, stats: ['33', '28', '10-21', '3-8', '5-6', '4', '9', '3', '2', '1', '0', '4', '2', '+12'] },
      ] }] },
    ],
  },
};

test('a box line is the athlete across every block he is in, with no-shows told apart from players the box does not carry', () => {
  const jrue = boxLine(nbaSummary, '3995');
  assert.equal(jrue.found, true); assert.equal(jrue.dnp, false);
  assert.equal(jrue.stats.points, '6'); assert.equal(jrue.stats.rebounds, '6');
  const rob = boxLine(nbaSummary, 4066211);
  assert.deepEqual([rob.found, rob.dnp, rob.reason], [true, true, 'INJURY']);
  const gone = boxLine(nbaSummary, '3917376');
  assert.deepEqual([gone.found, gone.dnp, gone.reason], [false, true, 'not in the box score']);
  assert.equal(boxLine(null, '1').dnp, true);
});

test('NBA actuals come from the box keys: plain columns, the made count of a made-attempted column, and the sums', () => {
  const jrue = boxLine(nbaSummary, '3995');
  assert.equal(boxActual(jrue, 'basketball_nba', 'points'), 6);
  assert.equal(boxActual(jrue, 'basketball_nba', 'pr'), 12);
  assert.equal(boxActual(jrue, 'basketball_nba', 'pra'), 16);
  assert.equal(boxActual(jrue, 'basketball_nba', 'threes'), 2);
  assert.equal(boxActual(jrue, 'basketball_nba', 'fgm'), 2);
  assert.equal(boxActual(jrue, 'basketball_nba', 'stocks'), 1);
  assert.equal(boxActual(jrue, 'basketball_nba', 'steals'), 1);
  assert.equal(boxActual(jrue, 'basketball_nba', 'nonsense'), null);
  assert.equal(boxActual(boxLine(nbaSummary, '4066211'), 'basketball_nba', 'rebounds'), null, 'a no-show has no actual');
  const ja = boxLine(nbaSummary, '4277961');
  assert.equal(boxActual(ja, 'basketball_nba', 'pa'), 37);
});

test('NFL actuals merge the passing, rushing and receiving blocks, and a category the player has no block for reads as zero', () => {
  const summary = { boxscore: { players: [{ team: { abbreviation: 'BUF' }, statistics: [
    { name: 'passing', keys: ['completions/passingAttempts', 'passingYards', 'yardsPerPassAttempt', 'passingTouchdowns', 'interceptions', 'sacks-sackYardsLost', 'adjQBR', 'QBRating'], athletes: [{ athlete: { id: '3918298', displayName: 'Josh Allen' }, stats: ['24/33', '278', '8.4', '2', '0', '1-7', '85.1', '118.6'] }] },
    { name: 'rushing', keys: ['rushingAttempts', 'rushingYards', 'yardsPerRushAttempt', 'rushingTouchdowns', 'longRushing'], athletes: [{ athlete: { id: '3918298', displayName: 'Josh Allen' }, stats: ['6', '41', '6.8', '1', '18'] }, { athlete: { id: '4379399', displayName: 'James Cook' }, stats: ['19', '92', '4.8', '1', '27'] }] },
    { name: 'receiving', keys: ['receptions', 'receivingYards', 'yardsPerReception', 'receivingTouchdowns', 'longReception', 'receivingTargets'], athletes: [{ athlete: { id: '4379399', displayName: 'James Cook' }, stats: ['3', '21', '7.0', '0', '11', '4'] }] },
  ] }] } };
  const allen = boxLine(summary, '3918298');
  assert.equal(boxActual(allen, 'americanfootball_nfl', 'passYds'), 278);
  assert.equal(boxActual(allen, 'americanfootball_nfl', 'passCompletions'), 24);
  assert.equal(boxActual(allen, 'americanfootball_nfl', 'passAttempts'), 33);
  assert.equal(boxActual(allen, 'americanfootball_nfl', 'passTds'), 2);
  assert.equal(boxActual(allen, 'americanfootball_nfl', 'rushYds'), 41);
  assert.equal(boxActual(allen, 'americanfootball_nfl', 'receptions'), 0, 'in the game, no receiving block: zero catches');
  const cook = boxLine(summary, '4379399');
  assert.equal(boxActual(cook, 'americanfootball_nfl', 'rushAttempts'), 19);
  assert.equal(boxActual(cook, 'americanfootball_nfl', 'targets'), 4);
  assert.equal(boxActual(cook, 'americanfootball_nfl', 'recYds'), 21);
});

test('the scoreboard event is found by either team abbreviation and read as final only once it is over', () => {
  const sb = { events: [
    { id: '1', name: 'A at B', status: { type: { state: 'in', completed: false } }, competitions: [{ competitors: [{ team: { abbreviation: 'LAL' } }, { team: { abbreviation: 'GS' } }] }] },
    { id: '2', name: 'C at D', status: { type: { state: 'post', completed: true } }, competitions: [{ competitors: [{ team: { abbreviation: 'NY' } }, { team: { abbreviation: 'PHI' } }] }] },
  ] };
  assert.equal(findBoxEvent(sb, 'gs').id, '1');
  assert.equal(findBoxEvent(sb, 'PHI').id, '2');
  assert.equal(findBoxEvent(sb, 'BOS'), null);
  assert.equal(eventFinal(findBoxEvent(sb, 'LAL')), false);
  assert.equal(eventFinal(findBoxEvent(sb, 'NY')), true);
  assert.equal(boxKey('basketball_nba', '2026-10-30'), 'trendpicks:box:basketball_nba:2026-10-30');
  assert.equal(boxLegKey(3917376, 'pa'), '3917376:pa');
});
