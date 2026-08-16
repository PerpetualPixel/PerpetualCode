# TakeOrFadeEngine

A quantitative sports betting decision engine and slip optimizer.

Grades any wager or ticket across five weighted pillars, sizes it with
quarter-Kelly, and — when a ticket fails — diagnoses *which legs* failed and
rebuilds it into a counter-proposal priced in a band where the risk is
actually compensated.

Self-contained Python package. It does not fetch data: every sport metric is
supplied by the caller on `WagerLeg.metrics`, and anything absent is reported
by name rather than replaced with a neutral guess (see
[Only what's real](#only-whats-real)).

---

## Install and run

```bash
pip install pydantic fastapi numpy pytest httpx uvicorn

# CLI
python -m take_or_fade_engine.cli slip  --json take_or_fade_engine/examples/tennis_sgp_plus.json
python -m take_or_fade_engine.cli slate --csv  take_or_fade_engine/examples/slate.csv
python -m take_or_fade_engine.cli parse --text "Rublev ML -225" --sport TENNIS

# API
uvicorn take_or_fade_engine.app:app --reload

# Tests
python -m pytest take_or_fade_engine/tests -q
```

---

## Scoring

```
TPS = 0.30·market + 0.25·matchup + 0.20·distribution + 0.15·context + 0.10·variance
```

| Pillar | Weight | What it measures |
|---|---|---|
| Market & price efficiency | 30% | De-vigged fair probability, EV, quarter-Kelly, dead-juice penalty |
| Sport-specific matchup | 25% | Dispatched per sport — see below |
| Median distribution vs mean | 20% | Hit rate ≥65% on the **median**, so a blowout can't carry a leg |
| Situational script & rest | 15% | Rest, travel, back-to-backs, game-script stability |
| Variance & Kelly sizing | 10% | Spread of outcomes around the edge, and what Kelly permits |

| TPS | Verdict | Units |
|---|---|---|
| 82–100 | `STRONG TAKE` | 1.5 – 2.0 |
| 68–81 | `TAKE` | 0.75 – 1.0 |
| 52–67 | `LEAN / PASS` | 0.0 – 0.5 |
| 35–51 | `FADE` | 0.0 |
| 0–34 | `STRONG FADE` | 0.0 |

**EV is a gate, not another weighted term.** The composite blends in
liquidity, form and situational factors, which describe how *sound a read* is
— not whether the price pays for it. A negative-expectation wager is not a
take at any composite score.

### De-vigging

Both methods are implemented because they disagree in a way that matters.

- **Multiplicative** (the spec's `P₁ / (P₁ + P₂)`) preserves the ratio
  between outcomes exactly. That is its defining property and its weakness:
  books load more margin onto the longshot, so it overstates a longshot's
  fair probability on a lopsided market.
- **Power** solves for `k` where `Σ(qᵢ^k) = 1` by bisection over a monotonic
  function. Since `k > 1` on an overround book, it shrinks small
  probabilities by proportionally more — the empirically observed shape of
  how margin is actually distributed.

### Dead juice

Not a second heuristic beside Kelly — it *is* Kelly. At -125 you risk 1.25 to
win 1; at -300 you risk 3. The same win probability supports a much smaller
fraction of bankroll, so the required edge scales with `b(-125) / b(price)`:
1.0× at -125, 2.4× at -300, 6.4× at -800.

---

## Only what's real

A pillar with no data scores `None`, **never a neutral 50**, and its weight
is redistributed. Every evaluator reports `unavailable_factors` naming what
it could not compute, and `coverage` reports the fraction of the model's
designed weight that had real data behind it.

A neutral midpoint would make *"no arsenal data for this pitcher"* render
identically to *"the arsenal matchup is average"*. A caller cannot act
differently on those two, so the number is worse than useless — it is
confident and wrong.

Redistribution is **split by group**. Missing *merit* weight (market,
matchup, distribution) goes to the other merit pillars, never to the
*modifiers* (context, variance). Modifiers measure the absence of problems,
which is not maximal evidence *for* a bet; letting them inherit 45% of the
model whenever a sport lacks a matchup feed lets a negative-EV wager score
well on a fresh line alone. They are also capped at 85 for the same reason.

### Sport factors

Each evaluator computes from whatever the caller supplies and names the rest.

| Sport | Factors read from `metrics` |
|---|---|
| Tennis | `dominance_ratio`, `cpi_alignment`, `rally_tolerance`, `surface_win_pct`, `h2h_win_pct`, `prior_round_hours` (>2.5h fatigue penalty) |
| Basketball | `opp_playtype_def_rank`, `usage_reallocation`, `pace_delta`, `minutes_trend`, `opp_def_rating`, `game_spread` (±12.5 blowout discount, counting props only) |
| Baseball | `arsenal_vs_lineup_woba`, `lineup_wrc_plus`, `barrel_rate_allowed`, `park_weather_factor`, `bullpen_leverage_available` |
| Football | `epa_per_play_diff`, `success_rate_vs_havoc`, `prwr_minus_pbwr`, `rest_days_diff`, `turnover_margin_expected`, `spread_point` (key numbers 3/7/6/10/14/4) |
| MMA | `slpm_minus_sapm`, `takedown_defense_pct`, `control_time_share`, `reach_advantage_in`, `capper_consensus`, `round_output_decay` |

Common to all: `subject`, `recent_samples` + `milestone_line` (distribution),
`rest_days`, `travel_miles`, `game_script_stability`, `motivation_index`,
`back_to_back`.

---

## Slip optimizer

`FADE` is a diagnosis, not an answer. A bettor who built a ticket expressed
an intent; the useful reply identifies the point of failure, preserves the
rest, and rebuilds.

**1 — Dead-juice anchor rejection.** A leg at -500 or heavier buys almost no
price while carrying full power to bust the ticket. A -1600 leg multiplies by
`1.0625` — six cents on the dollar for an entire extra way to lose. The test
is what the leg *bought*, not how likely it is: a -1600 leg can be a 95% shot
and still be wrong to include.

**2 — Volume vs dominance pruning.** A volume prop inside a ticket that also
expects a one-sided win is betting against itself: a routine straight-sets
result is the best case for the outcome leg and the worst for the volume leg.
The prop is dropped and the read *elevated* to a moneyline or set spread —
unless a surviving leg already expresses it, in which case elevating would be
doubling down rather than restructuring.

**3 — Correlation-priced SGP synthesis.** Same-competitor legs are combined
with their correlation applied, not multiplied as if independent:

```
P(A and B) = p_a·p_b + ρ·√(p_a·q_a·p_b·q_b)
```

If Fritz is holding serve well enough to win a set, he is also serving enough
to reach an ace milestone. That is why an SGP of two high-floor legs prices
near -350 rather than the much longer price independence implies.

Target band: **-135 to +110**.

The stated limit: without a fitted coefficient the true joint probability of
correlated legs is not computable from prices alone. What this reports is the
*direction* naive multiplication is wrong in, and roughly by how much.

### Worked case

```
$ python -m take_or_fade_engine.cli slip --json examples/tennis_sgp_plus.json

╭─ RUBLEV-FRITZ-SGP-PLUS
│  STRONG FADE  TPS 27.9  EV -23.44%  0.00u
│  ! Rublev to win at least one set: Anchor leg at -1600 …
│  ! Rublev 5+ Aces: Hit rate 30% is below the 65% bar for a milestone prop.
│  ! Cannibalization: 'Rublev 5+ Aces' needs volume that 'Rublev ML' actively suppresses …
│  ╭─ RESTRUCTURE → STRONG TAKE at -118
│  │  EV lift: +33.22 percentage points
│  │  [SGP]      Fritz 5+ Aces + Fritz to Win a Set   -356
│  │  [STRAIGHT] Rublev ML                            -225
│  ╰─
╰─
```

---

## API

| Endpoint | Purpose |
|---|---|
| `POST /evaluate/pick` | One wager |
| `POST /evaluate/slip` | A ticket: per-leg grades, ticket verdict, proposal if it fails |
| `POST /evaluate/parlay` | As above, forcing parlay semantics |
| `POST /evaluate/slate` | Many tickets, each graded independently |
| `POST /optimize/slip` | Restructure unconditionally; `404` when nothing constructive is possible |

Per-leg grades are returned in **every** case, including when the ticket is a
strong fade — a parlay that dies on one bad leg still contains legs worth
betting straight, and a verdict discarding that would be actionable only as
"don't".

---

## Layout

```
take_or_fade_engine/
├── core/
│   ├── market.py          De-vigging, EV, Kelly, juice, joint probability
│   ├── engine.py          Five-pillar composite and classification
│   ├── parlay.py          Correlation, synergy, cannibalization
│   └── slip_optimizer.py  Ticket Restructuring Engine
├── sports/                tennis · basketball · baseball · football · mma
├── schemas.py             Pydantic contract
├── evaluate.py            Orchestration
├── app.py                 FastAPI
├── cli.py                 CLI + text/CSV parsing
├── examples/              Tennis SGP+, NBA prop, NFL spread, slate CSV
└── tests/                 129 tests
```

## Relationship to the JavaScript engine

`docs/take-or-fade.js` in this repository implements the same five-pillar
model inside the live PerpetualPicks app, which is a Cloudflare Worker plus a
static frontend and cannot host a Python service. The two are independent
implementations of one specification; this package is the reference, with the
sport evaluators and the slip optimizer the JS side does not have.
