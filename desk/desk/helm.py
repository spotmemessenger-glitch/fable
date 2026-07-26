"""HELM — the orchestrator, and the only seat that speaks to the operator.

One command in, one synthesized answer out. HELM fetches the deterministic
snapshot, runs each wing, lets CASSANDRA argue with the result, weighs every
seat by LEDGER's record, sizes through SENTINEL, and — only when told to and
only when SENTINEL approves — has PILOT place the order. It never does a
specialist's analysis itself.

Paper is the default and the floor. execute=True still routes through
settings.mode, which is "paper" unless all three live switches are set.
"""
from __future__ import annotations

import logging
import time
from typing import Any

from . import narrate
from .agents import solana
from .agents.base import DeskContext
from .brain import DeskBrains
from .agents.book import Chartist, Sigma
from .agents.flow import Coil, Kraken, Tide
from .agents.guard import Ledger, Pilot, Ruling, Sentinel
from .agents.memes import Ballast, Geiger, Hound, Viper
from .agents.truth import Cassandra, Vesta
from .config import Settings
from .market import Market, Snapshot
from .portfolio import Portfolio
from .roster import BY_NAME
from .wallet import Wallet

log = logging.getLogger(__name__)

NON_DIRECTIONAL = {"SENTINEL", "PILOT", "LEDGER"}


class Helm:
    """The conductor. Owns the market feed, the book, and every seat."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.market = Market(settings.exchange_id)
        self.portfolio = Portfolio.load(settings.starting_cash, settings.state_dir)

        self.cex_seats = {
            "TIDE": Tide(BY_NAME["TIDE"]),
            "KRAKEN": Kraken(BY_NAME["KRAKEN"]),
            "COIL": Coil(BY_NAME["COIL"]),
            "CHARTIST": Chartist(BY_NAME["CHARTIST"]),
            "SIGMA": Sigma(BY_NAME["SIGMA"]),
            "VESTA": Vesta(BY_NAME["VESTA"]),
        }
        self.cassandra = Cassandra(BY_NAME["CASSANDRA"])
        self.sentinel = Sentinel(BY_NAME["SENTINEL"])
        self.pilot = Pilot(BY_NAME["PILOT"])
        self.ledger = Ledger(BY_NAME["LEDGER"], settings.state_dir)
        self.meme_seats = {"HOUND": Hound(BY_NAME["HOUND"]),
                           "GEIGER": Geiger(BY_NAME["GEIGER"]),
                           "BALLAST": Ballast(BY_NAME["BALLAST"]),
                           "VIPER": Viper(BY_NAME["VIPER"])}
        self.wallet = Wallet(settings)   # the meme wing's hands; read-only until armed

        # entry signals per open symbol, so LEDGER can score seats on the exit
        self._open_signals: dict[str, dict[str, float]] = {}

        # Conversational layer. Read-only over the desk: brains talk ABOUT
        # readings and can never produce one, so nothing here can move money.
        self.brains = DeskBrains(settings)
        self._last_readings: dict[str, Any] = {}
        self._last_symbol: str = ""

    # -- pricing -----------------------------------------------------------

    def _mark_prices(self, extra: str | None = None) -> dict[str, float | None]:
        wanted = set(self.portfolio.positions) | set(self.settings.symbols)
        if extra:
            wanted.add(extra)
        prices: dict[str, float | None] = {}
        for symbol in wanted:
            tick = self.market.ticker(symbol)
            prices[symbol] = float(tick["last"]) if tick and tick.get("last") else None
        return prices

    # -- analysis ----------------------------------------------------------

    def analyse(self, symbol: str) -> tuple[DeskContext, float, Ruling]:
        snap = self.market.snapshot(symbol, self.settings.timeframe)
        frame = self.market.ohlcv(symbol, self.settings.timeframe)
        prices = self._mark_prices(symbol)
        if snap.price is not None:
            prices[symbol] = snap.price

        ctx = DeskContext(market=self.market, settings=self.settings,
                          portfolio=self.portfolio, symbol=symbol, snapshot=snap,
                          frame=frame, prices=prices)

        for name, agent in self.cex_seats.items():
            ctx.readings[name] = agent.collect(ctx)
        ctx.readings["CASSANDRA"] = self.cassandra.collect(ctx)   # after the others
        ctx.readings["SENTINEL"] = self.sentinel.collect(ctx)
        ctx.readings["PILOT"] = self.pilot.collect(ctx)
        ctx.readings["LEDGER"] = self.ledger.collect(ctx)

        ctx.weights = self.ledger.weights(list(ctx.readings))
        consensus = self._consensus(ctx)
        ruling = self.sentinel.vet(ctx, consensus)
        return ctx, consensus, ruling

    def _consensus(self, ctx: DeskContext) -> float:
        """LEDGER-weighted, confidence-weighted mean of the directional seats."""
        num = den = 0.0
        for name, r in ctx.readings.items():
            if not r.usable or name in NON_DIRECTIONAL:
                continue
            weight = ctx.weights.get(name, 1.0) * r.confidence
            num += weight * r.signal
            den += weight
        return num / den if den else 0.0

    # -- the operator-facing verbs ----------------------------------------

    def look(self, symbol: str) -> dict[str, Any]:
        """Full analysis of one symbol. No execution."""
        ctx, consensus, ruling = self.analyse(symbol)
        return self._report(ctx, consensus, ruling, action="watch")

    def cycle(self, symbol: str, *, execute: bool = False) -> dict[str, Any]:
        """Manage open stops, analyse, and optionally act on the result."""
        self.manage_stops()
        ctx, consensus, ruling = self.analyse(symbol)
        action = "watch"

        held = symbol in self.portfolio.positions
        if execute and ruling.approved and not held and consensus > 0:
            fill = self.pilot.execute(ctx, "buy", ruling, wing="cex",
                                      thesis=f"consensus {consensus:+.2f}")
            self._open_signals[symbol] = {
                n: r.signal for n, r in ctx.readings.items()
                if r.usable and n not in NON_DIRECTIONAL}
            self.ledger.journal({
                "event": "entry", "symbol": symbol, "mode": fill.mode,
                "consensus": round(consensus, 3), "price": fill.price, "qty": fill.qty,
                "readings": {n: r.as_dict() for n, r in ctx.readings.items()}})
            self.portfolio.save()
            action = "bought"

        # Journal EVERY call, not only the ones that became trades. A seat that
        # said "short" while Sentinel stood aside was still right or wrong, and
        # that is most of the evidence — in a quiet market the desk may decline
        # for days, and without this the journal stays empty and no seat ever
        # earns or loses weight. Price is stamped so forward returns can score
        # these observations later.
        self.ledger.journal({
            "event": "observation",
            "symbol": symbol,
            "ts": time.time(),
            "price": self._mark_prices().get(symbol),
            "consensus": round(consensus, 3),
            "approved": ruling.approved,
            "reason": ruling.reasons[0] if ruling.reasons else "",
            "action": action,
            "signals": {n: round(r.signal, 3) for n, r in ctx.readings.items() if r.usable},
            "confidence": {n: round(r.confidence, 2) for n, r in ctx.readings.items() if r.usable},
        })

        return self._report(ctx, consensus, ruling, action=action)

    def manage_stops(self) -> list[dict[str, Any]]:
        """Exit any position whose stop or take the price has crossed."""
        if not self.portfolio.positions:
            return []
        prices = self._mark_prices()
        exits: list[dict[str, Any]] = []
        for symbol, kind, _level in self.portfolio.breached(prices):
            snap = self.market.snapshot(symbol, self.settings.timeframe)
            ctx = DeskContext(market=self.market, settings=self.settings,
                              portfolio=self.portfolio, symbol=symbol, snapshot=snap,
                              prices=prices)
            position = self.portfolio.positions[symbol]
            mark = prices.get(symbol) or position.entry
            fill = self.pilot.execute(
                ctx, "sell", Ruling(True, qty=position.qty, price=mark),
                thesis=f"{kind} hit")
            entry_sig = self._open_signals.pop(symbol, {})
            if entry_sig:
                self.ledger.score_close(entry_sig, fill.pnl > 0)
            self.ledger.journal({"event": "exit", "symbol": symbol, "reason": kind,
                                 "pnl": round(fill.pnl, 2), "mode": fill.mode})
            exits.append({"symbol": symbol, "reason": kind, "pnl": fill.pnl})
        if exits:
            self.portfolio.save()
        return exits

    def scan(self, *, execute: bool = False) -> list[dict[str, Any]]:
        """Run every configured symbol once."""
        return [self.cycle(sym, execute=execute) for sym in self.settings.symbols]

    def scan_memes(self, limit: int = 8, *, execute: bool = False) -> list[dict[str, Any]]:
        """Hunt Solana memecoins: HOUND finds, GEIGER gates, BALLAST sizes, VIPER checks.

        Analysis by default. With execute=True and the wallet armed, a GO
        candidate is bought through the wallet (BALLAST sizes it). Unarmed, the
        trade result just reports why nothing was sent — it is never a silent
        no-op, and the analysis still runs.
        """
        prices = self._mark_prices()
        results: list[dict[str, Any]] = []
        seen: set[str] = set()

        for mint in solana.dexscreener_boosted(limit):
            if mint in seen:                 # the boosted feed repeats mints
                continue
            seen.add(mint)
            token = solana.dexscreener_token(mint)
            if not token:
                continue
            token["rugcheck"] = solana.rugcheck_summary(mint)
            token["rugcheck_report"] = solana.rugcheck_report(mint)
            token["jupiter"] = solana.jupiter_quote(mint, 50.0)   # $50 test clip

            snap = Snapshot(symbol=token.get("symbol") or mint, timeframe="dex",
                            price=token.get("price_usd"))
            ctx = DeskContext(market=self.market, settings=self.settings,
                              portfolio=self.portfolio, symbol=token.get("symbol") or mint,
                              snapshot=snap, prices=prices, meme=token)
            for name, agent in self.meme_seats.items():
                ctx.readings[name] = agent.collect(ctx)

            geiger = ctx.readings["GEIGER"]
            ballast = ctx.readings["BALLAST"]
            viper = ctx.readings["VIPER"]
            hound = ctx.readings["HOUND"]
            safe = bool(geiger.metrics.get("passed")) and ballast.signal > -1 \
                and viper.signal > -0.4
            verdict = "GO" if (safe and hound.signal > 0.2) else "PASS"

            trade = self._buy_meme(mint, token, ballast) \
                if (execute and verdict == "GO") else None

            results.append({
                "mint": mint, "symbol": token.get("symbol"), "verdict": verdict,
                "readings": {n: r.as_dict() for n, r in ctx.readings.items()},
                "trade": trade,
                "narration": narrate.compose(token.get("symbol") or mint,
                                             hound.signal, Ruling(safe), ctx.readings,
                                             "watch")})
        return results

    def _buy_meme(self, mint: str, token: dict[str, Any], ballast: Any) -> dict[str, Any]:
        """Route a GO candidate through the wallet, sized by BALLAST and cash.

        Returns the wallet's swap result. Unarmed or underfunded, executed is
        False with a reason — the same honest contract as the CEX path.
        """
        per_name = float(ballast.metrics.get("per_name_usd") or 0.0)
        usdc = self.wallet.token_balance() or 0.0
        size = min(per_name, usdc)
        result = self.wallet.swap(mint, size)
        if result.get("executed"):
            self.ledger.journal({
                "event": "meme_buy", "mint": mint, "symbol": token.get("symbol"),
                "usdc": size, "signature": result.get("signature"),
                "out_amount": result.get("out_amount")})
        return result

    def wallet_status(self) -> dict[str, Any]:
        """The Solana wallet: address, arm state, and live balances."""
        bal = self.wallet.balances()
        return {"address": self.wallet.address, "armed": self.wallet.armed,
                "rpc": self.wallet.rpc, "sol": bal["sol"], "usdc": bal["usdc"]}

    # -- reporting ---------------------------------------------------------

    # -- conversation ------------------------------------------------------

    def ask(self, question: str, seat: str | None = None) -> dict[str, Any]:
        """Put a question to the desk; the right seat answers in its own words.

        Answers are grounded in the readings from the last analyse() — a seat
        that has not looked at anything yet says so rather than improvising.
        Run look()/cycle() first to give the seats something to talk about.
        """
        return self.brains.ask(
            question,
            readings=self._last_readings,
            portfolio=self.book(),
            seat=seat,
            symbol=self._last_symbol,
        )

    # -- reporting ---------------------------------------------------------

    def _report(self, ctx: DeskContext, consensus: float, ruling: Ruling,
                action: str) -> dict[str, Any]:
        # Cache the live Readings so the conversational layer can answer from
        # real numbers instead of memory.
        self._last_readings = dict(ctx.readings)
        self._last_symbol = ctx.symbol
        top_facts: list[str] = []
        for r in ctx.readings.values():
            if r.usable:
                top_facts.extend(r.facts[:1])
        line = narrate.compose(ctx.symbol, consensus, ruling, ctx.readings, action)
        line = narrate.llm_polish(line, top_facts, self.settings, ctx.language)
        voice_path = narrate.speak("HELM", line, self.settings)
        return {
            "symbol": ctx.symbol, "mode": self.settings.mode,
            "consensus": round(consensus, 3), "approved": ruling.approved,
            "ruling": ruling.reasons, "action": action,
            "readings": {n: r.as_dict() for n, r in ctx.readings.items()},
            "narration": line, "voice": str(voice_path) if voice_path else None,
        }

    def book(self) -> dict[str, Any]:
        prices = self._mark_prices()
        return {
            "mode": self.settings.mode,
            "cash": round(self.portfolio.cash, 2),
            "equity": round(self.portfolio.equity(prices), 2),
            "realised": round(self.portfolio.realised, 2),
            "unrealised": round(self.portfolio.unrealised(prices), 2),
            "positions": [
                {"symbol": s, "qty": p.qty, "entry": p.entry,
                 "price": prices.get(s), "pnl": round(p.pnl(prices.get(s) or p.entry), 2),
                 "pnl_pct": round(p.pnl_pct(prices.get(s) or p.entry), 2),
                 "stop": p.stop, "take": p.take, "wing": p.wing}
                for s, p in self.portfolio.positions.items()],
        }
