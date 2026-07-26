"""Rug / honeypot filter — the stage that matters most for meme coins.

A token is only allowed to trade if it clears EVERY check: liquidity floor,
24h volume, minimum age (fresh bucket), acceptable price impact for our size,
a working sell route (honeypot guard via a SOL->token->SOL round trip), and —
when RugCheck is reachable — no danger-level flags. Returns a verdict plus
human-readable reasons for any rejection.
"""
from __future__ import annotations

from dataclasses import dataclass

import httpx

from . import sources
from .config import SOL_MINT, SafetyConfig


@dataclass
class Verdict:
    ok: bool
    reasons: list[str]


def _test_sol_lamports(usd_size: float, sol_price_usd: float) -> int:
    """How many lamports our intended USD position is worth (for the sell test)."""
    sol = (usd_size / sol_price_usd) if sol_price_usd > 0 else 0.02
    return max(1, int(sol * 1e9))


def assess(client: httpx.Client, c: "sources.Candidate", cfg: SafetyConfig,
           usd_size: float, sol_price_usd: float, slippage_bps: int = 300) -> Verdict:
    reasons: list[str] = []

    min_liq = cfg.min_liq_fresh if c.bucket == "fresh" else cfg.min_liq_established
    if c.liq_usd < min_liq:
        reasons.append(f"liquidity ${c.liq_usd:,.0f} < ${min_liq:,.0f}")
    if c.vol24 < cfg.min_vol24:
        reasons.append(f"24h vol ${c.vol24:,.0f} < ${cfg.min_vol24:,.0f}")
    if c.bucket == "fresh" and c.age_min < cfg.min_age_min_fresh:
        reasons.append(f"too new ({c.age_min:.1f}m old)")

    # Honeypot / sell-route check: quote a real buy (SOL->token), then try to sell
    # the exact tokens back (token->SOL). No sell route == honeypot; a poor round
    # trip == crippling tax or thin book. This also validates OUR size can exit.
    lamports = _test_sol_lamports(usd_size, sol_price_usd)
    buy = sources.jupiter_quote(client, SOL_MINT, c.mint, lamports, slippage_bps)
    if not buy:
        reasons.append("no buy route on Jupiter")
    else:
        impact = sources._f(buy.get("priceImpactPct")) * 100.0
        if impact > cfg.max_price_impact_pct:
            reasons.append(f"price impact {impact:.1f}% > {cfg.max_price_impact_pct:.0f}%")
        if cfg.require_sell_route:
            sell = sources.jupiter_quote(client, c.mint, SOL_MINT,
                                         int(buy["outAmount"]), slippage_bps)
            if not sell:
                reasons.append("HONEYPOT: no sell route")
            else:
                roundtrip = int(sell["outAmount"]) / lamports if lamports else 0.0
                if roundtrip < cfg.min_roundtrip:
                    reasons.append(
                        f"round-trip only {roundtrip * 100:.0f}% "
                        f"(tax/impact; need {cfg.min_roundtrip * 100:.0f}%)")

    # RugCheck danger flags (best effort — never fail the token just because the
    # API is down, but DO reject on explicit danger-level risks).
    rc = sources.rugcheck_summary(client, c.mint)
    if rc:
        danger = [
            str(x.get("name")) for x in (rc.get("risks") or [])
            if str(x.get("level", "")).lower() in ("danger", "high") and x.get("name")
        ]
        if danger:
            reasons.append("rugcheck: " + ", ".join(danger[:3]))

    return Verdict(ok=(len(reasons) == 0), reasons=reasons)
