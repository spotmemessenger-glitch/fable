"""MEMES wing — Solana DEX. Different data, different death.

These four seats read ctx.meme (a dict of Solana token data HELM fetches from
solana.py), not the CEX snapshot. On a normal CEX symbol ctx.meme is None and
they all report no-data — they only wake for a meme scan.

  HOUND    finds fresh, moving pairs (early by design, wrong most often)
  GEIGER   the hard gate — a fail here is absolute
  BALLAST  sizes assuming the token goes to zero
  VIPER    plans the entry and the exit, and checks it can actually be filled
"""
from __future__ import annotations

from .base import Agent, DeskContext, Reading, clamp


class Hound(Agent):
    """Scent — new liquidity, volume spikes, buyer momentum in the first hours."""

    def collect(self, ctx: DeskContext) -> Reading:
        m = ctx.meme
        if not m:
            return self.nodata("no Solana token in context (CEX symbol)")

        comps: list[float] = []
        facts: list[str] = []
        liq = m.get("liquidity_usd")
        vol = m.get("volume_24h_usd")
        buys, sells = m.get("buys_24h"), m.get("sells_24h")
        change = m.get("price_change_24h")

        if liq is not None:
            facts.append(f"liquidity ${liq:,.0f}")
        if vol is not None and liq:
            turnover = vol / liq
            comps.append(clamp(turnover / 5))          # heavy turnover = momentum
            facts.append(f"24h volume ${vol:,.0f} ({turnover:.1f}× liquidity)")
        if buys is not None and sells is not None and (buys + sells) > 0:
            ratio = (buys - sells) / (buys + sells)
            comps.append(clamp(ratio))
            facts.append(f"{buys} buys / {sells} sells ({ratio:+.0%})")
        if change is not None:
            comps.append(clamp(change / 100))
            facts.append(f"price {change:+.1f}% 24h")

        signal = sum(comps) / len(comps) if comps else 0.0
        conf = 0.4 if comps else 0.15           # HOUND is deliberately low-confidence
        return self.ok(signal, conf, {k: m.get(k) for k in
                       ("symbol", "liquidity_usd", "volume_24h_usd")}, facts)


class Geiger(Agent):
    """Rug forensics — the hard gate. Any fail zeroes the whole idea."""

    def collect(self, ctx: DeskContext) -> Reading:
        m = ctx.meme
        if not m:
            return self.nodata("no Solana token in context")
        rc = m.get("rugcheck")
        rep = m.get("rugcheck_report")
        if rc is None and rep is None:
            return self.nodata("rugcheck")

        fails: list[str] = []
        facts: list[str] = []

        if rep:
            if rep.get("mint_authority"):
                fails.append("mint authority still live (supply can be inflated)")
            if rep.get("freeze_authority"):
                fails.append("freeze authority still live (your wallet can be frozen)")
            if rep.get("rugged"):
                fails.append("RugCheck flags this token as already rugged")
            top = rep.get("top5_holder_pct")
            if top is not None:
                facts.append(f"top-5 holders {top:.1f}%")
                if top > 60:
                    fails.append(f"top-5 holders hold {top:.0f}% — one wallet can dump the floor")
            lp = rep.get("lp_locked_pct")
            if lp is not None:
                facts.append(f"LP locked {lp:.0f}%")
                if lp < 50:
                    fails.append(f"only {lp:.0f}% of LP locked — liquidity can be pulled")

        if rc and rc.get("risks"):
            dangers = [r["name"] for r in rc["risks"] if r.get("level") == "danger"]
            if dangers:
                fails.append("RugCheck danger flags: " + ", ".join(dangers[:4]))
            facts.append(f"RugCheck score {rc.get('score')}")

        if fails:
            # a hard veto: negative signal, high confidence, state ok so it counts
            return self.ok(-1.0, 0.95, {"passed": False, "fails": fails},
                           ["REJECT — " + f for f in fails] + facts)
        facts.insert(0, "passed: no live authorities, LP locked, holders dispersed")
        return self.ok(0.15, 0.8, {"passed": True}, facts)


class Ballast(Agent):
    """Degen risk — sizes assuming zero, and caps the whole wing."""

    def collect(self, ctx: DeskContext) -> Reading:
        m = ctx.meme
        if not m:
            return self.nodata("no Solana token in context")

        lim = ctx.settings.limits
        p = ctx.portfolio
        eq = p.equity(ctx.prices) or ctx.settings.starting_cash

        # the meme wing gets a small slice of the book; each name a slice of that
        wing_cap = lim.max_position_pct * eq          # whole meme wing ceiling
        wing_used = p.wing_exposure_usd("memes", ctx.prices)
        wing_room = max(0.0, wing_cap - wing_used)
        per_name = min(wing_room, wing_cap / 4)       # at most a quarter of the wing per token

        # liquidity throttle: never more than 1% of pool liquidity
        liq = m.get("liquidity_usd")
        if liq:
            per_name = min(per_name, liq * 0.01)

        facts = [
            f"meme wing cap ${wing_cap:,.0f} ({lim.max_position_pct * 100:.0f}% of book), "
            f"${wing_used:,.0f} used",
            f"max this name ${per_name:,.0f} — sized to survive a total loss",
        ]
        signal = 0.0 if per_name > 10 else -1.0       # no room = a veto
        if per_name <= 10:
            facts.append("no room left in the meme wing — pass")
        metrics = {"per_name_usd": round(per_name, 2), "wing_room_usd": round(wing_room, 2)}
        return self.ok(signal, 0.85, metrics, facts)


class Viper(Agent):
    """Strike — route, slippage, and the exit ladder. Speed, not conviction."""

    def collect(self, ctx: DeskContext) -> Reading:
        m = ctx.meme
        if not m:
            return self.nodata("no Solana token in context")
        quote = m.get("jupiter")
        facts: list[str] = []
        signal = 0.0
        conf = 0.5

        if quote is None:
            facts.append("no Jupiter route — cannot confirm the token is exitable")
            return self.ok(-0.5, 0.5, {"routable": False}, facts)

        impact = quote.get("price_impact_pct")
        hops = quote.get("route_hops")
        facts.append(f"Jupiter route found ({hops} hop{'s' if hops != 1 else ''})")
        if impact is not None:
            facts.append(f"price impact {impact:.2f}% at test size")
            if impact > 3:
                signal = -0.4
                facts.append("impact too high — thin liquidity, fill would bleed")
            else:
                signal = 0.2

        price = m.get("price_usd")
        if price:
            facts.append(f"plan: TP1 +40% / TP2 +100%, trailing stop −25%, "
                         f"emergency dump on route loss (entry ~{price:.6g})")
        metrics = {"routable": True, "price_impact_pct": impact}
        return self.ok(signal, conf, metrics, facts)
