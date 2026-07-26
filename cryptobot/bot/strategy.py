"""Rule-based signal engine.

This is a *starting* strategy, deliberately simple and defensible — NOT a
promise of profit. It buys pullbacks (RSI oversold) only while the trend is up
(EMA-fast > EMA-slow), and flags an exit when RSI gets overbought. Protective
stops and profit targets are handled by risk.py, not here.

Swap or extend this module to change the bot's behaviour; the rest of the
engine does not care how a Signal was produced.
"""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from . import indicators as ind
from .config import StrategyConfig


@dataclass
class Signal:
    symbol: str
    action: str          # "buy" | "sell" | "hold"
    price: float
    atr: float
    reason: str
    strength: float = 0.0  # 0..1 ranking score used by the scanner


def evaluate(symbol: str, df: pd.DataFrame, cfg: StrategyConfig) -> Signal:
    close = df["close"]
    ema_fast = ind.ema(close, cfg.ema_fast)
    ema_slow = ind.ema(close, cfg.ema_slow)
    rsi = ind.rsi(close, cfg.rsi_period)
    atr = ind.atr(df, cfg.atr_period)

    price = float(close.iloc[-1])
    a = float(atr.iloc[-1])
    r = float(rsi.iloc[-1])
    uptrend = float(ema_fast.iloc[-1]) > float(ema_slow.iloc[-1])

    if uptrend and r <= cfg.rsi_oversold:
        strength = min(1.0, (cfg.rsi_oversold - r) / cfg.rsi_oversold + 0.2)
        return Signal(symbol, "buy", price, a,
                      f"uptrend + RSI {r:.0f} <= {cfg.rsi_oversold:.0f}", strength)
    if r >= cfg.rsi_overbought:
        return Signal(symbol, "sell", price, a,
                      f"RSI {r:.0f} >= {cfg.rsi_overbought:.0f}")
    return Signal(symbol, "hold", price, a,
                  f"trend={'up' if uptrend else 'down'} RSI {r:.0f}")
