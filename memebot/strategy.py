"""Entry signal + position sizing.

Momentum among safe survivors: real 5-minute upward move with genuine two-way
flow (more buys than sells), not something already blown off parabolically.
Sizing is deliberately tiny and hard-capped so no single meme can sink the
bankroll.
"""
from __future__ import annotations

from dataclasses import dataclass

from . import sources
from .config import RiskConfig


@dataclass
class Plan:
    mint: str
    symbol: str
    usd_size: float
    entry: float
    stop: float
    take_profit: float


def score(c: "sources.Candidate") -> float:
    """Higher = stronger short-term momentum backed by real flow and volume."""
    flow = (c.buys1h + 1) / (c.sells1h + 1)
    s = 0.0
    s += max(0.0, c.chg5m) * 1.5
    s += max(0.0, c.chg1h) * 0.5
    s += min(flow, 4.0) * 4.0
    s += min(c.vol1h / 10_000.0, 10.0)
    # Penalise already-parabolic names (mean-reversion / exit-liquidity risk).
    if c.chg1h > 120:
        s -= (c.chg1h - 120) * 0.3
    return s


def wants_entry(c: "sources.Candidate") -> bool:
    return c.chg5m > 1.0 and c.buys1h > c.sells1h and c.chg1h > -10.0


def size_position(equity: float, cfg: RiskConfig) -> float:
    usd = equity * cfg.risk_per_trade_pct
    cap = equity * cfg.max_position_pct
    return max(0.0, min(usd, cap))


def make_plan(c: "sources.Candidate", equity: float, cfg: RiskConfig) -> Plan | None:
    usd = size_position(equity, cfg)
    entry = c.price_usd
    if usd < 0.5 or entry <= 0:      # dust or no price — skip
        return None
    return Plan(
        mint=c.mint,
        symbol=c.symbol,
        usd_size=usd,
        entry=entry,
        stop=entry * (1 - cfg.stop_loss_pct),
        take_profit=entry * (1 + cfg.take_profit_pct),
    )
