"""Ticket Restructuring Engine — active restructuring, not passive rejection.

The premise of this module is that "FADE" is a diagnosis, not an answer. A
bettor who built a ticket expressed an intent: these players, this match,
this direction. When the ticket grades badly, the useful reply is not to
delete it — it is to identify which specific legs are the point of failure,
preserve the intent behind the rest, and rebuild it into something priced in
a band where the risk is actually compensated.

Three rules, in the order they fire:

1. **Dead-juice / anchor rejection.** A leg at -500 or heavier contributes
   almost nothing to the ticket price while carrying full power to bust it.
   Pairing a -225 favourite with a -1600 anchor yields about -189: the anchor
   bought roughly 36 cents of price in exchange for an entire extra way to
   lose. It goes.

2. **Volume-vs-dominance cannibalization pruning.** A volume prop inside a
   ticket that also expects a one-sided win is betting against itself. The
   fix is not to drop the intent but to *elevate* it: the competitor the
   ticket already likes moves to a straight moneyline or set spread, which
   is the same read expressed in a market that dominance helps rather than
   hurts.

3. **High-floor SGP pairing.** Legs on the same competitor that genuinely
   correlate are combined into a same-game parlay priced with that
   correlation, not with naive multiplication — which is what makes an SGP
   of two high-floor legs land near -350 rather than the much longer price
   independence would imply. That SGP is then paired with the strongest
   surviving straight to reach the target band.

The target band is -135 to +110: heavy enough that the ticket is built on
things that actually happen, long enough that the payout compensates the
risk taken.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

from ..schemas import BetSlipInput, OptimizationProposal, RestructuredLeg, WagerLeg
from .engine import (
    LEAN_PASS,
    LegAssessment,
    classify,
    evaluate_leg,
    is_fade_side,
    is_take_side,
)
from .market import (
    ANCHOR_LEG_THRESHOLD_AMERICAN,
    american_to_decimal,
    decimal_to_american,
    expected_value,
    joint_probability,
)
from .parlay import Relationship, classify_pair, correlation_findings

# The band a restructured ticket should land in.
TARGET_ODDS_MIN_AMERICAN: int = -135
TARGET_ODDS_MAX_AMERICAN: int = 110


def in_target_band(american: int) -> bool:
    """Whether a price sits in the risk-compensated band."""
    return TARGET_ODDS_MIN_AMERICAN <= american <= TARGET_ODDS_MAX_AMERICAN


@dataclass(slots=True)
class PrunedLeg:
    """A leg the optimizer removed, and the rule that removed it."""

    assessment: LegAssessment
    rule: str
    reason: str


@dataclass(slots=True)
class RestructureResult:
    """Everything the optimizer decided, before it becomes a Pydantic model."""

    kept: list[LegAssessment] = field(default_factory=list)
    pruned: list[PrunedLeg] = field(default_factory=list)
    sgp_groups: list[list[LegAssessment]] = field(default_factory=list)
    straights: list[LegAssessment] = field(default_factory=list)
    elevated: list[tuple[LegAssessment, WagerLeg]] = field(default_factory=list)


def _reject_anchor_legs(assessments: Sequence[LegAssessment]) -> tuple[list[LegAssessment], list[PrunedLeg]]:
    """Rule 1: drop legs so heavy they buy no price.

    The test is not merely "is this price heavy" but "what did it actually
    add". A -1600 leg multiplies the ticket by 1.0625 — six cents on the
    dollar — for a full extra chance to lose, which is why the threshold
    lives on the price rather than on the leg's own quality. A -1600 leg can
    be a 94% shot and still be the wrong thing to put on a ticket.
    """
    kept: list[LegAssessment] = []
    pruned: list[PrunedLeg] = []
    for item in assessments:
        price = item.leg.odds_american
        if price <= ANCHOR_LEG_THRESHOLD_AMERICAN:
            contribution = american_to_decimal(price)
            pruned.append(PrunedLeg(
                item,
                "DEAD_JUICE_ANCHOR",
                f"{item.leg.selection} at {price:+d} multiplies the ticket by only "
                f"{contribution:.4f} — {(contribution - 1) * 100:.1f}% of extra price for a full "
                "extra way to lose the ticket.",
            ))
        else:
            kept.append(item)
    return kept, pruned


def _prune_cannibalized(
    assessments: Sequence[LegAssessment],
) -> tuple[list[LegAssessment], list[PrunedLeg], list[tuple[LegAssessment, WagerLeg]]]:
    """Rule 2: drop volume props the ticket's own dominance suppresses.

    Returns the survivors, what was pruned, and any ELEVATION — the pruned
    leg's underlying read re-expressed as a straight outcome market, which is
    how the bettor's intent survives the pruning rather than being discarded
    with it.
    """
    findings = correlation_findings(list(assessments))
    cannibalized: set[str] = set()
    for finding in findings:
        if finding.kind is not Relationship.CANNIBALIZATION:
            continue
        # Drop the volume leg, keep whichever leg is the outcome market.
        for selection in finding.legs:
            match = next((a for a in assessments if a.leg.selection == selection), None)
            if match is None:
                continue
            metrics = match.leg.metrics or {}
            if metrics.get("volume_dependent") or str(match.leg.market_type).upper() == "PROP_MILESTONE":
                cannibalized.add(selection)

    kept: list[LegAssessment] = []
    pruned: list[PrunedLeg] = []
    elevated: list[tuple[LegAssessment, WagerLeg]] = []

    for item in assessments:
        if item.leg.selection not in cannibalized:
            kept.append(item)
            continue
        pruned.append(PrunedLeg(
            item,
            "VOLUME_DOMINANCE_CONFLICT",
            f"{item.leg.selection} needs volume that this same ticket's expected one-sided win "
            "suppresses. A routine straight-sets result is the best case for the outcome leg and "
            "the worst case for this one.",
        ))
        elevation = _elevate(item)
        if elevation is not None:
            elevated.append((item, elevation))

    return kept, pruned, elevated


def _elevate(item: LegAssessment) -> WagerLeg | None:
    """Re-express a cannibalized volume prop as the outcome market it implies.

    The bettor liked this competitor. The prop was the wrong instrument for
    that view given the rest of the ticket; the moneyline or set spread is
    the right one. `elevation_market` and `elevation_odds` are supplied by
    the caller because this package does not fetch prices — without them the
    intent is reported as un-elevatable rather than priced from thin air.
    """
    metrics = item.leg.metrics or {}
    market = metrics.get("elevation_market")
    price = metrics.get("elevation_odds_american")
    if market is None or price is None:
        return None
    return WagerLeg(
        event_id=item.leg.event_id,
        sport=item.leg.sport,
        matchup=item.leg.matchup,
        market_type=str(market),
        selection=f"{item.leg.subject} {metrics.get('elevation_label', 'ML')}",
        odds_american=int(price),
        sharp_fair_prob=metrics.get("elevation_fair_prob"),
        metrics={k: v for k, v in metrics.items() if not k.startswith("elevation_")},
    )


def _build_sgp_groups(assessments: Sequence[LegAssessment]) -> tuple[list[list[LegAssessment]], list[LegAssessment]]:
    """Rule 3a: group genuinely correlated same-competitor legs into SGPs."""
    groups: list[list[LegAssessment]] = []
    used: set[int] = set()

    for i, a in enumerate(assessments):
        if i in used:
            continue
        group = [a]
        for j, b in enumerate(assessments):
            if j <= i or j in used:
                continue
            if a.leg.event_id != b.leg.event_id:
                continue
            kind, _, _ = classify_pair(a, b)
            if kind is Relationship.SYNERGY:
                group.append(b)
                used.add(j)
        if len(group) > 1:
            used.add(i)
            groups.append(group)

    singles = [a for i, a in enumerate(assessments) if i not in used]
    return groups, singles


def sgp_price(group: Sequence[LegAssessment]) -> tuple[float, int]:
    """Correlation-adjusted price for a same-game parlay.

    This is the mathematical heart of the third rule. Naive multiplication
    treats the legs as independent, which for two legs on the same competitor
    is simply wrong: if Fritz is holding serve well enough to win a set, he is
    also serving enough to reach an ace milestone. The joint probability is
    materially higher than the product, so the fair price is materially
    SHORTER — which is exactly why a book quotes an SGP of two high-floor
    legs near -350 rather than the much longer price independence implies.

    Returns ``(decimal, american)`` at fair value; a book's own margin would
    sit on top of this.
    """
    probs = [a.fair_prob for a in group]
    if not probs:
        raise ValueError("an SGP needs legs")
    dominant_rho = 0.0
    for i, a in enumerate(group):
        for b in group[i + 1:]:
            kind, rho, _ = classify_pair(a, b)
            if kind is Relationship.SYNERGY and abs(rho) > abs(dominant_rho):
                dominant_rho = rho
    joint = joint_probability(probs, rho=dominant_rho)
    joint = min(max(joint, 1e-6), 0.999999)
    decimal = 1.0 / joint
    return decimal, decimal_to_american(decimal)


def optimize(slip: BetSlipInput, assessments: Sequence[LegAssessment]) -> OptimizationProposal | None:
    """Restructure a failing ticket into a counter-proposal.

    Returns ``None`` when there is nothing constructive to say — either the
    ticket was already fine, or pruning left too little to rebuild from.
    Returning a proposal in that second case would mean inventing legs the
    bettor never expressed any interest in, which is a different bet, not a
    restructuring of theirs.
    """
    result = RestructureResult()

    survivors, anchor_pruned = _reject_anchor_legs(assessments)
    result.pruned.extend(anchor_pruned)

    survivors, cannibal_pruned, elevated = _prune_cannibalized(survivors)
    result.pruned.extend(cannibal_pruned)
    result.elevated = elevated

    # Elevated legs re-enter the pool as real, gradeable wagers — but only
    # when the read they express is not ALREADY on the ticket.
    #
    # Found by running the Rublev/Fritz case study: pruning "Rublev 5+ Aces"
    # elevated it to a Rublev set spread, which then grouped with the
    # surviving Rublev moneyline into a same-competitor SGP. The result was a
    # second, redundant bet on a competitor the ticket already backed — which
    # is doubling down, not restructuring, and it pushed the ticket out of the
    # target band entirely. An elevation is a REPLACEMENT for a lost
    # expression of intent, so it is only warranted when that intent has no
    # surviving expression.
    covered_subjects = {
        a.leg.subject.lower() for a in survivors
        if str(a.leg.market_type).upper() in {"MONEYLINE", "SPREAD", "SET_SPREAD", "SET_WIN"}
    }
    redundant: list[tuple[LegAssessment, WagerLeg]] = []
    for original, replacement in elevated:
        if replacement.subject.lower() in covered_subjects:
            redundant.append((original, replacement))
            continue
        covered_subjects.add(replacement.subject.lower())
        survivors.append(evaluate_leg(replacement))
    result.elevated = [pair for pair in elevated if pair not in redundant]
    for original, _ in redundant:
        result.pruned.append(PrunedLeg(
            original,
            "REDUNDANT_ELEVATION",
            f"{original.leg.selection} was dropped as cannibalized, and the outcome market it "
            f"would elevate to is already covered by another surviving leg on {original.leg.subject}.",
        ))

    # Only legs that stand on their own belong in a rebuilt ticket. A
    # restructure that keeps a bad leg has not restructured anything.
    survivors = [a for a in survivors if not is_fade_side(a.verdict)]
    if len(survivors) < 2:
        return None

    groups, singles = _build_sgp_groups(survivors)
    result.sgp_groups = groups
    result.straights = singles

    components: list[RestructuredLeg] = []
    decimals: list[float] = []
    probs: list[float] = []

    for group in groups:
        decimal, american = sgp_price(group)
        decimals.append(decimal)
        probs.append(1.0 / decimal)
        components.append(RestructuredLeg(
            type="SGP",
            selection=" + ".join(a.leg.selection for a in group),
            odds_american=american,
            rationale=(
                f"Same-competitor legs priced with their correlation rather than multiplied as if "
                f"independent — high floor, and the joint probability is genuinely "
                f"{(1.0 / decimal) * 100:.1f}% rather than the "
                f"{joint_probability([a.fair_prob for a in group], 0.0) * 100:.1f}% independence implies."
            ),
        ))

    # Best straights first, so the ticket is built from strength.
    for single in sorted(singles, key=lambda a: (a.composite or 0.0), reverse=True):
        decimals.append(single.leg.odds_decimal or american_to_decimal(single.leg.odds_american))
        probs.append(single.fair_prob)
        components.append(RestructuredLeg(
            type="STRAIGHT",
            selection=single.leg.selection,
            odds_american=single.leg.odds_american,
            rationale=(
                f"Grades {single.composite:.0f}/100 with {single.ev * 100:+.2f}% expected value — "
                "strong enough to anchor the ticket on its own."
            ),
        ))

    if len(components) < 2:
        return None

    # Trim from the back (weakest first) until the price lands in the band.
    while len(components) > 2:
        combined = 1.0
        for d in decimals:
            combined *= d
        if decimal_to_american(combined) <= TARGET_ODDS_MAX_AMERICAN:
            break
        components.pop()
        decimals.pop()
        probs.pop()

    combined_decimal = 1.0
    for d in decimals:
        combined_decimal *= d
    target_american = decimal_to_american(combined_decimal)

    # Components are cross-event by construction (SGP groups collapse each
    # event to one component), so independence across components holds.
    proposal_joint = joint_probability(probs, rho=0.0)
    proposal_ev = expected_value(proposal_joint, combined_decimal)

    original_ev = _original_ev(slip, assessments)
    lift = (proposal_ev - original_ev) * 100.0

    proposal_score, _ = _proposal_score(assessments, survivors)
    verdict, _units = classify(proposal_score, proposal_ev, juice_flagged=False)

    return OptimizationProposal(
        verdict=verdict,
        composite_score=round(proposal_score, 2),
        target_odds_american=target_american,
        expected_value_lift=f"{lift:+.2f} percentage points"
                            + ("" if in_target_band(target_american)
                               else f" (note: {target_american:+d} sits outside the "
                                    f"{TARGET_ODDS_MIN_AMERICAN:+d} to {TARGET_ODDS_MAX_AMERICAN:+d} "
                                    "target band)"),
        restructured_legs=components,
        dropped_legs=_dropped_summary(result.pruned),
    )


def _dropped_summary(pruned: Sequence[PrunedLeg]) -> list[str]:
    """One line per dropped leg, merging every rule that fired on it.

    A leg can trip more than one rule — a cannibalized prop whose elevation
    is also redundant trips two — and listing it twice reads as two separate
    legs being removed, which misrepresents what happened to the ticket.
    """
    order: list[str] = []
    reasons: dict[str, list[str]] = {}
    for item in pruned:
        selection = item.assessment.leg.selection
        if selection not in reasons:
            order.append(selection)
            reasons[selection] = []
        reasons[selection].append(item.reason)
    return [f"{sel} — {' '.join(reasons[sel])}" for sel in order]


def _original_ev(slip: BetSlipInput, assessments: Sequence[LegAssessment]) -> float:
    """The offered ticket's expected value, for the lift comparison."""
    from .parlay import ticket_math

    math = ticket_math(assessments, slip.offered_odds_american or None)
    return math.ev if math else -1.0


def _proposal_score(
    original: Sequence[LegAssessment], survivors: Sequence[LegAssessment]
) -> tuple[float, float]:
    """Composite for the rebuilt ticket: its weakest surviving leg.

    A ticket is only as strong as the leg most likely to break it, and
    averaging would let one excellent leg paper over a marginal one — which
    is the exact failure mode that produced the original slip.
    """
    scored = [a.composite for a in survivors if a.composite is not None]
    if not scored:
        return 0.0, 0.0
    return min(scored), sum(scored) / len(scored)
