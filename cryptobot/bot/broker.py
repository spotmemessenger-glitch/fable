"""Execution layer.

PaperBroker simulates fills (price + slippage, minus fee). LiveBroker places
real CCXT market orders and is *refused* unless the account is explicitly armed
with keys + BOT_LIVE_ARM='I_UNDERSTAND'. Both expose the same `market()` call so
the engine is identical in paper and live.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Fill:
    symbol: str
    side: str      # "buy" | "sell"
    qty: float
    price: float
    fee: float


class PaperBroker:
    def __init__(self, taker_fee: float, slippage: float):
        self.taker_fee = taker_fee
        self.slippage = slippage

    def market(self, symbol: str, side: str, qty: float, price: float) -> Fill:
        slip = self.slippage if side == "buy" else -self.slippage
        fill_price = price * (1 + slip)
        fee = fill_price * qty * self.taker_fee
        return Fill(symbol, side, qty, fill_price, fee)


class LiveBroker:
    def __init__(self, exchange_id: str, api_key: str, api_secret: str,
                 taker_fee: float, armed: bool):
        if not armed:
            raise RuntimeError(
                "LiveBroker refused. To trade REAL money set BOT_API_KEY, "
                "BOT_API_SECRET and BOT_LIVE_ARM='I_UNDERSTAND'."
            )
        import ccxt
        self.exchange = getattr(ccxt, exchange_id)(
            {"apiKey": api_key, "secret": api_secret, "enableRateLimit": True})
        self.taker_fee = taker_fee

    def market(self, symbol: str, side: str, qty: float, price: float) -> Fill:
        order = self.exchange.create_order(symbol, "market", side, qty)
        fill_price = float(order.get("average") or order.get("price") or price)
        filled = float(order.get("filled") or qty)
        fee = fill_price * filled * self.taker_fee
        return Fill(symbol, side, filled, fill_price, fee)
