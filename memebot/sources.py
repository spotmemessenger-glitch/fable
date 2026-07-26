"""External data sources — all free, no API keys.

- DexScreener: token discovery (established memes + fresh/boosted launches) and
  live prices/liquidity/volume/flow.
- Jupiter (quote API): best-route pricing and the honeypot round-trip check.
- RugCheck: best-effort risk report (tolerated to fail).
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import httpx

DEX = "https://api.dexscreener.com"
# Jupiter's old quote-api.jup.ag/v6 host was retired; the free public endpoint is
# now lite-api.jup.ag/swap/v1 (same QuoteResponse shape: outAmount, priceImpactPct).
JUP = "https://lite-api.jup.ag/swap/v1"
RUG = "https://api.rugcheck.xyz/v1"

# Established, liquid Solana memes we search for by symbol, then liquidity-filter.
_SEEDS = ["WIF", "BONK", "POPCAT", "MEW", "BOME", "GIGA", "MOODENG",
          "PNUT", "FWOG", "GOAT", "SLERF", "MICHI", "PENG", "ai16z"]


@dataclass
class Candidate:
    mint: str
    symbol: str
    name: str
    price_usd: float
    liq_usd: float
    vol24: float
    vol1h: float
    chg5m: float
    chg1h: float
    chg6h: float
    buys1h: int
    sells1h: int
    age_min: float
    pair: str
    bucket: str          # "established" | "fresh"


def _f(x, default=0.0) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def _norm(pair: dict, bucket: str) -> Candidate | None:
    if pair.get("chainId") != "solana":
        return None
    base = pair.get("baseToken") or {}
    mint = base.get("address")
    if not mint:
        return None
    liq = pair.get("liquidity") or {}
    vol = pair.get("volume") or {}
    chg = pair.get("priceChange") or {}
    h1 = (pair.get("txns") or {}).get("h1") or {}
    created = pair.get("pairCreatedAt")  # ms epoch, may be missing
    age_min = ((time.time() * 1000 - created) / 60000.0) if created else 1e9
    return Candidate(
        mint=mint,
        symbol=base.get("symbol", "?"),
        name=base.get("name", "?"),
        price_usd=_f(pair.get("priceUsd")),
        liq_usd=_f(liq.get("usd")),
        vol24=_f(vol.get("h24")),
        vol1h=_f(vol.get("h1")),
        chg5m=_f(chg.get("m5")),
        chg1h=_f(chg.get("h1")),
        chg6h=_f(chg.get("h6")),
        buys1h=int(_f(h1.get("buys"))),
        sells1h=int(_f(h1.get("sells"))),
        age_min=age_min,
        pair=pair.get("pairAddress", ""),
        bucket=bucket,
    )


def _best_solana_pair(pairs: list, bucket: str) -> Candidate | None:
    best = None
    for p in pairs or []:
        c = _norm(p, bucket)
        if c and (best is None or c.liq_usd > best.liq_usd):
            best = c
    return best


def discover_established(client: httpx.Client, min_liq: float) -> list[Candidate]:
    """Search seed symbols, keep the deepest Solana pair per token above the floor."""
    out, seen = [], set()
    for q in _SEEDS:
        try:
            r = client.get(f"{DEX}/latest/dex/search", params={"q": q}, timeout=15)
            pairs = (r.json() or {}).get("pairs") or []
        except Exception:
            continue
        for p in pairs:
            c = _norm(p, "established")
            if c and c.mint not in seen and c.liq_usd >= min_liq:
                seen.add(c.mint)
                out.append(c)
    return out


def discover_fresh(client: httpx.Client, min_liq: float) -> list[Candidate]:
    """Latest boosted/profiled tokens on Solana, resolved to their deepest pair."""
    out, seen = [], set()
    for path in ("/token-boosts/latest/v1", "/token-profiles/latest/v1"):
        try:
            r = client.get(f"{DEX}{path}", timeout=15)
            items = r.json() or []
        except Exception:
            continue
        if not isinstance(items, list):
            continue
        for it in items:
            if it.get("chainId") != "solana":
                continue
            addr = it.get("tokenAddress")
            if not addr or addr in seen:
                continue
            seen.add(addr)
            try:
                rr = client.get(f"{DEX}/latest/dex/tokens/{addr}", timeout=15)
                pairs = (rr.json() or {}).get("pairs") or []
            except Exception:
                continue
            best = _best_solana_pair(pairs, "fresh")
            if best and best.liq_usd >= min_liq:
                out.append(best)
    return out


def token_price(client: httpx.Client, mint: str) -> float | None:
    """Live USD price for a held token (deepest Solana pair)."""
    try:
        r = client.get(f"{DEX}/latest/dex/tokens/{mint}", timeout=12)
        pairs = (r.json() or {}).get("pairs") or []
    except Exception:
        return None
    best = _best_solana_pair(pairs, "held")
    return best.price_usd if best else None


def jupiter_quote(client: httpx.Client, input_mint: str, output_mint: str,
                  amount: int, slippage_bps: int = 300) -> dict | None:
    """Jupiter best-route quote. `amount` is in the input mint's base units.
    Returns the quote dict (outAmount, priceImpactPct, ...) or None if no route."""
    try:
        r = client.get(f"{JUP}/quote", params={
            "inputMint": input_mint,
            "outputMint": output_mint,
            "amount": int(amount),
            "slippageBps": slippage_bps,
        }, timeout=15)
        if r.status_code != 200:
            return None
        j = r.json()
        if not j or "outAmount" not in j:
            return None
        return j
    except Exception:
        return None


def rugcheck_summary(client: httpx.Client, mint: str) -> dict | None:
    """Best-effort RugCheck report summary. None if unavailable."""
    try:
        r = client.get(f"{RUG}/tokens/{mint}/report/summary", timeout=12)
        if r.status_code != 200:
            return None
        return r.json()
    except Exception:
        return None
