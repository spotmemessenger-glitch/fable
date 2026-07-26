"""The agent contract — deterministic collection, separate narration.

Two phases, and the split is the entire safety argument:

    collect(ctx) -> Reading   Pure Python. Reads Market, Portfolio and the
                              public feeds, computes metrics and a signal in
                              [-1, +1]. No language model is involved, so
                              nothing here can be hallucinated.

    narrate(reading)          Hands the finished Reading to a model and gets
                              prose back. The prose lands in Reading.note and
                              is never parsed for numbers. If the model invents
                              a figure it changes nothing the desk acts on —
                              sizing, stops and vetoes read .signal and
                              .metrics, never .note.

A seat with no data returns state "no-data" with confidence 0.0, and HELM drops
zero-confidence seats out of the weighted vote entirely. Silence beats a guess.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from ..config import Settings
from ..market import Market, Snapshot
from ..portfolio import Portfolio
from ..roster import Seat


def clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def pct(part: float | None, whole: float | None) -> float | None:
    if part is None or not whole:
        return None
    return part / whole * 100.0


@dataclass
class Reading:
    """One seat's answer for one symbol at one moment."""

    agent: str
    role: str
    wing: str
    state: str = "no-data"          # ok | thin | no-data | error
    signal: float = 0.0             # -1 short .. +1 long, computed in Python
    confidence: float = 0.0         # 0..1, how much real data backed it
    metrics: dict[str, Any] = field(default_factory=dict)
    facts: list[str] = field(default_factory=list)   # deterministic sentences
    missing: list[str] = field(default_factory=list)
    note: str = ""                  # model narration; never parsed back

    @property
    def usable(self) -> bool:
        return self.state in ("ok", "thin") and self.confidence > 0.0

    @property
    def stance(self) -> str:
        if self.signal >= 0.35:
            return "long"
        if self.signal <= -0.35:
            return "short"
        if abs(self.signal) < 0.12:
            return "flat"
        return "lean long" if self.signal > 0 else "lean short"

    def as_dict(self) -> dict[str, Any]:
        return {
            "agent": self.agent, "role": self.role, "wing": self.wing,
            "state": self.state, "signal": round(self.signal, 4),
            "confidence": round(self.confidence, 3), "stance": self.stance,
            "metrics": self.metrics, "facts": self.facts,
            "missing": self.missing, "note": self.note,
        }


@dataclass
class DeskContext:
    """Everything a seat may look at for one symbol, one moment."""

    market: Market
    settings: Settings
    portfolio: Portfolio
    symbol: str
    snapshot: Snapshot
    frame: pd.DataFrame | None = None            # OHLCV, fetched once by HELM
    prices: dict[str, float | None] = field(default_factory=dict)
    readings: dict[str, Reading] = field(default_factory=dict)  # CASSANDRA reads this
    weights: dict[str, float] = field(default_factory=dict)     # LEDGER's scorecard
    meme: dict[str, Any] | None = None   # Solana token data, set for meme scans
    language: str = "auto"

    @property
    def base(self) -> str:
        return self.symbol.split("/")[0]

    @property
    def price(self) -> float | None:
        return self.snapshot.price


class Agent(ABC):
    """A seat at the desk. Subclasses implement collect() and nothing else."""

    def __init__(self, seat: Seat) -> None:
        self.seat = seat

    @property
    def name(self) -> str:
        return self.seat.name

    @abstractmethod
    def collect(self, ctx: DeskContext) -> Reading:
        """Deterministic. Must never call a language model."""

    # -- Reading constructors, so subclasses stay about the analysis --------

    def _new(self, **kwargs: Any) -> Reading:
        return Reading(agent=self.seat.name, role=self.seat.role,
                       wing=self.seat.wing, **kwargs)

    def ok(self, signal: float, confidence: float, metrics: dict[str, Any],
           facts: list[str], *, missing: list[str] | None = None) -> Reading:
        return self._new(
            state="ok" if not missing else "thin",
            signal=clamp(signal), confidence=clamp(confidence, 0.0, 1.0),
            metrics=metrics, facts=facts, missing=missing or [])

    def nodata(self, *sources: str) -> Reading:
        return self._new(
            state="no-data", missing=list(sources),
            facts=[f"no data from {', '.join(sources)}" if sources else "no data"])

    def error(self, detail: str) -> Reading:
        return self._new(state="error", facts=[f"failed: {detail}"])
