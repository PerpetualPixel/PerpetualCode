#!/usr/bin/env node

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

// Get current git commit hash (short)
let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD').toString().trim();
} catch (e) {
  console.warn('Could not get git commit hash');
}

// Get current timestamp in Eastern Time, always labeled EST — Intl's own
// 'short' timeZoneName follows real-world daylight saving (EDT in summer),
// but the About panel is meant to show a fixed "EST" label year-round
// rather than flip labels every DST changeover, so the wall-clock time
// itself is still the correct America/New_York time, just suffixed by hand
// instead of asking Intl for the DST-aware abbreviation.
const now = new Date();
const builtAt = now.toLocaleString('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
}) + ' EST';

// Read current version
const versionPath = path.join(__dirname, 'docs', 'version.js');
let currentVersion = '0.1';
try {
  const content = fs.readFileSync(versionPath, 'utf8');
  const match = content.match(/version: '([^']+)'/);
  if (match) {
    const [major, minor] = match[1].split('.');
    const newMinor = parseInt(minor) + 1;
    currentVersion = `${major}.${newMinor}`;
  }
} catch (e) {
  console.warn('Could not read current version, starting at 0.1');
}

// Generate new version.js
const versionContent = `/**
 * Build metadata for the About panel's "last updated" line. Static site, no
 * build step, regenerate this by hand (bump version, short commit hash,
 * current time) as part of any commit meant to ship, so the value on screen
 * actually reflects what's live rather than going stale.
 *
 * version is a plain incrementing minor counter (0.1, 0.2, ... 0.10, 0.11),
 * not a decimal fraction; bump the number after the dot by 1 per shipped
 * commit. Stays below 1.0 until the app is actually considered a 1.0.
 */
export const BUILD_INFO = {
  version: '${currentVersion}',
  commit: '${commit}',
  builtAt: '${builtAt}',
};
`;

fs.writeFileSync(versionPath, versionContent);
console.log(`✅ Updated version.js: v${currentVersion} (${commit}) @ ${builtAt}`);

// Cache-bust the two entry points app.html loads directly (styles.css,
// app.js) by stamping the same version onto their URL as a query string —
// GitHub Pages serves both with no cache-busting otherwise, so a browser
// that already cached an old copy can keep serving it after a deploy until
// that cache happens to expire on its own. Changing the URL on every
// version bump forces a fresh fetch instead. Idempotent: replaces any
// previous ?v=... rather than appending a new one each run. Scoped to just
// these two entry points rather than every module app.js imports — in
// practice a change to any imported file (engine.js, config.js, etc.) ships
// alongside an app.js change in the same commit, so busting app.js's own
// cache key covers the real-world case without query-stringing every import
// specifier individually.
//
// index.html is the public landing page (self-contained, no styles.css/
// app.js of its own) — app.html is the actual gated app shell those two
// entry points belong to, so that's what gets cache-busted here.
// Every page that loads a local .js or .css gets its own version stamp.
// This used to be app.html only, which was fine while every other page kept
// its script inline — an inline script can't go stale, because the browser
// revalidates the HTML that carries it. Now that login/account/index each
// load a real .js file (moved out so those pages can run under a
// Content-Security-Policy that forbids inline script), those files are
// separately cacheable and need the same treatment or a returning visitor
// keeps yesterday's copy.
const CACHE_BUSTED_PAGES = ['app.html', 'login.html', 'account.html', 'index.html'];

for (const page of CACHE_BUSTED_PAGES) {
  const pagePath = path.join(__dirname, 'docs', page);
  try {
    const before = fs.readFileSync(pagePath, 'utf8');
    // Local .js/.css only: absolute URLs (Google Fonts, Turnstile) aren't
    // ours to version, and images/manifests aren't code.
    const after = before.replace(
      /((?:href|src)="(?!https?:)[^"?]+\.(?:js|css))(\?v=[^"]*)?(")/g,
      `$1?v=${currentVersion}$3`,
    );
    if (after !== before) fs.writeFileSync(pagePath, after);
    const count = [...after.matchAll(/\?v=/g)].length;
    console.log(`✅ Cache-busted ${count} asset${count === 1 ? '' : 's'} in ${page} to ?v=${currentVersion}`);
  } catch (e) {
    console.warn(`Could not cache-bust ${page}:`, e.message);
  }
}
