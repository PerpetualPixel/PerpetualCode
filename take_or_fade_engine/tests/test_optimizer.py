"""Ticket Restructuring Engine, including the Rublev/Fritz case study."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from take_or_fade_engine import BetSlipInput, WagerLeg, evaluate_slip
from take_or_fade_engine.core.engine import (
    STRONG_TAKE, TAKE, evaluate_leg, is_fade_side, is_take_side,
)
from take_or_fade_engine.core.market import ANCHOR_LEG_THRESHOLD_AMERICAN, american_to_decimal
from take_or_fade_engine.core.parlay import Relationship, correlation_findings
from take_or_fade_engine.core.slip_optimizer import (
    TARGET_ODDS_MAX_AMERICAN, TARGET_ODDS_MIN_AMERICAN, in_target_band, optimize, sgp_price,
)

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


def leg(**kwargs) -> WagerLeg:
    base = dict(
        event_id="e1", sport="TENNIS", matchup="A v B",
        market_type="MONEYLINE", selection="A ML", odds_american=-150,
        sharp_fair_prob=0.70, metrics={},
    )
    base.update(kwargs)
    return WagerLeg(**base)


# --------------------------------------------------------------------------
# Rule 1 — dead-juice anchor rejection
# --------------------------------------------------------------------------

def test_anchor_leg_is_rejected() -> None:
    slip = BetSlipInput(
        ticket_id="anchor", slip_type="PARLAY", offered_odds_american=-189,
        legs=[
            leg(selection="Favourite ML", odds_american=-225, sharp_fair_prob=0.78,
                metrics={"subject": "Favourite"}),
            leg(event_id="e2", selection="Anchor to win a set", odds_american=-1600,
                market_type="SET_WIN", sharp_fair_prob=0.955, metrics={"subject": "Anchor"}),
            leg(event_id="e3", selection="Third ML", odds_american=-140, sharp_fair_prob=0.72,
                metrics={"subject": "Third"}),
        ],
    )
    proposal = optimize(slip, [evaluate_leg(l) for l in slip.legs])
    assert proposal is not None
    assert not any("Anchor" in c.selection for c in proposal.restructured_legs)
    assert any("Anchor to win a set" in d for d in proposal.dropped_legs)


def test_the_anchor_rule_is_about_price_bought_not_leg_quality() -> None:
    """A -1600 leg can be a 95% shot and still be wrong to put on a ticket."""
    assessment = evaluate_leg(leg(odds_american=-1600, sharp_fair_prob=0.96,
                                  metrics={"subject": "X"}))
    assert assessment.ev > 0, "the leg itself is genuinely +EV"
    assert american_to_decimal(ANCHOR_LEG_THRESHOLD_AMERICAN) == pytest.approx(1.2)
    assert any("Anchor leg" in v for v in assessment.vulnerabilities)


# --------------------------------------------------------------------------
# Rule 2 — volume vs dominance cannibalization
# --------------------------------------------------------------------------

def _cannibal_slip() -> BetSlipInput:
    return BetSlipInput(
        ticket_id="cannibal", slip_type="SGP", offered_odds_american=-150,
        legs=[
            leg(selection="Rublev ML", odds_american=-225, sharp_fair_prob=0.78,
                metrics={"subject": "Rublev"}),
            leg(selection="Rublev 5+ Aces", odds_american=-140, market_type="PROP_MILESTONE",
                sharp_fair_prob=0.52,
                metrics={"subject": "Rublev", "volume_dependent": True,
                         "game_dominance_expected": True}),
            leg(event_id="e2", selection="Other ML", odds_american=-160, sharp_fair_prob=0.74,
                metrics={"subject": "Other"}),
        ],
    )


def test_volume_prop_squeezed_by_expected_dominance_is_detected() -> None:
    assessments = [evaluate_leg(l) for l in _cannibal_slip().legs]
    findings = correlation_findings(assessments)
    cannibal = [f for f in findings if f.kind is Relationship.CANNIBALIZATION]
    assert cannibal, "a routine straight-sets win is the shortest match for an ace prop"
    assert "Rublev 5+ Aces" in cannibal[0].explanation


def test_cannibalized_volume_prop_is_pruned_from_the_restructure() -> None:
    slip = _cannibal_slip()
    proposal = optimize(slip, [evaluate_leg(l) for l in slip.legs])
    assert proposal is not None
    assert not any("Aces" in c.selection for c in proposal.restructured_legs)
    assert any("Rublev 5+ Aces" in d for d in proposal.dropped_legs)


def test_a_volume_prop_with_no_expected_dominance_is_synergy_not_cannibalization() -> None:
    """The rule keys on the SHAPE of the game, not on the market type."""
    assessments = [
        evaluate_leg(leg(selection="Player ML", odds_american=-150, metrics={"subject": "Player"})),
        evaluate_leg(leg(selection="Player 5+ Aces", odds_american=-130,
                         market_type="PROP_MILESTONE", metrics={"subject": "Player"})),
    ]
    kinds = {f.kind for f in correlation_findings(assessments)}
    assert Relationship.CANNIBALIZATION not in kinds
    assert Relationship.SYNERGY in kinds


def test_elevation_is_suppressed_when_the_read_already_survives() -> None:
    """Elevating onto a competitor the ticket already backs is doubling down.

    Found by running the case study: pruning "Rublev 5+ Aces" elevated it to
    a Rublev set spread, which then grouped with the surviving Rublev
    moneyline into a redundant same-competitor SGP and pushed the ticket out
    of the target band.
    """
    slip = BetSlipInput(
        ticket_id="elev", slip_type="SGP", offered_odds_american=-150,
        legs=[
            leg(selection="Rublev ML", odds_american=-225, sharp_fair_prob=0.78,
                metrics={"subject": "Rublev"}),
            leg(selection="Rublev 5+ Aces", odds_american=-140, market_type="PROP_MILESTONE",
                sharp_fair_prob=0.52,
                metrics={"subject": "Rublev", "volume_dependent": True,
                         "game_dominance_expected": True,
                         "elevation_market": "SET_SPREAD", "elevation_label": "-1.5 sets",
                         "elevation_odds_american": -130, "elevation_fair_prob": 0.62}),
            leg(event_id="e2", selection="Fritz ML", odds_american=-160, sharp_fair_prob=0.74,
                metrics={"subject": "Fritz"}),
        ],
    )
    proposal = optimize(slip, [evaluate_leg(l) for l in slip.legs])
    assert proposal is not None
    rublev_components = [c for c in proposal.restructured_legs if "Rublev" in c.selection]
    assert len(rublev_components) == 1, "one expression of the Rublev read, not two"
    assert "-1.5 sets" not in rublev_components[0].selection


# --------------------------------------------------------------------------
# Rule 3 — correlation-priced SGP synthesis
# --------------------------------------------------------------------------

def test_sgp_is_priced_with_correlation_not_naive_multiplication() -> None:
    """This is why an SGP of two high-floor legs lands near -350.

    If Fritz is holding serve well enough to win a set, he is also serving
    enough to reach an ace milestone. Multiplying the two prices as if
    independent produces a materially longer price than the joint
    probability supports.
    """
    group = [
        evaluate_leg(leg(selection="Fritz 5+ Aces", market_type="PROP_MILESTONE",
                         odds_american=-190, sharp_fair_prob=0.84,
                         metrics={"subject": "Fritz"})),
        evaluate_leg(leg(selection="Fritz to Win a Set", market_type="SET_WIN",
                         odds_american=-260, sharp_fair_prob=0.88,
                         metrics={"subject": "Fritz"})),
    ]
    decimal, american = sgp_price(group)
    naive = 0.84 * 0.88
    assert 1.0 / decimal > naive, "correlation must raise the joint probability"
    assert american < -300, f"a high-floor correlated pair should price short, got {american}"


def test_sgp_grouping_only_fires_within_one_event() -> None:
    group_a = evaluate_leg(leg(event_id="e1", selection="X 5+ Aces",
                               market_type="PROP_MILESTONE", metrics={"subject": "X"}))
    group_b = evaluate_leg(leg(event_id="e2", selection="X to Win a Set",
                               market_type="SET_WIN", metrics={"subject": "X"}))
    assert correlation_findings([group_a, group_b]) == []


# --------------------------------------------------------------------------
# The case study
# --------------------------------------------------------------------------

def _case_study() -> BetSlipInput:
    return BetSlipInput(**json.loads((EXAMPLES / "tennis_sgp_plus.json").read_text()))


def test_case_study_original_slip_is_a_fade() -> None:
    result = evaluate_slip(_case_study())
    assert is_fade_side(result.original_verdict), result.original_verdict
    assert result.recommended_units == 0.0


def test_case_study_names_every_point_of_failure() -> None:
    result = evaluate_slip(_case_study())
    joined = " | ".join(result.vulnerabilities)
    assert "Anchor leg at -1600" in joined
    assert "Hit rate 30%" in joined
    assert "Volume-dependent prop" in joined
    assert "Cannibalization" in joined


def test_case_study_restructures_to_a_minus_118_hybrid_take() -> None:
    """The specification's headline case, end to end.

    A -150 SGP+ carrying a -1600 anchor and a cannibalized ace prop is
    diagnosed, pruned, and rebuilt as a correlation-priced Fritz SGP paired
    with the Rublev moneyline at -118 — inside the target band, and a take
    rather than a fade.
    """
    result = evaluate_slip(_case_study())
    proposal = result.optimization_proposal
    assert proposal is not None, "a failing ticket must get a counter-proposal"

    assert proposal.target_odds_american == -118
    assert in_target_band(proposal.target_odds_american)
    assert is_take_side(proposal.verdict), proposal.verdict

    kinds = {c.type for c in proposal.restructured_legs}
    assert kinds == {"SGP", "STRAIGHT"}, "the output is a hybrid ticket, not one or the other"

    sgp = next(c for c in proposal.restructured_legs if c.type == "SGP")
    straight = next(c for c in proposal.restructured_legs if c.type == "STRAIGHT")
    assert "Fritz 5+ Aces" in sgp.selection and "Fritz to Win a Set" in sgp.selection
    assert sgp.odds_american < -300
    assert straight.selection == "Rublev ML"
    assert straight.odds_american == -225

    dropped = " | ".join(proposal.dropped_legs)
    assert "Rublev to win at least one set" in dropped
    assert "Rublev 5+ Aces" in dropped


def test_case_study_reports_a_positive_expected_value_lift() -> None:
    proposal = evaluate_slip(_case_study()).optimization_proposal
    assert proposal is not None
    assert proposal.expected_value_lift.startswith("+")


def test_case_study_grades_every_leg_individually_even_though_the_ticket_fades() -> None:
    """A fading ticket still contains legs worth betting straight."""
    result = evaluate_slip(_case_study())
    assert len(result.leg_evaluations) == 5
    takes = [l for l in result.leg_evaluations if is_take_side(l.verdict)]
    fades = [l for l in result.leg_evaluations if is_fade_side(l.verdict)]
    assert takes and fades, "the ticket is mixed, and the per-leg detail must show it"
    assert any(l.selection == "Rublev 5+ Aces" for l in fades)
    assert any(l.selection == "Fritz 5+ Aces" for l in takes)


def test_every_dropped_leg_is_listed_once_with_all_its_reasons_merged() -> None:
    proposal = evaluate_slip(_case_study()).optimization_proposal
    assert proposal is not None
    selections = [d.split(" — ")[0] for d in proposal.dropped_legs]
    assert len(selections) == len(set(selections)), "a leg tripping two rules is still one leg"


# --------------------------------------------------------------------------
# Declining to propose
# --------------------------------------------------------------------------

def test_optimizer_declines_rather_than_inventing_legs() -> None:
    """Pruning can leave too little to rebuild from, and that is a real answer."""
    slip = BetSlipInput(
        ticket_id="thin", slip_type="PARLAY", offered_odds_american=-200,
        legs=[
            leg(selection="Bad One", odds_american=-300, sharp_fair_prob=0.60,
                metrics={"subject": "One"}),
            leg(event_id="e2", selection="Bad Two", odds_american=-250, sharp_fair_prob=0.55,
                metrics={"subject": "Two"}),
        ],
    )
    assert optimize(slip, [evaluate_leg(l) for l in slip.legs]) is None


def test_target_band_bounds_match_the_specification() -> None:
    assert (TARGET_ODDS_MIN_AMERICAN, TARGET_ODDS_MAX_AMERICAN) == (-135, 110)
    assert in_target_band(-118) and in_target_band(-135) and in_target_band(110)
    assert not in_target_band(-150) and not in_target_band(136)
