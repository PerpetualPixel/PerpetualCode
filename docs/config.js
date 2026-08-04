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
};
