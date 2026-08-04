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

**5. Create the D1 database (for user auth):**

```bash
cd worker
wrangler d1 create pixel-pick
```

Wrangler will print something like:
```
✅ Successfully created DB 'pixel-pick'!

[[d1_databases]]
binding = "DB"
database_name = "pixel-pick"
database_id = "12345678-abcd-efgh-ijkl-mnopqrstuvwx"
```

Copy the `database_id` and paste it into `wrangler.toml`, replacing the empty string.

**6. Run migrations to create tables:**

```bash
wrangler d1 migrations apply pixel-pick --local
wrangler d1 migrations apply pixel-pick --remote
```

**7. Deploy:**

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

The app never fetches on page load — only the first tap of *Generate Picks*
pays. Subsequent taps within the cache window are free, so one sitting costs 3
credits no matter how many picks you generate.

On the free 500-credit plan with the default `SPORTS: ['upcoming']`:

| | Credits per sitting | Sittings per month |
|---|---|---|
| `['upcoming']` (default) | 3 | **166** (~5/day) |
| 4 leagues listed | 12 | 41 (~1.4/day) |

The expensive move is listing leagues, not tapping the button. `'upcoming'` is
one call covering the next games across every sport, and it's almost always
what you want. The Worker refuses more than 4 sports per request so a bad query
string can't drain the month in one go.

If you ever do leave the app open and refreshing, raise `CACHE_SECONDS` in
`wrangler.toml` — `900` (15 min) triples your runway and barely changes the
picks, since lines don't move much inside a quarter hour.

## Endpoints

```
GET /odds?sports=upcoming
GET /odds?sports=americanfootball_nfl,basketball_nba
```

Returns `{ events, sports, cached, quota, errors, fetchedAt }`. Sports are
allowlisted in `src/index.js`; anything else is rejected with a 400. Tennis is
allowed by prefix (`tennis_atp_`, `tennis_wta_`) because its keys are
per-tournament and an exact list would go stale every few days.

**Costs 3 credits per league, per cache miss.** Capped at 3 leagues a request —
the browser enforces the same limit, but a spend ceiling doesn't belong only in
a place the user can edit.

```
GET /sports
```

The requestable league catalogue. **Free** — The Odds API doesn't bill its
`/sports` endpoint — so the app populates its league picker on load without
touching the budget. Cached an hour.

```
GET /context?sport=baseball_mlb&home=Baltimore+Orioles&away=Los+Angeles+Angels
```

Season and venue records, last five results, head-to-head, ATS and the injury
report for one fixture, normalised from ESPN. **Free** — it never touches the
odds feed. Returns `{ context: null }` when the fixture can't be matched with
confidence, which is a normal answer: the card then shows fewer bullets rather
than another team's statistics.

ESPN's site API is undocumented and unsupported. It's read defensively
throughout and a missing section only shortens a card, but it carries no SLA —
worth swapping for a licensed provider before charging for this.

Tennis is deliberately absent here: ESPN's tennis athletes have no ids and its
tennis summary endpoint 400s. That sport is served by a static archive built
with `scripts/build-tennis-data.mjs`.
