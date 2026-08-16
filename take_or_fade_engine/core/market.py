"""De-vigging, implied probability, expected value and Kelly sizing.

Every number that later pillars, the classifier and the slip optimizer rely
on originates here, so this module is deliberately the most heavily tested
in the package: an error in `devig_multiplicative` is not a local bug, it
silently biases every verdict the engine ever returns.

Conventions used throughout the package
---------------------------------------
* American odds are ``int``; decimal odds are ``float``.
* Probabilities are floats in ``(0, 1)``.
* "implied" means *with vig* — straight from a quoted price.
* "fair" means *de-vigged* — the overround removed.

The distinction matters more than it looks. Implied probabilities across a
two-way market sum to more than 1; the excess is the book's margin. Treating
an implied probability as if it were fair systematically overstates every
edge, which is precisely the error that makes a naive EV screen look
profitable on paper and lose money in practice.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np

# Quarter-Kelly. Full Kelly maximises long-run growth but only if the win
# probability going in is exactly right — which a de-vigged market consensus
# is a good estimate of, not a guarantee of. A fraction trades some growth
# for a far smoother ride, and is standard professional practice.
KELLY_FRACTION: float = 0.25

# Hard ceiling on any single wager as a fraction of bankroll, applied after
# the Kelly fraction. Protection against model error rather than a claim
# that the formula is wrong: a very thin market or a mispriced input can
# make full Kelly demand an absurd stake, and no single bet should be able
# to do that much damage.
MAX_STAKE_FRACTION: float = 0.05

# Price beyond which juice starts demanding proportionally more edge.
JUICE_THRESHOLD_AMERICAN: int = -125

# A leg at or heavier than this is an "anchor": it contributes almost no
# price to a ticket while contributing full correlation-free risk. See
# core/slip_optimizer.py's dead-juice rule.
ANCHOR_LEG_THRESHOLD_AMERICAN: int = -500


def american_to_decimal(american: int | float) -> float:
    """Convert American odds to decimal. ``-150 -> 1.6667``, ``+150 -> 2.5``."""
    value = float(american)
    if value == 0:
        raise ValueError("American odds of 0 are not a price")
    return 1.0 + (value / 100.0 if value > 0 else 100.0 / -value)


def decimal_to_american(decimal: float) -> int:
    """Convert decimal odds to American, rounding away from the 2.0 pivot."""
    if decimal <= 1.0:
        raise ValueError(f"decimal odds must exceed 1.0, got {decimal}")
    if decimal >= 2.0:
        return int(round((decimal - 1.0) * 100.0))
    return int(round(-100.0 / (decimal - 1.0)))


def implied_probability(american: int | float) -> float:
    """Implied (vigged) win probability of a quoted American price."""
    return 1.0 / american_to_decimal(american)


def devig_multiplicative(implied: Sequence[float]) -> list[float]:
    """Proportional de-vig: scale every implied probability so they sum to 1.

    This is the method named in the specification,
    ``P_fair = P_implied_1 / (P_implied_1 + P_implied_2)``, generalised to n
    outcomes. It preserves the *ratio* between outcomes exactly, which is
    both its defining property and its known weakness: books do not
    distribute margin proportionally, they load more of it onto the
    longshot, so this overstates a longshot's fair probability on a lopsided
    market. :func:`devig_power` is the correction, and both are provided so
    the caller can choose rather than inherit an unexamined default.
    """
    probs = np.asarray([float(p) for p in implied], dtype=float)
    if probs.size == 0 or np.any(probs <= 0) or not np.all(np.isfinite(probs)):
        raise ValueError("implied probabilities must all be finite and positive")
    return list(probs / probs.sum())


def devig_power(implied: Sequence[float], iterations: int = 80) -> list[float]:
    """Power de-vig: solve for ``k`` where ``sum(q_i ** k) == 1``.

    Because ``k > 1`` for an overround book, exponentiation shrinks a small
    probability by proportionally more than a large one — the empirically
    observed shape of how books distribute margin.

    Solved by bisection rather than Newton's method: ``sum(q_i ** k)`` is
    strictly decreasing in ``k`` over the bracket, so bisection cannot
    diverge or oscillate, and 80 halvings of ``[0.5, 10]`` resolve ``k`` to
    roughly 1e-23 — far past the precision any quoted price carries.
    """
    probs = np.asarray([float(p) for p in implied], dtype=float)
    if probs.size < 2 or np.any(probs <= 0) or np.any(probs >= 1):
        raise ValueError("power de-vig needs at least two probabilities in (0, 1)")

    def total(k: float) -> float:
        return float(np.sum(probs**k))

    lo, hi = 0.5, 10.0
    if total(lo) < 1.0:
        # Degenerate book (an underround / arbitrage quote). Fall back rather
        # than extrapolate the bracket, which would be inventing structure.
        return devig_multiplicative(probs)
    for _ in range(iterations):
        mid = (lo + hi) / 2.0
        if total(mid) > 1.0:
            lo = mid
        else:
            hi = mid
    out = probs ** ((lo + hi) / 2.0)
    return list(out / out.sum())  # renormalise away the final bisection residue


def fair_probability(
    american_pair: Sequence[int | float],
    method: str = "multiplicative",
) -> float:
    """Sharp fair probability of the FIRST outcome of a two-way market.

    Defaults to multiplicative because that is what the specification names
    for Pillar 1. Pass ``method="power"`` on a lopsided market where the
    favourite-longshot bias actually bites.
    """
    if len(american_pair) != 2:
        raise ValueError("a two-way market needs exactly two prices")
    implied = [implied_probability(a) for a in american_pair]
    fair = devig_power(implied) if method == "power" else devig_multiplicative(implied)
    return fair[0]


def expected_value(fair_prob: float, decimal_odds: float) -> float:
    """EV per unit staked: ``p_fair * decimal - 1``."""
    if decimal_odds <= 1.0:
        raise ValueError(f"decimal odds must exceed 1.0, got {decimal_odds}")
    return fair_prob * decimal_odds - 1.0


def full_kelly(fair_prob: float, decimal_odds: float) -> float:
    """Full Kelly fraction ``(b*p - q) / b``, floored at 0.

    Floored rather than allowed negative: a negative Kelly is the
    instruction to bet the other side, which is a different wager, not a
    negative stake on this one.
    """
    b = decimal_odds - 1.0
    if b <= 0 or not 0.0 < fair_prob < 1.0:
        return 0.0
    return max(0.0, (b * fair_prob - (1.0 - fair_prob)) / b)


def fractional_kelly(
    fair_prob: float,
    decimal_odds: float,
    fraction: float = KELLY_FRACTION,
    cap: float = MAX_STAKE_FRACTION,
) -> float:
    """Conservative staking fraction: ``0.25 * full Kelly``, capped."""
    return min(full_kelly(fair_prob, decimal_odds) * fraction, cap)


@dataclass(frozen=True, slots=True)
class JuiceAssessment:
    """Whether a price charges more juice than its edge justifies."""

    flagged: bool
    required_kelly: float
    actual_kelly: float
    ratio: float

    @property
    def shortfall(self) -> float:
        return max(0.0, self.required_kelly - self.actual_kelly)


# Minimum quarter-Kelly fraction below which a stake is a rounding error
# rather than a bet.
MIN_KELLY_FRACTION: float = 0.0025


def assess_juice(american: int | float, kelly: float) -> JuiceAssessment:
    """Dead-juice check, scaled by how much worse than -125 the price is.

    "Proportional edge" is not a second heuristic sitting beside Kelly — it
    is exactly what Kelly measures. At -125 you risk 1.25 to win 1; at -300
    you risk 3. The same win probability therefore supports a much smaller
    fraction of bankroll as the price gets heavier, so the required edge
    scales with ``b(-125) / b(price)``: 1.0x at -125, 2.4x at -300, 6.4x at
    -800.
    """
    price = float(american)
    if price >= JUICE_THRESHOLD_AMERICAN:
        return JuiceAssessment(False, MIN_KELLY_FRACTION, kelly, 1.0)
    b_ref = american_to_decimal(JUICE_THRESHOLD_AMERICAN) - 1.0
    b = american_to_decimal(price) - 1.0
    ratio = max(1.0, b_ref / b) if b > 0 else float("inf")
    required = MIN_KELLY_FRACTION * ratio
    return JuiceAssessment(kelly < required, required, kelly, ratio)


def parlay_decimal(decimals: Iterable[float]) -> float:
    """Combined decimal price of independent legs."""
    combined = 1.0
    for d in decimals:
        if d <= 1.0:
            raise ValueError(f"decimal odds must exceed 1.0, got {d}")
        combined *= d
    return combined


def joint_probability(probs: Sequence[float], rho: float = 0.0) -> float:
    """Joint probability of legs landing together, adjusted for correlation.

    For two correlated binary events the exact expression is

        P(A and B) = p_a * p_b + rho * sqrt(p_a*(1-p_a) * p_b*(1-p_b))

    which is applied pairwise and chained for longer tickets. That chaining
    is an approximation for n > 2 — the exact joint needs the full
    correlation matrix, which nothing in this package claims to have — but
    it is the right approximation, because it moves the answer in the
    correct direction with the correct magnitude for the dominant pair.

    ``rho = 0`` recovers plain independence, which is what an ordinary
    cross-game parlay is.
    """
    if not probs:
        raise ValueError("joint probability of no legs is undefined")
    joint = float(probs[0])
    for p in probs[1:]:
        p = float(p)
        adjusted = joint * p + rho * float(np.sqrt(joint * (1 - joint) * p * (1 - p)))
        joint = float(np.clip(adjusted, 1e-9, 1 - 1e-9))
    return joint
