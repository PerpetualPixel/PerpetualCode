"""De-vigging, EV and Kelly — the arithmetic everything else rests on."""

from __future__ import annotations

import math

import pytest

from take_or_fade_engine.core.market import (
    ANCHOR_LEG_THRESHOLD_AMERICAN,
    JUICE_THRESHOLD_AMERICAN,
    KELLY_FRACTION,
    MAX_STAKE_FRACTION,
    MIN_KELLY_FRACTION,
    american_to_decimal,
    assess_juice,
    decimal_to_american,
    devig_multiplicative,
    devig_power,
    expected_value,
    fair_probability,
    fractional_kelly,
    full_kelly,
    implied_probability,
    joint_probability,
    parlay_decimal,
)


# --------------------------------------------------------------------------
# Price conversion
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "american,decimal",
    [(-110, 1.909090909), (-150, 1.666666667), (100, 2.0), (-100, 2.0), (250, 3.5), (-1600, 1.0625)],
)
def test_american_to_decimal(american: int, decimal: float) -> None:
    assert american_to_decimal(american) == pytest.approx(decimal, abs=1e-9)


@pytest.mark.parametrize("american", [-1600, -400, -150, -110, 100, 150, 900])
def test_price_conversion_round_trips(american: int) -> None:
    assert decimal_to_american(american_to_decimal(american)) == american


def test_zero_is_not_a_price() -> None:
    with pytest.raises(ValueError):
        american_to_decimal(0)


def test_implied_probability_is_the_decimal_reciprocal() -> None:
    assert implied_probability(-150) == pytest.approx(0.6, abs=1e-9)
    assert implied_probability(100) == pytest.approx(0.5, abs=1e-9)


# --------------------------------------------------------------------------
# De-vigging
# --------------------------------------------------------------------------

def test_multiplicative_devig_sums_to_one() -> None:
    fair = devig_multiplicative([implied_probability(-110), implied_probability(-110)])
    assert sum(fair) == pytest.approx(1.0, abs=1e-12)


def test_multiplicative_devig_matches_the_specification_formula() -> None:
    """P_fair = P_1 / (P_1 + P_2), stated literally in the spec."""
    p1, p2 = implied_probability(-200), implied_probability(160)
    assert devig_multiplicative([p1, p2])[0] == pytest.approx(p1 / (p1 + p2), abs=1e-12)


def test_multiplicative_devig_preserves_the_ratio_between_outcomes() -> None:
    """Ratio preservation IS the multiplicative method — and its weakness."""
    p1, p2 = implied_probability(-400), implied_probability(300)
    fair = devig_multiplicative([p1, p2])
    assert fair[0] / fair[1] == pytest.approx(p1 / p2, abs=1e-12)


def test_symmetric_market_devigs_to_a_coin_flip_under_both_methods() -> None:
    implied = [implied_probability(-110), implied_probability(-110)]
    assert devig_multiplicative(implied)[0] == pytest.approx(0.5, abs=1e-12)
    assert devig_power(implied)[0] == pytest.approx(0.5, abs=1e-9)


def test_power_devig_corrects_favourite_longshot_bias() -> None:
    """The whole reason both methods exist.

    Books load more margin onto the longshot, so the proportional method
    overstates it. Power must assign the longshot a LOWER fair probability
    and the favourite a correspondingly higher one.
    """
    implied = [implied_probability(-400), implied_probability(300)]
    mult = devig_multiplicative(implied)
    power = devig_power(implied)
    assert power[1] < mult[1]
    assert power[0] > mult[0]
    assert sum(power) == pytest.approx(1.0, abs=1e-9)


def test_power_devig_actually_solves_its_constraint() -> None:
    implied = [implied_probability(-250), implied_probability(200)]
    fair = devig_power(implied)
    k = math.log(fair[0]) / math.log(implied[0])
    assert sum(p**k for p in implied) == pytest.approx(1.0, abs=1e-6)


def test_power_devig_falls_back_rather_than_extrapolating_an_underround() -> None:
    """An arbitrage quote sums below 1; the bracket cannot solve it."""
    implied = [0.40, 0.40]
    assert devig_power(implied) == pytest.approx(devig_multiplicative(implied))


def test_fair_probability_rejects_a_one_sided_market() -> None:
    with pytest.raises(ValueError):
        fair_probability([-110])


def test_fair_probability_honours_the_method_argument() -> None:
    pair = [-400, 300]
    assert fair_probability(pair, "power") != fair_probability(pair, "multiplicative")


# --------------------------------------------------------------------------
# EV and Kelly
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "prob,decimal,ev",
    [(0.55, 2.0, 0.10), (0.50, 2.0, 0.0), (0.45, 2.0, -0.10), (0.76, 1.444444444, 0.097777778)],
)
def test_expected_value(prob: float, decimal: float, ev: float) -> None:
    assert expected_value(prob, decimal) == pytest.approx(ev, abs=1e-8)


def test_full_kelly_matches_the_specification_formula() -> None:
    """f = (b*p - q) / b with b = decimal - 1."""
    p, decimal = 0.60, 2.0
    b, q = decimal - 1.0, 1.0 - p
    assert full_kelly(p, decimal) == pytest.approx((b * p - q) / b, abs=1e-12)


def test_fractional_kelly_is_exactly_a_quarter_of_full() -> None:
    assert KELLY_FRACTION == 0.25
    assert fractional_kelly(0.60, 2.0, cap=1.0) == pytest.approx(full_kelly(0.60, 2.0) * 0.25, abs=1e-12)
    assert fractional_kelly(0.60, 2.0, cap=1.0) == pytest.approx(0.05, abs=1e-12)


def test_fractional_kelly_respects_the_single_bet_cap() -> None:
    assert fractional_kelly(0.99, 5.0) == pytest.approx(MAX_STAKE_FRACTION)


def test_negative_edge_stakes_nothing_rather_than_a_negative_amount() -> None:
    assert full_kelly(0.40, 2.0) == 0.0
    assert fractional_kelly(0.40, 2.0) == 0.0


# --------------------------------------------------------------------------
# Dead juice
# --------------------------------------------------------------------------

@pytest.mark.parametrize("american", [JUICE_THRESHOLD_AMERICAN, -110, 100, 400])
def test_prices_at_or_better_than_the_threshold_are_never_flagged(american: int) -> None:
    assert assess_juice(american, 0.0).flagged is False


def test_juice_requirement_scales_with_how_much_worse_than_the_threshold() -> None:
    """Proportional edge is what Kelly already measures, not a second rule."""
    at_150 = assess_juice(-150, 0.0)
    at_300 = assess_juice(-300, 0.0)
    at_800 = assess_juice(-800, 0.0)
    assert at_150.required_kelly < at_300.required_kelly < at_800.required_kelly
    b_ref = american_to_decimal(JUICE_THRESHOLD_AMERICAN) - 1.0
    assert at_300.ratio == pytest.approx(b_ref / (american_to_decimal(-300) - 1.0), abs=1e-9)
    assert at_300.required_kelly == pytest.approx(MIN_KELLY_FRACTION * at_300.ratio, abs=1e-12)


def test_heavy_juice_with_a_real_edge_is_not_flagged() -> None:
    assert assess_juice(-300, 0.05).flagged is False


def test_heavy_juice_with_a_thin_edge_is_flagged() -> None:
    assert assess_juice(-300, MIN_KELLY_FRACTION).flagged is True


def test_anchor_threshold_is_where_a_leg_stops_buying_price() -> None:
    """A -1600 leg multiplies a ticket by 1.0625 — six cents for a full extra loss path."""
    assert american_to_decimal(ANCHOR_LEG_THRESHOLD_AMERICAN) == pytest.approx(1.2, abs=1e-9)
    assert american_to_decimal(-1600) == pytest.approx(1.0625, abs=1e-9)


# --------------------------------------------------------------------------
# Parlay maths
# --------------------------------------------------------------------------

def test_parlay_decimal_multiplies() -> None:
    assert parlay_decimal([1.5, 2.0, 1.25]) == pytest.approx(3.75, abs=1e-12)


def test_joint_probability_with_no_correlation_is_the_product() -> None:
    assert joint_probability([0.6, 0.5], rho=0.0) == pytest.approx(0.30, abs=1e-9)


def test_positive_correlation_raises_the_joint_above_the_product() -> None:
    """Legs that move together land together more often than independence says."""
    independent = joint_probability([0.85, 0.90], rho=0.0)
    correlated = joint_probability([0.85, 0.90], rho=0.35)
    assert correlated > independent
    expected = 0.85 * 0.90 + 0.35 * math.sqrt(0.85 * 0.15 * 0.90 * 0.10)
    assert correlated == pytest.approx(expected, abs=1e-9)


def test_negative_correlation_lowers_the_joint_below_the_product() -> None:
    """Cannibalized legs land together LESS often — the bettor is underpaid."""
    assert joint_probability([0.7, 0.7], rho=-0.25) < joint_probability([0.7, 0.7], rho=0.0)


def test_joint_probability_of_nothing_is_an_error_not_one() -> None:
    with pytest.raises(ValueError):
        joint_probability([])
