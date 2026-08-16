"""Sport-specific weighting, the scoring matrix, and the only-what's-real rule."""

from __future__ import annotations

import pytest

from take_or_fade_engine import BetSlipInput, WagerLeg, evaluate_slip
from take_or_fade_engine.core.engine import (
    CLASSIFICATION_BANDS,
    FADE,
    LEAN_PASS,
    MERIT_PILLARS,
    MODIFIER_PILLARS,
    MODIFIER_PILLAR_CEILING,
    NO_READ,
    PILLAR_WEIGHTS,
    STRONG_FADE,
    STRONG_TAKE,
    TAKE,
    classify,
    composite_score,
    evaluate_leg,
)
from take_or_fade_engine.sports import evaluator_for
from take_or_fade_engine.sports.base import HIT_RATE_FLOOR, PillarResult
from take_or_fade_engine.sports.football import FootballEvaluator


def leg(**kwargs) -> WagerLeg:
    base = dict(
        event_id="e1", sport="TENNIS", matchup="A v B", market_type="MONEYLINE",
        selection="A ML", odds_american=-150, sharp_fair_prob=0.70, metrics={},
    )
    base.update(kwargs)
    return WagerLeg(**base)


# --------------------------------------------------------------------------
# Weights and the classification matrix
# --------------------------------------------------------------------------

def test_pillar_weights_match_the_specification_and_sum_to_one() -> None:
    assert PILLAR_WEIGHTS == {
        "market": 0.30, "matchup": 0.25, "distribution": 0.20,
        "context": 0.15, "variance": 0.10,
    }
    assert sum(PILLAR_WEIGHTS.values()) == pytest.approx(1.0, abs=1e-12)


def test_classification_bands_match_the_specification() -> None:
    assert [(floor, verdict) for floor, verdict, _ in CLASSIFICATION_BANDS] == [
        (82.0, STRONG_TAKE), (68.0, TAKE), (52.0, LEAN_PASS), (35.0, FADE), (0.0, STRONG_FADE),
    ]


@pytest.mark.parametrize(
    "tps,expected",
    [(95.0, STRONG_TAKE), (82.0, STRONG_TAKE), (75.0, TAKE), (68.0, TAKE),
     (60.0, LEAN_PASS), (52.0, LEAN_PASS), (40.0, FADE), (35.0, FADE), (10.0, STRONG_FADE)],
)
def test_every_band_is_reachable(tps: float, expected: str) -> None:
    verdict, _ = classify(tps, ev=0.05)
    assert verdict == expected


def test_unit_sizing_follows_the_specification_ranges() -> None:
    _, top = classify(100.0, 0.10)
    _, bottom = classify(82.0, 0.10)
    assert 1.5 <= bottom <= top <= 2.0
    _, take_top = classify(81.9, 0.10)
    _, take_bottom = classify(68.0, 0.10)
    assert 0.75 <= take_bottom <= take_top <= 1.0
    assert classify(40.0, 0.10)[1] == 0.0


def test_negative_expected_value_is_never_a_take_at_any_score() -> None:
    for tps in (99.0, 85.0, 70.0):
        verdict, units = classify(tps, ev=-0.01)
        assert verdict in (FADE, STRONG_FADE)
        assert units == 0.0


def test_flagged_juice_cannot_reach_a_take_tier() -> None:
    assert classify(95.0, 0.05, juice_flagged=True)[0] == LEAN_PASS


def test_an_unscoreable_leg_is_no_read_rather_than_the_bottom_tier() -> None:
    assert classify(None, 0.05)[0] == NO_READ


# --------------------------------------------------------------------------
# Only what's real
# --------------------------------------------------------------------------

def p(score: float | None) -> PillarResult:
    return PillarResult(score, [], [])


def test_a_missing_pillar_is_not_scored_as_zero() -> None:
    everything = composite_score({k: p(80.0) for k in PILLAR_WEIGHTS})
    partial = composite_score({
        "market": p(80.0), "matchup": p(None), "distribution": p(None),
        "context": p(80.0), "variance": p(80.0),
    })
    assert everything[0] == pytest.approx(80.0, abs=1e-9)
    assert partial[0] == pytest.approx(80.0, abs=1e-9)


def test_coverage_reports_the_real_fraction_of_designed_weight() -> None:
    _, coverage = composite_score({
        "market": p(80.0), "matchup": p(None), "distribution": p(None),
        "context": p(80.0), "variance": p(80.0),
    })
    assert coverage == pytest.approx(
        PILLAR_WEIGHTS["market"] + PILLAR_WEIGHTS["context"] + PILLAR_WEIGHTS["variance"], abs=1e-9
    )


def test_missing_merit_weight_stays_within_merit() -> None:
    """The modifiers must not inherit merit weight.

    Uncorrected, context and variance would absorb 45% of the model whenever
    a sport has no matchup feed, letting a negative-expectation bet score
    well on a fresh line and a tight book spread alone.
    """
    good_market = composite_score({
        "market": p(100.0), "matchup": p(None), "distribution": p(None),
        "context": p(40.0), "variance": p(40.0),
    })[0]
    bad_market = composite_score({
        "market": p(0.0), "matchup": p(None), "distribution": p(None),
        "context": p(40.0), "variance": p(40.0),
    })[0]
    merit_share = sum(PILLAR_WEIGHTS[k] for k in MERIT_PILLARS)
    assert good_market - bad_market == pytest.approx(100.0 * merit_share, abs=1e-9)


def test_modifier_weight_crosses_over_only_when_no_merit_survives() -> None:
    score, _ = composite_score({
        "market": p(None), "matchup": p(None), "distribution": p(None),
        "context": p(60.0), "variance": p(60.0),
    })
    assert score == pytest.approx(60.0, abs=1e-9)


def test_nothing_scored_yields_none_rather_than_zero() -> None:
    assert composite_score({k: p(None) for k in PILLAR_WEIGHTS})[0] is None


def test_modifier_pillars_are_capped() -> None:
    assessment = evaluate_leg(leg(metrics={
        "subject": "A", "rest_days": 4, "travel_miles": 0,
        "game_script_stability": 1.0, "motivation_index": 1.0,
    }))
    for name in MODIFIER_PILLARS:
        score = assessment.pillars[name].score
        assert score is None or score <= MODIFIER_PILLAR_CEILING


def test_a_leg_with_no_sharp_benchmark_says_so_and_shows_no_edge() -> None:
    """A vigged price treated as fair would manufacture an edge of exactly the vig."""
    assessment = evaluate_leg(leg(sharp_fair_prob=None))
    assert assessment.ev == pytest.approx(0.0, abs=1e-12)
    assert any("sharp de-vigged benchmark" in u for u in assessment.unavailable)
    assert any("no sharp benchmark" in v.lower() for v in assessment.vulnerabilities)


# --------------------------------------------------------------------------
# Per-sport dispatch and factors
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "sport,name",
    [("TENNIS", "Tennis (singles)"), ("NBA", "Basketball"), ("CBB", "Basketball"),
     ("MLB", "Baseball"), ("NFL", "Football"), ("CFB", "Football"),
     ("UFC", "MMA"), ("MMA", "MMA"), ("CRICKET", "General")],
)
def test_sport_dispatch(sport: str, name: str) -> None:
    assert evaluator_for(sport).name == name


def test_an_unmodelled_sport_scores_nothing_rather_than_guessing() -> None:
    assert evaluator_for("CRICKET").matchup(leg(sport="CRICKET")).score is None


def test_missing_factors_are_named_not_silently_neutral() -> None:
    result = evaluator_for("MLB").matchup(leg(sport="MLB"))
    assert result.score is None
    assert any("arsenal" in u.lower() for u in result.unavailable)
    assert any("barrel" in u.lower() for u in result.unavailable)


def test_supplying_a_factor_activates_it_and_raises_coverage() -> None:
    bare = evaluate_leg(leg(sport="MLB", metrics={"subject": "P"}))
    fed = evaluate_leg(leg(sport="MLB", metrics={
        "subject": "P", "arsenal_vs_lineup_woba": 0.280, "lineup_wrc_plus": 88,
        "barrel_rate_allowed": 0.05, "park_weather_factor": 0.92,
        "bullpen_leverage_available": 3,
    }))
    assert bare.pillars["matchup"].score is None
    assert fed.pillars["matchup"].score is not None
    assert fed.coverage > bare.coverage


# --------------------------------------------------------------------------
# Sport-specific rules
# --------------------------------------------------------------------------

def test_tennis_fatigue_penalty_applies_past_two_and_a_half_hours() -> None:
    base = dict(subject="A", dominance_ratio=1.25, surface_win_pct=0.75)
    fresh = evaluator_for("TENNIS").matchup(leg(metrics={**base, "prior_round_hours": 1.5}))
    tired = evaluator_for("TENNIS").matchup(leg(metrics={**base, "prior_round_hours": 4.0}))
    assert tired.score < fresh.score
    assert any("fatigue" in s.lower() for s in tired.signals)


def test_tennis_fatigue_is_reported_missing_when_unknown() -> None:
    result = evaluator_for("TENNIS").matchup(leg(metrics={"subject": "A", "dominance_ratio": 1.2}))
    assert any("prior-round duration" in u for u in result.unavailable)


def test_basketball_blowout_discount_hits_counting_props_only() -> None:
    metrics = dict(subject="P", opp_playtype_def_rank=25, usage_reallocation=6.0,
                   pace_delta=3.0, minutes_trend=2.0, game_spread=-18.0)
    prop = evaluator_for("NBA").matchup(
        leg(sport="NBA", market_type="PROP_MILESTONE", metrics=metrics))
    moneyline = evaluator_for("NBA").matchup(leg(sport="NBA", market_type="MONEYLINE", metrics=metrics))
    assert prop.score < moneyline.score
    assert any("blowout" in s.lower() for s in prop.signals)


def test_mma_cardio_decay_penalises_a_fader() -> None:
    base = dict(subject="F", slpm_minus_sapm=1.5, takedown_defense_pct=0.8, control_time_share=0.6)
    strong = evaluator_for("MMA").matchup(leg(sport="MMA", metrics={**base, "round_output_decay": 0.95}))
    weak = evaluator_for("MMA").matchup(leg(sport="MMA", metrics={**base, "round_output_decay": 0.55}))
    assert weak.score < strong.score
    assert any("cardio" in s.lower() for s in weak.signals)


@pytest.mark.parametrize("point,expect_better", [(-2.5, True), (-3.5, False)])
def test_football_key_number_discipline(point: float, expect_better: bool) -> None:
    ev = FootballEvaluator()
    result = ev.key_number_discipline(
        leg(sport="NFL", market_type="SPREAD", metrics={"spread_point": point}))
    assert (result.score > 50.0) is expect_better


def test_football_exactly_on_a_key_number_warns_about_pushes() -> None:
    result = FootballEvaluator().key_number_discipline(
        leg(sport="NFL", market_type="SPREAD", metrics={"spread_point": -3.0}))
    assert any("pushes far more often" in s for s in result.signals)


def test_football_still_names_the_feeds_it_lacks() -> None:
    result = evaluator_for("NFL").matchup(
        leg(sport="NFL", market_type="SPREAD", metrics={"spread_point": -2.5}))
    assert any("EPA" in u for u in result.unavailable)


# --------------------------------------------------------------------------
# Distribution pillar: median vs mean
# --------------------------------------------------------------------------

def test_distribution_requires_the_specification_hit_rate() -> None:
    assert HIT_RATE_FLOOR == 0.65
    weak = evaluate_leg(leg(market_type="PROP_MILESTONE", metrics={
        "subject": "P", "milestone_line": 5, "recent_samples": [4, 3, 6, 2, 5, 3, 4, 2, 7, 3],
    }))
    assert any("below the 65% bar" in v for v in weak.vulnerabilities)


def test_distribution_flags_a_mean_carried_by_outliers() -> None:
    """Median-vs-mean is the point: a blowout game must not carry a leg."""
    result = evaluate_leg(leg(market_type="PROP_MILESTONE", metrics={
        "subject": "P", "milestone_line": 20,
        "recent_samples": [21, 19, 18, 22, 60, 17, 19, 21, 18, 20],
    }))
    assert any("outlier games" in s for s in result.pillars["distribution"].signals)


def test_distribution_is_unavailable_without_samples() -> None:
    result = evaluate_leg(leg(market_type="PROP_MILESTONE", metrics={"subject": "P"}))
    assert result.pillars["distribution"].score is None
    assert any("recent_samples" in u for u in result.unavailable)


# --------------------------------------------------------------------------
# Example configurations
# --------------------------------------------------------------------------

@pytest.mark.parametrize("filename", ["tennis_sgp_plus.json", "nba_player_prop.json", "nfl_spread.json"])
def test_shipped_examples_all_validate_and_evaluate(filename: str) -> None:
    import json
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "examples" / filename
    result = evaluate_slip(BetSlipInput(**json.loads(path.read_text())))
    assert result.leg_evaluations
    assert result.original_verdict in {STRONG_TAKE, TAKE, LEAN_PASS, FADE, STRONG_FADE, NO_READ}
