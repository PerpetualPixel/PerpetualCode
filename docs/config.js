/**
 * Pixel Pick configuration.
 *
 * WORKER_URL is the only thing you must change. Until it's set, the app runs
 * on clearly-labelled demo data so you can see the interface working.
 */
export const CONFIG = {
  // Your deployed Cloudflare Worker, e.g.
  // 'https://pixel-pick-odds.your-subdomain.workers.dev'
  WORKER_URL: '',

  // Leagues to pull. Each one costs API credits, so keep this short.
  // 'upcoming' is the cheapest option: next games across all sports, one call.
  SPORTS: ['upcoming'],

  // Re-fetch odds at most this often. Taps in between re-sample the cached
  // pool, which is why generating picks repeatedly is free.
  REFRESH_MS: 5 * 60 * 1000,
};
