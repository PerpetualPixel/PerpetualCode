# PerpetualCode


This repository is a collection of useful powershell scripts and lines that may be useful in the future!

## Pixel Pick

A one-button sports betting app that runs on your phone. It reads the live US
odds market, grades every available bet against the market's own no-vig
consensus, and surfaces one or two that are priced better than they should be.

Each pick also carries the research behind it — recent form, head-to-head,
surface records, and who's ruled out — so the numbers on the card are the whole
argument rather than a starting point.

- App: [`docs/`](docs/) — static site, deploys via GitHub Pages
- Odds proxy: [`worker/`](worker/) — Cloudflare Worker holding the API key
- Setup and how the picks are chosen: [`docs/README.md`](docs/README.md)

```bash
node --test test/engine.test.mjs test/insights.test.mjs
```

### Where the research comes from

The odds feed carries prices and nothing else — an event is just
`{ id, sport_key, commence_time, home_team, away_team, bookmakers }`. Everything
else is sourced separately:

| Sport | Source | Carries |
|---|---|---|
| NFL, MLB, NBA, soccer | ESPN, via the worker's `/context` | season and venue records, last five, head-to-head, ATS, injury report |
| Tennis (ATP + WTA) | static archive in [`docs/data/`](docs/data/) | head-to-head, form, surface splits, rankings, retirements |
| MMA (UFC, PFL, Contender Series) | Sherdog, via the worker's `/mma-context` | pro record, finish-rate breakdown, loss-by-method, recent form, layoff disclosure |
| NFL, NCAAF | [Gridiron Engine](https://perpetualpixel.github.io/NFL-NCAA-Football-Prediction-Engine/) `picks.json` | the model's pick and tier, calibrated win probability, projected score, injury report, matchup grades |

ESPN has no usable tennis data at all — its tennis athletes carry no ids and the
summary endpoint returns 400 — so tennis runs off a season archive built from
[tennis-data.co.uk](http://www.tennis-data.co.uk/alldata.php):

```bash
node scripts/build-tennis-data.mjs   # refresh docs/data/tennis-{atp,wta}.json
```

Re-run it weekly; matches only accumulate.

MMA is different again: ESPN has no MMA pages at all on the ESPN host this app
can actually reach from Cloudflare (see [`worker/README.md`](worker/README.md)
for why site.api.espn.com is off the table entirely), and the Odds API bundles
UFC, PFL, and Dana White's Contender Series under one key with no tag saying
which — a promotion only ever surfaces indirectly, in an event name inside a
fighter's own fight history. `worker/src/mma.js` reads Sherdog instead, which
explicitly allows crawling in its `robots.txt`. This is HTML scraping, not an
API, so it's the most fragile source in this app — a Sherdog redesign can
silently break a selector. Every extractor fails toward a shorter card, never
a wrong one; a brand-new Contender Series prospect with a thin or absent
Sherdog page is a true "nothing on file" case, not a bug.

Which *card* a fight belongs to is a separate problem with a separate source:
ESPN's per-promotion MMA scoreboards on `site.web.api.espn.com` (reachable,
unlike the hosts above) carry the real event name, and
[`worker/src/ufc-events.js`](worker/src/ufc-events.js) matches each priced
fight against them. The promotions it queries are discovered from ESPN's own
league directories rather than hardcoded — a fixed UFC+PFL pair left every
other promotion's card displaying as a bare `Card - MM/DD`, and a longer
hand-kept list would fail the same silent way the next time ESPN's roster of
leagues changed.

### Football: the Gridiron Engine feed

The NFL/NCAA prediction engine at
[perpetualpixel.github.io/NFL-NCAA-Football-Prediction-Engine](https://perpetualpixel.github.io/NFL-NCAA-Football-Prediction-Engine/)
publishes `picks.json` beside its week pages: per game, the moneyline and
spread it lands on, the tier, the calibrated win probability, and every
breakdown paragraph from the card as plain text. [`docs/gridiron.js`](docs/gridiron.js)
reads it, matches each entry to the football games on this app's own odds
board, and folds the result into both the research bullets and the grade.

**How much it is allowed to move a grade, and why it is not more.** MMA's
capper consensus carries its own ±25 swing because the cappers *are* this
app's handicapping model for that sport. Football is the opposite case, and
the engine says so itself in the feed's `disclosure`: measured 2023-2025 its
optimal blend weight given the closing line is 0.00, its closing line value is
34-39%, and its largest disagreements with the market were its worst bets. So
it enters as an ordinary qualitative signal inside the generic ±8 clamp,
blended with the ESPN form/injury/EPA signal rather than replacing it, and its
magnitude is *damped* as it strays above the price rather than amplified — the
opposite of what a naive "the model likes it more than the book does" reading
would do. Spread agreement is capped lower still, because the engine's own
tracking says its spread sides cover about half the time. Totals get the
projected scoreline as research and no grade change at all: the engine
publishes no totals record, so there is nothing to stand behind.

Where the engine's pick is the *other* side of a bet on the board, the card
says so, and the drawer carries the engine's own disclosure verbatim. A site
borrowing another model's picks does not get to keep the confidence and drop
the caveat.

None of these sources cost odds credits.

**The rule in [`docs/insights.js`](docs/insights.js): every sentence must trace
to a value that arrived in a payload.** No inference, no "should keep
dominating", no rounding 3-1 up to "dominant". Where a fact isn't in the data the
bullet is dropped, so a thin card means thin evidence — which is information in
itself. A fabricated stat reads exactly like a real one, and someone is betting
money on it.
