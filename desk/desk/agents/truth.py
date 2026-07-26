"""TRUTH wing — supply and dissent.

VESTA reads the supply side: how much of the token is really circulating, and
whether the chain earns anything. CASSANDRA reads the rest of the desk and
argues against it, so fourteen seats cannot quietly become a chorus.
"""
from __future__ import annotations

from .base import Agent, DeskContext, Reading, clamp
from ..web import chain_tvl, token_supply


class Vesta(Agent):
    """Supply-side truth — circulating vs diluted, unlock overhang, real TVL."""

    def collect(self, ctx: DeskContext) -> Reading:
        base = ctx.base
        sup = token_supply(base)
        if sup is None:
            return self.nodata(f"tokenomics for {base}")

        comps: list[float] = []
        facts: list[str] = []
        metrics: dict[str, float] = {}

        circ = sup.get("circulating_supply")
        total = sup.get("total_supply") or sup.get("max_supply")
        if circ and total and total > 0:
            ratio = circ / total
            comps.append(clamp((ratio - 0.7) * 2))     # <70% circulating = dilution ahead
            tail = "" if ratio > 0.85 else " — unlock overhang ahead"
            facts.append(f"{ratio * 100:.0f}% of supply circulating{tail}")
            metrics["circulating_ratio"] = round(ratio, 3)

        mc = sup.get("market_cap_usd")
        fdv = sup.get("fdv_usd")
        if mc and fdv and fdv > 0:
            facts.append(f"MC ${mc:,.0f} / FDV ${fdv:,.0f} ({mc / fdv * 100:.0f}%)")
            metrics["mc_fdv_ratio"] = round(mc / fdv, 3)

        if sup.get("ath_change_pct") is not None:
            facts.append(f"{sup['ath_change_pct']:.0f}% from all-time high")
            metrics["ath_change_pct"] = sup["ath_change_pct"]

        tvl = chain_tvl(base)
        if tvl:
            comps.append(0.1)      # real on-chain usage, a mild positive
            facts.append(f"chain TVL ${tvl:,.0f}")
            metrics["chain_tvl_usd"] = tvl

        signal = sum(comps) / len(comps) if comps else 0.0
        return self.ok(signal, 0.55, metrics, facts)


class Cassandra(Agent):
    """Red team. Argues against whatever the desk is crowding into."""

    IGNORE = {"CASSANDRA", "SENTINEL", "PILOT", "LEDGER"}

    def collect(self, ctx: DeskContext) -> Reading:
        peers = [r for name, r in ctx.readings.items()
                 if r.usable and name not in self.IGNORE]
        if len(peers) < 2:
            return self.nodata("peer readings")

        sigs = [r.signal for r in peers]
        mean = sum(sigs) / len(sigs)
        disp = (sum((x - mean) ** 2 for x in sigs) / len(sigs)) ** 0.5
        same_side = sum(1 for x in sigs if (x > 0) == (mean > 0) and abs(x) > 0.1)
        crowding = same_side / len(sigs)

        # oppose a crowded, low-dispersion consensus; stay quiet when the desk is split
        signal = -clamp(mean * crowding * (1.2 - min(disp, 1.0)))
        conf = clamp(0.4 + 0.5 * crowding, 0.3, 0.9)

        side = "long" if mean > 0 else "short"
        facts = [f"{same_side}/{len(sigs)} seats lean {side}; dispersion {disp:.2f}"]
        facts.append("the crowded side is where the pain trades live"
                     if crowding > 0.7 else "desk is split — less to lean against")

        metrics = {"consensus": round(mean, 3), "crowding": round(crowding, 2),
                   "dispersion": round(disp, 3)}
        return self.ok(signal, conf, metrics, facts)
