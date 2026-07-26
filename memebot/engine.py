"""The engine: one cycle = discover -> manage exits -> rank -> safety-gate -> enter.

Paper mode fills on real live DexScreener prices minus a slippage+fee haircut, so
you can watch the exact strategy run on real tokens with zero money at risk. Live
mode (Jupiter swap + local signing with your key) is the next milestone and is
deliberately refused until we build and test it together with a tiny amount.

Portfolio state persists to state/ledger.json; every fill is appended to
state/trades.csv.
"""
from __future__ import annotations

import csv
import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

import httpx

from . import safety, sources, strategy
from .config import SOL_MINT, USDC_MINT, MemeConfig


# --------------------------------------------------------------- portfolio
@dataclass
class Position:
    mint: str
    symbol: str
    cost_usd: float      # USD put in (cost basis)
    tokens: float        # notional token units held (paper)
    entry: float         # fill price
    stop: float
    take_profit: float
    high: float          # highest price seen, for the trailing stop


@dataclass
class Portfolio:
    cash: float
    realized: float = 0.0
    positions: dict = field(default_factory=dict)

    def equity(self, prices: dict) -> float:
        v = self.cash
        for mint, p in self.positions.items():
            v += p.tokens * prices.get(mint, p.entry)
        return v

    @classmethod
    def load(cls, state_dir: str, starting_cash: float) -> "Portfolio":
        path = os.path.join(state_dir, "ledger.json")
        if os.path.exists(path):
            with open(path) as f:
                d = json.load(f)
            pf = cls(cash=d["cash"], realized=d.get("realized", 0.0))
            for mint, pd in (d.get("positions") or {}).items():
                pf.positions[mint] = Position(**pd)
            return pf
        return cls(cash=starting_cash)

    def save(self, state_dir: str) -> None:
        os.makedirs(state_dir, exist_ok=True)
        d = {
            "cash": self.cash,
            "realized": self.realized,
            "positions": {m: asdict(p) for m, p in self.positions.items()},
        }
        with open(os.path.join(state_dir, "ledger.json"), "w") as f:
            json.dump(d, f, indent=2)


def _log_trade(state_dir: str, row: dict) -> None:
    os.makedirs(state_dir, exist_ok=True)
    path = os.path.join(state_dir, "trades.csv")
    new = not os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(
            f, fieldnames=["ts", "symbol", "mint", "side", "usd", "price", "reason", "pnl"])
        if new:
            w.writeheader()
        w.writerow(row)


# ------------------------------------------------------------------- engine
class Engine:
    def __init__(self, cfg: MemeConfig):
        self.cfg = cfg
        self.client = httpx.Client(headers={"User-Agent": "memebot/0.1"})
        self.pf = Portfolio.load(cfg.state_dir, cfg.risk.bankroll)
        self.day = None
        self.day_start_equity = None
        if cfg.mode == "live":
            self._require_live_ready()

    def _require_live_ready(self) -> None:
        armed = bool(self.cfg.private_key) and self.cfg.live_arm == "I_UNDERSTAND"
        if not armed:
            raise RuntimeError(
                "LIVE refused: set SOLANA_PRIVATE_KEY and BOT_LIVE_ARM='I_UNDERSTAND'.")
        # Even when armed, on-chain execution isn't wired yet — fail loudly rather
        # than silently doing nothing or (worse) mishandling a real transaction.
        raise RuntimeError(
            "Live execution (Jupiter swap + local signing) is not wired yet. Run in "
            "paper mode (MEME_MODE=paper). We build and test the live path together, "
            "with a tiny amount, as the next step.")

    # ---- pricing helpers ----
    def _sol_price_usd(self) -> float:
        q = sources.jupiter_quote(self.client, SOL_MINT, USDC_MINT, int(1e9), 50)
        if q and q.get("outAmount"):
            return int(q["outAmount"]) / 1e6
        return 150.0  # conservative fallback if the quote endpoint hiccups

    # ---- one cycle ----
    def step(self):
        cfg = self.cfg
        candidates: list[sources.Candidate] = []
        if cfg.hunt_established:
            candidates += sources.discover_established(self.client, cfg.safety.min_liq_established)
        if cfg.hunt_fresh:
            candidates += sources.discover_fresh(self.client, cfg.safety.min_liq_fresh)

        uniq: dict[str, sources.Candidate] = {}
        for c in candidates:
            uniq.setdefault(c.mint, c)
        candidates = list(uniq.values())[:cfg.max_candidates]

        prices = {c.mint: c.price_usd for c in candidates}
        for mint in list(self.pf.positions):          # ensure held names are priced
            if mint not in prices:
                prices[mint] = sources.token_price(self.client, mint) or self.pf.positions[mint].entry

        equity = self.pf.equity(prices)
        today = datetime.now(timezone.utc).date()
        if self.day != today:
            self.day, self.day_start_equity = today, equity
        halted = bool(self.day_start_equity) and \
            equity <= self.day_start_equity * (1 - cfg.risk.daily_loss_halt_pct)

        self._manage_exits(prices)

        if not halted and len(self.pf.positions) < cfg.risk.max_positions:
            self._enter(candidates, equity)

        self.pf.save(cfg.state_dir)
        return equity, halted, len(candidates)

    def _manage_exits(self, prices: dict) -> None:
        cfg = self.cfg
        for mint in list(self.pf.positions):
            p = self.pf.positions[mint]
            px = prices.get(mint, p.entry)
            p.high = max(p.high, px)
            reason = None
            if px <= p.stop:
                reason = "stop-loss"
            elif px >= p.take_profit:
                reason = "take-profit"
            elif px > p.entry and px <= p.high * (1 - cfg.risk.trailing_pct):
                reason = "trailing-stop"
            if reason:
                self._paper_sell(mint, px, reason)

    def _enter(self, candidates: list, equity: float) -> None:
        cfg = self.cfg
        sol_price = self._sol_price_usd()
        ranked = sorted(
            (c for c in candidates
             if strategy.wants_entry(c) and c.mint not in self.pf.positions),
            key=strategy.score, reverse=True)
        for c in ranked:
            if len(self.pf.positions) >= cfg.risk.max_positions:
                break
            plan = strategy.make_plan(c, equity, cfg.risk)
            if not plan:
                continue
            if plan.usd_size * (1 + cfg.taker_fee) > self.pf.cash:
                continue
            verdict = safety.assess(self.client, c, cfg.safety, plan.usd_size,
                                    sol_price, cfg.slippage_bps)
            if not verdict.ok:
                continue
            self._paper_buy(c, plan)

    # ---- paper fills (real prices, simulated execution) ----
    def _haircut(self) -> float:
        return self.cfg.taker_fee + self.cfg.slippage_bps / 20000.0

    def _paper_buy(self, c: "sources.Candidate", plan: "strategy.Plan") -> None:
        fill = plan.entry * (1 + self._haircut())
        tokens = plan.usd_size / fill
        self.pf.cash -= plan.usd_size
        self.pf.positions[c.mint] = Position(
            mint=c.mint, symbol=c.symbol, cost_usd=plan.usd_size, tokens=tokens,
            entry=fill, stop=plan.stop, take_profit=plan.take_profit, high=fill)
        self._log(c.symbol, c.mint, "buy", plan.usd_size, fill, f"entry:{c.bucket}", 0.0)

    def _paper_sell(self, mint: str, px: float, reason: str) -> None:
        p = self.pf.positions[mint]
        fill = px * (1 - self._haircut())
        proceeds = p.tokens * fill
        pnl = proceeds - p.cost_usd
        self.pf.cash += proceeds
        self.pf.realized += pnl
        self._log(p.symbol, mint, "sell", proceeds, fill, reason, pnl)
        del self.pf.positions[mint]

    def _log(self, symbol, mint, side, usd, price, reason, pnl) -> None:
        _log_trade(self.cfg.state_dir, {
            "ts": datetime.now(timezone.utc).isoformat(),
            "symbol": symbol, "mint": mint, "side": side,
            "usd": round(usd, 4), "price": round(price, 12),
            "reason": reason, "pnl": round(pnl, 4),
        })
