"""Baseball (MLB): arsenal vs lineup splits, barrels, park and weather, bullpen."""

from __future__ import annotations

from .base import Factor, SportEvaluator


class BaseballEvaluator(SportEvaluator):
    name = "Baseball"

    # Several bands below are INVERTED (lo > hi) because the metric improves
    # as it falls — wOBA allowed, wRC+ faced, barrel rate. norm100 handles
    # that directly rather than needing a sign flip at each call site.
    factors = (
        Factor("arsenal_vs_lineup_woba", "Primary arsenal vs lineup wOBA split",
               weight=0.30, lo=0.360, hi=0.260),
        Factor("lineup_wrc_plus", "Opposing lineup wRC+",
               weight=0.20, lo=125.0, hi=75.0),
        Factor("barrel_rate_allowed", "Barrel rate allowed",
               weight=0.18, lo=0.12, hi=0.03),
        # Park and weather as one physics factor: temperature, wind vector
        # and altitude all act on the same ball, so splitting them would
        # double-count the same effect.
        Factor("park_weather_factor", "Park factor with weather physics applied",
               weight=0.18, lo=1.15, hi=0.85),
        Factor("bullpen_leverage_available", "Bullpen high-leverage arms available",
               weight=0.14, lo=0.0, hi=4.0),
    )
