"""Football (NFL/CFB): EPA, success rate vs havoc, trench win rates, key numbers."""

from __future__ import annotations

from .base import Factor, PillarResult, SportEvaluator


class FootballEvaluator(SportEvaluator):
    name = "Football"

    factors = (
        Factor("epa_per_play_diff", "EPA/play differential",
               weight=0.32, lo=-0.25, hi=0.30),
        Factor("success_rate_vs_havoc", "Success rate against opponent havoc rate",
               weight=0.24, lo=-0.10, hi=0.12),
        # Pass Rush Win Rate minus opponent Pass Block Win Rate. The trench
        # matchup decides more possessions than skill-position talent does.
        Factor("prwr_minus_pbwr", "Pass rush win rate vs pass block win rate",
               weight=0.24, lo=-0.10, hi=0.12),
        Factor("rest_days_diff", "Rest advantage in days",
               weight=0.10, lo=-4.0, hi=6.0),
        Factor("turnover_margin_expected", "Expected turnover margin",
               weight=0.10, lo=-1.5, hi=1.5),
    )

    # Football margins cluster on these, so a spread's exact number matters
    # far more than its distance from the next one suggests.
    KEY_NUMBERS: tuple[int, ...] = (3, 7, 6, 10, 14, 4)

    def key_number_discipline(self, leg) -> PillarResult:
        """Where a spread sits relative to the nearest key number.

        Computable from the spread alone — no external feed — which is why
        this is a scored factor rather than another listed gap.
        """
        if str(getattr(leg, "market_type", "")).upper() != "SPREAD":
            return PillarResult(None, [], [])
        point = (getattr(leg, "metrics", {}) or {}).get("spread_point")
        if point is None:
            return PillarResult(None, [], ["spread point (key-number discipline)"])
        try:
            point = float(point)
        except (TypeError, ValueError):
            return PillarResult(None, [], ["spread point (key-number discipline)"])

        magnitude = abs(point)
        laying = point < 0
        nearest = min(self.KEY_NUMBERS, key=lambda k: abs(magnitude - k))
        distance = magnitude - nearest

        if abs(distance) < 0.01:
            return PillarResult(50.0, [
                f"Sitting exactly on the key number {nearest} — the single most likely margin, "
                "so this pushes far more often than a half-point either side."
            ], [])
        if laying == (distance < 0):
            return PillarResult(74.0, [
                f"{'Laying' if laying else 'Taking'} {magnitude:g} with the key number {nearest} "
                "on your side of the line — the most common margins fall your way."
            ], [])
        return PillarResult(30.0, [
            f"{'Laying' if laying else 'Taking'} {magnitude:g} across the key number {nearest} — "
            "the most common margin sits against you, which is what the extra half-point buys."
        ], [])

    def matchup(self, leg) -> PillarResult:
        result = super().matchup(leg)
        key = self.key_number_discipline(leg)
        if key.score is None:
            result.unavailable.extend(key.unavailable)
            return result
        result.signals.extend(key.signals)
        # Key-number position is real but secondary: it shapes how a margin
        # converts into a cover, not which side is better.
        result.score = key.score if result.score is None else result.score * 0.75 + key.score * 0.25
        return result
