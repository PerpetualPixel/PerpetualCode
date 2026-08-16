"""Basketball (NBA/CBB): play-type defence, usage reallocation, pace, blowout risk."""

from __future__ import annotations

from .base import Factor, PillarResult, SportEvaluator


class BasketballEvaluator(SportEvaluator):
    name = "Basketball"

    factors = (
        # Opponent defensive rating against the play type this player's
        # offence is actually built on — a spot-up shooter and a PnR handler
        # face completely different defences on the same team.
        Factor("opp_playtype_def_rank", "Opponent defence vs this play type (rank, 1 best)",
               weight=0.30, lo=1.0, hi=30.0),
        # Usage inherited when a teammate is out: the single largest
        # legitimate mover of a player prop, and knowable pre-game.
        Factor("usage_reallocation", "Usage reallocation from inactive teammates (pp)",
               weight=0.26, lo=-4.0, hi=10.0),
        Factor("pace_delta", "Pace mismatch vs season baseline (possessions)",
               weight=0.20, lo=-6.0, hi=8.0),
        Factor("minutes_trend", "Minutes trend over the last five",
               weight=0.14, lo=-6.0, hi=8.0),
        # Inverted band: a LOWER defensive rating is a tougher defence.
        Factor("opp_def_rating", "Opponent overall defensive rating",
               weight=0.10, lo=120.0, hi=105.0),
    )

    # A spread this wide starts pulling starters in the fourth, capping
    # counting-stat props however good the matchup was.
    BLOWOUT_SPREAD: float = 12.5
    BLOWOUT_MAX_PENALTY: float = 15.0

    def matchup(self, leg) -> PillarResult:
        result = super().matchup(leg)
        metrics = getattr(leg, "metrics", {}) or {}

        spread = metrics.get("game_spread")
        if spread is None:
            result.unavailable.append("game spread (blowout minute discount)")
            return result
        try:
            spread = abs(float(spread))
        except (TypeError, ValueError):
            result.unavailable.append("game spread (blowout minute discount)")
            return result

        # Only counting props are exposed to garbage time; a moneyline is if
        # anything helped by a blowout.
        if str(getattr(leg, "market_type", "")).upper() not in {"PROP_MILESTONE", "TOTAL"}:
            return result
        if spread < self.BLOWOUT_SPREAD:
            return result

        penalty = min(self.BLOWOUT_MAX_PENALTY, (spread - self.BLOWOUT_SPREAD) * 2.0 + 5.0)
        result.signals.append(
            f"Spread of {spread:.1f} is past the {self.BLOWOUT_SPREAD} blowout line — "
            f"fourth-quarter minutes are at risk, {penalty:.0f} points off."
        )
        if result.score is not None:
            result.score = max(0.0, result.score - penalty)
        return result
