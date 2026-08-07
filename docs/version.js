/**
 * Build metadata for the About panel's "last updated" line. Static site, no
 * build step — regenerate this by hand (short commit hash + current time)
 * as part of any commit meant to ship, so the value on screen actually
 * reflects what's live rather than going stale.
 */
export const BUILD_INFO = {
  commit: '7d2f0a6',
  builtAt: '2026-08-07T10:22:53-04:00',
};
