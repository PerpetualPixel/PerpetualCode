# Pixel Pick

One button. It reads the live US betting market, finds bets priced better than
the market's own consensus, and shows you one or two of them.

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

## The price rules

Straight from the spec, enforced in `engine.js` and covered by
`test/engine.test.mjs`:

- Every leg sits between **-250 and +150**. Nothing outside that is shown.
- A leg from **-150 to +150** can stand alone.
- A leg from **-250 to -151** is *never shown alone* — it gets paired with a leg
  from a different game, chosen to drag the ticket as close to **+100** as
  possible.
- A two-leg ticket **may exceed +150**. That's the point of pairing.
- Combo legs always come from different games. Two legs of the same game are
  correlated, and a parlay price assumes they aren't.

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
