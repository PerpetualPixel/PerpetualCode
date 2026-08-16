"""Correlation, synergy and cannibalization across the legs of one ticket.

The honest limit, stated up front because it governs how everything here
should be read: without a fitted correlation coefficient the TRUE joint
probability of correlated legs is not computable from prices alone. What
this module does is identify the DIRECTION in which naive parlay
multiplication is wrong, and by roughly how much. That is the actionable
part — a synergy means the real number is higher than the multiplication
says and the book is not paying you for it; a conflict or a cannibalization
means it is lower and you are being paid too little for the risk.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from itertools import combinations
from typing import Sequence

from .engine import LegAssessment
from .market import joint_probability

# Correlation coefficients applied by relationship type. Deliberately modest:
# these move a joint probability by a few points, which is the right order of
# magnitude for "the book's price is a little wrong", not a claim to have
# modelled the dependence structure exactly.
RHO_SAME_SUBJECT_SYNERGY: float = 0.35
RHO_SAME_GAME_SAME_SIDE: float = 0.22
RHO_CANNIBALIZATION: float = -0.25


class Relationship(str, Enum):
    SYNERGY = "SYNERGY"
    CONFLICT = "CONFLICT"
    CANNIBALIZATION = "CANNIBALIZATION"
    INDEPENDENT = "INDEPENDENT"


@dataclass(slots=True)
class CorrelationFinding:
    kind: Relationship
    event_id: str
    legs: tuple[str, str]
    rho: float
    explanation: str


def _subject(assessment: LegAssessment) -> str:
    return assessment.leg.subject.lower()


def _is_volume_prop(assessment: LegAssessment) -> bool:
    market = str(assessment.leg.market_type).upper()
    return market in {"PROP_MILESTONE", "TOTAL"} or bool(
        (assessment.leg.metrics or {}).get("volume_dependent")
    )


def _is_outcome_market(assessment: LegAssessment) -> bool:
    return str(assessment.leg.market_type).upper() in {
        "MONEYLINE", "SPREAD", "SET_SPREAD", "SET_WIN",
    }


def classify_pair(a: LegAssessment, b: LegAssessment) -> tuple[Relationship, float, str]:
    """How two legs on the same event relate."""
    a_subject, b_subject = _subject(a), _subject(b)
    same_subject = a_subject == b_subject

    if _is_outcome_market(a) and _is_outcome_market(b) and not same_subject:
        return (
            Relationship.CONFLICT,
            0.0,
            f"'{a.leg.selection}' and '{b.leg.selection}' are opposing outcomes in the same event. "
            "They cannot both land in the way this ticket needs.",
        )

    if same_subject and _is_outcome_market(a) != _is_outcome_market(b):
        # One outcome market and one prop on the SAME player. Whether that is
        # synergy or cannibalization depends on the prop: a milestone the
        # player reaches by playing well is synergistic, but a VOLUME prop
        # can be squeezed by the very dominance the outcome leg needs.
        volume_leg = a if _is_volume_prop(a) else b
        outcome_leg = b if _is_volume_prop(a) else a
        if (volume_leg.leg.metrics or {}).get("game_dominance_expected"):
            return (
                Relationship.CANNIBALIZATION,
                RHO_CANNIBALIZATION,
                f"'{volume_leg.leg.selection}' needs volume that '{outcome_leg.leg.selection}' "
                "actively suppresses — a routine, one-sided win is the shortest path to the "
                "outcome leg and the shortest match for the volume leg.",
            )
        return (
            Relationship.SYNERGY,
            RHO_SAME_SUBJECT_SYNERGY,
            f"'{a.leg.selection}' and '{b.leg.selection}' are the same competitor performing well "
            "in the same event — genuinely correlated, so the true joint probability is higher "
            "than multiplying the two prices suggests.",
        )

    if same_subject:
        return (
            Relationship.SYNERGY,
            RHO_SAME_SUBJECT_SYNERGY,
            f"'{a.leg.selection}' and '{b.leg.selection}' both depend on the same competitor's "
            "performance in the same event.",
        )

    if _is_volume_prop(a) and _is_volume_prop(b):
        return (
            Relationship.CANNIBALIZATION,
            RHO_CANNIBALIZATION,
            f"'{a.leg.selection}' and '{b.leg.selection}' draw on the same finite pool of "
            "possessions or points. One competitor's big night comes partly out of the other's.",
        )

    return (
        Relationship.SYNERGY,
        RHO_SAME_GAME_SAME_SIDE,
        f"'{a.leg.selection}' and '{b.leg.selection}' share a game script.",
    )


def correlation_findings(assessments: Sequence[LegAssessment]) -> list[CorrelationFinding]:
    """Every non-independent pairing on the ticket."""
    by_event: dict[str, list[LegAssessment]] = {}
    for item in assessments:
        by_event.setdefault(item.leg.event_id, []).append(item)

    findings: list[CorrelationFinding] = []
    for event_id, group in by_event.items():
        for a, b in combinations(group, 2):
            kind, rho, explanation = classify_pair(a, b)
            if kind is Relationship.INDEPENDENT:
                continue
            findings.append(
                CorrelationFinding(kind, event_id, (a.leg.selection, b.leg.selection), rho, explanation)
            )
    return findings


@dataclass(slots=True)
class TicketMath:
    """The ticket's own numbers, independent and correlation-adjusted."""

    naive_joint: float
    adjusted_joint: float
    combined_decimal: float
    combined_american: int
    fair_american: int
    ev: float
    kelly: float
    leg_count: int


def ticket_math(assessments: Sequence[LegAssessment], offered_american: int | None = None) -> TicketMath | None:
    """Price and probability for a whole ticket.

    ``naive_joint`` multiplies the legs as if independent; ``adjusted_joint``
    applies the dominant pairwise correlation. Both are returned rather than
    only the adjusted one, so the size of the correction is visible instead
    of being folded silently into a single number.
    """
    from .market import (
        american_to_decimal, decimal_to_american, expected_value, fractional_kelly, parlay_decimal,
    )

    if not assessments:
        return None

    probs = [a.fair_prob for a in assessments]
    decimals = [a.leg.odds_decimal or 0.0 for a in assessments]
    if any(d <= 1.0 for d in decimals):
        return None

    naive = joint_probability(probs, rho=0.0)

    findings = correlation_findings(assessments)
    if any(f.kind is Relationship.CONFLICT for f in findings):
        # Opposing outcomes cannot co-occur. Reporting a small positive
        # number here would dignify a ticket that literally cannot win.
        adjusted = 0.0
    elif findings:
        dominant = max(findings, key=lambda f: abs(f.rho))
        adjusted = joint_probability(probs, rho=dominant.rho)
    else:
        adjusted = naive

    combined_decimal = parlay_decimal(decimals)
    offered_decimal = american_to_decimal(offered_american) if offered_american else combined_decimal
    ev = expected_value(adjusted, offered_decimal) if adjusted > 0 else -1.0
    kelly = fractional_kelly(adjusted, offered_decimal) if adjusted > 0 else 0.0

    return TicketMath(
        naive_joint=naive,
        adjusted_joint=adjusted,
        combined_decimal=combined_decimal,
        combined_american=decimal_to_american(combined_decimal),
        fair_american=decimal_to_american(1.0 / adjusted) if adjusted > 0 else 0,
        ev=ev,
        kelly=kelly,
        leg_count=len(assessments),
    )
