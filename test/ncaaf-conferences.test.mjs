import test from 'node:test';
import assert from 'node:assert/strict';

import { isPower4Team, isPower4Matchup } from '../docs/ncaaf-conferences.js';

test('recognizes a team from each of the four power conferences', () => {
  assert.equal(isPower4Team('Alabama Crimson Tide'), true);   // SEC
  assert.equal(isPower4Team('Ohio State Buckeyes'), true);    // Big Ten
  assert.equal(isPower4Team('Clemson Tigers'), true);         // ACC
  assert.equal(isPower4Team('Texas Tech Red Raiders'), true); // Big 12
});

test('reflects real, current realignment rather than a stale remembered list', () => {
  // Moved to the ACC in the last realignment cycle.
  assert.equal(isPower4Team('SMU Mustangs'), true);
  assert.equal(isPower4Team('Stanford Cardinal'), true);
  // Moved to the Big Ten.
  assert.equal(isPower4Team('Oregon Ducks'), true);
  assert.equal(isPower4Team('USC Trojans'), true);
  // Moved to the Big 12.
  assert.equal(isPower4Team('Colorado Buffaloes'), true);
  assert.equal(isPower4Team('Arizona Wildcats'), true);
});

test('excludes Group of 5, FCS, and the collapsed Pac-12 remnant', () => {
  assert.equal(isPower4Team('Boise State Broncos'), false);
  assert.equal(isPower4Team('James Madison Dukes'), false);
  assert.equal(isPower4Team('Oregon State Beavers'), false); // Pac-12 remnant, 2 teams left
  assert.equal(isPower4Team('Washington State Cougars'), false);
});

test('excludes Notre Dame under the literal "in one of the four conferences" reading', () => {
  assert.equal(isPower4Team('Notre Dame Fighting Irish'), false);
});

test('name matching is case/accent-insensitive', () => {
  assert.equal(isPower4Team('alabama crimson tide'), true);
  assert.equal(isPower4Team('ALABAMA CRIMSON TIDE'), true);
});

test('a matchup requires BOTH teams to be Power 4, not just one', () => {
  assert.equal(isPower4Matchup('Alabama Crimson Tide', 'Georgia Bulldogs'), true);
  assert.equal(isPower4Matchup('Alabama Crimson Tide', 'Boise State Broncos'), false);
  assert.equal(isPower4Matchup('Boise State Broncos', 'James Madison Dukes'), false);
});
