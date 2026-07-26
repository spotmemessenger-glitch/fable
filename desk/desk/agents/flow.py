"""FLOW wing — positioning and regime.

TIDE reads the macro weather (same for every symbol). KRAKEN reads order-book
pressure and relative volume. COIL reads the derivatives surface — the seat an
equities desk cannot have — and honestly reports no-data on a spot market.
"""
from __future__ import annotations

from .base import Agent, DeskContext, Reading, clamp
from ..web import fear_greed, global_stats, stablecoin_supply


def _fg_label(value: int) -> str:
    if value < 25:
        return "extreme fear"
    if value < 45:
        return "fear"
    if value < 55:
        return "neutral"
    if value < 75:
        return "greed"
    return "extreme greed"


class Tide(Agent):
    """Market regime — risk-on, risk-off, or chop."""

    def collect(self, ctx: DeskContext) -> Reading:
        fg = fear_greed()
        g = global_stats()
        st = stablecoin_supply()
        if fg is None and g is None and st is None:
            return self.nodata("fear&greed", "coingecko", "defillama")

        comps: list[float] = []
        facts: list[str] = []
        missing: list[str] = []
        metrics: dict[str, float] = {}

        if fg is not None:
            # contrarian at the extremes, mild trend-follow in the middle
            c = -clamp((fg - 50) / 50) if (fg > 75 or fg < 25) else clamp((fg - 50) / 80)
            comps.append(c)
            facts.append(f"Fear & Greed {fg} ({_fg_label(fg)})")
            metrics["fear_greed"] = fg
        else:
            missing.append("fear&greed")

        if g is not None:
            comps.append(clamp(g["mcap_change_24h_pct"] / 6))
            facts.append(f"total mcap {g['mcap_change_24h_pct']:+.2f}% 24h; "
                         f"BTC dominance {g['btc_dominance']:.1f}%")
            metrics.update(g)
        else:
            missing.append("coingecko")

        if st is not None:
            comps.append(clamp(st["change_pct"] * 3))      # supply growing = dry powder
            verb = "building" if st["change_pct"] > 0 else "leaving"
            facts.append(f"stablecoin supply {st['change_pct']:+.2f}% → dry powder {verb}")
            metrics["stable_change_pct"] = st["change_pct"]
        else:
            missing.append("defillama")

        signal = sum(comps) / len(comps)
        conf = clamp(0.4 + 0.15 * len(comps), 0.3, 0.85)
        return self.ok(signal, conf, metrics, facts, missing=missing or None)


class Kraken(Agent):
    """Where size actually moves — book pressure and relative volume."""

    def collect(self, ctx: DeskContext) -> Reading:
        s = ctx.snapshot
        if s.bid_depth_usd is None and s.volume_24h_usd is None:
            return self.nodata("orderbook", "ticker")

        comps: list[float] = []
        facts: list[str] = []
        missing: list[str] = []
        metrics: dict[str, float] = {}

        if s.bid_depth_usd is not None and s.ask_depth_usd is not None \
                and (s.bid_depth_usd + s.ask_depth_usd) > 0:
            imb = (s.bid_depth_usd - s.ask_depth_usd) / (s.bid_depth_usd + s.ask_depth_usd)
            comps.append(clamp(imb * 1.5))
            facts.append(f"book pressure {imb:+.1%} "
                         f"({'bid' if imb > 0 else 'ask'}-heavy, top 20 levels)")
            metrics["book_imbalance"] = round(imb, 4)
        else:
            missing.append("orderbook")

        if ctx.frame is not None and len(ctx.frame) > 50:
            vol = ctx.frame["volume"]
            mean = float(vol.tail(50).mean()) or 1.0
            rvol = float(vol.iloc[-1]) / mean
            facts.append(f"RVOL {rvol:.2f}× the 50-bar mean")
            metrics["rvol"] = round(rvol, 2)

        # honesty: true on-chain exchange netflow needs a paid provider
        facts.append("on-chain exchange netflow needs a provider key — not wired")

        signal = sum(comps) / len(comps) if comps else 0.0
        conf = 0.55 if comps else 0.2
        return self.ok(signal, conf, metrics, facts, missing=missing or None)


class Coil(Agent):
    """The derivatives surface — funding, open interest, crowding."""

    def collect(self, ctx: DeskContext) -> Reading:
        s = ctx.snapshot
        if s.funding_rate is None and s.open_interest_usd is None:
            return self.nodata("funding/OI (spot market — point DESK_EXCHANGE "
                               "at a perp venue to light this seat up)")

        comps: list[float] = []
        facts: list[str] = []
        metrics: dict[str, float] = {}

        if s.funding_rate is not None:
            fr = s.funding_rate
            comps.append(-clamp(fr * 4000))     # +funding = crowded longs → fade
            side = "longs pay (crowded long)" if fr > 0 else "shorts pay (squeeze fuel)"
            facts.append(f"funding {fr * 100:.4f}%/8h → {side}")
            metrics["funding_rate"] = fr

        if s.open_interest_usd is not None:
            facts.append(f"open interest ${s.open_interest_usd:,.0f}")
            metrics["open_interest_usd"] = s.open_interest_usd

        signal = sum(comps) / len(comps) if comps else 0.0
        return self.ok(signal, 0.6, metrics, facts)
