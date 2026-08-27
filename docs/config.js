/**
 * Pixel Pick configuration.
 *
 * WORKER_URL is the only thing you must change. Until it's set, the app runs
 * on clearly-labelled demo data so you can see the interface working.
 */
export const CONFIG = {
  // Your deployed Cloudflare Worker, e.g.
  // 'https://pixel-pick-odds.your-subdomain.workers.dev'
  WORKER_URL: 'https://pixel-pick-odds.mgbouldering.workers.dev',

  // Gate the app behind sign-in. Leave false until the D1 database is created
  // and migrations are applied — the auth endpoints 500 without it, which would
  // lock you out of your own app.
  REQUIRE_AUTH: false,

  // Temporary (2026-08-26 direction): for PICKING purposes, the day's Prop
  // Play of the Day is the Ladder Challenge rung. The Prop Play slot on the
  // Play of the Day tab names the ladder's bet instead of a player-prop
  // ticket, and the Ladder section keeps its own place below, unchanged.
  //
  // Deliberately display-only: the worker still selects, posts, tracks and
  // grades a real Prop Play every day, so its history stays continuous and
  // the algorithm-health review keeps its sample. Flip this back to false to
  // restore the prop ticket on the board with no gap in the record and no
  // worker deploy.
  PROP_PLAY_IS_LADDER: true,

  // How many picks Pixel's Picks shows — matches worker/src/tracking.js's
  // own TOP5_COUNT, the real source of truth now that Pixel's Picks is
  // generated once daily server-side (2am ET) rather than live per-request;
  // topPicks() runs with guaranteeCount there too, so this is always exactly
  // how many locks the board shows — the sharp ones first, the rest flagged
  // if the standard below couldn't fill every slot.
  TOP_PICKS_COUNT: 5,

  // Pixel's Picks' fixed sharp standard — not user-adjustable. A pick outside
  // this range or below this grade can still appear (to guarantee 5), but
  // flagged as outside the standard rather than shown as a plain lock.
  ODDS_MIN_DEFAULT: -250,
  ODDS_MAX_DEFAULT: 250,
  MIN_SCORE_DEFAULT: 50,

  // Tennis's wider alternate-spread ladder (more game-handicap points than
  // the featured board carries — NOT a sets-won market; The Odds API has no
  // such thing for tennis) lives on a per-event odds endpoint that bills a
  // real credit per match, unlike the featured board pull. This caps how many
  // of the tennis matches already on the board get that extra lookup — the
  // best-scoring ones first — so a tennis-heavy tap can't silently burn the
  // whole monthly budget in one Generate.
  TENNIS_ALT_SPREAD_LIMIT: 6,
};
