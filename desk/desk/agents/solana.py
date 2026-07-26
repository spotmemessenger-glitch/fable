"""Solana DEX data — the numbers the meme wing reads.

Same contract as market.py and web.py: real values from public endpoints, or
None. Nothing here fabricates a price, a liquidity figure, or a safety score.

Endpoints (all public, no key):
  DexScreener   token pairs, new-pair discovery, boosted tokens
  RugCheck      mint/freeze authority, LP lock, holder concentration, risk list
  Jupiter       swap quote and price impact (lite-api host — the keyless one)
"""
from __future__ import annotations

from typing import Any

from ..web import get_json

DEXS_TOKEN = "https://api.dexscreener.com/latest/dex/tokens/"
DEXS_SEARCH = "https://api.dexscreener.com/latest/dex/search"
DEXS_BOOSTS = "https://api.dexscreener.com/token-boosts/latest/v1"
RUGCHECK = "https://api.rugcheck.xyz/v1/tokens/"
JUPITER_QUOTE = "https://lite-api.jup.ag/swap/v1/quote"

USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"


def _best_pair(pairs: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    """The deepest Solana pair for a token — liquidity is the honest tiebreak."""
    if not pairs:
        return None
    sol = [p for p in pairs if p.get("chainId") == "solana"]
    if not sol:
        return None
    return max(sol, key=lambda p: (p.get("liquidity") or {}).get("usd") or 0.0)


def _pair_stats(pair: dict[str, Any]) -> dict[str, Any]:
    liq = (pair.get("liquidity") or {}).get("usd")
    vol = (pair.get("volume") or {}).get("h24")
    txns = (pair.get("txns") or {}).get("h24") or {}
    change = (pair.get("priceChange") or {}).get("h24")
    price = pair.get("priceUsd")
    return {
        "mint": (pair.get("baseToken") or {}).get("address"),
        "symbol": (pair.get("baseToken") or {}).get("symbol"),
        "pair_address": pair.get("pairAddress"),
        "price_usd": float(price) if price else None,
        "liquidity_usd": float(liq) if liq is not None else None,
        "volume_24h_usd": float(vol) if vol is not None else None,
        "buys_24h": txns.get("buys"),
        "sells_24h": txns.get("sells"),
        "price_change_24h": float(change) if change is not None else None,
        "pair_created_at": pair.get("pairCreatedAt"),
        "fdv": pair.get("fdv"),
    }


def dexscreener_token(mint: str) -> dict[str, Any] | None:
    """Best-pair stats for a token mint. None if unlisted or the fetch fails."""
    payload = get_json(DEXS_TOKEN + mint, ttl=30)
    pair = _best_pair(payload.get("pairs") if isinstance(payload, dict) else None)
    return _pair_stats(pair) if pair else None


def dexscreener_search(query: str) -> list[dict[str, Any]]:
    """Search Solana pairs by symbol or name, deepest liquidity first."""
    payload = get_json(DEXS_SEARCH, ttl=30, params={"q": query})
    pairs = payload.get("pairs") if isinstance(payload, dict) else None
    sol = [p for p in (pairs or []) if p.get("chainId") == "solana"]
    sol.sort(key=lambda p: (p.get("liquidity") or {}).get("usd") or 0.0, reverse=True)
    return [_pair_stats(p) for p in sol[:20]]


def dexscreener_boosted(limit: int = 30) -> list[str]:
    """Currently-boosted Solana mints — HOUND's hunting ground of the moment."""
    payload = get_json(DEXS_BOOSTS, ttl=60)
    if not isinstance(payload, list):
        return []
    mints = [row.get("tokenAddress") for row in payload
             if row.get("chainId") == "solana" and row.get("tokenAddress")]
    return mints[:limit]


def rugcheck_summary(mint: str) -> dict[str, Any] | None:
    """GEIGER's gate: authorities, LP lock, top-holder %, and the risk list."""
    payload = get_json(RUGCHECK + mint + "/report/summary", ttl=120)
    if not isinstance(payload, dict):
        return None
    risks = payload.get("risks") or []
    return {
        "score": payload.get("score"),
        "score_normalised": payload.get("score_normalised"),
        "risks": [{"name": r.get("name"), "level": r.get("level"),
                   "value": r.get("value")} for r in risks],
    }


def rugcheck_report(mint: str) -> dict[str, Any] | None:
    """Fuller RugCheck report — authorities and holder concentration."""
    payload = get_json(RUGCHECK + mint + "/report", ttl=120)
    if not isinstance(payload, dict):
        return None
    holders = payload.get("topHolders") or []
    top_pct = sum((h.get("pct") or 0.0) for h in holders[:5])
    markets = payload.get("markets") or []
    lp_locked = None
    if markets:
        lp_locked = (markets[0].get("lp") or {}).get("lpLockedPct")
    return {
        "mint_authority": payload.get("mintAuthority"),
        "freeze_authority": payload.get("freezeAuthority"),
        "lp_locked_pct": lp_locked,
        "top5_holder_pct": round(top_pct, 2) if holders else None,
        "rugged": payload.get("rugged"),
    }


def jupiter_quote(output_mint: str, amount_usdc: float) -> dict[str, Any] | None:
    """VIPER's route check: price impact for a USDC→token buy of this size."""
    amount = int(amount_usdc * 1_000_000)      # USDC has 6 decimals
    payload = get_json(JUPITER_QUOTE, ttl=15, params={
        "inputMint": USDC_MINT, "outputMint": output_mint,
        "amount": amount, "slippageBps": 100})
    if not isinstance(payload, dict) or "outAmount" not in payload:
        return None
    impact = payload.get("priceImpactPct")
    return {
        "out_amount": payload.get("outAmount"),
        "price_impact_pct": float(impact) * 100 if impact is not None else None,
        "route_hops": len(payload.get("routePlan") or []),
    }
