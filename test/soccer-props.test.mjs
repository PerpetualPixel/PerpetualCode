import test from 'node:test';
import assert from 'node:assert/strict';
import { soccerStatIndex, goalsFromAnytimeScorer, soccerPriorSeason, SOCCER_LEAGUES, SOCCER_PROP_KEYS, soccerSpec } from '../worker/src/soccer-props.js';
import { espnAbbr, soccerTeamId, teamLogoUrl } from '../docs/team-logos.js';
import { boxLine, boxActual } from '../worker/src/box-grading.js';

test('the game log reads goals, assists, shots and shots on target by key; last season is the first year less one', () => {
  const log = { names: ['totalGoals', 'goalAssists', 'totalShots', 'shotsOnTarget', 'foulsCommitted'], labels: ['G', 'A', 'SHOT', 'SOG', 'FC'], seasonTypes: [{ displayName: '2026-27 English Premier League' }] };
  assert.deepEqual([soccerStatIndex(log, 'goals'), soccerStatIndex(log, 'assists'), soccerStatIndex(log, 'shots'), soccerStatIndex(log, 'shotsOnTarget'), soccerStatIndex(log, 'saves')], [0, 1, 2, 3, -1]);
  assert.equal(soccerPriorSeason(log), 2025);
  assert.deepEqual(SOCCER_PROP_KEYS, Object.keys(SOCCER_LEAGUES));
  const spec = soccerSpec('soccer_spain_la_liga');
  assert.equal(spec.title, 'La Liga'); assert.equal(spec.ttlMinutes, 720); assert.equal(typeof spec.fetchOdds, 'function');
});

test('the anytime scorer market becomes goals Over 0.5 on each player, the No side and the rest untouched', () => {
  const odds = { bookmakers: [{ key: 'fanduel', markets: [
    { key: 'player_goal_scorer_anytime', outcomes: [{ name: 'Yes', description: 'Erling Haaland', price: -150, link: 'x' }, { name: 'No', description: 'Erling Haaland', price: 120 }, { name: 'Yes', description: 'Phil Foden', price: 210 }] },
    { key: 'player_shots_on_target', outcomes: [{ name: 'Over', description: 'Erling Haaland', point: 1.5, price: -140 }] },
  ] }] };
  const out = goalsFromAnytimeScorer(odds);
  const goals = out.bookmakers[0].markets.find((m) => m.key === 'player_goals');
  assert.deepEqual(goals.outcomes.map((o) => [o.description, o.name, o.point, o.price]), [['Erling Haaland', 'Over', 0.5, -150], ['Phil Foden', 'Over', 0.5, 210]]);
  assert.equal(goals.outcomes[0].link, 'x', 'the link rides along');
  assert.equal(out.bookmakers[0].markets[1].key, 'player_shots_on_target');
});

test('clubs resolve by name the way the feed and ESPN each write them, to the abbreviation the cards show and the id ESPN serves', () => {
  assert.equal(espnAbbr('soccer_epl', 'Brighton and Hove Albion'), 'bha');
  assert.equal(espnAbbr('soccer_epl', 'Brighton & Hove Albion'), 'bha');
  assert.equal(espnAbbr('soccer_spain_la_liga', 'Atlético Madrid'), 'atm');
  assert.equal(espnAbbr('soccer_italy_serie_a', 'Inter Milan'), 'int');
  assert.equal(espnAbbr('soccer_germany_bundesliga', '1. FC Union Berlin'), 'fcu');
  assert.equal(espnAbbr('soccer_france_ligue_one', 'Paris Saint Germain'), 'psg');
  assert.equal(espnAbbr('soccer_uefa_champs_league', 'Bodo/Glimt'), 'bodo');
  assert.equal(soccerTeamId('soccer_epl', 'LIV'), 364);
  assert.equal(teamLogoUrl('soccer_epl', 'Liverpool'), 'https://a.espncdn.com/i/teamlogos/soccer/500/364.png');
});

test('a soccer summary grades off the roster stats: shots, shots on target, goals and assists; a bench player who never came on did not play', () => {
  const summary = { header: {}, boxscore: { teams: [] }, rosters: [
    { team: { abbreviation: 'COMO' }, homeAway: 'home', roster: [
      { athlete: { id: '1', displayName: 'Nico Paz' }, starter: true, subbedIn: false, stats: [{ name: 'appearances', value: 1 }, { name: 'totalShots', value: 4 }, { name: 'shotsOnTarget', value: 2 }, { name: 'totalGoals', value: 1 }, { name: 'goalAssists', value: 0 }] },
      { athlete: { id: '2', displayName: 'Bench Guy' }, starter: false, subbedIn: false, stats: [{ name: 'appearances', value: 0 }] },
      { athlete: { id: '3', displayName: 'Late Sub' }, starter: false, subbedIn: true, stats: [{ name: 'appearances', value: 1 }, { name: 'totalShots', value: 0 }] },
    ] },
  ] };
  const paz = boxLine(summary, '1');
  assert.deepEqual([boxActual(paz, 'soccer_italy_serie_a', 'shots'), boxActual(paz, 'soccer_italy_serie_a', 'shotsOnTarget'), boxActual(paz, 'soccer_italy_serie_a', 'goals'), boxActual(paz, 'soccer_italy_serie_a', 'assists')], [4, 2, 1, 0]);
  assert.equal(boxLine(summary, '2').dnp, true, 'never came on');
  assert.equal(boxActual(boxLine(summary, '3'), 'soccer_italy_serie_a', 'shotsOnTarget'), 0, 'a sub with no shots on target reads zero');
  assert.equal(boxLine(summary, '9').dnp, true, 'not in the squad');
});
