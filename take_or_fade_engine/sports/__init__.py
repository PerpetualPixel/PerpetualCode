"""Per-sport matchup evaluators, dispatched on `WagerLeg.sport`."""

from __future__ import annotations

from .base import Factor, PillarResult, SportEvaluator, HIT_RATE_FLOOR
from .tennis import TennisEvaluator
from .basketball import BasketballEvaluator
from .baseball import BaseballEvaluator
from .football import FootballEvaluator
from .mma import MMAEvaluator

_EVALUATORS: dict[str, SportEvaluator] = {
    "TENNIS": TennisEvaluator(),
    "NBA": BasketballEvaluator(),
    "CBB": BasketballEvaluator(),
    "BASKETBALL": BasketballEvaluator(),
    "MLB": BaseballEvaluator(),
    "BASEBALL": BaseballEvaluator(),
    "NFL": FootballEvaluator(),
    "CFB": FootballEvaluator(),
    "FOOTBALL": FootballEvaluator(),
    "MMA": MMAEvaluator(),
    "UFC": MMAEvaluator(),
}

_GENERIC = SportEvaluator()


def evaluator_for(sport: str) -> SportEvaluator:
    """The evaluator for a sport key, or a generic one that scores nothing.

    A generic fall-through returns an unavailable matchup pillar rather than
    guessing, which is the correct behaviour for a sport this package has no
    model for.
    """
    return _EVALUATORS.get(str(sport or "").strip().upper(), _GENERIC)


__all__ = [
    "Factor", "PillarResult", "SportEvaluator", "HIT_RATE_FLOOR",
    "TennisEvaluator", "BasketballEvaluator", "BaseballEvaluator",
    "FootballEvaluator", "MMAEvaluator", "evaluator_for",
]
