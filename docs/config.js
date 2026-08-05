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

  // Leagues pulled on first run, before the user picks their own. 'upcoming' is
  // the cheapest option: the next games across all sports in a single call.
  SPORTS: ['upcoming'],

  // Hard ceiling on leagues per refresh. Each league is its own billed call
  // (3 markets x 1 region = 3 credits), so this is a spend limit, not a UI
  // preference. The worker enforces the same number independently.
  MAX_LEAGUES: 3,
  CREDITS_PER_LEAGUE: 3,

  // Re-fetch odds at most this often. Taps in between re-sample the cached
  // pool, which is why generating picks repeatedly is free. Keep this at or
  // above the worker's CACHE_SECONDS so the client never asks for a board the
  // edge would only have to re-fetch anyway.
  REFRESH_MS: 15 * 60 * 1000,

  // How many straight bets Generate hands back, ranked purely by grade across
  // every sport currently selected. The point is a pool to build your own
  // parlays or straights from, not a pre-built slate — so this is a flat list,
  // never an auto-paired combo.
  TOP_PICKS_COUNT: 8,

  // Default odds range and confidence floor, and the outer bounds the sliders
  // allow widening to. -1000/+500 is deliberately generous: the sliders exist
  // specifically so a thin board (MMA on a quiet night) can be widened into
  // rather than come back empty. -200/+150 is the Pixel Picks tab's own
  // spec'd band for its "most confident winner" picks.
  ODDS_MIN_DEFAULT: -200,
  ODDS_MAX_DEFAULT: 150,
  ODDS_FLOOR: -1000,
  ODDS_CEIL: 500,
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
