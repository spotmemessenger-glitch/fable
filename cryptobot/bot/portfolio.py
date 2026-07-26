"""Portfolio state, PnL tracking, and JSON/CSV persistence.

State survives restarts: positions and cash are written to state/ledger.json
after every step, and every fill is appended to state/trades.csv.
"""
from __future__ import annotations

import csv
import json
import os
from dataclasses import asdict, dataclass, field


@dataclass
class Position:
    symbol: str
    qty: float
    avg_price: float
    stop: float
    take_profit: float


@dataclass
class Portfolio:
    cash: float
    positions: dict[str, Position] = field(default_factory=dict)
    realized_pnl: float = 0.0

    def equity(self, prices: dict[str, float]) -> float:
        val = self.cash
        for sym, pos in self.positions.items():
            val += pos.qty * prices.get(sym, pos.avg_price)
        return val

    def save(self, state_dir: str) -> None:
        os.makedirs(state_dir, exist_ok=True)
        data = {
            "cash": self.cash,
            "realized_pnl": self.realized_pnl,
            "positions": {s: asdict(p) for s, p in self.positions.items()},
        }
        with open(os.path.join(state_dir, "ledger.json"), "w") as f:
            json.dump(data, f, indent=2)

    @classmethod
    def load(cls, state_dir: str, starting_cash: float) -> "Portfolio":
        path = os.path.join(state_dir, "ledger.json")
        if not os.path.exists(path):
            return cls(cash=starting_cash)
        with open(path) as f:
            data = json.load(f)
        positions = {s: Position(**p) for s, p in data.get("positions", {}).items()}
        return cls(cash=data["cash"], positions=positions,
                   realized_pnl=data.get("realized_pnl", 0.0))


def log_trade(state_dir: str, row: dict) -> None:
    os.makedirs(state_dir, exist_ok=True)
    path = os.path.join(state_dir, "trades.csv")
    exists = os.path.exists(path)
    with open(path, "a", newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=["ts", "symbol", "side", "qty", "price", "fee", "reason", "pnl"])
        if not exists:
            writer.writeheader()
        writer.writerow(row)
