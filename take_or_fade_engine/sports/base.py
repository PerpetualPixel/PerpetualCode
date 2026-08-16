"""Shared shape for every sport evaluator.

A `PillarResult` carries three things, and the third is what keeps this
package honest: `unavailable` names the factors the evaluator could NOT
compute for this leg. Those names propagate all the way to the API response.

The alternative — scoring a missing factor at a neutral midpoint — makes
"no arsenal data for this pitcher" indistinguishable in the output from "the
arsenal matchup is average". A caller cannot act differently on those two,
which means the number is worse than useless: it is confident and wrong.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

import numpy as np


@dataclass(slots=True)
class PillarResult:
    """A pillar's 0-100 score, its evidence, and what it could not see."""

    score: float | None
    signals: list[str] = field(default_factory=list)
    unavailable: list[str] = field(default_factory=list)

    @property
    def available(self) -> bool:
        return self.score is not None


def norm100(value: float | None, lo: float, hi: float) -> float | None:
    """Map `value` from [lo, hi] onto 0-100, clamped. None passes through."""
    if value is None or not np.isfinite(value):
        return None
    return float(np.clip((value - lo) / (hi - lo) * 100.0, 0.0, 100.0))


def blend(parts: list[tuple[float, float]]) -> float | None:
    """Weighted mean of (score, weight) pairs, renormalised over what exists."""
    live = [(s, w) for s, w in parts if s is not None and np.isfinite(s)]
    if not live:
        return None
    total_w = sum(w for _, w in live)
    if total_w <= 0:
        return None
    return float(sum(s * w for s, w in live) / total_w)


@dataclass(slots=True)
class Factor:
    """One computable input to a sport's matchup pillar.

    `key` is the name looked up in `WagerLeg.metrics`. `label` is what the
    user is told when it is missing — deliberately human-readable, since
    these strings are the package's to-do list as much as its disclosure.
    """

    key: str
    label: str
    weight: float
    lo: float
    hi: float
    transform: Callable[[Any], float] | None = None

    def score(self, metrics: Mapping[str, Any]) -> float | None:
        if self.key not in metrics:
            return None
        raw = metrics[self.key]
        try:
            value = float(self.transform(raw) if self.transform else raw)
        except (TypeError, ValueError):
            return None
        return norm100(value, self.lo, self.hi)


class SportEvaluator:
    """Scores a leg's matchup pillar from whatever metrics the caller supplied."""

    name: str = "General"
    factors: tuple[Factor, ...] = ()

    def matchup(self, leg: Any) -> PillarResult:
        metrics = getattr(leg, "metrics", {}) or {}
        parts: list[tuple[float, float]] = []
        signals: list[str] = []
        missing: list[str] = []

        for factor in self.factors:
            score = factor.score(metrics)
            if score is None:
                missing.append(factor.label)
                continue
            parts.append((score, factor.weight))
            signals.append(f"{factor.label}: {metrics[factor.key]} (scores {score:.0f}/100)")

        return PillarResult(blend(parts), signals, missing)

    def distribution(self, leg: Any) -> PillarResult:
        """Median-vs-mean hit-rate test. Shared: the shape is sport-agnostic.

        The specification's requirement is a >=65% hit rate in
        context-equivalent games, measured on the MEDIAN rather than the mean
        so a blowout or a single monster game cannot carry a leg that
        otherwise misses.
        """
        metrics = getattr(leg, "metrics", {}) or {}
        samples = metrics.get("recent_samples")
        line = metrics.get("milestone_line")
        if not samples or line is None:
            return PillarResult(
                None,
                [],
                ["outcome distribution (needs recent_samples and milestone_line)"],
            )

        values = np.asarray([float(v) for v in samples], dtype=float)
        threshold = float(line)
        hit_rate = float(np.mean(values >= threshold))
        median = float(np.median(values))
        mean = float(np.mean(values))

        signals = [
            f"Cleared the line in {hit_rate * 100:.0f}% of the last {values.size} samples "
            f"(the {HIT_RATE_FLOOR * 100:.0f}% bar is {'met' if hit_rate >= HIT_RATE_FLOOR else 'missed'}).",
            f"Median {median:.1f} vs mean {mean:.1f} against a line of {threshold:.1f}.",
        ]
        if mean > median * MEAN_MEDIAN_SKEW_RATIO:
            signals.append(
                f"Mean {mean:.1f} sits {((mean / median) - 1) * 100:.0f}% above the median — the "
                "average is being carried by outlier games, so the line is harder to clear than "
                "the average suggests."
            )

        # Hit rate leads; the median's own margin over the line is the
        # confirmation that the hits are not all scraping through.
        margin = norm100((median - threshold) / max(threshold, 1e-9), -0.3, 0.5)
        return PillarResult(blend([(norm100(hit_rate, 0.35, 0.95), 0.7), (margin, 0.3)]), signals, [])


# Specification: require >= 65% hit rate in context-equivalent games.
HIT_RATE_FLOOR: float = 0.65

# How far the mean may sit above the median before the sample is called
# outlier-distorted.
#
# Calibrated against the case this pillar exists for: ten samples with a
# median of 20 and one 60 in them. That single game lifts the mean to 23.5 —
# a 17.5% gap — and is precisely the blowout the specification's
# median-over-mean requirement is meant to strip out. An earlier 1.25 here
# let that case through silently, which is a threshold that agrees with the
# principle in the comment and not in the arithmetic.
#
# For a roughly symmetric distribution mean and median coincide, so 1.15 is
# not a hair trigger: it takes real right-skew to reach it.
MEAN_MEDIAN_SKEW_RATIO: float = 1.15
