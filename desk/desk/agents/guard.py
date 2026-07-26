"""GUARD wing — risk, execution, memory. Shared by every market.

SENTINEL sizes and vetoes; its gates are the frozen limits in config.py, never
a model's output. PILOT owns the only code path that touches an exchange —
paper by default, a real CCXT order only when all three live switches are set.
LEDGER journals every decision and scores each seat so conviction is earned.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import ccxt

from .base import Agent, DeskContext, Reading
from ..portfolio import Fill, utcnow, utctoday


@dataclass
class Ruling:
    """SENTINEL's verdict on a proposed entry. approved=False means no trade."""

    approved: bool
    qty: float = 0.0
    price: float = 0.0
    stop: float | None = None
    take: float | None = None
    notional: float = 0.0
    reasons: list[str] = field(default_factory=list)


class Sentinel(Agent):
    """Risk officer. Sizes every position, sets every stop, holds the veto."""

    def collect(self, ctx: DeskContext) -> Reading:
        p = ctx.portfolio
        lim = ctx.settings.limits
        eq = p.equity(ctx.prices)
        exp = p.exposure_usd(ctx.prices)
        day = p.day_pnl_pct(ctx.prices)
        halted = p.halted_until == utctoday()

        facts = [
            f"equity ${eq:,.0f}",
            f"exposure {(exp / eq * 100) if eq else 0:.0f}% of "
            f"{lim.max_total_exposure_pct * 100:.0f}% cap",
            f"day P&L {day:+.2f}% (halt at −{lim.daily_loss_limit_pct * 100:.0f}%)",
        ]
        if halted:
            facts.append("DESK HALTED for the rest of the UTC day")
        metrics = {"equity": round(eq, 2), "exposure_usd": round(exp, 2),
                   "day_pnl_pct": round(day, 2), "halted": halted}
        return self.ok(0.0, 0.9, metrics, facts)      # risk officer isn't directional

    def vet(self, ctx: DeskContext, signal: float, wing: str = "cex",
            cap_usd: float | None = None) -> Ruling:
        """Turn a desk signal into a sized order — or a documented refusal.

        Every gate here is a hard limit from config.py. No argument, no model
        output, and no conviction anywhere can widen them.
        """
        lim = ctx.settings.limits
        s = ctx.snapshot
        p = ctx.portfolio
        price = s.price
        if price is None:
            return Ruling(False, reasons=["no price"])

        p.roll_day(ctx.prices)
        if p.halted_until == utctoday():
            return Ruling(False, price=price, reasons=["daily-loss halt in force"])

        day = p.day_pnl_pct(ctx.prices)
        if day <= -lim.daily_loss_limit_pct * 100:
            p.halted_until = utctoday()
            return Ruling(False, price=price,
                          reasons=[f"daily loss {day:.2f}% hit the limit — desk halted"])

        if signal < lim.min_conviction:
            return Ruling(False, price=price,
                          reasons=[f"conviction {signal:.2f} < floor {lim.min_conviction}"])

        if s.volume_24h_usd is not None and s.volume_24h_usd < lim.min_24h_volume_usd:
            return Ruling(False, price=price,
                          reasons=[f"24h volume ${s.volume_24h_usd:,.0f} below liquidity floor"])
        if s.annualised_vol is not None and s.annualised_vol > lim.max_annualised_vol:
            return Ruling(False, price=price,
                          reasons=[f"volatility {s.annualised_vol:.2f} over ceiling"])
        if s.spread_bps is not None and s.spread_bps > lim.max_spread_bps:
            return Ruling(False, price=price,
                          reasons=[f"spread {s.spread_bps:.1f}bps over ceiling"])

        eq = p.equity(ctx.prices)
        room = lim.max_total_exposure_pct * eq - p.exposure_usd(ctx.prices)
        if room <= 0:
            return Ruling(False, price=price, reasons=["total-exposure cap reached"])

        ceiling = min(lim.max_position_pct * eq, room, p.cash)
        if cap_usd is not None:
            ceiling = min(ceiling, cap_usd)          # BALLAST's per-name meme cap
        if ceiling <= 10:
            return Ruling(False, price=price, reasons=["no sizing room or cash"])

        atr = s.atr_14 or (price * 0.03)
        stop = price - lim.stop_atr_multiple * atr
        take = price + 2 * (price - stop)            # 2R target

        notional = ceiling * min(1.0, 0.4 + 0.6 * signal)   # scale into conviction
        qty = notional / price
        reasons = [f"sized ${notional:,.0f}, stop {stop:.4g} "
                   f"({lim.stop_atr_multiple:g}×ATR), take {take:.4g} (2R)"]
        return Ruling(True, qty=qty, price=price, stop=stop, take=take,
                      notional=notional, reasons=reasons)


class Pilot(Agent):
    """Execution and microstructure. The only seat that touches an exchange."""

    def __init__(self, seat: Any) -> None:
        super().__init__(seat)
        self._live: Any = None

    def collect(self, ctx: DeskContext) -> Reading:
        s = ctx.snapshot
        if s.spread_bps is None:
            return self.nodata("orderbook")
        facts = [f"spread {s.spread_bps:.2f} bps"]
        if s.bid_depth_usd and s.ask_depth_usd:
            facts.append(f"depth bid ${s.bid_depth_usd:,.0f} / ask ${s.ask_depth_usd:,.0f}")
        return self.ok(0.0, 0.8, {"spread_bps": s.spread_bps}, facts)

    def _live_exchange(self, ctx: DeskContext) -> Any:
        """Authenticated exchange — built only when live arming is complete."""
        if self._live is None:
            self._live = getattr(ccxt, ctx.settings.exchange_id)({
                "apiKey": os.environ["DESK_API_KEY"],
                "secret": os.environ["DESK_API_SECRET"],
                "enableRateLimit": True,
            })
        return self._live

    def execute(self, ctx: DeskContext, side: str, ruling: Ruling, *,
                wing: str = "cex", thesis: str = "") -> Fill:
        """Place the order. Real only if settings.mode == 'live'; else paper."""
        p = ctx.portfolio
        mode = ctx.settings.mode
        symbol = ctx.symbol

        if mode == "live":
            exchange = self._live_exchange(ctx)
            order = exchange.create_order(symbol, "market", side, ruling.qty)
            fill_price = float(order.get("average") or order.get("price") or ruling.price)
            order_id = str(order.get("id", ""))
        else:
            half_spread = (ctx.snapshot.spread_bps or 2.0) / 10_000 / 2
            fill_price = ruling.price * (1 + half_spread) if side == "buy" \
                else ruling.price * (1 - half_spread)
            order_id = "paper"

        if side == "buy":
            return p.buy(symbol, ruling.qty, fill_price, mode=mode, stop=ruling.stop,
                         take=ruling.take, wing=wing, thesis=thesis, order_id=order_id)
        return p.sell(symbol, fill_price, mode=mode, reason=thesis, order_id=order_id)


class Ledger(Agent):
    """The book — journals every call and scores each seat's track record."""

    def __init__(self, seat: Any, state_dir: Path) -> None:
        super().__init__(seat)
        self.state_dir = Path(state_dir)
        self.journal_path = self.state_dir / "journal.jsonl"
        self.score_path = self.state_dir / "scorecard.json"
        self.scores: dict[str, dict[str, float]] = self._load_scores()

    def collect(self, ctx: DeskContext) -> Reading:
        p = ctx.portfolio
        closed = [f for f in p.fills if f.side == "sell"]
        wins = [f for f in closed if f.pnl > 0]
        win_rate = (len(wins) / len(closed) * 100) if closed else 0.0
        facts = [f"realised ${p.realised:+,.2f}",
                 f"{len(closed)} closed, {win_rate:.0f}% win rate"]
        if self.scores:
            worst = min(self.scores.items(), key=lambda kv: kv[1].get("weight", 1.0))
            if worst[1].get("weight", 1.0) < 0.9:
                facts.append(f"downweighting {worst[0]} "
                             f"(weight {worst[1]['weight']:.2f})")
        return self.ok(0.0, 0.9, {"win_rate": round(win_rate, 1),
                                  "realised": round(p.realised, 2)}, facts)

    # -- calibration -------------------------------------------------------

    def weight(self, name: str) -> float:
        return self.scores.get(name, {}).get("weight", 1.0)

    def weights(self, names: list[str]) -> dict[str, float]:
        return {n: self.weight(n) for n in names}

    def score_close(self, entry_signals: dict[str, float], won: bool) -> None:
        """Reward seats that were on the right side of a closed trade.

        Weight is a bounded record of correctness, not a prompt — a seat that
        keeps calling it wrong loses vote share, and earns it back the same way.
        """
        for name, sig in entry_signals.items():
            if abs(sig) < 0.1:
                continue
            right = (sig > 0) == won
            rec = self.scores.setdefault(name, {"correct": 0.0, "total": 0.0, "weight": 1.0})
            rec["total"] += 1
            rec["correct"] += 1.0 if right else 0.0
            hit = rec["correct"] / rec["total"]
            rec["weight"] = round(0.5 + hit, 3)      # 0.5 (never right) .. 1.5 (always)
        self._save_scores()

    # -- journal -----------------------------------------------------------

    def journal(self, entry: dict[str, Any]) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        entry = {"ts": utcnow(), **entry}
        with self.journal_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")

    def _load_scores(self) -> dict[str, dict[str, float]]:
        if not self.score_path.exists():
            return {}
        try:
            return json.loads(self.score_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def _save_scores(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.score_path.write_text(json.dumps(self.scores, indent=2), encoding="utf-8")
