"""BOOK wing — price and structure.

CHARTIST reads the trend and the levels; SIGMA sizes the uncertainty. Both work
purely off the Snapshot that market.py already computed, so every number they
quote is exchange-derived.
"""
from __future__ import annotations

from .base import Agent, DeskContext, Reading, clamp


class Chartist(Agent):
    """Trend, momentum, and the levels that matter."""

    def collect(self, ctx: DeskContext) -> Reading:
        s = ctx.snapshot
        if s.price is None or s.rsi_14 is None or s.ema_fast is None or s.ema_slow is None:
            return self.nodata("ohlcv")
        price = s.price

        sep = (s.ema_fast - s.ema_slow) / price if s.ema_slow else 0.0
        trend = clamp(sep * 40)

        rsi_sig = clamp((s.rsi_14 - 50) / 25)
        if s.rsi_14 > 78 or s.rsi_14 < 22:      # stretched — fade the edge
            rsi_sig *= 0.5

        macd_sig = 0.0
        if s.atr_14 and s.macd_hist is not None:
            macd_sig = clamp(s.macd_hist / s.atr_14)

        loc = 0.0
        if s.support is not None and s.resistance is not None and s.resistance > s.support:
            pos = (price - s.support) / (s.resistance - s.support)
            loc = clamp((0.5 - pos) * 1.2)      # near support → +, near resistance → −

        signal = 0.42 * trend + 0.24 * rsi_sig + 0.22 * macd_sig + 0.12 * loc
        agree = 1.0 - abs(trend - macd_sig) / 2.0
        conf = clamp(0.5 + 0.4 * agree, 0.3, 0.95)

        facts = [
            f"trend {'up' if sep > 0 else 'down'}: EMA21 {s.ema_fast:.4g} vs EMA55 {s.ema_slow:.4g}",
            f"RSI14 {s.rsi_14:.1f}",
        ]
        if s.macd_hist is not None:
            facts.append(f"MACD histogram {s.macd_hist:+.4g}")
        if s.support and s.resistance:
            facts.append(f"range {s.support:.4g}–{s.resistance:.4g}, price {price:.4g}")

        metrics = {"trend": round(trend, 3), "rsi": s.rsi_14, "macd_hist": s.macd_hist,
                   "support": s.support, "resistance": s.resistance}
        return self.ok(signal, conf, metrics, facts)


class Sigma(Agent):
    """Volatility, ATR, and vol-targeted sizing. Speaks in distributions."""

    LOW, HIGH = 0.40, 0.90       # annualised-vol regime cuts

    def collect(self, ctx: DeskContext) -> Reading:
        s = ctx.snapshot
        if s.annualised_vol is None or s.price is None:
            return self.nodata("ohlcv")
        vol = s.annualised_vol
        atr_pct = (s.atr_14 / s.price * 100) if s.atr_14 else None
        regime = "low" if vol < self.LOW else "high" if vol > self.HIGH else "normal"

        sep = (s.ema_fast - s.ema_slow) / s.price if (s.ema_fast and s.ema_slow) else 0.0
        signal = clamp(sep / max(vol, 0.05) * 3.0) * 0.5      # vol-adjusted, muted

        target_vol = 0.20
        size_frac = clamp(target_vol / max(vol, 1e-6), 0.0, 1.0)
        conf = 0.7 if regime != "high" else 0.5

        facts = [f"annualised vol {vol * 100:.1f}% ({regime})"]
        if atr_pct is not None:
            facts.append(f"ATR14 {atr_pct:.2f}% of price")
        facts.append(f"vol-target size {size_frac * 100:.0f}% of a full clip")

        metrics = {"annualised_vol": vol, "atr_pct": atr_pct, "regime": regime,
                   "size_frac": round(size_frac, 3)}
        return self.ok(signal, conf, metrics, facts)
