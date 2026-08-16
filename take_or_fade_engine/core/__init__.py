"""Core quantitative layer: market maths, pillar scoring, correlation, restructuring."""

from __future__ import annotations

from .engine import (
    CLASSIFICATION_BANDS, FADE, LEAN_PASS, NO_READ, PILLAR_WEIGHTS, STRONG_FADE,
    STRONG_TAKE, TAKE, LegAssessment, classify, composite_score, evaluate_leg,
    is_fade_side, is_take_side,
)
from .market import (
    KELLY_FRACTION, american_to_decimal, assess_juice, decimal_to_american,
    devig_multiplicative, devig_power, expected_value, fair_probability,
    fractional_kelly, full_kelly, implied_probability, joint_probability, parlay_decimal,
)
from .parlay import CorrelationFinding, Relationship, correlation_findings, ticket_math
from .slip_optimizer import in_target_band, optimize, sgp_price

__all__ = [
    "CLASSIFICATION_BANDS", "FADE", "LEAN_PASS", "NO_READ", "PILLAR_WEIGHTS",
    "STRONG_FADE", "STRONG_TAKE", "TAKE", "LegAssessment", "classify",
    "composite_score", "evaluate_leg", "is_fade_side", "is_take_side",
    "KELLY_FRACTION", "american_to_decimal", "assess_juice", "decimal_to_american",
    "devig_multiplicative", "devig_power", "expected_value", "fair_probability",
    "fractional_kelly", "full_kelly", "implied_probability", "joint_probability",
    "parlay_decimal", "CorrelationFinding", "Relationship", "correlation_findings",
    "ticket_math", "in_target_band", "optimize", "sgp_price",
]
