# Deploy guide — Tail or Fade release

Everything on `claude/mma-card-name-discovery-sqr8k7` / PR #58.

**One thing needs manual attention before this works: `ANTHROPIC_API_KEY`.**
Read [step 3](#3-check-the-secret--the-one-that-actually-matters) before deploying.

---

## 0. Merge

PR #58 → https://github.com/PerpetualPixel/PerpetualCode/pull/58

It's a draft; mark it ready, then merge. Six commits.

---

## 1. Pull

```powershell
cd C:\path\to\PerpetualCode
git checkout main
git pull origin main
git log --oneline -1
```

Expected top commit: the Tail or Fade quota commit. **If `git log` shows
anything older, stop** — two deploys earlier in this project shipped stale
code from a checkout that hadn't pulled, and the only symptom was "the
feature isn't there."

---

## 2. Frontend — nothing to do

`docs/` is GitHub Pages. Merging publishes it; give it a minute or two.

Asset version is **v1.153**. Hard-refresh (Ctrl+F5) if you see the old UI —
the `?v=` bump handles it for everyone else.

---

## 3. Check the secret — the one that actually matters

The bet-slip reader calls Anthropic. **The worker already uses
`ANTHROPIC_API_KEY` for Play of the Day write-ups**, so this is very likely
already set — but verify rather than assume:

```powershell
cd worker
npx wrangler secret list
```

Look for `ANTHROPIC_API_KEY` in the output.

**If it's there:** nothing to do. Same key, same account, no new billing
setup.

**If it isn't:**

```powershell
npx wrangler secret put ANTHROPIC_API_KEY
# paste the key at the prompt
```

Without it, dropping a slip returns *"Bet slip reading is not configured on
this deployment"* — a clear message, not a crash — and every other part of
Tail or Fade (typing a bet, picking off the slate, the whole analysis
engine) still works. So a missing key degrades the image route only.

While you're there, confirm `OWNER_PASSPHRASE` is set too. It's what makes
your reads unlimited (see [step 6](#6-your-own-unlimited-access)).

---

## 4. Deploy the worker

```powershell
cd worker
npx wrangler deploy
```

**Expected output: `Total Upload: 558.69 KiB`.**

If it says something materially smaller, the pull didn't take — go back to
step 1. This byte count is the only reliable proof the deploy shipped what
you think it did.

**No database migration in this release.** `wrangler d1 migrations apply` is
not needed.

---

## 5. Verify it's live

```powershell
# 1. The quota endpoint should answer (anonymous, so 3/day)
Invoke-RestMethod "https://pixel-pick-odds.mgbouldering.workers.dev/tail-fade/quota"
# expect: kind=anonymous, used=0, limit=3, remaining=3

# 2. Your own key should come back exempt
Invoke-RestMethod "https://pixel-pick-odds.mgbouldering.workers.dev/tail-fade/quota" `
  -Headers @{ "X-Owner-Key" = "<your owner passphrase>" }
# expect: exempt=True, limit=null
```

Then in the browser: Full Slate → **Tail or Fade** → *Bet slip image* → drop
a real screenshot of a parlay. You should see the allowance under the drop
zone, then your actual legs, then the verdict — with no second click.

---

## 6. Your own unlimited access

Send the `X-Owner-Key` header with your `OWNER_PASSPHRASE`. That's the same
header the admin routes already use.

**In the browser this is not automatic** — the app doesn't hold your owner
key, so browsing normally you're on the signed-in limit of 10/day like
anyone else. Unlimited applies to API calls where you set the header
yourself (PowerShell, curl, or automation).

If you want unlimited in the browser too, say so and I'll add an owner-key
field to the account settings page — it's small, but it means storing the
passphrase in `localStorage`, which is a real tradeoff worth deciding on
deliberately rather than by default.

---

## The limits, as shipped

| Who | Slip reads / day | How they're counted |
|---|---|---|
| **You** (with `X-Owner-Key`) | unlimited | exempt, no counter written |
| Signed-in user | **10** | by account id — follows them across devices |
| Anonymous visitor | **3** | by IP |

Reset at **midnight ET**, on the same day boundary as every other surface.

Three deliberate choices worth knowing about:

- **Anonymous gets less (3, not 10)** because an IP is a coarse bucket — a
  shared office counts as one person, a phone changing networks as several.
  The cost of getting a coarse bucket wrong should be smaller than the cost
  of getting an account wrong. The refusal message tells them signing in
  raises it.
- **The quota is consumed before the API call, not after.** A request that
  fails upstream still spends its unit, because the money is already gone by
  then. Only counting successes would make a stream of failures free.
- **A KV outage fails open** — it doesn't lock everyone out of a paid
  feature because a counter is unreadable. The existing per-minute burst
  limiter still sits in front of the route, so the exposure is bounded.

**Only the image route is limited.** Typing a bet in, pasting text, and
picking off the slate are all unlimited — they cost nothing. The refusal
message says so, so a user who runs out has an obvious next step.

---

## What's in this release

| | |
|---|---|
| **Team form at selection time** | `worker/src/team-form.js` — form and injuries now consulted when picks are *chosen*, not just when they're drawn. Affects Full Slate, Pixel's Picks, Play of the Day, ladder. |
| **Tail or Fade agrees with the app** | Pasting your own Play of the Day can no longer come back FADE. Structurally impossible now, not just unlikely. |
| **Real bet-slip reading** | Drop a screenshot → your actual legs → analysis, no second click. Was a mock returning fixed sample legs. |
| **Slate / parlay toggle** | Ten legs graded individually either way; the toggle changes what the headline verdict means. |
| **Grading engine** | Five pillars, de-vigging, quarter-Kelly, five verdict tiers. |
| **`take_or_fade_engine/`** | Python package with the slip Ticket Restructuring Engine. Reference implementation — **not deployed, nothing to run.** |
| **Prop Play measurable** | It carried no `consensusProb`, so the weekly review silently skipped every one. Now countable. |

**799 JS tests, 129 pytest, 18 browser checks on the drop path.**

---

## Still outstanding from earlier (unchanged by this deploy)

These are the admin commands still queued from the MMA cleanup — unrelated
to this release, but they're the open items:

```powershell
$key = @{ "X-Owner-Key" = "<your owner passphrase>" }
$base = "https://pixel-pick-odds.mgbouldering.workers.dev"

# 1. Sidney Outlaw — confirmed from his own Sherdog page
Invoke-RestMethod -Method Post -Uri "$base/admin/manual-mma-result" -Headers $key `
  -Body (@{ dateKey = "2026-08-15"; pickId = "134588f132f2bd8c580db380ea6eabe5:h2h|Sidney Outlaw|"; winnerName = "Sidney Outlaw"; method = "Rear Naked Choke"; round = 2 } | ConvertTo-Json)

# 2. Johnson/Henrique — "Under 2.5" totals; round = 3 makes it grade LOST, which is correct
Invoke-RestMethod -Method Post -Uri "$base/admin/manual-mma-result" -Headers $key `
  -Body (@{ dateKey = "2026-08-15"; home = "Charles Johnson"; away = "Eduardo Henrique"; winnerName = "Charles Johnson"; method = "Submission"; round = 3 } | ConvertTo-Json)

# 3. Barboza/Ribovics regrade — dry run FIRST, check the output, then apply
Invoke-RestMethod -Method Post -Uri "$base/admin/regrade-mma-totals" -Headers $key
Invoke-RestMethod -Method Post -Uri "$base/admin/regrade-mma-totals?apply=true" -Headers $key
```

---

## If something's wrong

| Symptom | Cause | Fix |
|---|---|---|
| "Bet slip reading is not configured" | `ANTHROPIC_API_KEY` missing | Step 3 |
| Upload button does nothing | Frontend cached | Ctrl+F5 |
| Deploy size ≠ 558.69 KiB | Stale checkout | Step 1 |
| Everyone hits the limit instantly | `OWNER_PASSPHRASE` unset → nobody is exempt, but that shouldn't affect *others'* counts. Check `wrangler tail` for quota errors. | |
| Legs come back wrong | The model misread the image — low-confidence legs are flagged in the UI | Type the bet in instead; that path has no reader |

Live logs: `cd worker && npx wrangler tail`
