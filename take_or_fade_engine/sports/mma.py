"""MMA/UFC: striking differential, takedown defence, control time, cardio decay."""

from __future__ import annotations

from .base import Factor, PillarResult, SportEvaluator


class MMAEvaluator(SportEvaluator):
    name = "MMA"

    factors = (
        # Significant strikes landed per minute minus absorbed — a
        # differential rather than a rate precisely because absorbing is half
        # of striking.
        Factor("slpm_minus_sapm", "Striking differential (SLpM - SApM)",
               weight=0.34, lo=-2.0, hi=3.0),
        Factor("takedown_defense_pct", "Takedown defence %",
               weight=0.26, lo=0.40, hi=0.92),
        Factor("control_time_share", "Share of control time",
               weight=0.22, lo=0.25, hi=0.75),
        Factor("reach_advantage_in", "Reach advantage (inches)",
               weight=0.08, lo=-5.0, hi=8.0),
        Factor("capper_consensus", "Capper consensus lean",
               weight=0.10, lo=-1.0, hi=1.0),
    )

    def matchup(self, leg) -> PillarResult:
        result = super().matchup(leg)
        metrics = getattr(leg, "metrics", {}) or {}

        decay = metrics.get("round_output_decay")
        if decay is None:
            result.unavailable.append("round-by-round output decay (cardio)")
            return result
        try:
            decay = float(decay)
        except (TypeError, ValueError):
            result.unavailable.append("round-by-round output decay (cardio)")
            return result

        # Fraction of round-one output still landing late. Below 0.75 is a
        # real cardio problem over a scheduled five.
        if decay < 0.75:
            penalty = min(16.0, (0.75 - decay) * 60.0)
            result.signals.append(
                f"Output falls to {decay * 100:.0f}% of round-one volume in the later rounds "
                f"— {penalty:.0f} points off for cardio decay."
            )
            if result.score is not None:
                result.score = max(0.0, result.score - penalty)
        else:
            result.signals.append(
                f"Holds {decay * 100:.0f}% of round-one output late — no cardio drag."
            )
        return result
