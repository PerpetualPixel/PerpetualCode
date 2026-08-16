"""Top-level orchestration: a slip in, a full `EvaluationResponse` out."""

from __future__ import annotations

from .core.engine import (
    LegAssessment, classify, evaluate_leg, is_fade_side, LEAN_PASS, NO_READ,
)
from .core.parlay import Relationship, correlation_findings, ticket_math
from .core.slip_optimizer import optimize
from .schemas import BetSlipInput, EvaluationResponse, LegEvaluation


def _leg_evaluation(a: LegAssessment) -> LegEvaluation:
    return LegEvaluation(
        selection=a.leg.selection,
        odds_american=a.leg.odds_american,
        verdict=a.verdict,
        composite_score=round(a.composite, 2) if a.composite is not None else 0.0,
        expected_value_pct=round(a.ev * 100.0, 3),
        fair_probability=round(a.fair_prob, 5),
        recommended_units=a.units,
        pillar_scores={
            name: (round(p.score, 2) if p.score is not None else None)
            for name, p in a.pillars.items()
        },
        coverage=round(a.coverage, 3),
        vulnerabilities=a.vulnerabilities,
        unavailable_factors=a.unavailable,
    )


def evaluate_slip(slip: BetSlipInput) -> EvaluationResponse:
    """Grade every leg, then the ticket, then restructure it if it failed.

    Per-leg grades are returned in EVERY case, including when the ticket as a
    whole is a strong fade. A parlay that dies on one bad leg still contains
    legs worth betting straight, and a verdict that discarded that detail
    would be actionable only as "don't" — the least useful true thing it
    could say.
    """
    assessments = [evaluate_leg(leg) for leg in slip.legs]
    leg_views = [_leg_evaluation(a) for a in assessments]

    findings = correlation_findings(assessments)
    math = ticket_math(assessments, slip.offered_odds_american or None)

    vulnerabilities: list[str] = []
    for a in assessments:
        vulnerabilities.extend(f"{a.leg.selection}: {v}" for v in a.vulnerabilities)
    vulnerabilities.extend(
        f"{f.kind.value.title()}: {f.explanation}"
        for f in findings
        if f.kind is not Relationship.SYNERGY
    )

    scored = [a.composite for a in assessments if a.composite is not None]
    if not scored:
        return EvaluationResponse(
            ticket_id=slip.ticket_id,
            original_verdict=NO_READ,
            composite_score=0.0,
            expected_value_pct=0.0,
            recommended_units=0.0,
            pillar_scores={},
            vulnerabilities=vulnerabilities,
            leg_evaluations=leg_views,
        )

    if len(assessments) == 1:
        ticket_score = scored[0]
    else:
        # A parlay is only as strong as its weakest leg — it needs all of
        # them. Averaging would let one excellent leg carry a fatal one.
        ticket_score = min(scored)

    ticket_ev = math.ev if math else assessments[0].ev
    if any(f.kind is Relationship.CONFLICT for f in findings):
        verdict, units = "STRONG FADE", 0.0
    else:
        verdict, units = classify(ticket_score, ticket_ev)

    # Pillar scores for the ticket are the weakest leg's, for the same
    # reason its composite is: that is the leg that decides the outcome.
    weakest = min(
        (a for a in assessments if a.composite is not None), key=lambda a: a.composite
    )
    pillar_scores = {
        name: (round(p.score, 2) if p.score is not None else None)
        for name, p in weakest.pillars.items()
    }

    proposal = None
    if is_fade_side(verdict) or verdict == LEAN_PASS:
        proposal = optimize(slip, assessments)

    return EvaluationResponse(
        ticket_id=slip.ticket_id,
        original_verdict=verdict,
        composite_score=round(ticket_score, 2),
        expected_value_pct=round(ticket_ev * 100.0, 3),
        recommended_units=units,
        pillar_scores=pillar_scores,
        vulnerabilities=vulnerabilities,
        leg_evaluations=leg_views,
        optimization_proposal=proposal,
    )
