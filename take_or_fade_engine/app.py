"""FastAPI surface: /evaluate/pick, /evaluate/slip, /evaluate/slate, /optimize/slip.

Every endpoint is a thin adapter over `evaluate_slip`. Deliberately thin:
putting decision logic in a request handler is how two callers end up
getting different verdicts for the same bet.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .core.slip_optimizer import optimize
from .core.engine import evaluate_leg
from .evaluate import evaluate_slip
from .schemas import BetSlipInput, EvaluationResponse, OptimizationProposal, WagerLeg

app = FastAPI(
    title="TakeOrFadeEngine",
    version="1.0.0",
    description=(
        "Quantitative sports betting decision engine. Grades wagers across five weighted "
        "pillars, sizes them with quarter-Kelly, and restructures failing tickets rather "
        "than merely rejecting them."
    ),
)


class SlateInput(BaseModel):
    """Several independent tickets graded in one call."""

    slips: list[BetSlipInput]


class SlateResponse(BaseModel):
    results: list[EvaluationResponse]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/evaluate/pick", response_model=EvaluationResponse)
def evaluate_pick(leg: WagerLeg) -> EvaluationResponse:
    """Grade a single wager, with no ticket around it."""
    slip = BetSlipInput(
        ticket_id=f"pick:{leg.event_id}",
        slip_type="STRAIGHT",
        offered_odds_american=leg.odds_american,
        legs=[leg],
    )
    return evaluate_slip(slip)


@app.post("/evaluate/slip", response_model=EvaluationResponse)
def evaluate_slip_endpoint(slip: BetSlipInput) -> EvaluationResponse:
    """Grade a ticket, per leg and as a whole, with a proposal if it fails."""
    return evaluate_slip(slip)


@app.post("/evaluate/parlay", response_model=EvaluationResponse)
def evaluate_parlay_endpoint(slip: BetSlipInput) -> EvaluationResponse:
    """Alias of /evaluate/slip that forces parlay semantics."""
    return evaluate_slip(slip.model_copy(update={"slip_type": "PARLAY"}))


@app.post("/evaluate/slate", response_model=SlateResponse)
def evaluate_slate_endpoint(payload: SlateInput) -> SlateResponse:
    """Grade a whole day's worth of tickets independently."""
    if not payload.slips:
        raise HTTPException(status_code=422, detail="a slate needs at least one slip")
    return SlateResponse(results=[evaluate_slip(s) for s in payload.slips])


@app.post("/optimize/slip", response_model=OptimizationProposal)
def optimize_slip_endpoint(slip: BetSlipInput) -> OptimizationProposal:
    """Restructure a ticket unconditionally, whatever it graded.

    404 rather than an empty proposal when there is nothing constructive to
    return: the optimizer declines when pruning leaves too little to rebuild
    from, and manufacturing legs the bettor never expressed interest in would
    be a different bet rather than a restructuring of theirs.
    """
    assessments = [evaluate_leg(leg) for leg in slip.legs]
    proposal = optimize(slip, assessments)
    if proposal is None:
        raise HTTPException(
            status_code=404,
            detail=(
                "No constructive restructure available — after removing anchor legs and "
                "cannibalized props, fewer than two legs stood on their own."
            ),
        )
    return proposal
