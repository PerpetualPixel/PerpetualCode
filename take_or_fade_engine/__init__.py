"""TakeOrFadeEngine — quantitative sports betting decision engine and slip optimizer."""

from __future__ import annotations

from .evaluate import evaluate_slip
from .schemas import (
    BetSlipInput, EvaluationResponse, LegEvaluation, OptimizationProposal,
    RestructuredLeg, WagerLeg,
)

__version__ = "1.0.0"
__all__ = [
    "evaluate_slip", "BetSlipInput", "EvaluationResponse", "LegEvaluation",
    "OptimizationProposal", "RestructuredLeg", "WagerLeg", "__version__",
]
