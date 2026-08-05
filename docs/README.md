# Pixel Pick

One button. It reads the live US betting market, finds bets priced better than
the market's own consensus, and shows you up to 8 of them to build your own
parlays or straights from.

- **`index.html` / `styles.css` / `app.js`** — the interface.
- **`engine.js`** — all the betting logic. Pure functions, no DOM, no network.
- **`demo.js`** — fake-but-realistic slate used until you point at a live feed.
- **`config.js`** — the one file you edit.

---

## 1. Turn on GitHub Pages

Repo **Settings → Pages → Source: Deploy from a branch**, branch `main`,
folder **`/docs`**. Wait a minute, then open:

```
https://miguelsgarcia4.github.io/PerpetualCode/
```

It works immediately on demo data. On your iPhone, tap **Share → Add to Home
Screen** and it runs full-screen like a normal app.

## 2. Deploy the odds proxy

The API key must never sit in this repo — a static page can't hide one. A tiny
Cloudflare Worker holds it instead. See [`../worker/README.md`](../worker/README.md).
Takes about five minutes and costs nothing.

## 3. Point the app at it

In `config.js`:

```js
WORKER_URL: 'https://pixel-pick-odds.YOUR-SUBDOMAIN.workers.dev',
```

Commit, push, done. The yellow "Demo data" banner disappears and the credit
counter appears.

---

## How picks are chosen

Not "odds in range, pick at random." The engine runs the same three steps a
professional bettor runs before placing anything:

**1. De-vig every book.** A book showing -110 / -110 is not saying "50/50" — it's
saying 50/50 plus a 4.8% fee. Strip the fee and you get what that book actually
believes.

**2. Build a consensus that excludes the book you'd bet at.** This is the step
most naive models skip. If DraftKings hangs +150 and everyone else says +130,
letting DraftKings vote on its own price makes every outlier look like free
money. The benchmark is built from the *other* books only.

**3. Grade the best available price against that benchmark.** The gap is your
edge, expressed as expected value per dollar.

Then four confidence weights decide which edges are trustworthy:

| Factor | Weight | Why it matters |
|---|---|---|
| Edge vs consensus | 45% | The actual money. Everything else is a filter on this. |
| Book count | 18% | Three books agreeing is noise. Ten is a market. |
| Market agreement | 15% | An outlier only means something if everyone else is clustered. |
| Line-shopping gain | 14% | The best number vs the field average — this is the part you control. |
| Freshness | 8% | A stale line on a game six days out isn't a real price. |

The `?` on each pick shows the real numbers behind that grade, not a generated
adjective.

## Generate: a top-8 pool, not a pre-built slate

Generate hands back up to 8 straight bets — `topPicks()` in `engine.js` —
ranked purely by grade across every sport currently selected. Every pick is
its own leg at its own real price; the app doesn't parlay any of them
together. The point is a pool you build your own parlays or straights from,
sized (per the app's own design goal) so 4 parlays or 5 straights don't
over-expose one board.

Odds range and confidence floor are both adjustable, under the "Odds &
Confidence" filter tab — default −250 to +150, confidence ≥50, widenable to
−1000/+500 and down to 0. A thin sport (MMA on a quiet night, tennis
off-season) clearing nothing at the default settings is the range doing its
job, not a bug — widen it rather than assume something's broken.

(`generateSlate()`, the older 1–2 pick model that auto-pairs a short-priced
leg with a partner to drag the combined price toward +100, still exists and
is still tested — it's just not what the main Generate button calls anymore.)

## Closing Line Value (CLV)

The sharp-betting benchmark that matters across a large sample more than any
single bet's outcome: did you get a better price than the line eventually
closed at? History tracks this per leg — `lastKnownAmerican` is the freshest
price seen for that exact bet while its game hadn't started yet, refreshed
every time the board loads and left frozen the moment the game goes off the
board. That frozen number is this app's best-effort stand-in for a true
closing line — there's no historical-odds time-series feed here to read a
guaranteed one from, so it depends on the app having been open again before
that game started to catch a later price. An aggregate CLV appears at the top
of the History panel once at least one leg has closed.

## Parlay Builder

A third tab, separate from both the automatic top-8 and Play of the Day: pick
your own legs by hand. Toggle on the sports you want (from whatever's already
loaded on the Board — it never fetches anything of its own), and for each,
which market types are eligible — "UFC: moneylines only," "NFL: spreads
only." Set your own odds range, confidence floor, and leg count, then
Generate builds one ticket from the highest-graded candidates that clear
every filter (`buildParlay()` in `engine.js`).

Legs always come from different games, the same rule `generateSlate()`'s
combo-pairing already enforces — `combineLegs()` multiplies decimal odds
assuming independence, which is only true across separate events. A team to
cover and that same game's total are correlated bets; combining them as if
independent would misstate the true parlay price, not just be optimistic
about it. If a ticket can't fill every leg from what's toggled on, it says
exactly how many legs are missing and how many candidates qualify, rather
than padding it with something that fails the filter.

## Play of the Day

A separate tab: one editorially-selected pick, the same for every visitor
that day, with a full write-up (the price case plus every research bullet
this app can source for it) rather than the compact card version. Generated
server-side by the worker's hourly cron (`worker/src/potd.js`) — the app just
reads whatever's currently stored via `GET /potd`.

Posts around 8am ET most days. When the best pick's own game starts too early
for that (an early tennis match, say, at 6am ET), the evening before (~7pm
ET) posts it instead, so there's still a full day's notice rather than
posting after the game already started. Once a day's pick is written it
doesn't change again that day, regardless of what the market does afterward
— it's an editorial call made at a point in time, not a live-repriced
candidate like the ones on the main board.

## Suggested stake (Kelly Criterion)

Every pick — on the Board, in a Parlay Builder ticket, and on Play of the
Day — carries a suggested stake as a % of bankroll, using quarter-Kelly
against the pick's own no-vig consensus (`kellyFraction()` /
`suggestedStake()` / `suggestedParlayStake()` in `engine.js`). Full Kelly
maximizes long-run growth but is only correct if the win-probability input is
exactly right, and a devigged market consensus is a good estimate of that,
not a guarantee — quarter-Kelly trades some growth for a meaningfully
smoother ride, the standard practice this app's own reference framework
recommends over full Kelly. Capped at 5% of bankroll per bet regardless of
what the raw formula says, as protection against the estimate being wrong in
one particular market's favor, not a claim that the math itself is wrong. A
parlay's stake uses the product of its legs' individual probabilities — the
same independence assumption `combineLegs()` already makes when multiplying
their decimal odds, and `buildParlay()` enforces structurally by refusing two
legs from the same game.

### Bankroll and units

The Bankroll button (top bar) turns that %-of-bankroll figure into something
directly actionable. Set a bankroll and every stake line converts to a real
dollar amount; set a unit size too (or leave it blank to use the built-in 2%
recommendation) and toggle "Show stakes as" to Units to see stakes the way
most bettors actually track their own action — "1.5 units" rather than a raw
dollar figure, which stays meaningful as the bankroll itself grows or
shrinks. Everything here is local-only (`localStorage`, never sent
anywhere) and display changes apply on the next Generate/parlay/Play-of-the-Day
view rather than live-patching whatever's already on screen — the same
"applies on next tap" convention the Odds & Confidence range filter already
uses, and for the same reason: it avoids a spurious re-fetch of a pick's
research bullets just to update a stake string.

## Guide

A plain-language reference for a new bettor, opened from the Guide button in
the top bar: American odds, what "Confidence" and "no-vig fair value" mean,
why picks show several sportsbooks, what Kelly staking and units are, what
CLV is, and what each of the three tabs actually does. Static content in
`index.html` (`#guidePanel`) — collapsible `<details>` sections, no
JavaScript beyond the same panel-open/close plumbing every other side panel
already uses.

## The price rules

Straight from the spec, enforced in `engine.js` and covered by
`test/engine.test.mjs`:

- A leg from **-150 to +150** can stand alone.
- A leg from **-250 to -151** is *never shown alone* — it gets paired with a leg
  from a different game, chosen to drag the ticket as close to **+100** as
  possible.
- A two-leg ticket **may exceed +150**. That's the point of pairing.
- Combo legs always come from different games. Two legs of the same game are
  correlated, and a parlay price assumes they aren't.

These are `generateSlate()`'s rules specifically — `topPicks()` (what Generate
actually calls) shows every leg straight, at whatever price the user's own
odds-range slider allows.

Run the tests:

```bash
node --test test/engine.test.mjs
```

## Known limits — read these

- **Player props aren't included.** The Odds API bills props per-event and gates
  them behind its Business tier. Game markets (moneyline, spread, total) are
  what's reachable on a free or cheap plan. The engine handles props unchanged
  if you ever upgrade — only the Worker's market list needs to change.
- **The Action Network link goes to their league odds page, not a pre-filled bet
  slip.** They don't publish a deep-link or bet-placement API. The card tells you
  which book had the best number so you know where to go; the link is for
  cross-checking.
- **Odds are cached up to five minutes** to protect your API quota. The card
  shows when each line was last seen. Always confirm the number at the book.
- **The model grades price, not injuries.** It reads what the market has already
  priced in. It does not know that a starter was scratched twenty minutes ago —
  though sharp books do, and that shows up as sudden market disagreement, which
  the model does penalise.
