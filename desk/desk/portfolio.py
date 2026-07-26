"""Positions, cash, and the book.

The same object serves paper and live. The only difference between the two is
whether PILOT sends the order to an exchange before recording the fill here —
the accounting is identical either way, which is what makes a paper track
record worth anything when live arming eventually happens.

Long-only for now. Shorts need margin plumbing and a different liquidation
model, and the desk has no business holding either until it has a record.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def utctoday() -> str:
    return datetime.now(timezone.utc).date().isoformat()


@dataclass
class Position:
    symbol: str
    qty: float
    entry: float
    stop: float | None = None
    take: float | None = None
    opened_at: str = field(default_factory=utcnow)
    wing: str = "cex"          # "cex" | "memes" — BALLAST caps the meme wing
    thesis: str = ""

    def value(self, price: float) -> float:
        return self.qty * price

    def pnl(self, price: float) -> float:
        return (price - self.entry) * self.qty

    def pnl_pct(self, price: float) -> float:
        return (price / self.entry - 1.0) * 100.0 if self.entry else 0.0


@dataclass
class Fill:
    ts: str
    symbol: str
    side: str                  # "buy" | "sell"
    qty: float
    price: float
    mode: str                  # "paper" | "live"
    pnl: float = 0.0
    reason: str = ""
    order_id: str = ""


class Portfolio:
    """Cash, open positions, and the fill history. Persists to state/."""

    def __init__(self, starting_cash: float, state_dir: Path) -> None:
        self.starting_cash = starting_cash
        self.cash = starting_cash
        self.positions: dict[str, Position] = {}
        self.fills: list[Fill] = []
        self.realised = 0.0
        self.day = utctoday()
        self.day_start_equity = starting_cash
        self.halted_until: str = ""      # UTC date the daily-loss halt covers
        self._path = Path(state_dir) / "portfolio.json"

    # -- valuation ---------------------------------------------------------

    def equity(self, prices: dict[str, float | None]) -> float:
        held = 0.0
        for symbol, position in self.positions.items():
            price = prices.get(symbol)
            held += position.value(price if price else position.entry)
        return self.cash + held

    def exposure_usd(self, prices: dict[str, float | None]) -> float:
        total = 0.0
        for symbol, position in self.positions.items():
            price = prices.get(symbol)
            total += position.value(price if price else position.entry)
        return total

    def wing_exposure_usd(self, wing: str, prices: dict[str, float | None]) -> float:
        total = 0.0
        for symbol, position in self.positions.items():
            if position.wing != wing:
                continue
            price = prices.get(symbol)
            total += position.value(price if price else position.entry)
        return total

    def unrealised(self, prices: dict[str, float | None]) -> float:
        total = 0.0
        for symbol, position in self.positions.items():
            price = prices.get(symbol)
            if price:
                total += position.pnl(price)
        return total

    def day_pnl_pct(self, prices: dict[str, float | None]) -> float:
        """Percent move in equity since the UTC day opened. Negative is a loss."""
        self.roll_day(prices)
        if self.day_start_equity <= 0:
            return 0.0
        return (self.equity(prices) / self.day_start_equity - 1.0) * 100.0

    def roll_day(self, prices: dict[str, float | None]) -> None:
        """Reset the daily loss baseline when the UTC date changes."""
        today = utctoday()
        if today != self.day:
            self.day = today
            self.day_start_equity = self.equity(prices)

    # -- mutation ----------------------------------------------------------

    def buy(self, symbol: str, qty: float, price: float, *, mode: str,
            stop: float | None = None, take: float | None = None,
            wing: str = "cex", thesis: str = "", order_id: str = "") -> Fill:
        """Record a purchase. Averages up into an existing position."""
        cost = qty * price
        if cost > self.cash:
            raise ValueError(f"insufficient cash: need {cost:.2f}, have {self.cash:.2f}")
        self.cash -= cost

        existing = self.positions.get(symbol)
        if existing:
            total_qty = existing.qty + qty
            existing.entry = (existing.entry * existing.qty + price * qty) / total_qty
            existing.qty = total_qty
            if stop is not None:
                existing.stop = stop
            if take is not None:
                existing.take = take
        else:
            self.positions[symbol] = Position(
                symbol=symbol, qty=qty, entry=price, stop=stop, take=take,
                wing=wing, thesis=thesis)

        fill = Fill(utcnow(), symbol, "buy", qty, price, mode,
                    reason=thesis, order_id=order_id)
        self.fills.append(fill)
        return fill

    def sell(self, symbol: str, price: float, *, mode: str, qty: float | None = None,
             reason: str = "", order_id: str = "") -> Fill:
        """Close all or part of a position. Realises P&L."""
        position = self.positions.get(symbol)
        if not position:
            raise ValueError(f"no open position in {symbol}")
        qty = position.qty if qty is None else min(qty, position.qty)

        pnl = (price - position.entry) * qty
        self.cash += qty * price
        self.realised += pnl
        position.qty -= qty
        if position.qty <= 1e-12:
            del self.positions[symbol]

        fill = Fill(utcnow(), symbol, "sell", qty, price, mode,
                    pnl=pnl, reason=reason, order_id=order_id)
        self.fills.append(fill)
        return fill

    # -- stops -------------------------------------------------------------

    def breached(self, prices: dict[str, float | None]) -> list[tuple[str, str, float]]:
        """Positions whose stop or take level the price has crossed.

        Returns (symbol, "stop"|"take", level). Checked every cycle, in code —
        an exit is never left to a model's judgement.
        """
        hits: list[tuple[str, str, float]] = []
        for symbol, position in self.positions.items():
            price = prices.get(symbol)
            if price is None:
                continue
            if position.stop is not None and price <= position.stop:
                hits.append((symbol, "stop", position.stop))
            elif position.take is not None and price >= position.take:
                hits.append((symbol, "take", position.take))
        return hits

    # -- persistence -------------------------------------------------------

    def as_dict(self) -> dict[str, Any]:
        return {
            "starting_cash": self.starting_cash,
            "cash": self.cash,
            "realised": self.realised,
            "day": self.day,
            "day_start_equity": self.day_start_equity,
            "halted_until": self.halted_until,
            "positions": {s: asdict(p) for s, p in self.positions.items()},
            "fills": [asdict(f) for f in self.fills[-500:]],
        }

    def save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(self.as_dict(), indent=2), encoding="utf-8")

    @classmethod
    def load(cls, starting_cash: float, state_dir: Path) -> "Portfolio":
        book = cls(starting_cash, state_dir)
        if not book._path.exists():
            return book
        try:
            data = json.loads(book._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return book
        book.starting_cash = data.get("starting_cash", starting_cash)
        book.cash = data.get("cash", starting_cash)
        book.realised = data.get("realised", 0.0)
        book.day = data.get("day", utctoday())
        book.day_start_equity = data.get("day_start_equity", book.cash)
        book.halted_until = data.get("halted_until", "")
        book.positions = {s: Position(**p) for s, p in data.get("positions", {}).items()}
        book.fills = [Fill(**f) for f in data.get("fills", [])]
        return book
