"""Desk configuration — all from the environment, nothing hardcoded.

Paper mode is the default and stays the default. Live execution requires THREE
independent switches (mode, keys, and an explicit arm phrase) so no single
stray environment variable can start trading real money.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _load_env() -> None:
    """Populate os.environ from .env, desk-local first, then the shared one.

    Must run before Settings() is constructed, since its defaults read the
    environment eagerly. A real environment variable always wins over a file,
    so an operator can override any of this per shell. Secrets live only in
    these gitignored files — never in code.
    """
    try:
        from dotenv import load_dotenv
    except ImportError:                       # the desk still runs keyless
        return
    for path in (PROJECT_ROOT / ".env", PROJECT_ROOT.parent / ".env"):
        if path.is_file():
            load_dotenv(path, override=False)


_load_env()


def _env_list(name: str, default: str) -> list[str]:
    return [s.strip() for s in os.environ.get(name, default).split(",") if s.strip()]


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


@dataclass(frozen=True)
class RiskLimits:
    """Sentinel's hard gates.

    These are code, not prompts. No model output can widen them — the veto
    path never consults the LLM.
    """

    max_position_pct: float = 0.10           # of equity, per position
    max_total_exposure_pct: float = 0.40     # of equity, all positions
    daily_loss_limit_pct: float = 0.03       # halt the desk for the rest of the day
    stop_atr_multiple: float = 2.0           # stop distance = N x ATR
    min_24h_volume_usd: float = 5_000_000.0  # liquidity floor
    max_annualised_vol: float = 2.50         # above this, no new entries
    max_spread_bps: float = 25.0             # bid/ask spread ceiling
    min_conviction: float = 0.25             # weighted desk signal needed to act


@dataclass(frozen=True)
class Settings:
    exchange_id: str = field(
        default_factory=lambda: os.environ.get("DESK_EXCHANGE", "binance"))
    symbols: list[str] = field(
        default_factory=lambda: _env_list("DESK_SYMBOLS", "BTC/USDT,ETH/USDT,SOL/USDT"))
    timeframe: str = field(
        default_factory=lambda: os.environ.get("DESK_TIMEFRAME", "15m"))
    starting_cash: float = field(
        default_factory=lambda: _env_float("DESK_STARTING_CASH", 10_000.0))
    refresh_seconds: int = field(
        default_factory=lambda: _env_int("DESK_REFRESH_SECONDS", 30))

    # Narration only. The model never produces a number — see market.py.
    llm_provider: str = field(
        default_factory=lambda: os.environ.get("DESK_LLM_PROVIDER", "none"))
    llm_model: str = field(
        default_factory=lambda: os.environ.get("DESK_LLM_MODEL", "claude-opus-4-8"))

    # Each agent speaks in its own ElevenLabs voice; ids live in voices.json.
    voice_enabled: bool = field(
        default_factory=lambda: os.environ.get("DESK_VOICE", "0") == "1")
    elevenlabs_model: str = field(
        default_factory=lambda: os.environ.get("DESK_TTS_MODEL", "eleven_turbo_v2_5"))

    state_dir: Path = field(
        default_factory=lambda: Path(os.environ.get("DESK_STATE_DIR", str(PROJECT_ROOT / "state"))))
    voices_file: Path = field(
        default_factory=lambda: Path(os.environ.get("DESK_VOICES_FILE", str(PROJECT_ROOT / "voices.json"))))

    # Solana wallet — the meme wing's hands. Public address in wallet.json;
    # the signing key is read from DESK_SOLANA_KEY at runtime, never stored.
    solana_rpc: str = field(
        default_factory=lambda: os.environ.get("DESK_SOLANA_RPC",
                                               "https://api.mainnet-beta.solana.com"))
    wallet_file: Path = field(
        default_factory=lambda: Path(os.environ.get("DESK_WALLET_FILE", str(PROJECT_ROOT / "wallet.json"))))

    limits: RiskLimits = field(default_factory=RiskLimits)

    @property
    def live_armed(self) -> bool:
        """Three independent switches, all required. Anything less is paper."""
        return (
            os.environ.get("DESK_MODE") == "live"
            and bool(os.environ.get("DESK_API_KEY"))
            and bool(os.environ.get("DESK_API_SECRET"))
            and os.environ.get("DESK_LIVE_ARM") == "I_UNDERSTAND_THE_RISK"
        )

    @property
    def solana_armed(self) -> bool:
        """On-chain swaps are irreversible, so they get their own three switches.

        Independent of the CEX arm: you may run the meme wing live without CEX
        keys, or the CEX side live without ever touching Solana.
        """
        return (
            os.environ.get("DESK_MODE") == "live"
            and bool(os.environ.get("DESK_SOLANA_KEY"))
            and os.environ.get("DESK_SOLANA_ARM") == "I_UNDERSTAND_THE_RISK"
        )

    @property
    def mode(self) -> str:
        return "live" if self.live_armed else "paper"


settings = Settings()
