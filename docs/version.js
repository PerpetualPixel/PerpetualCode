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
  version: '1.131',
  commit: '4787646',
  builtAt: 'Aug 14, 2026, 3:40:00 AM EDT',
};
