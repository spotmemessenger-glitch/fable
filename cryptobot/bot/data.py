"""Market data feed via CCXT.

Price/OHLCV endpoints are public — no API key required. The same exchange
object is reused (rate-limited) for the whole run.
"""
from __future__ import annotations

import ccxt
import pandas as pd

OHLCV_COLS = ["ts", "open", "high", "low", "close", "volume"]


class DataFeed:
    def __init__(self, exchange_id: str = "binance"):
        self.exchange = getattr(ccxt, exchange_id)({"enableRateLimit": True})

    def ohlcv(self, symbol: str, timeframe: str = "5m", limit: int = 200) -> pd.DataFrame:
        raw = self.exchange.fetch_ohlcv(symbol, timeframe=timeframe, limit=limit)
        df = pd.DataFrame(raw, columns=OHLCV_COLS)
        df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
        return df

    def price(self, symbol: str) -> float:
        return float(self.exchange.fetch_ticker(symbol)["last"])
