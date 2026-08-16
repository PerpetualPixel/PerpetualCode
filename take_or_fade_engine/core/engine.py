"""Five-pillar composite scoring and the decision classification matrix.

    TPS = 0.30*market + 0.25*matchup + 0.20*distribution
        + 0.15*context + 0.10*variance

The rule that shapes this module: a pillar with no real data behind it
scores ``None``, never a neutral 50, and its weight is redistributed. The
redistribution is not uniform — see :func:`composite_score` for why merit
weight must not flow to the modifier pillars, and what goes wrong when it
does.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping, Optional

import numpy as np

from ..schemas import WagerLeg
from ..sports import evaluator_for
from ..sports.base import HIT_RATE_FLOOR, PillarResult, blend, norm100
from .market import (
    MIN_KELLY_FRACTION,
    american_to_decimal,
    assess_juice,
    expected_value,
    fractional_kelly,
    implied_probability,
)

PILLAR_WEIGHTS: dict[str, float] = {
    "market": 0.30,
    "matchup": 0.25,
    "distribution": 0.20,
    "context": 0.15,
    "variance": 0.10,
}

# Pillars that measure MERIT — reasons the bet is good.
MERIT_PILLARS = ("market", "matchup", "distribution")
# Pillars that measure the ABSENCE OF PROBLEMS. Different thing entirely.
MODIFIER_PILLARS = ("context", "variance")

# Ceiling on the modifier pillars. Absence of problems is not maximal
# evidence FOR a bet, and left uncapped both pin at 100 on any ordinary
# wager — which, combined with redistribution, lets a negative-EV bet score
# in the sixties on the strength of a fresh line and a tight book spread.
MODIFIER_PILLAR_CEILING: float = 85.0

# Specification classification matrix, with the unit sizing it prescribes.
STRONG_TAKE = "STRONG TAKE"
TAKE = "TAKE"
LEAN_PASS = "LEAN / PASS"
FADE = "FADE"
STRONG_FADE = "STRONG FADE"
NO_READ = "NO READ"

VERDICT_ORDER = (STRONG_TAKE, TAKE, LEAN_PASS, FADE, STRONG_FADE)

CLASSIFICATION_BANDS: tuple[tuple[float, str, tuple[float, float]], ...] = (
    (82.0, STRONG_TAKE, (1.5, 2.0)),
    (68.0, TAKE, (0.75, 1.0)),
    (52.0, LEAN_PASS, (0.0, 0.5)),
    (35.0, FADE, (0.0, 0.0)),
    (0.0, STRONG_FADE, (0.0, 0.0)),
)


def is_take_side(verdict: str) -> bool:
    return verdict in (STRONG_TAKE, TAKE)


def is_fade_side(verdict: str) -> bool:
    return verdict in (FADE, STRONG_FADE)


@dataclass(slots=True)
class LegAssessment:
    """A fully graded leg: score, verdict, sizing, evidence and gaps."""

    leg: WagerLeg
    pillars: dict[str, PillarResult]
    composite: Optional[float]
    coverage: float
    fair_prob: float
    ev: float
    kelly: float
    verdict: str
    units: float
    vulnerabilities: list[str] = field(default_factory=list)

    @property
    def unavailable(self) -> list[str]:
        seen: list[str] = []
        for pillar in self.pillars.values():
            for name in pillar.unavailable:
                if name not in seen:
                    seen.append(name)
        return seen

    @property
    def signals(self) -> list[str]:
        return [s for pillar in self.pillars.values() for s in pillar.signals]


def composite_score(pillars: Mapping[str, PillarResult]) -> tuple[Optional[float], float]:
    """Weighted composite over the pillars that produced a real score.

    Redistribution is split by GROUP. A missing merit pillar's weight goes to
    the other merit pillars, never to the modifiers: context and variance
    measure the absence of problems, and letting them inherit 45% of the
    model because no matchup feed exists for a sport means a bet with
    terrible expected value still scoring well on the strength of a fresh
    line. Only when a whole group is empty does its weight cross over, since
    at that point the alternative is discarding the model entirely.

    Returns ``(score, coverage)`` where coverage is the fraction of the
    model's DESIGNED weight that had real data — reported unchanged by the
    redistribution, because a 78 built on 55% coverage and a 78 built on all
    of it are not the same claim.
    """
    live_merit = [k for k in MERIT_PILLARS if pillars.get(k) and pillars[k].available]
    live_modifier = [k for k in MODIFIER_PILLARS if pillars.get(k) and pillars[k].available]
    if not live_merit and not live_modifier:
        return None, 0.0

    merit_weight = sum(PILLAR_WEIGHTS[k] for k in MERIT_PILLARS)
    modifier_weight = sum(PILLAR_WEIGHTS[k] for k in MODIFIER_PILLARS)
    merit_share = merit_weight + (modifier_weight if not live_modifier else 0.0) if live_merit else 0.0
    modifier_share = modifier_weight + (merit_weight if not live_merit else 0.0) if live_modifier else 0.0

    score = 0.0
    for group, share in ((live_merit, merit_share), (live_modifier, modifier_share)):
        if not group:
            continue
        total = sum(PILLAR_WEIGHTS[k] for k in group)
        for k in group:
            score += (PILLAR_WEIGHTS[k] / total) * share * pillars[k].score

    coverage = sum(PILLAR_WEIGHTS[k] for k in (*live_merit, *live_modifier))
    return float(np.clip(score, 0.0, 100.0)), coverage


def classify(tps: Optional[float], ev: float, juice_flagged: bool = False) -> tuple[str, float]:
    """Composite plus EV onto a verdict and a unit size.

    EV is a GATE rather than another weighted term: the composite blends in
    liquidity, form and situational factors, which describe how sound a read
    is — not whether the price pays for it. A negative-expectation bet is not
    a take at any composite score.
    """
    if tps is None or not np.isfinite(tps):
        return NO_READ, 0.0

    for floor, verdict, (unit_lo, unit_hi) in CLASSIFICATION_BANDS:
        if tps >= floor:
            break

    if ev <= 0:
        # Demote into the fade half rather than merely capping: a bet that
        # loses money on expectation is not a "pass".
        verdict = STRONG_FADE if (ev <= -0.05 or tps < 52.0) else FADE
        return verdict, 0.0

    if juice_flagged and is_take_side(verdict):
        return LEAN_PASS, 0.25

    if not is_take_side(verdict):
        return verdict, unit_lo

    # Position within the band scales the stake across its prescribed range,
    # so a 68 and an 81 are not both "1.0 units".
    next_floor = 100.0 if verdict == STRONG_TAKE else next(
        f for f, v, _ in CLASSIFICATION_BANDS if v == STRONG_TAKE
    )
    span = max(next_floor - floor, 1e-9)
    position = float(np.clip((tps - floor) / span, 0.0, 1.0))
    return verdict, round(unit_lo + position * (unit_hi - unit_lo), 2)


def _market_pillar(leg: WagerLeg) -> tuple[PillarResult, float, float, float, bool]:
    """Pillar 1. Returns the pillar plus the fair prob, EV, Kelly and juice flag."""
    decimal = leg.odds_decimal or american_to_decimal(leg.odds_american)
    signals: list[str] = []
    unavailable: list[str] = []

    if leg.sharp_fair_prob is not None:
        fair = float(leg.sharp_fair_prob)
    else:
        # No sharp benchmark supplied. Fall back to the leg's own implied
        # probability and SAY SO — a vigged number treated as fair would
        # manufacture an edge of exactly the size of the vig.
        fair = implied_probability(leg.odds_american)
        unavailable.append("sharp de-vigged benchmark (fell back to this leg's own implied price)")
        signals.append(
            "No sharp benchmark supplied, so expected value is measured against this leg's own "
            "implied probability — which cannot show an edge by construction."
        )

    ev = expected_value(fair, decimal)
    kelly = fractional_kelly(fair, decimal)
    juice = assess_juice(leg.odds_american, kelly)

    signals.append(
        f"Fair probability {fair * 100:.1f}% against a price of {leg.odds_american:+d} "
        f"({decimal:.3f} decimal) — {ev * 100:+.2f}% expected value per unit."
    )
    signals.append(
        f"Quarter-Kelly stake {kelly * 100:.2f}% of bankroll"
        + ("." if kelly >= MIN_KELLY_FRACTION else
           f" — below the {MIN_KELLY_FRACTION * 100:.2f}% floor that counts as a real bet.")
    )
    if juice.flagged:
        signals.append(
            f"Dead juice: {leg.odds_american:+d} demands {juice.required_kelly * 100:.2f}% Kelly "
            f"({juice.ratio:.1f}x the baseline) and this returns {juice.actual_kelly * 100:.2f}%."
        )

    ev_score = norm100(ev, -0.05, 0.10)
    # EV carries the pillar; the juice penalty is the specification's
    # explicit deduction for prices worse than -125 without backing edge.
    score = ev_score
    if score is not None and juice.flagged:
        score = max(0.0, score - 22.0)
    return PillarResult(score, signals, unavailable), fair, ev, kelly, juice.flagged


def _context_pillar(leg: WagerLeg) -> PillarResult:
    """Pillar 4: rest, travel, back-to-backs, game-script stability."""
    metrics = leg.metrics or {}
    parts: list[tuple[float, float]] = []
    signals: list[str] = []
    missing: list[str] = []

    mapping = (
        ("rest_days", "Rest days", 0.30, 0.0, 4.0),
        ("travel_miles", "Travel burden", 0.20, 2500.0, 0.0),  # inverted: less travel is better
        ("game_script_stability", "Game-script stability", 0.30, 0.0, 1.0),
        ("motivation_index", "Motivational context", 0.20, 0.0, 1.0),
    )
    for key, label, weight, lo, hi in mapping:
        if key not in metrics:
            missing.append(label)
            continue
        try:
            value = float(metrics[key])
        except (TypeError, ValueError):
            missing.append(label)
            continue
        parts.append((norm100(value, lo, hi), weight))
        signals.append(f"{label}: {metrics[key]}")

    if metrics.get("back_to_back"):
        parts.append((15.0, 0.35))
        signals.append("On the second night of a back-to-back — rotation and legs both suffer.")

    score = blend(parts)
    if score is not None:
        score = min(MODIFIER_PILLAR_CEILING, score)
    return PillarResult(score, signals, missing)


def _variance_pillar(leg: WagerLeg, fair_prob: float, kelly: float) -> PillarResult:
    """Pillar 5: how wide the outcome distribution is, and what Kelly permits."""
    signals: list[str] = []
    parts: list[tuple[float, float]] = []

    # A genuine longshot carries variance a favourite does not, whatever the
    # edge. This is not a second EV term — it is the spread around it.
    parts.append((norm100(fair_prob, 0.30, 0.72), 0.55))
    if fair_prob < 0.40:
        signals.append(
            f"A {fair_prob * 100:.1f}% shot — real underdog variance regardless of the edge."
        )
    elif fair_prob > 0.80:
        signals.append(
            f"A {fair_prob * 100:.1f}% favourite — low variance, but the price pays for that certainty."
        )

    parts.append((norm100(kelly, 0.0, 0.03), 0.45))
    signals.append(f"Kelly permits {kelly * 100:.2f}% of bankroll at this price and probability.")

    score = blend(parts)
    if score is not None:
        score = min(MODIFIER_PILLAR_CEILING, score)
    return PillarResult(score, signals, [])


def _vulnerabilities(leg: WagerLeg, pillars: Mapping[str, PillarResult],
                     ev: float, kelly: float, juice_flagged: bool) -> list[str]:
    """Concrete points of failure — the input the slip optimizer acts on."""
    out: list[str] = []
    metrics = leg.metrics or {}

    if ev < 0:
        out.append(
            f"Negative expected value ({ev * 100:+.2f}%) — the price does not pay for the probability."
        )
    elif ev == 0:
        # Exactly zero is the signature of a leg with no sharp benchmark: EV
        # measured against a price's own implied probability is 0 by
        # construction. Saying "negative" there would blame the bet for a
        # gap in the inputs.
        out.append(
            "No edge measurable — expected value is exactly zero because no sharp benchmark "
            "was supplied for this leg, so it was measured against its own price."
        )
    if juice_flagged:
        out.append(
            f"Dead juice at {leg.odds_american:+d}: heavier than -125 without proportional edge behind it."
        )
    from .market import ANCHOR_LEG_THRESHOLD_AMERICAN
    if leg.odds_american <= ANCHOR_LEG_THRESHOLD_AMERICAN:
        out.append(
            f"Anchor leg at {leg.odds_american:+d} — contributes almost no price to the ticket "
            "while carrying full risk of busting it."
        )

    samples = metrics.get("recent_samples")
    line = metrics.get("milestone_line")
    if samples and line is not None:
        hit = float(np.mean(np.asarray([float(v) for v in samples]) >= float(line)))
        if hit < HIT_RATE_FLOOR:
            out.append(
                f"Hit rate {hit * 100:.0f}% is below the {HIT_RATE_FLOOR * 100:.0f}% bar "
                "for a milestone prop."
            )

    if metrics.get("volume_dependent") and metrics.get("game_dominance_expected"):
        out.append(
            "Volume-dependent prop in a match the same ticket expects to be one-sided — "
            "a routine win squeezes the very volume this leg needs."
        )

    if kelly < MIN_KELLY_FRACTION and ev > 0:
        out.append("Edge too thin to stake meaningfully even at full quarter-Kelly.")

    return out


def evaluate_leg(leg: WagerLeg) -> LegAssessment:
    """Grade one leg across all five pillars."""
    sport = evaluator_for(leg.sport)
    market, fair, ev, kelly, juice_flagged = _market_pillar(leg)
    pillars = {
        "market": market,
        "matchup": sport.matchup(leg),
        "distribution": sport.distribution(leg),
        "context": _context_pillar(leg),
        "variance": _variance_pillar(leg, fair, kelly),
    }
    tps, coverage = composite_score(pillars)
    verdict, units = classify(tps, ev, juice_flagged)
    return LegAssessment(
        leg=leg,
        pillars=pillars,
        composite=tps,
        coverage=coverage,
        fair_prob=fair,
        ev=ev,
        kelly=kelly,
        verdict=verdict,
        units=units,
        vulnerabilities=_vulnerabilities(leg, pillars, ev, kelly, juice_flagged),
    )
