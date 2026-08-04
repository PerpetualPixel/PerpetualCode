# Pixel Pick odds proxy

A Cloudflare Worker that sits between the app and The Odds API.

**Why this exists:** GitHub Pages serves static files. Anything the browser can
read, anyone can read — so an API key in `config.js` would be public the moment
you push. The Worker holds the key server-side as an encrypted secret. The
browser only ever talks to the Worker.

It also caches aggressively, which is what makes a free-tier key survive real
use: tapping *Generate Picks* fifty times costs the same as tapping it once.

## Setup

Free Cloudflare account required. No credit card, no paid plan.

**1. Get an odds API key** — sign up at [the-odds-api.com](https://the-odds-api.com/).
The free tier is 500 credits/month.

**2. Install Wrangler and log in:**

```bash
npm install -g wrangler
wrangler login
```

**3. Set your GitHub Pages origin** in `wrangler.toml`. No trailing slash:

```toml
ALLOWED_ORIGINS = "https://miguelsgarcia4.github.io"
```

Only origins listed here may call the proxy, so a stranger who finds the URL
can't spend your credits.

**4. Store the key as a secret — not in any file:**

```bash
cd worker
wrangler secret put ODDS_API_KEY
# paste the key when prompted
```

**5. Deploy:**

```bash
wrangler deploy
```

Wrangler prints a URL like `https://pixel-pick-odds.your-name.workers.dev`.
Put that in `docs/config.js` as `WORKER_URL`.

**6. Verify:**

```bash
curl "https://pixel-pick-odds.your-name.workers.dev/odds?sports=upcoming"
```

You should get JSON with an `events` array and a `quota` block.

## Budgeting your credits

Cost is **markets × regions per upstream call**. This Worker requests 3 markets
(`h2h,spreads,totals`) in 1 region (`us`), so **3 credits per sport, per cache
miss**.

With `CACHE_SECONDS = 300`, the worst case is 12 misses/hour → 36 credits/hour of
active use. On a 500-credit plan that's roughly **14 hours of live use per
month**, which is plenty for checking a slate a few times a day.

To stretch it further, raise `CACHE_SECONDS` in `wrangler.toml` — `900` (15 min)
triples your runway and barely changes the picks, since lines don't move much
inside a quarter hour.

Keep `CONFIG.SPORTS` short. `'upcoming'` is the cheapest option: one call
covering the next games across every sport. Each extra league you list is
another 3 credits per refresh. The Worker refuses more than 4 sports per
request so a bad query string can't drain the month in one go.

## Endpoint

```
GET /odds?sports=upcoming
GET /odds?sports=americanfootball_nfl,basketball_nba
```

Returns `{ events, sports, cached, quota, errors, fetchedAt }`. Sports are
allowlisted in `src/index.js`; anything else is rejected with a 400.
