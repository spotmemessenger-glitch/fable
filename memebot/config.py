"""Configuration for the Solana meme-coin bot.

Secrets are read ONLY from environment variables — nothing sensitive is hardcoded.
Paper mode (default) simulates fills on real live prices and risks NOTHING.
Live mode requires ALL of:
    MEME_MODE=live
    SOLANA_PRIVATE_KEY=...            (base58 secret key — stays on your machine)
    BOT_LIVE_ARM=I_UNDERSTAND         (explicit acknowledgement real money is at risk)
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

# Well-known mints (Solana).
SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"


@dataclass
class RiskConfig:
    bankroll: float = float(os.getenv("MEME_BANKROLL", "50"))  # money you can fully lose
    risk_per_trade_pct: float = 0.06      # ~$3 per trade on $50 — deliberately tiny
    max_positions: int = 4                # never more than N open bets at once
    stop_loss_pct: float = 0.25           # cut a loser at -25%
    take_profit_pct: float = 0.60         # take profit at +60%
    trailing_pct: float = 0.20            # once in profit, trail 20% off the high
    daily_loss_halt_pct: float = 0.30     # halt NEW buys after -30% on the day
    max_position_pct: float = 0.34        # never more than a third of bankroll in one


@dataclass
class SafetyConfig:
    min_liq_established: float = 50_000.0  # deep liquidity for the "established" bucket
    min_liq_fresh: float = 8_000.0         # lower floor for fresh launches
    min_vol24: float = 20_000.0            # ignore illiquid/ghost tokens
    min_age_min_fresh: float = 3.0         # skip <3-min-old tokens (pure snipe chaos)
    max_price_impact_pct: float = 8.0      # our size must not move price more than this
    min_roundtrip: float = 0.80            # SOL->token->SOL must return >=80% (tax/honeypot)
    require_sell_route: bool = True        # honeypot guard: a sell route MUST exist


@dataclass
class MemeConfig:
    mode: str = os.getenv("MEME_MODE", "paper")        # "paper" | "live"
    hunt_established: bool = True
    hunt_fresh: bool = True
    slippage_bps: int = 300               # 3% — memes are volatile
    taker_fee: float = 0.003              # rough Jupiter+Solana cost, for paper haircut
    loop_seconds: int = 45
    max_candidates: int = 25              # cap tokens assessed per cycle (rate/cost)
    state_dir: str = os.path.join(os.path.dirname(__file__), "state")
    rpc_url: str = os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")

    risk: RiskConfig = field(default_factory=RiskConfig)
    safety: SafetyConfig = field(default_factory=SafetyConfig)

    # Secrets — env only. Never pasted to the assistant, never logged.
    private_key: str = field(default_factory=lambda: os.getenv("SOLANA_PRIVATE_KEY", ""))
    live_arm: str = field(default_factory=lambda: os.getenv("BOT_LIVE_ARM", ""))


def load_config() -> MemeConfig:
    return MemeConfig()
