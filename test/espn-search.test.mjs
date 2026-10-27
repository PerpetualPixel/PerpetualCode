import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchAthleteId } from '../worker/src/espn-search.js';

test('searchAthleteId takes the first player result whose name and league match, on a stubbed search reply', async () => {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ results: [
      { type: 'team', contents: [{ id: '8', displayName: 'Detroit Lions' }] },
      { type: 'player', contents: [
        { id: '999', displayName: 'Jared Goff', defaultLeagueSlug: 'college-football' },
        { id: '16760', displayName: 'Jared Goff', defaultLeagueSlug: 'nfl', subtitle: 'Detroit Lions' },
      ] },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    assert.equal(await searchAthleteId('Jared Goff', 'nfl', { waitUntil() {} }), '16760');
    assert.ok(calls[0].includes('query=Jared%20Goff'));
    assert.equal(await searchAthleteId('Someone Else', 'nfl', { waitUntil() {} }), null);
    globalThis.fetch = async () => new Response('<html>403</html>', { status: 403 });
    assert.equal(await searchAthleteId('Jared Goff', 'nfl', { waitUntil() {} }), null, 'a refused search is null, never a throw');
  } finally {
    globalThis.fetch = saved;
  }
});
