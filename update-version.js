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

// Get current timestamp in Eastern Time (EST/EDT)
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
  timeZoneName: 'short'
});

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
const appShellPath = path.join(__dirname, 'docs', 'app.html');
try {
  let appHtml = fs.readFileSync(appShellPath, 'utf8');
  appHtml = appHtml.replace(
    /(href="styles\.css)(\?v=[^"]*)?(")/,
    `$1?v=${currentVersion}$3`,
  );
  appHtml = appHtml.replace(
    /(src="app\.js)(\?v=[^"]*)?(")/,
    `$1?v=${currentVersion}$3`,
  );
  fs.writeFileSync(appShellPath, appHtml);
  console.log(`✅ Cache-busted styles.css and app.js in app.html to ?v=${currentVersion}`);
} catch (e) {
  console.warn('Could not cache-bust app.html:', e.message);
}
