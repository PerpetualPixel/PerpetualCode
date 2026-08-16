"""FastAPI endpoints and the CLI — the two interfaces the spec requires."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from take_or_fade_engine.app import app
from take_or_fade_engine.cli import main, parse_text_leg, slip_from_text, slips_from_csv

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
client = TestClient(app)


def _case_study() -> dict:
    return json.loads((EXAMPLES / "tennis_sgp_plus.json").read_text())


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

def test_health() -> None:
    assert client.get("/health").json() == {"status": "ok"}


def test_evaluate_slip_returns_the_full_response_shape() -> None:
    body = client.post("/evaluate/slip", json=_case_study()).json()
    assert body["ticket_id"] == "RUBLEV-FRITZ-SGP-PLUS"
    for key in (
        "original_verdict", "composite_score", "expected_value_pct",
        "recommended_units", "pillar_scores", "vulnerabilities",
        "leg_evaluations", "optimization_proposal",
    ):
        assert key in body


def test_evaluate_slip_carries_the_restructure_through_the_api() -> None:
    proposal = client.post("/evaluate/slip", json=_case_study()).json()["optimization_proposal"]
    assert proposal is not None
    assert proposal["target_odds_american"] == -118
    assert {c["type"] for c in proposal["restructured_legs"]} == {"SGP", "STRAIGHT"}


def test_evaluate_pick_grades_a_single_wager() -> None:
    leg = _case_study()["legs"][0]
    body = client.post("/evaluate/pick", json=leg).json()
    assert len(body["leg_evaluations"]) == 1
    assert body["leg_evaluations"][0]["selection"] == "Rublev ML"


def test_evaluate_slate_grades_each_ticket_independently() -> None:
    payload = {"slips": [_case_study(), json.loads((EXAMPLES / "nfl_spread.json").read_text())]}
    results = client.post("/evaluate/slate", json=payload).json()["results"]
    assert len(results) == 2
    assert {r["ticket_id"] for r in results} == {"RUBLEV-FRITZ-SGP-PLUS", "NFL-SPREAD-KEY-NUMBER"}


def test_empty_slate_is_rejected() -> None:
    assert client.post("/evaluate/slate", json={"slips": []}).status_code == 422


def test_optimize_endpoint_returns_a_proposal() -> None:
    body = client.post("/optimize/slip", json=_case_study()).json()
    assert body["target_odds_american"] == -118


def test_optimize_404s_rather_than_inventing_a_ticket() -> None:
    """Declining is a real answer; manufacturing legs would be a different bet."""
    thin = {
        "ticket_id": "thin", "slip_type": "PARLAY", "offered_odds_american": -200,
        "legs": [{
            "event_id": "e1", "sport": "TENNIS", "matchup": "A v B",
            "market_type": "MONEYLINE", "selection": "Only Leg", "odds_american": -300,
            "sharp_fair_prob": 0.60,
        }],
    }
    response = client.post("/optimize/slip", json=thin)
    assert response.status_code == 404
    assert "constructive" in response.json()["detail"]


def test_a_slip_with_no_legs_is_rejected_at_the_schema() -> None:
    bad = {"ticket_id": "x", "slip_type": "PARLAY", "offered_odds_american": -110, "legs": []}
    assert client.post("/evaluate/slip", json=bad).status_code == 422


def test_decimal_odds_are_derived_when_the_caller_omits_them() -> None:
    """Regression: a field validator does not fire on a defaulted field.

    Omitting odds_decimal left it at 0.0, which made every downstream price
    calculation refuse to compute and silently returned a null ticket price.
    """
    leg = dict(_case_study()["legs"][0])
    leg.pop("odds_decimal", None)
    body = client.post("/evaluate/pick", json=leg).json()
    assert body["expected_value_pct"] != 0.0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "line,selection,price",
    [
        ("Rublev ML -225", "Rublev ML", -225),
        ("Fritz 5+ Aces +110", "Fritz 5+ Aces", 110),
        ("Chiefs -3.5 (-110)", "Chiefs -3.5", -110),
    ],
)
def test_text_parsing_keeps_the_selection_and_reads_the_price(
    line: str, selection: str, price: int
) -> None:
    leg = parse_text_leg(line)
    assert leg is not None
    assert leg.selection == selection
    assert leg.odds_american == price


def test_a_line_with_no_price_is_rejected_rather_than_guessed() -> None:
    """A wager without a price cannot be graded, and inventing one is fabrication."""
    assert parse_text_leg("Rublev to win the tournament") is None


def test_text_slip_round_trips_through_evaluation() -> None:
    slip = slip_from_text("Rublev ML -225\nFritz 5+ Aces -190", sport="TENNIS")
    assert len(slip.legs) == 2
    assert client.post("/evaluate/slip", json=slip.model_dump()).status_code == 200


def test_text_with_nothing_priced_raises() -> None:
    with pytest.raises(ValueError):
        slip_from_text("no prices here at all")


def test_slate_csv_groups_by_ticket_and_maps_m_prefixed_metrics() -> None:
    slips = slips_from_csv(EXAMPLES / "slate.csv")
    assert {s.ticket_id for s in slips} == {"T1", "T2", "T3"}
    tennis = next(s for s in slips if s.ticket_id == "T1")
    assert tennis.legs[0].metrics["dominance_ratio"] == pytest.approx(1.31)
    assert tennis.legs[0].metrics["subject"] == "Sinner"


def test_cli_slate_mode_runs(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["slate", "--csv", str(EXAMPLES / "slate.csv"), "--no-colour"]) == 0
    out = capsys.readouterr().out
    assert "T1" in out and "T2" in out and "T3" in out


def test_cli_slip_mode_renders_the_restructure(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["slip", "--json", str(EXAMPLES / "tennis_sgp_plus.json"), "--no-colour"]) == 0
    out = capsys.readouterr().out
    assert "RESTRUCTURE" in out
    assert "-118" in out


def test_cli_raw_mode_emits_valid_json(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["slip", "--json", str(EXAMPLES / "nfl_spread.json"), "--raw"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload[0]["ticket_id"] == "NFL-SPREAD-KEY-NUMBER"
