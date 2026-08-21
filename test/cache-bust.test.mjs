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

const CACHE_BUSTED_PAGES = ['app.html', 'login.html', 'account.html', 'index.html'];

for (const page of CACHE_BUSTED_PAGES) {
  test(`every ?v= asset in ${page} is pinned to the declared build version`, () => {
    const version = declaredVersion();
    const html = read(page);
    const pinned = [...html.matchAll(/(?:href|src)="([^"?]+)\?v=([^"]+)"/g)];

    assert.ok(pinned.length >= 1, `${page} should cache-bust the local assets it loads`);
    for (const [, asset, pin] of pinned) {
      assert.equal(
        pin, version,
        `${page}: ${asset} is pinned at ?v=${pin} but version.js says ${version} — returning browsers would keep the cached copy`,
      );
    }
  });
}

/* The pages above each load a local .js now rather than carrying an inline
   <script>, so a file left unstamped is silently cacheable — the exact drift
   the test above exists to catch, just on a page it didn't used to cover. */
test('no page loads a local .js or .css without a version stamp', () => {
  for (const page of CACHE_BUSTED_PAGES) {
    const html = read(page);
    const unstamped = [...html.matchAll(/(?:href|src)="(?!https?:)([^"?]+\.(?:js|css))"/g)];
    assert.deepEqual(
      unstamped.map((m) => m[1]), [],
      `${page} loads local asset(s) with no ?v= stamp — run update-version.js`,
    );
  }
});
