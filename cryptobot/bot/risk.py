"""Risk management: position sizing, stop/target computation, daily-loss halt.

Sizing is risk-based: we never bet a fixed dollar amount, we bet whatever size
makes a stop-out cost exactly `risk_per_trade` of current equity. This is the
single most important discipline that separates a bot from gambling.
"""
from __future__ import annotations

from dataclasses import dataclass

from .config import RiskConfig


@dataclass
class PlannedTrade:
    symbol: str
    qty: float
    entry: float
    stop: float
    take_profit: float
    notional: float


def plan_entry(symbol: str, price: float, atr: float, equity: float,
               cfg: RiskConfig) -> PlannedTrade | None:
    stop_dist = cfg.stop_atr_mult * atr
    if stop_dist <= 0 or price <= 0 or equity <= 0:
        return None

    stop = price - stop_dist
    take_profit = price + cfg.take_profit_r * stop_dist

    risk_amount = equity * cfg.risk_per_trade
    qty = risk_amount / stop_dist
    notional = qty * price

    max_notional = equity * cfg.max_position_pct
    if notional > max_notional:
        notional = max_notional
        qty = notional / price

    if notional < cfg.min_notional:
        return None
    return PlannedTrade(symbol, qty, price, stop, take_profit, notional)


def daily_halt(day_start_equity: float, equity: float, cfg: RiskConfig) -> bool:
    if not day_start_equity or day_start_equity <= 0:
        return False
    drawdown = (day_start_equity - equity) / day_start_equity
    return drawdown >= cfg.daily_loss_halt_pct
