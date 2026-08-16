"""Command-line interface for rapid slate evaluation.

    python -m take_or_fade_engine.cli pick   --json leg.json
    python -m take_or_fade_engine.cli slip   --json ticket.json
    python -m take_or_fade_engine.cli slate  --csv  slate.csv
    python -m take_or_fade_engine.cli parse  --text "Rublev ML -225"
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable

from .core.engine import is_fade_side, is_take_side
from .evaluate import evaluate_slip
from .schemas import BetSlipInput, EvaluationResponse, WagerLeg

# "Rublev ML -225", "Fritz 5+ Aces +110", "Chiefs -3.5 (-110)"
_PRICE = re.compile(r"([+-]\d{3,5})(?!\d)")


def parse_text_leg(line: str, event_id: str = "e1", sport: str = "UNKNOWN") -> WagerLeg | None:
    """One free-text line into a leg.

    Deliberately forgiving about everything except the price: a human typing
    a slip writes the selection however they think of it, and anything not
    clearly a price is kept as part of the selection rather than discarded.
    A line with no readable price is rejected outright, because a wager
    without a price cannot be graded and guessing one would be fabrication.
    """
    raw = line.strip()
    if not raw:
        return None
    match = _PRICE.search(raw)
    if not match:
        return None
    price = int(match.group(1))
    selection = _PRICE.sub("", raw).replace("()", "").strip(" ()-,@")
    if not selection:
        return None
    upper = selection.upper()
    market = (
        "MONEYLINE" if " ML" in f" {upper}" or "MONEYLINE" in upper
        else "SET_SPREAD" if "SET" in upper
        else "PROP_MILESTONE" if "+" in selection or "OVER" in upper or "UNDER" in upper
        else "SPREAD"
    )
    return WagerLeg(
        event_id=event_id, sport=sport, matchup=selection,
        market_type=market, selection=selection, odds_american=price,
    )


def slip_from_text(text: str, ticket_id: str = "text-slip", sport: str = "UNKNOWN") -> BetSlipInput:
    legs = [
        leg for i, line in enumerate(text.splitlines())
        if (leg := parse_text_leg(line, event_id=f"e{i}", sport=sport)) is not None
    ]
    if not legs:
        raise ValueError("no priced legs found in that text")
    return BetSlipInput(ticket_id=ticket_id, slip_type="PARLAY", offered_odds_american=0, legs=legs)


def slips_from_csv(path: Path) -> list[BetSlipInput]:
    """A slate CSV into slips, grouped by `ticket_id`.

    Required columns: ticket_id, event_id, sport, matchup, market_type,
    selection, odds_american. Any column prefixed `m_` becomes a metric, so a
    caller can supply `m_dominance_ratio` without this module needing to know
    every sport's schema in advance.
    """
    grouped: dict[str, list[WagerLeg]] = {}
    offered: dict[str, int] = {}
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            metrics: dict[str, Any] = {}
            for key, value in row.items():
                if key and key.startswith("m_") and value not in (None, ""):
                    try:
                        metrics[key[2:]] = float(value)
                    except ValueError:
                        metrics[key[2:]] = value
            ticket = row.get("ticket_id") or "slate"
            grouped.setdefault(ticket, []).append(WagerLeg(
                event_id=row["event_id"], sport=row["sport"], matchup=row["matchup"],
                market_type=row["market_type"], selection=row["selection"],
                odds_american=int(row["odds_american"]),
                sharp_fair_prob=float(row["sharp_fair_prob"]) if row.get("sharp_fair_prob") else None,
                metrics=metrics,
            ))
            if row.get("offered_odds_american"):
                offered[ticket] = int(row["offered_odds_american"])
    return [
        BetSlipInput(
            ticket_id=t, slip_type="PARLAY" if len(legs) > 1 else "STRAIGHT",
            offered_odds_american=offered.get(t, 0), legs=legs,
        )
        for t, legs in grouped.items()
    ]


_COLOURS = {"take": "\033[32m", "fade": "\033[31m", "lean": "\033[33m", "off": "\033[0m"}


def _tint(verdict: str, use_colour: bool) -> str:
    if not use_colour:
        return verdict
    key = "take" if is_take_side(verdict) else "fade" if is_fade_side(verdict) else "lean"
    return f"{_COLOURS[key]}{verdict}{_COLOURS['off']}"


def render(result: EvaluationResponse, use_colour: bool = True) -> str:
    lines = [
        f"╭─ {result.ticket_id}",
        f"│  {_tint(result.original_verdict, use_colour)}  "
        f"TPS {result.composite_score:.1f}  EV {result.expected_value_pct:+.2f}%  "
        f"{result.recommended_units:.2f}u",
    ]
    for leg in result.leg_evaluations:
        lines.append(
            f"│    {leg.selection[:44]:<44} {leg.odds_american:+6d}  "
            f"{_tint(leg.verdict, use_colour):<12} TPS {leg.composite_score:5.1f}  "
            f"EV {leg.expected_value_pct:+6.2f}%  cov {leg.coverage * 100:3.0f}%"
        )
        for gap in leg.unavailable_factors[:2]:
            lines.append(f"│        no data: {gap}")
    for v in result.vulnerabilities:
        lines.append(f"│  ! {v}")
    if result.optimization_proposal:
        p = result.optimization_proposal
        lines.append(f"│  ╭─ RESTRUCTURE → {_tint(p.verdict, use_colour)} at {p.target_odds_american:+d}")
        lines.append(f"│  │  EV lift: {p.expected_value_lift}")
        for leg in p.restructured_legs:
            lines.append(f"│  │  [{leg.type}] {leg.selection} {leg.odds_american:+d}")
            lines.append(f"│  │      {leg.rationale}")
        for dropped in p.dropped_legs:
            lines.append(f"│  │  dropped: {dropped}")
        lines.append("│  ╰─")
    lines.append("╰─")
    return "\n".join(lines)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="take-or-fade", description=__doc__)
    parser.add_argument("mode", choices=["pick", "slip", "slate", "parse"])
    parser.add_argument("--json", type=Path, help="path to a leg or slip JSON file")
    parser.add_argument("--csv", type=Path, help="path to a slate CSV")
    parser.add_argument("--text", type=str, help="raw pasted bet slip text")
    parser.add_argument("--sport", type=str, default="UNKNOWN", help="sport key for --text legs")
    parser.add_argument("--raw", action="store_true", help="emit JSON instead of the rendered view")
    parser.add_argument("--no-colour", action="store_true")
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.mode == "slate":
        if not args.csv:
            parser.error("slate mode needs --csv")
        results = [evaluate_slip(s) for s in slips_from_csv(args.csv)]
    elif args.mode == "parse":
        if not args.text:
            parser.error("parse mode needs --text")
        results = [evaluate_slip(slip_from_text(args.text, sport=args.sport))]
    else:
        if not args.json:
            parser.error(f"{args.mode} mode needs --json")
        payload = json.loads(args.json.read_text(encoding="utf-8"))
        if args.mode == "pick":
            leg = WagerLeg(**payload)
            payload = BetSlipInput(
                ticket_id=f"pick:{leg.event_id}", slip_type="STRAIGHT",
                offered_odds_american=leg.odds_american, legs=[leg],
            )
        else:
            payload = BetSlipInput(**payload)
        results = [evaluate_slip(payload)]

    if args.raw:
        print(json.dumps([r.model_dump() for r in results], indent=2))
    else:
        for r in results:
            print(render(r, use_colour=not args.no_colour))
    return 0


if __name__ == "__main__":
    sys.exit(main())
