import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NFL_VENUES, MLB_VENUES, hasVenue, periodCovering } from '../worker/src/weather.js';
import { weatherInsights } from '../docs/insights.js';

/* ---------------------------------------------------------------- */
/* Venue table                                                       */
/* ---------------------------------------------------------------- */

test('hasVenue only recognises the two outdoor US sports this app covers', () => {
  assert.equal(hasVenue('americanfootball_nfl'), true);
  assert.equal(hasVenue('baseball_mlb'), true);
  assert.equal(hasVenue('basketball_nba'), false);
  assert.equal(hasVenue('tennis_atp_canadian_open'), false);
  assert.equal(hasVenue('mma_mixed_martial_arts'), false);
});

test('every NFL and MLB venue has real coordinates and a valid roof type', () => {
  for (const [team, venue] of Object.entries({ ...NFL_VENUES, ...MLB_VENUES })) {
    assert.ok(['outdoor', 'dome', 'retractable'].includes(venue.roof), `${team}: bad roof value`);
    assert.ok(Math.abs(venue.lat) <= 90, `${team}: invalid latitude`);
    assert.ok(Math.abs(venue.lon) <= 180, `${team}: invalid longitude`);
  }
  assert.equal(Object.keys(NFL_VENUES).length, 32);
  assert.equal(Object.keys(MLB_VENUES).length, 30);
});

/* ---------------------------------------------------------------- */
/* periodCovering — matching a game time to an hourly forecast period   */
/* ---------------------------------------------------------------- */

const PERIODS = [
  { startTime: '2026-08-05T18:00:00-05:00', endTime: '2026-08-05T19:00:00-05:00', temperature: 88 },
  { startTime: '2026-08-05T19:00:00-05:00', endTime: '2026-08-05T20:00:00-05:00', temperature: 86 },
  { startTime: '2026-08-05T20:00:00-05:00', endTime: '2026-08-05T21:00:00-05:00', temperature: 84 },
];

test('periodCovering picks the hour window containing the game time', () => {
  const atMs = Date.parse('2026-08-05T19:30:00-05:00');
  const period = periodCovering(PERIODS, atMs);
  assert.equal(period.temperature, 86);
});

test('periodCovering returns null when the game is outside every period', () => {
  const farFuture = Date.parse('2026-08-10T19:30:00-05:00');
  assert.equal(periodCovering(PERIODS, farFuture), null);
});

test('periodCovering handles an empty or missing period list', () => {
  assert.equal(periodCovering([], Date.now()), null);
  assert.equal(periodCovering(undefined, Date.now()), null);
});

/* ---------------------------------------------------------------- */
/* weatherInsights — the bullets a forecast actually produces            */
/* ---------------------------------------------------------------- */

test('no weather bundle means no bullets, never a placeholder', () => {
  assert.deepEqual(weatherInsights(null), []);
});

test('a plain forecast produces one environmental bullet with the real numbers', () => {
  const bullets = weatherInsights({
    roof: 'outdoor', shortForecast: 'Partly Cloudy', temperatureF: 72,
    windSpeed: '10 mph', windDirection: 'NW', precipChance: 10,
  });
  assert.equal(bullets.length, 1);
  assert.equal(bullets[0].tier, 'environmental');
  assert.match(bullets[0].text, /72°F/);
  assert.match(bullets[0].text, /partly cloudy/);
  assert.match(bullets[0].text, /10 mph NW/);
});

test('a real precipitation chance gets its own bullet; a negligible one does not', () => {
  const rainy = weatherInsights({ roof: 'outdoor', temperatureF: 60, precipChance: 70 });
  assert.ok(rainy.some((b) => /70% chance of precipitation/.test(b.text)));

  const dry = weatherInsights({ roof: 'outdoor', temperatureF: 60, precipChance: 5 });
  assert.ok(!dry.some((b) => /chance of precipitation/.test(b.text)));
});

test('a retractable roof gets an explicit "roof status uncertain" caveat', () => {
  const bullets = weatherInsights({
    roof: 'retractable', shortForecast: 'Sunny', temperatureF: 95, windSpeed: '5 mph',
  });
  assert.ok(bullets.some((b) => /retractable roof/.test(b.text)));
  assert.ok(bullets.some((b) => /team decision made day-of/.test(b.text)));
});

test('a retractable roof with no forecast data at all produces no caveat either', () => {
  // If there's nothing else to say, the roof caveat alone isn't worth a bullet.
  const bullets = weatherInsights({ roof: 'retractable' });
  assert.deepEqual(bullets, []);
});

test('every weatherInsights bullet is tagged environmental, never another tier', () => {
  const bullets = weatherInsights({
    roof: 'retractable', shortForecast: 'Windy', temperatureF: 50,
    windSpeed: '20 mph', windDirection: 'W', precipChance: 60,
  });
  assert.ok(bullets.length >= 3);
  for (const b of bullets) assert.equal(b.tier, 'environmental');
});
