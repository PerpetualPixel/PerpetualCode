/**
 * Head-to-head tennis player photos (worker/src/tennis-photo.js) — the
 * confidence check that decides whether an already-fetched Wikipedia
 * summary is trusted for a photo, and the name -> title guess feeding it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoFromSummary, toTitle } from '../worker/src/tennis-photo.js';

test('toTitle turns a plain name into a Wikipedia-style title', () => {
  assert.equal(toTitle('Carlos Alcaraz'), 'Carlos_Alcaraz');
  assert.equal(toTitle('  Iga Swiatek  '), 'Iga_Swiatek');
  assert.equal(toTitle(''), '');
  assert.equal(toTitle(null), '');
});

test('photoFromSummary trusts a summary whose bio mentions tennis and carries a thumbnail', () => {
  const summary = {
    description: 'Spanish tennis player',
    extract: 'Carlos Alcaraz Garfia is a Spanish professional tennis player.',
    thumbnail: { source: 'https://upload.wikimedia.org/carlos-alcaraz.jpg' },
  };
  assert.equal(photoFromSummary(summary), 'https://upload.wikimedia.org/carlos-alcaraz.jpg');
});

test('photoFromSummary refuses a disambiguation page even with a thumbnail', () => {
  const summary = {
    type: 'disambiguation',
    extract: 'Smith may refer to several tennis players.',
    thumbnail: { source: 'https://upload.wikimedia.org/smith.jpg' },
  };
  assert.equal(photoFromSummary(summary), null);
});

test('photoFromSummary refuses a bio that never mentions tennis (the name-collision case)', () => {
  const summary = {
    description: 'American actor',
    extract: 'John Smith is an American actor known for several films.',
    thumbnail: { source: 'https://upload.wikimedia.org/john-smith.jpg' },
  };
  assert.equal(photoFromSummary(summary), null, 'a same-named actor is not a tennis player');
});

test('photoFromSummary is null when the page has no thumbnail, even if it is confidently a tennis player', () => {
  const summary = {
    description: 'Tennis player',
    extract: 'A tennis player with no photo currently on file.',
  };
  assert.equal(photoFromSummary(summary), null);
});

test('photoFromSummary handles a missing page and a null/undefined summary', () => {
  assert.equal(photoFromSummary(null), null);
  assert.equal(photoFromSummary(undefined), null);
  assert.equal(photoFromSummary({}), null);
});
