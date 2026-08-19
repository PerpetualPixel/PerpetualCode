/**
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
  version: '1.160',
  commit: '5dfc88e',
  builtAt: 'Aug 19, 2026, 6:53:11 PM EDT',
};
