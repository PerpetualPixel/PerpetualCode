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

**7. Create the KV namespace (for Play of the Day):**

```bash
cd worker
wrangler kv namespace create POTD_KV
```

Wrangler prints an `id` — paste it into the `[[kv_namespaces]]` block in
`wrangler.toml`, replacing the placeholder. This is a one-time setup step;
after this, `/potd` and the hourly cron just work.

**8. Deploy:**

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

**Play of the Day adds up to 6 credits/day on its own**, independent of any
user tapping anything: the hourly cron's two active ticks (8am and 7pm ET)
each pull `'upcoming'` (3 credits) *if* that league's cache happens to be
cold — which it often won't be, since it's the same shared cache real user
taps populate. Worst case (nobody's used the app in the last 15 minutes when
a cron tick fires) is 6 credits/day, ~180/month — a real bite out of the
500-credit budget, worth knowing about rather than discovering later.

## Endpoints

```
GET /odds?sports=upcoming
GET /odds?sports=americanfootball_nfl,basketball_nba
```

Returns `{ events, sports, cached, quota, errors, fetchedAt }`. Sports are
allowlisted in `src/index.js`; anything else is rejected with a 400. Tennis is
allowed by prefix (`tennis_atp_`, `tennis_wta_`) because its keys are
per-tournament and an exact list would go stale every few days.

NFL preseason is allowed by the same discover-don't-hardcode reasoning, but
matched separately from the tennis prefixes rather than added to them:
`ALLOWED_SPORT_PREFIXES` doubles as `regionsFor()`'s "is this tennis" test,
so anything listed there would also get priced off UK/EU books. The allowlist
is the gate that matters — `fetchCatalogue` filters on `isAllowedSport`, so
without it the client could never see the key to put preseason on the board
at all.

**Preseason reaches the Full Slate only.** It is excluded from Pixel's Picks
(`tracking.js`) and Play of the Day (`potd.js`) by `isNflPreseason`, and from
`topPicks()` itself as a hard rejection alongside the EV/Kelly floor — not as
part of the relaxable odds band, because Pixel's Picks runs with
`guaranteeCount: true` and that fallback pads a thin board from the *raw*
candidate list. Filtering only the main pool left exactly that hole: a quiet
day's padding could post the preseason game the rule exists to keep out
(`test/engine.test.mjs` covers it, and fails without the fix). Starters play a
series or two and roster churn is total, so the result says almost nothing
about either team — the high-variance, low-information game those two curated
surfaces exist to avoid.

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

Reads `cdn.espn.com/core/*`, not `site.api.espn.com`. The latter — ESPN's
better-documented site API — **403s every request from a Cloudflare Worker's
egress IPs**, confirmed live: identical requests succeed from any normal
machine. `cdn.espn.com` carries the same underlying sections
(`lastFiveGames`, `injuries`, `seasonseries`, `predictor`) under a webpage's
own JSON wrapper instead of a clean API response, which is why `context.js`
unwraps `content.sbData` and `gamepackageJSON` rather than reading a flat
object. Soccer is a partial exception: its `/game` detail page 404s on this
host entirely (confirmed against a live in-season MLS match, not just an
off-calendar friendly), so soccer fixtures fall back to scoreboard-only data —
season record, no form/H2H/injuries. NHL is dropped from `LEAGUE_PATHS`
outright for the same reason, no scoreboard page at all on this host.

This is still an unofficial, undocumented ESPN surface, not covered by any
SLA — every field is read defensively and a missing section only shortens a
card, but it's worth swapping for a licensed provider before charging for this.

Tennis is served separately, by a static archive built with
`scripts/build-tennis-data.mjs` — ESPN has no usable tennis data on any host,
its tennis athletes carry no ids at all.

```
GET /mma-context?a=Amanda+Lemos&b=Alexia+Thainara
```

Pro record, finish-rate breakdown (KO/TKO vs. submission vs. decision),
loss-by-method, recent form, and a layoff disclosure for one MMA matchup,
scraped from Sherdog. **Free** — no odds credits. Returns
`{ context: { a, b } }` with either side `null` when that fighter has no
confident Sherdog match — normal for a brand-new prospect, not an error.

ESPN has no MMA pages at all on `cdn.espn.com` — confirmed 404 on every path
tried — so this isn't the same host-swap fix as the other sports; ESPN is a
dead end for MMA entirely. The Odds API doesn't help either: UFC, PFL, and
Dana White's Contender Series all arrive under one bundled key
(`mma_mixed_martial_arts`) with no tag saying which promotion a fight belongs
to — the promotion only ever surfaces indirectly, in an event name inside a
fighter's own Sherdog fight history (`"Dana White's Contender Series - Season
3, Episode 2"` shows up there for fighters who came up through it).

Sherdog's `robots.txt` explicitly allows crawling (`Allow: /`), and it was
confirmed reachable from a live Cloudflare Worker before `worker/src/mma.js`
was built against it — the ESPN block above is exactly why that check came
first this time instead of after deploying. This is HTML scraping, not an
API — meaningfully more fragile than every other source in this app. A
Sherdog redesign can silently break a selector. Every extractor in `mma.js` is
written field-by-field rather than as one large pattern spanning a whole row,
specifically because one earlier version broke this way: a title-fight row
wraps its event name in an extra `<span itemprop="award">` that a normal row
doesn't have, and a single regex spanning the full row silently mis-aligned
several rows after the first one it couldn't match. Splitting into row chunks
first, then reading each field independently, means one odd row loses a field
or two and nothing else.

```
GET /mma-results
```

Every finished MMA fight ESPN's scoreboard currently carries — winner, finish
method, and round — for the card grouping and live/finished state Full Slate
draws on the client (`docs/app.js`'s `mmaFightConcluded`/`slateGameState`).
**Free** — no odds credit. Returns `{ results: [...] }`, one entry per
completed fight across every promotion `worker/src/ufc-events.js` discovers
(UFC and PFL always, plus whatever else ESPN's own league list currently
carries — see that file's own comment on why promotions are discovered
rather than hardcoded).

This is `site.web.api.espn.com`, **not** the `cdn.espn.com` host the
`/mma-context` section above just called a dead end for MMA — that claim is
specific to `cdn.espn.com`, which genuinely has no MMA pages at all.
`site.web.api.espn.com` is a separate, already-proven-reachable host
(`worker/src/ufc-events.js`'s own top comment: confirmed live from a
Cloudflare Worker, unlike the 403-blocked `site.api.espn.com`), used for
MMA card/event names since before this route existed; `/mma-results` is the
same source, just exposing its completed-fight data too.

This exists because the Odds API's own `/scores` is a poor fit for MMA: a
sportsbook stops pricing a fight the moment it starts rather than ever
reporting a result through that feed, so `completed:true` for an MMA event
is rare to the point of being nearly useless. `worker/src/full-slate-tracking.js`'s
grading pass already solved this for TRACKED picks, with the exact same
ESPN source, as a fallback ahead of `/scores`
(`gradeMmaPickWithFallback`) — but that only resolves a fight once it's both
been tracked (an MMA event's market can vanish from the odds feed before a
candidate is ever built for it) and graded (the grading cron runs on its own
schedule, and a void grade never resolves through it at all). The client had
no equivalent for the untracked, ungraded, or still-pending gap, so a
finished MMA fight could sit under "Live" on the Full Slate long after it
actually ended — reported live off the deployed site, then reproduced in a
synthetic session before this fix, not a hypothetical. `/mma-results` gives
the client the same authoritative signal server-side grading already
trusts, directly, without waiting on either a tracked pick or a grading pass.

**No Method of Victory market — confirmed at the schema level, not just "not
populated yet."** Requesting a guessed market key like `method_of_victory`
against The Odds API's own event-odds endpoint returns a distinct
`INVALID_MARKET` error — proof the API validates market keys against a fixed
list, not that a given key is simply empty right now. Cross-checked against
every one of the ~280 market keys in The Odds API's own markets
documentation: none of them are Method of Victory, or any other MMA prop,
under any name. Checked the closest actual fight in the live feed at the time
(66 hours out) and several others on the same card — all showed only `h2h`,
which matches: if the key doesn't exist in the schema, no amount of waiting
until closer to fight time changes that. This would need a different data
provider entirely, not a timing fix.

```
GET /tennis-alt-spread?sport=tennis_atp_canadian_open&eventId=...
```

A wider ladder of game-margin spread points for one tennis match than the
featured board carries. **Not a sets-won market** — a first version of this
shipped mislabeled as "Set Spread" on the strength of one match's ladder
(-2.5..2.5) looking plausible as sets; a second match's ladder ran to ±9.5,
impossible as a sets margin in any tennis format, which proved
`alternate_spreads` is the same game-margin axis as the featured `spreads`
market, just denser (confirmed against The Odds API's own docs: "all
available point spread outcomes"). There is no sets-won market in this feed.

Costs a real odds credit per match (1 market × 1 region), unlike every other
endpoint here — it's the per-event odds endpoint, not the featured board. The
app calls this for only a bounded, score-ranked slice of the tennis matches
already on its board (`CONFIG.TENNIS_ALT_SPREAD_LIMIT`, default 6), never the
whole tour, and caches each event for an hour on top of that.

```
GET /potd
```

Today's Play of the Day — one editorially-selected pick with a full
price-case-plus-research write-up, the same for every user that day. **Free**
— reads Workers KV, never touches the odds feed on this path. Returns
`{ potd: null }` before either cron run has fired that day, or
`{ potd: { ...yesterday's record, stale: true } }` as a labelled fallback
rather than nothing.

Generation happens in `scheduled()` (see `worker/src/potd.js`), not here —
this route only reads what that already wrote. Cloudflare Cron Triggers are
UTC-only and the target times are ET wall-clock (8am, or 7pm the evening
before for a match too early for the morning slot), which shift by an hour
across DST — the cron fires hourly and the handler checks the actual current
ET hour itself via `Intl.DateTimeFormat`, so the schedule stays correct across
DST without two hand-maintained UTC crons. Once a date's pick is written nothing
overwrites it that day, including an early-match pick claimed the evening
before — that idempotency check is what makes "consistent all day" actually
true rather than just usually true.

```
GET /ladder
GET /ladder-history
```

The Ladder Challenge (`worker/src/ladder.js`): one lower-risk play a day in
the −250..−165 band, staking the entire ladder bankroll each time. **Free** —
KV only on both paths. `/ladder` returns the live climb, the ideal plan, and
today's rung (or yesterday's, labelled `stale`, before today's posts);
`/ladder-history` returns every settled rung plus every finished climb, which
is what the dashboard's ladder panel draws.

This is the one surface here that compounds. Every other tracker flat-stakes a
unit per pick and is judged on win rate and ROI; the ladder rides its whole
bankroll on each rung, so it's accounted for in RUNS — $20 up to $360 in eight
wins, skimming $5/$15/$30 out at $40/$120/$240 on the way, and a single loss
ends the climb and starts the next one back at $20. A void doesn't count either
way: the rung is simply replayed. The skimmed money is the only thing a busted
climb keeps, which is the whole reason the skims exist.

Selection runs in `scheduled()` **after** the Play of the Day batch, never
concurrently with it: the ladder's rule is "not the Play of the Day, not the
Prop Play, nothing contradicting today's board", and it reads all three out of
KV. Run in parallel with the batch that writes them and the exclusions would
read an undecided day and pass on an empty set — the ladder could post the
exact pick it exists to avoid. A day with nothing in band posts nothing and
the climb keeps its place; holding is a valid outcome, not a failure.

NFL preseason is excluded the same way Pixel's Picks and Play of the Day
are (`isNflPreseason`, `docs/engine.js`) — arguably more so here: this is the
one surface that stakes its whole compounding bankroll on a single rung
rather than one flat unit, so a low-information preseason game has more to
lose against, not less.

```
GET /weather?sport=baseball_mlb&home=Houston+Astros&commenceMs=1785953400000
```

Live venue weather for one NFL or MLB fixture — temperature, short forecast,
wind, and precipitation chance — from the **National Weather Service**
(api.weather.gov), a free, no-API-key, official US government source.
**Free** — no odds credit, cached 30 minutes. Returns `{ weather: null }` for
every other sport, a domed venue (`worker/src/weather.js`'s static venue
table — 32 NFL + 30 MLB, manually maintained and just as fragile to a
stadium relocation or roof retrofit as `context.js`'s ESPN league-path
table), or a game further out than NWS's forecast actually reaches — all
real "nothing to say" cases, not fetch failures.

A retractable-roof venue still gets a forecast, but every bullet built from
it says plainly that whether the roof is actually open for that specific
game isn't knowable from any source this app has — that's a team's own
day-of call. Confirmed reachable from a live Worker before `weather.js` was
built against it, the same check ESPN's site API failed and taught this app
to always run first.
