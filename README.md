# PerpetualCode


This repository is a collection of useful powershell scripts and lines that may be useful in the future!

## Pixel Pick

A one-button sports betting app that runs on your phone. It reads the live US
odds market, grades every available bet against the market's own no-vig
consensus, and surfaces one or two that are priced better than they should be.

- App: [`docs/`](docs/) — static site, deploys via GitHub Pages
- Odds proxy: [`worker/`](worker/) — Cloudflare Worker holding the API key
- Setup and how the picks are chosen: [`docs/README.md`](docs/README.md)

```bash
node --test test/engine.test.mjs   # verify the odds math and pairing rules
```
