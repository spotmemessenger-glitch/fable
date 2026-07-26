"""The trading engine: scan -> signal -> manage/exit -> risk-size -> enter -> log.

One `step()` evaluates every symbol once. `run.py` calls it on a loop. The same
engine runs in paper and live mode; only the broker differs.
"""
from __future__ import annotations

from datetime import datetime, timezone

from .broker import Fill, LiveBroker, PaperBroker
from .config import BotConfig
from .data import DataFeed
from .portfolio import Portfolio, Position, log_trade
from .risk import daily_halt, plan_entry
from .strategy import evaluate


class Engine:
    def __init__(self, cfg: BotConfig):
        self.cfg = cfg
        self.feed = DataFeed(cfg.exchange_id)
        self.pf = Portfolio.load(cfg.state_dir, cfg.starting_cash)
        self.broker = self._make_broker()
        self.day = None
        self.day_start_equity = None

    def _make_broker(self):
        if self.cfg.mode == "live":
            armed = bool(self.cfg.api_key and self.cfg.api_secret
                         and self.cfg.live_arm == "I_UNDERSTAND")
            return LiveBroker(self.cfg.exchange_id, self.cfg.api_key,
                              self.cfg.api_secret, self.cfg.taker_fee, armed)
        return PaperBroker(self.cfg.taker_fee, self.cfg.slippage)

    def _prices(self) -> dict[str, float]:
        return {s: self.feed.price(s) for s in self.cfg.symbols}

    def _log(self, fill: Fill, reason: str, pnl: float = 0.0) -> None:
        log_trade(self.cfg.state_dir, {
            "ts": datetime.now(timezone.utc).isoformat(),
            "symbol": fill.symbol, "side": fill.side,
            "qty": round(fill.qty, 8), "price": round(fill.price, 6),
            "fee": round(fill.fee, 6), "reason": reason, "pnl": round(pnl, 6),
        })

    def step(self):
        cfg = self.cfg
        prices = self._prices()
        equity = self.pf.equity(prices)

        today = datetime.now(timezone.utc).date()
        if self.day != today:
            self.day, self.day_start_equity = today, equity
        halted = daily_halt(self.day_start_equity, equity, cfg.risk)

        for sym in cfg.symbols:
            df = self.feed.ohlcv(sym, cfg.timeframe, cfg.candles)
            sig = evaluate(sym, df, cfg.strategy)
            price = prices[sym]
            pos = self.pf.positions.get(sym)

            if pos:  # manage an open position first
                reason = None
                if price <= pos.stop:
                    reason = "stop-loss"
                elif price >= pos.take_profit:
                    reason = "take-profit"
                elif sig.action == "sell":
                    reason = sig.reason
                if reason:
                    fill = self.broker.market(sym, "sell", pos.qty, price)
                    proceeds = fill.qty * fill.price - fill.fee
                    pnl = proceeds - pos.qty * pos.avg_price
                    self.pf.cash += proceeds
                    self.pf.realized_pnl += pnl
                    del self.pf.positions[sym]
                    self._log(fill, reason, pnl)
                continue

            if halted or sig.action != "buy":
                continue
            plan = plan_entry(sym, price, sig.atr, equity, cfg.risk)
            if not plan or (plan.qty * price + plan.qty * price * cfg.taker_fee) > self.pf.cash:
                continue
            fill = self.broker.market(sym, "buy", plan.qty, price)
            self.pf.cash -= (fill.qty * fill.price + fill.fee)
            self.pf.positions[sym] = Position(
                sym, fill.qty, fill.price, plan.stop, plan.take_profit)
            self._log(fill, sig.reason)

        self.pf.save(cfg.state_dir)
        return equity, halted
