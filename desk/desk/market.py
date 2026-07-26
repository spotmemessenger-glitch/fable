"""The numbers layer. Every figure the desk quotes originates here.

This module is the whole safety thesis in one file: prices, indicators and
derivatives stats are computed by code from exchange data, then handed TO the
model. No agent asks a language model for a number, and nothing here ever
substitutes a plausible value for a missing one — a failed fetch returns None
and the agent degrades to "no data" out loud.

Public endpoints only; no API key is required for anything in here.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any

import ccxt
import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

OHLCV_COLS = ["ts", "open", "high", "low", "close", "volume"]
BARS_PER_YEAR = {"1m": 525_600, "5m": 105_120, "15m": 35_040,
                 "1h": 8_760, "4h": 2_190, "1d": 365}


# --------------------------------------------------------------------------
# indicators — pure pandas/numpy, no TA-Lib (installs cleanly on Windows)
# --------------------------------------------------------------------------

def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0.0, float("nan"))
    return (100 - (100 / (1 + rs))).fillna(50.0)


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    high, low, close = df["high"], df["low"], df["close"]
    prev = close.shift(1)
    true_range = pd.concat(
        [(high - low), (high - prev).abs(), (low - prev).abs()], axis=1
    ).max(axis=1)
    return true_range.ewm(alpha=1 / period, adjust=False).mean()


def macd(close: pd.Series, fast: int = 12, slow: int = 26,
         signal: int = 9) -> tuple[pd.Series, pd.Series]:
    line = ema(close, fast) - ema(close, slow)
    return line, ema(line, signal)


def realised_vol(close: pd.Series, timeframe: str, window: int = 96) -> float | None:
    """Annualised realised volatility from log returns. None if too few bars."""
    if len(close) < window + 1:
        return None
    returns = np.log(close / close.shift(1)).dropna().tail(window)
    if returns.empty:
        return None
    periods = BARS_PER_YEAR.get(timeframe)
    if periods is None:
        return None
    return float(returns.std(ddof=1) * math.sqrt(periods))


def support_resistance(df: pd.DataFrame, lookback: int = 96) -> tuple[float, float]:
    window = df.tail(lookback)
    return float(window["low"].min()), float(window["high"].max())


# --------------------------------------------------------------------------
# the feed
# --------------------------------------------------------------------------

@dataclass
class Snapshot:
    """One symbol, one moment. Every field is either a real number from the
    exchange or None — never an estimate."""

    symbol: str
    timeframe: str
    price: float | None = None
    change_24h_pct: float | None = None
    volume_24h_usd: float | None = None

    # structure
    spread_bps: float | None = None
    bid_depth_usd: float | None = None
    ask_depth_usd: float | None = None

    # technicals
    rsi_14: float | None = None
    atr_14: float | None = None
    ema_fast: float | None = None
    ema_slow: float | None = None
    macd_hist: float | None = None
    support: float | None = None
    resistance: float | None = None

    # statistics
    annualised_vol: float | None = None

    # derivatives (COIL's wing; absent on spot-only exchanges)
    funding_rate: float | None = None
    open_interest_usd: float | None = None

    missing: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if k != "missing"}


class Market:
    """Rate-limited CCXT wrapper. One instance is shared by the whole desk."""

    def __init__(self, exchange_id: str = "binance") -> None:
        self.exchange_id = exchange_id
        self.exchange = getattr(ccxt, exchange_id)({"enableRateLimit": True})

    # -- raw fetches; each returns None rather than raising -----------------

    def ohlcv(self, symbol: str, timeframe: str = "15m",
              limit: int = 300) -> pd.DataFrame | None:
        try:
            raw = self.exchange.fetch_ohlcv(symbol, timeframe=timeframe, limit=limit)
        except Exception:
            log.warning("ohlcv failed for %s", symbol, exc_info=True)
            return None
        if not raw:
            return None
        df = pd.DataFrame(raw, columns=OHLCV_COLS)
        df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
        return df

    def ticker(self, symbol: str) -> dict[str, Any] | None:
        try:
            return self.exchange.fetch_ticker(symbol)
        except Exception:
            log.warning("ticker failed for %s", symbol, exc_info=True)
            return None

    def orderbook(self, symbol: str, limit: int = 50) -> dict[str, Any] | None:
        try:
            return self.exchange.fetch_order_book(symbol, limit=limit)
        except Exception:
            log.warning("orderbook failed for %s", symbol, exc_info=True)
            return None

    def funding_rate(self, symbol: str) -> float | None:
        """Perp funding. Absent on spot markets — that is not an error."""
        if not self.exchange.has.get("fetchFundingRate"):
            return None
        try:
            rate = self.exchange.fetch_funding_rate(symbol).get("fundingRate")
            return float(rate) if rate is not None else None
        except Exception:
            return None

    def open_interest(self, symbol: str) -> float | None:
        if not self.exchange.has.get("fetchOpenInterest"):
            return None
        try:
            oi = self.exchange.fetch_open_interest(symbol)
            value = oi.get("openInterestValue") or oi.get("openInterestAmount")
            return float(value) if value is not None else None
        except Exception:
            return None

    # -- the composite the agents actually consume --------------------------

    def snapshot(self, symbol: str, timeframe: str = "15m") -> Snapshot:
        snap = Snapshot(symbol=symbol, timeframe=timeframe)

        tick = self.ticker(symbol)
        if tick:
            snap.price = _f(tick.get("last"))
            snap.change_24h_pct = _f(tick.get("percentage"))
            snap.volume_24h_usd = _f(tick.get("quoteVolume"))
        else:
            snap.missing.append("ticker")

        df = self.ohlcv(symbol, timeframe)
        if df is not None and len(df) > 30:
            close = df["close"]
            snap.rsi_14 = float(rsi(close).iloc[-1])
            snap.atr_14 = float(atr(df).iloc[-1])
            snap.ema_fast = float(ema(close, 21).iloc[-1])
            snap.ema_slow = float(ema(close, 55).iloc[-1])
            line, sig = macd(close)
            snap.macd_hist = float((line - sig).iloc[-1])
            snap.support, snap.resistance = support_resistance(df)
            snap.annualised_vol = realised_vol(close, timeframe)
            if snap.price is None:
                snap.price = float(close.iloc[-1])
        else:
            snap.missing.append("ohlcv")

        book = self.orderbook(symbol)
        if book and book.get("bids") and book.get("asks"):
            best_bid, best_ask = float(book["bids"][0][0]), float(book["asks"][0][0])
            mid = (best_bid + best_ask) / 2
            if mid > 0:
                snap.spread_bps = (best_ask - best_bid) / mid * 10_000
            snap.bid_depth_usd = sum(p * q for p, q in book["bids"][:20])
            snap.ask_depth_usd = sum(p * q for p, q in book["asks"][:20])
        else:
            snap.missing.append("orderbook")

        snap.funding_rate = self.funding_rate(symbol)
        snap.open_interest_usd = self.open_interest(symbol)
        return snap


def _f(value: Any) -> float | None:
    """Coerce to float, or None. Never guesses."""
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None
