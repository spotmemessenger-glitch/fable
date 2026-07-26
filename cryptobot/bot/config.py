"""Central configuration for the paper/live trading bot.

Edit the DEFAULTS below to tune the bot. Secrets (API keys) are read ONLY from
environment variables and are never hardcoded here.

To go live you must set ALL of:
    BOT_MODE=live
    BOT_API_KEY=...            (exchange key, TRADE-only, NO withdrawal, IP-whitelisted)
    BOT_API_SECRET=...
    BOT_LIVE_ARM=I_UNDERSTAND  (explicit acknowledgement that real money is at risk)
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass
class RiskConfig:
    risk_per_trade: float = 0.01        # fraction of equity risked to the stop (1%)
    max_position_pct: float = 0.30      # hard cap: max notional in one position (30%)
    stop_atr_mult: float = 2.0          # protective stop = entry - 2*ATR
    take_profit_r: float = 2.0          # target = 2x the risk distance (2:1)
    daily_loss_halt_pct: float = 0.10   # stop new entries after -10% on the day
    min_notional: float = 5.0           # skip orders smaller than this (quote ccy)


@dataclass
class StrategyConfig:
    ema_fast: int = 20
    ema_slow: int = 50
    rsi_period: int = 14
    rsi_oversold: float = 35.0
    rsi_overbought: float = 70.0
    atr_period: int = 14


@dataclass
class BotConfig:
    mode: str = os.getenv("BOT_MODE", "paper")            # "paper" | "live"
    exchange_id: str = os.getenv("BOT_EXCHANGE", "binance")
    # Comma-separated override, e.g. BOT_SYMBOLS="BTC/USDC,ETH/USDC" for Hyperliquid.
    symbols: list[str] = field(default_factory=lambda: [
        s.strip() for s in os.getenv("BOT_SYMBOLS", "BTC/USDT,ETH/USDT,SOL/USDT").split(",")
        if s.strip()
    ])
    timeframe: str = "5m"
    candles: int = 200
    starting_cash: float = 20.0         # paper starting balance (your $20)
    loop_seconds: int = 60
    taker_fee: float = 0.001            # 0.1% assumed fee per fill
    slippage: float = 0.0005            # 0.05% assumed slippage on paper fills
    state_dir: str = os.path.join(os.path.dirname(os.path.dirname(__file__)), "state")

    risk: RiskConfig = field(default_factory=RiskConfig)
    strategy: StrategyConfig = field(default_factory=StrategyConfig)

    # Secrets — env only.
    api_key: str = field(default_factory=lambda: os.getenv("BOT_API_KEY", ""))
    api_secret: str = field(default_factory=lambda: os.getenv("BOT_API_SECRET", ""))
    live_arm: str = field(default_factory=lambda: os.getenv("BOT_LIVE_ARM", ""))


def load_config() -> BotConfig:
    return BotConfig()
