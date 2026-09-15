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

Not "odds in range, pick at random." The engine runs the same four steps a
professional bettor runs before placing anything:

**1. De-vig every book — with the power method, not a proportional rescale.**
A book showing -110 / -110 is not saying "50/50" — it's saying 50/50 plus a
4.8% fee. Strip the fee and you get what that book actually believes. *How*
you strip it matters: books do not charge the margin evenly. Longshots are
overpriced relative to their true chance (the favourite-longshot bias, one of
the best-replicated findings in betting markets), so rescaling every outcome
proportionally hands the underdog a point or two of probability it doesn't
have — on a +240 dog that is about 5% of phantom expected value, more than
three times this app's entire edge floor, and it is why an outlier-hunting
engine drifts toward dogs that win 30% of the time. The power method
(`devig()` in `engine.js`) raises each implied probability to the exponent
that makes them sum to 1, which takes the margin mostly out of the longshot.

**2. Anchor the consensus to the sharp market.** The worker pulls Pinnacle's
line alongside the US board (`worker/src/odds.js`), and where it prices a
game the consensus is 70% its de-vigged number and 30% the soft-book median
(`SHARP_ANCHOR_WEIGHT`). Soft books copy each other and lag the sharp market
by minutes to hours, so "one book is better than the median of the others"
very often meant "one book has moved toward where Pinnacle already is and the
rest haven't" — a bet *against* the sharp read, dressed as an edge. Pinnacle
is never the bet (it doesn't take US customers); it is the benchmark. Where no
sharp quote exists the soft-book median stands alone, exactly as before, and
the pick's `anchor` field says which regime graded it.

**3. Exclude the book you'd bet at from its own benchmark.** If DraftKings
hangs +150 and everyone else says +130, letting DraftKings vote on its own
price makes every outlier look like free money. The benchmark is built from
the *other* books only.

**4. Grade the best price the reader can actually take.** The best price is
chosen among the books in the app's own registry (`SPORTSBOOKS`) whenever one
of them prices the line — an offshore outlier isn't a price most readers can
get, and the tracked record grades at this number, so it has to be one they
could have taken. The gap between that price and the anchored consensus is the
edge, expressed as expected value per dollar.

Then the grade: **edge, multiplied by confidence.** The score is
`100 · edge · (0.55 + 0.45 · confidence)`, where confidence blends book count
(35%), market agreement (25%), sharp anchor present (15%), line-shopping gain
(15%) and freshness (10%). The confidence factors *scale* the edge; they never
add to it. The previous additive blend let a zero-EV bet with a tidy, liquid,
fresh number score about 70 — twenty points clear of the floor — and the
boards that rank by score kept choosing the cleanest number over the most
profitable one. A zero-EV candidate now scores at most 33 whatever its market
quality.

**A curated pick is priced at a book you can bet.** Play of the Day,
Pixel's Picks and the Ladder refuse a candidate whose best price sits only at
an offshore or EU book (`bettable` on the candidate; `requireBettable` in
`topPicks`). The live record made the case: Pixel's Picks priced at a registry
book went 24-19 for +24.7%, those priced at offshore/EU books 35-42 for −10%,
and those at Pinnacle or an exchange 6-8 for −25% — and the edge read only
predicted results at registry prices. Tennis now pulls the US region too so
main-tour matches carry registry prices at all. The Full Slate, as the raw
record, still tracks every line.

**The edge floor is the one thing no board relaxes.** Play of the Day,
Pixel's Picks, the Ladder rung and the Prop Play each require a real edge
(`RULES.MIN_EV_PCT`, 2% of stake against the anchored consensus, plus a
minimum quarter-Kelly stake) before a pick can post at all — flagged fallback
tiers relax the price band or the confidence floor, never this. Until
2026-09-15 Play of the Day and the Ladder had no EV requirement, and every
board had a last-resort tier that posted bets the engine itself graded as
losers so the board never looked short. A day with fewer real edges now posts
fewer picks, with the reason written to the card: a pass is a pick too.

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

## More Stats

Every leg, on every surface (Board and its history
entries), has a "More Stats" button next to its "?" — a side drawer with the
full breakdown instead of the compact card's single price bullet and
tier-flattened bullet list:

- The full Market & Price Case (`explainExtensive()`, the same expanded
  price reasoning Play of the Day carries — no-vig fair value, book
  agreement, line-shopping gain, and freshness relative to kickoff, each its
  own sentence instead of one compact paragraph).
- Research grouped into the same named sections Play of the Day uses
  (Primary Personnel & Direct Matchup / Supporting Cast & Availability /
  Environmental & Situational Notes) — same tagged bullets, same
  `insightsByTier()`, just also available from the compact card now instead
  of only from the daily pick.
- Weather as stat pills (temperature, conditions, wind, precipitation
  chance) when the leg is an NFL/MLB fixture with one, instead of buried in
  a sentence.
- Every book's price and implied probability on this exact line, as a
  sortable table — the same `quotes[]` already backing the book buttons,
  just shown in full rather than as a row of pills.

Opens instantly with a skeleton, fills in once the (already-cached) research
fetch resolves — reopening a leg whose "why" panel is already expanded costs
no extra network call, since both read from the same `state.context` cache
keyed by event/venue. A section is omitted entirely when it has nothing
real behind it (an individual sport's "Supporting Cast," a domed venue's
weather) — same rule as the compact card and Play of the Day: a gap in the
data is a shorter drawer, never an invented placeholder.

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

### The write-up's tiers

The write-up is built from up to four sections, each shown only when it
actually has content:

1. **The Market & Price Case** — `explainExtensive()` in `engine.js`, the
   fuller version of the compact card's single price bullet: the no-vig
   consensus and fair value, book agreement/clustering, the line-shopping
   gain specifically (a real number every candidate already carries but
   which the compact card never states on its own), and how fresh the quote
   is relative to kickoff. Always present.
2. **Primary Personnel & Direct Matchup** — the subject's own record, form,
   head-to-head/series history, surface splits and ranking (tennis), or
   finish tendencies (MMA).
3. **Supporting Cast & Availability** — team-sport roster availability
   (injuries) only. Never appears for tennis or MMA, which have no
   supporting cast to report on — omitted, not a placeholder pretending
   otherwise.
4. **Environmental & Situational Notes** — live venue weather (NFL/MLB,
   from the National Weather Service — see `worker/README.md`'s `/weather`
   entry) and a layoff or retirement/walkover flag (tennis/MMA), combined
   under one heading since in practice a given sport only ever populates one
   of the two. This *is* real environmental coverage now, unlike an earlier
   version of this write-up, which called this tier "Situational Notes" and
   explicitly declined the "Environmental" label because there was no
   weather or venue data behind the app at all — that gap is what
   `weather.js` closes.

Every non-price bullet, from every sport, is tagged `{ tier, text }` at the
source (`insights.js`) — `'personnel'`, `'supporting'`, `'environmental'`, or
`'situational'` — rather than guessed at afterward from its wording.
`'environmental'` and `'situational'` stay separate tags (they answer
different questions — the game's setting vs. a competitor's own recent
history) even though the write-up presents them together. The compact card
(`insightTexts()`) just flattens the tags away and shows the same list it
always has — weather included, on a total as much as a side bet, since
weather is about the game rather than either side of it; Play of the Day
(`insightsByTier()`) groups by them. One set of real bullets, two ways of
presenting them, matching how honest each surface gets to be about depth.

## Suggested stake (Kelly Criterion)

Every pick — on the Board and on Play of the
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
their decimal odds, and `findPartner()` enforces structurally by refusing two
legs from the same game.

### Bankroll and units

The Bankroll button (top bar) turns that %-of-bankroll figure into something
directly actionable. Set a bankroll and every stake line converts to a real
dollar amount; set a unit size too (or leave it blank to use the built-in 2%
recommendation) and toggle "Show stakes as" to Units to see stakes the way
most bettors actually track their own action — "1.5 units" rather than a raw
dollar figure, which stays meaningful as the bankroll itself grows or
shrinks.

These figures are saved to `localStorage` and, once you enter an owner
passphrase under "Sync key," mirrored to the worker as well
(`GET`/`PUT /settings`, backed by KV — see `worker/src/settings.js`), so they
survive a cleared browser and follow you to another device. The local copy is
always written, so sync is never load-bearing: with no key configured, or the
worker unreachable, the app behaves exactly as it did before sync existed.
The passphrase is an interim single-owner stand-in for real accounts — it
gates reads as well as writes, since a bankroll shouldn't be readable by every
visitor to a public site.

Display changes apply on the next Generate/Play-of-the-Day
view rather than live-patching whatever's already on screen — the same
"applies on next tap" convention the Odds & Confidence range filter already
uses, and for the same reason: it avoids a spurious re-fetch of a pick's
research bullets just to update a stake string.

## Daily Learning

The self-correction loop (`worker/src/daily-learning.js`), reported in the
Tracking panel's "Daily Learning" section. Every morning at the 2am ET batch,
before any picks are chosen, the review digests the trailing 30 days of
graded results — actual wins vs. what each pick's own no-vig probability
predicted (a z-test), plus closing-line value, the fastest honest tell that
a perceived edge is illusory — for every sport + bet-type segment and odds
band. Each feature gets a bounded reliability weight (x0.70 to x1.05, shrunk
toward 1.0 on small samples) that multiplies into candidate scores at that
morning's Pixel's Picks and Play of the Day selection: a misfiring segment
needs a visibly better number to make the board, a sharp one gets a small
nudge.

Three properties keep it honest. Adjustments apply only to the *next* day's
selection — nothing is re-graded or touched intraday, so the tracked record
is never skewed. The Full Slate tracker never has weights applied — it keeps
recording the raw engine so tomorrow's learning draws from unbiased
evidence rather than from a record already filtered by yesterday's lessons.
And every adjusted pick stores both its raw and adjusted score, so whether
the learning layer is actually helping is itself measurable. Each morning's
review writes a plain-English report (what yesterday did, what changed and
why) to the same panel.

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
