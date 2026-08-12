/**
 * The cache-busting version pinned on docs/app.html's assets must match
 * docs/version.js.
 *
 * This is a static site with no build step, so `app.js?v=N` is the *only*
 * thing that makes a returning browser pick up new code — GitHub Pages serves
 * the old file happily otherwise. The number lives in two places that are
 * edited by hand, and bumping version.js while leaving app.html pinned to the
 * previous value ships a release that is invisible to every existing visitor:
 * the code deploys, the browser keeps running yesterday's copy, and nothing
 * anywhere reports an error. That exact drift shipped once; this test is why
 * it can't ship silently again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../docs/${rel}`, import.meta.url)), 'utf8');

/** The version string BUILD_INFO declares, e.g. "1.99". */
function declaredVersion() {
  const match = read('version.js').match(/version:\s*'([^']+)'/);
  assert.ok(match, 'docs/version.js must declare a BUILD_INFO.version string');
  return match[1];
}

test('every ?v= asset in app.html is pinned to the declared build version', () => {
  const version = declaredVersion();
  const html = read('app.html');
  const pinned = [...html.matchAll(/(?:href|src)="([^"?]+)\?v=([^"]+)"/g)];

  assert.ok(pinned.length >= 2, 'app.html should still cache-bust app.js and styles.css');
  for (const [, asset, pin] of pinned) {
    assert.equal(
      pin, version,
      `${asset} is pinned at ?v=${pin} but version.js says ${version} — returning browsers would keep the cached copy`,
    );
  }
});
