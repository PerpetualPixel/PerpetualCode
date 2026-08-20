/**
 * Sport glyphs for the Full Slate league chips.
 *
 * These replace the emoji map that used to live in app.js. Emoji were a
 * problem for two reasons beyond looking toy-like: they render as a
 * different picture on every OS (so the brand mark wasn't ours to control),
 * and five of the twelve leagues collided on the same glyph — ATP/WTA both
 * landed on the tennis ball, NBA/WNBA both on the basketball, and NCAAF
 * (id `ncaa`) / NCAAB both on the graduation cap. A row where five tokens
 * are indistinguishable isn't a decorative problem, it's a broken picker.
 *
 * The fix is a division of labour rather than twelve unique drawings: the
 * GLYPH names the sport, and the chip's text label (LEAGUE_GROUPS[].label)
 * names the league. So a shared basketball across NBA/WNBA/NCAAB is correct
 * — those really are the same sport, and "NBA" vs "WNBA" beside it is what
 * actually distinguishes them. That also keeps the set to seven drawings.
 *
 * Each glyph is a bare fragment (no <svg> wrapper) on a 24x24 grid, stroked
 * in currentColor so it inherits the chip's own active/hover/off-season
 * color states with no per-state icon rules.
 */

const BASEBALL = `
  <circle cx="12" cy="12" r="9"/>
  <path d="M6.1 5.4c1.9 2 3 4.6 3 6.6s-1.1 4.6-3 6.6"/>
  <path d="M17.9 5.4c-1.9 2-3 4.6-3 6.6s1.1 4.6 3 6.6"/>`;

const FOOTBALL = `
  <path d="M4.6 19.4c-1.7-1.7-1-7 2.1-10.1S15.1 4.6 19.4 4.6c1.7 1.7 1 7-2.1 10.1s-8.4 6.4-12.7 4.7z"/>
  <path d="M9.4 14.6l5.2-5.2"/>
  <path d="M10.6 11.5l1.9 1.9M12.5 9.6l1.9 1.9"/>`;

const BASKETBALL = `
  <circle cx="12" cy="12" r="9"/>
  <path d="M12 3v18M3 12h18"/>
  <path d="M5.6 5.6c3.6 3.6 3.6 9.2 0 12.8M18.4 5.6c-3.6 3.6-3.6 9.2 0 12.8"/>`;

const TENNIS = `
  <circle cx="12" cy="12" r="9"/>
  <path d="M4.4 7.4c3.6 1.4 5.7 4.7 5.7 8.7 0 1.6-.3 3.2-1 4.6"/>
  <path d="M19.6 7.4c-3.6 1.4-5.7 4.7-5.7 8.7 0 1.6.3 3.2 1 4.6"/>`;

const HOCKEY = `
  <path d="M4.2 3.6l6 12.4M19.8 3.6l-6 12.4"/>
  <ellipse cx="12" cy="19.4" rx="5" ry="2.2"/>`;

const SOCCER = `
  <circle cx="12" cy="12" r="9"/>
  <path d="M12 7.1l3.7 2.7-1.4 4.4H9.7L8.3 9.8z"/>
  <path d="M12 3.1v4M4.2 9.9l4.1-.1M7 19.1l2.7-3.4M17 19.1l-2.7-3.4M19.8 9.9l-4.1-.1"/>`;

const GLOVE = `
  <path d="M6.2 10.4a4.2 4.2 0 018.4 0v1.1h1.2a3.2 3.2 0 013.2 3.2v1.6a5.2 5.2 0 01-5.2 5.2h-4a5.2 5.2 0 01-5.2-5.2v-4.9a1.8 1.8 0 011.6-1.8z"/>
  <path d="M6.2 14.6h8.4"/>`;

/** League group id -> sport glyph. Ids match LEAGUE_GROUPS in app.js. */
export const LEAGUE_ICONS = {
  mlb: BASEBALL,
  nfl: FOOTBALL,
  nflpre: FOOTBALL,
  ncaa: FOOTBALL,
  atp: TENNIS,
  wta: TENNIS,
  nba: BASKETBALL,
  wnba: BASKETBALL,
  ncaab: BASKETBALL,
  nhl: HOCKEY,
  mls: SOCCER,
  mma: GLOVE,
};

/** A neutral dot, for a league group that hasn't been given a glyph yet. */
const FALLBACK = '<circle cx="12" cy="12" r="4.5"/>';

/**
 * The full <svg> element for a league group id, ready to drop into a chip.
 * aria-hidden because the chip already carries the league name as real
 * text — the glyph is a visual aid, not the label.
 */
export function leagueIconSvg(id) {
  return `<svg class="league-chip-icon" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true" focusable="false">${
    LEAGUE_ICONS[id] ?? FALLBACK
  }</svg>`;
}
