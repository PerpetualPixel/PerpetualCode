"""Tennis (singles): surface speed, dominance ratio, rally tolerance, fatigue."""

from __future__ import annotations

from .base import Factor, PillarResult, SportEvaluator


class TennisEvaluator(SportEvaluator):
    """Singles only. Doubles has a different serve/return economy entirely."""

    name = "Tennis (singles)"

    factors = (
        # Dominance Ratio = (% return points won) / (% serve points lost).
        # 1.0 is break-even; the tour's elite live near 1.3. Supplied
        # pre-computed because deriving it needs point-level data this
        # package does not ingest.
        Factor("dominance_ratio", "Dominance Ratio (return pts won / serve pts lost)",
               weight=0.32, lo=0.75, hi=1.35),
        # Court Speed Index scored as the ALIGNMENT between surface and the
        # player's game, not raw speed: a fast court is an edge only for a
        # player who wants one.
        Factor("cpi_alignment", "Court Speed Index alignment with player's game",
               weight=0.24, lo=-1.0, hi=1.0),
        Factor("rally_tolerance", "Rally-length tolerance (>5 vs <4 shots)",
               weight=0.20, lo=0.40, hi=0.62),
        Factor("surface_win_pct", "Surface-split win rate",
               weight=0.14, lo=0.40, hi=0.80),
        Factor("h2h_win_pct", "Head-to-head record",
               weight=0.10, lo=0.0, hi=1.0),
    )

    # A prior round over this length is a real, measurable drag on the next
    # match, and one of the few tennis factors knowable in advance for
    # certain.
    FATIGUE_HOURS_THRESHOLD: float = 2.5
    FATIGUE_MAX_PENALTY: float = 18.0

    def matchup(self, leg) -> PillarResult:
        result = super().matchup(leg)
        metrics = getattr(leg, "metrics", {}) or {}

        hours = metrics.get("prior_round_hours")
        if hours is None:
            result.unavailable.append("prior-round duration (fatigue check)")
            return result
        try:
            hours = float(hours)
        except (TypeError, ValueError):
            result.unavailable.append("prior-round duration (fatigue check)")
            return result

        if hours <= self.FATIGUE_HOURS_THRESHOLD:
            result.signals.append(
                f"Prior round lasted {hours:.1f}h — inside the {self.FATIGUE_HOURS_THRESHOLD}h "
                "threshold, so no fatigue drag."
            )
            return result

        # Penalty grows with the overrun then saturates: a 4h prior round is
        # bad, a 5h one is not meaningfully worse for the next match.
        over = hours - self.FATIGUE_HOURS_THRESHOLD
        penalty = min(self.FATIGUE_MAX_PENALTY, over * 12.0)
        result.signals.append(
            f"Prior round lasted {hours:.1f}h, {over:.1f}h past the fatigue threshold "
            f"— {penalty:.0f} points off the matchup score."
        )
        if result.score is not None:
            result.score = max(0.0, result.score - penalty)
        return result
