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

// Get current timestamp in EST format
const now = new Date();
const estTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
const builtAt = estTime.toISOString().replace('Z', '') + '-05:00'; // EST offset

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
