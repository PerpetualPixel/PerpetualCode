"""Pydantic models — the package's external contract.

Field names and shapes follow the specification exactly, so a slip that
validates against `BetSlipInput` here validates against the documented API.

One design note that runs through everything below: `WagerLeg.metrics` is an
open dict supplied by the CALLER, not fetched by this package. That is what
lets the sport evaluators compute real numbers without this package owning a
data pipeline for EPA, barrel rates, court speed indices and so on. Whatever
the caller supplies is used; whatever is absent is reported by name as
unavailable rather than silently replaced with a neutral value.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

SlipType = Literal["STRAIGHT", "PARLAY", "SGP", "SGP_PLUS"]
MarketType = Literal[
    "MONEYLINE",
    "SPREAD",
    "TOTAL",
    "PROP_MILESTONE",
    "SET_SPREAD",
    "SET_WIN",
]


class WagerLeg(BaseModel):
    """One selection on a ticket."""

    event_id: str
    sport: str
    matchup: str
    market_type: str = Field(description="MONEYLINE, SPREAD, PROP_MILESTONE, SET_SPREAD, ...")
    selection: str
    odds_american: int
    odds_decimal: float = 0.0
    # The sharp de-vigged probability, when the caller has one from
    # Pinnacle/Circa. Left None when they don't: the engine will fall back to
    # the leg's own implied probability and SAY that it did, rather than
    # quietly treating a vigged number as fair.
    sharp_fair_prob: Optional[float] = None
    metrics: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _fill_decimal(self) -> "WagerLeg":
        """Derive decimal odds from the American price whenever they disagree.

        A model validator rather than a field validator, deliberately: field
        validators do not run on a field left at its default, so a caller who
        omits ``odds_decimal`` entirely — the common case — would have kept a
        decimal of 0.0 and every downstream price calculation would silently
        refuse to compute. Found exactly that way.

        The American price is authoritative. A caller supplying both and
        getting them inconsistent is a real and silent failure mode, so the
        decimal is recomputed whenever it is absent or disagrees by more than
        a cent.
        """
        from .core.market import american_to_decimal

        derived = american_to_decimal(self.odds_american)
        if self.odds_decimal is None or self.odds_decimal <= 1.0 or abs(self.odds_decimal - derived) > 0.01:
            object.__setattr__(self, "odds_decimal", derived)
        return self

    @property
    def subject(self) -> str:
        """The competitor this leg is on.

        Correlation detection turns entirely on this: two legs are only
        same-competitor synergy if they name the same person, and "Fritz 5+
        Aces" and "Fritz to Win a Set" have to resolve to the same subject
        for the SGP grouping to fire at all.

        Parsing it out of free-text selections is unreliable in exactly the
        cases that matter, so an explicit ``metrics["subject"]`` always wins.
        The heuristic below is a fallback for casually-entered slips, not the
        intended path: it strips the market phrasing this package sees most
        often and keeps the leading capitalised run, which handles
        "Fritz 5+ Aces" and "Rublev ML" but is not claimed to handle every
        way a book might word a selection.
        """
        explicit = (self.metrics or {}).get("subject")
        if explicit:
            return str(explicit).strip()

        text = self.selection
        for marker in (" to ", " ML", " Moneyline", " over ", " Over ", " under ", " Under "):
            text = text.split(marker)[0]
        tokens = text.strip().split()
        name: list[str] = []
        for token in tokens:
            if token[:1].isupper() and not any(ch.isdigit() for ch in token):
                name.append(token)
            else:
                break
        return " ".join(name) if name else text.strip()


class BetSlipInput(BaseModel):
    """A ticket as the bettor constructed it."""

    ticket_id: str
    slip_type: str = "PARLAY"
    offered_odds_american: int = 0
    legs: list[WagerLeg]

    @field_validator("legs", mode="after")
    @classmethod
    def _non_empty(cls, v: list[WagerLeg]) -> list[WagerLeg]:
        if not v:
            raise ValueError("a slip needs at least one leg")
        return v


class RestructuredLeg(BaseModel):
    """One component of a counter-proposal ticket."""

    type: str  # STRAIGHT or SGP
    selection: str
    odds_american: int
    rationale: str


class OptimizationProposal(BaseModel):
    """The restructured ticket the optimizer recommends instead."""

    verdict: str
    composite_score: float
    target_odds_american: int
    expected_value_lift: str
    restructured_legs: list[RestructuredLeg]
    # Every leg the optimizer removed, and why. Present so a proposal is
    # auditable rather than a black box: the bettor's intent was expressed by
    # the legs they chose, and dropping one silently would discard that.
    dropped_legs: list[str] = Field(default_factory=list)


class LegEvaluation(BaseModel):
    """One leg's own grade — returned in every mode, never only in aggregate."""

    selection: str
    odds_american: int
    verdict: str
    composite_score: float
    expected_value_pct: float
    fair_probability: float
    recommended_units: float
    pillar_scores: dict[str, Optional[float]]
    coverage: float = Field(description="Fraction of the model's designed weight that had real data")
    vulnerabilities: list[str] = Field(default_factory=list)
    unavailable_factors: list[str] = Field(default_factory=list)


class EvaluationResponse(BaseModel):
    """The full result for one ticket."""

    ticket_id: str
    original_verdict: str
    composite_score: float
    expected_value_pct: float
    recommended_units: float
    pillar_scores: dict[str, Optional[float]]
    vulnerabilities: list[str] = Field(default_factory=list)
    leg_evaluations: list[LegEvaluation] = Field(default_factory=list)
    optimization_proposal: Optional[OptimizationProposal] = None
