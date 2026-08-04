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
| MLB, NFL, NBA, NHL, soccer | ESPN, via the worker's `/context` | season and venue records, last five, head-to-head, ATS, injury report |
| Tennis (ATP + WTA) | static archive in [`docs/data/`](docs/data/) | head-to-head, form, surface splits, rankings, retirements |

ESPN has no usable tennis data at all — its tennis athletes carry no ids and the
summary endpoint returns 400 — so tennis runs off a season archive built from
[tennis-data.co.uk](http://www.tennis-data.co.uk/alldata.php):

```bash
node scripts/build-tennis-data.mjs   # refresh docs/data/tennis-{atp,wta}.json
```

Re-run it weekly; matches only accumulate. Neither source costs odds credits.

**The rule in [`docs/insights.js`](docs/insights.js): every sentence must trace
to a value that arrived in a payload.** No inference, no "should keep
dominating", no rounding 3-1 up to "dominant". Where a fact isn't in the data the
bullet is dropped, so a thin card means thin evidence — which is information in
itself. A fabricated stat reads exactly like a real one, and someone is betting
money on it.
