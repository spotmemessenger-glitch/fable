"""Free public HTTP sources, with a short cache and no exceptions escaping.

Every function returns None on any failure — timeout, rate limit, schema
change, offline. A missing source makes a seat say "no data" out loud; it
never becomes a guess. That rule is the same one market.py enforces for
exchange data, applied to the endpoints that have no CCXT equivalent.

No API keys. Everything here is a public endpoint.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import requests

log = logging.getLogger(__name__)

_UA = {"User-Agent": "desk/0.1 (+local research)"}
_CACHE: dict[str, tuple[float, Any]] = {}


def get_json(url: str, *, ttl: float = 60.0, params: dict[str, Any] | None = None,
             timeout: float = 8.0) -> Any | None:
    """GET and parse JSON, cached for ttl seconds. None on any failure."""
    key = url if not params else f"{url}?{sorted(params.items())}"
    hit = _CACHE.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < ttl:
        return hit[1]
    try:
        response = requests.get(url, params=params, headers=_UA, timeout=timeout)
        response.raise_for_status()
        payload = response.json()
    except Exception:
        log.warning("fetch failed: %s", url, exc_info=True)
        return None
    _CACHE[key] = (now, payload)
    return payload


# --------------------------------------------------------------------------
# the specific sources the seats use
# --------------------------------------------------------------------------

FNG_URL = "https://api.alternative.me/fng/"
CG_GLOBAL = "https://api.coingecko.com/api/v3/global"
CG_MARKETS = "https://api.coingecko.com/api/v3/coins/markets"
LLAMA_STABLES = "https://stablecoins.llama.fi/stablecoincharts/all"
LLAMA_CHAINS = "https://api.llama.fi/v2/chains"


def fear_greed() -> int | None:
    """Crypto Fear & Greed, 0 (extreme fear) to 100 (extreme greed)."""
    payload = get_json(FNG_URL, ttl=900, params={"limit": 1})
    try:
        return int(payload["data"][0]["value"])
    except (TypeError, KeyError, IndexError, ValueError):
        return None


def global_stats() -> dict[str, float] | None:
    """BTC/ETH dominance and total market cap change over 24h."""
    payload = get_json(CG_GLOBAL, ttl=900)
    try:
        data = payload["data"]
        return {
            "btc_dominance": float(data["market_cap_percentage"]["btc"]),
            "eth_dominance": float(data["market_cap_percentage"]["eth"]),
            "total_mcap_usd": float(data["total_market_cap"]["usd"]),
            "mcap_change_24h_pct": float(data["market_cap_change_percentage_24h_usd"]),
        }
    except (TypeError, KeyError, ValueError):
        return None


def stablecoin_supply() -> dict[str, float] | None:
    """Total stablecoin circulation and its 24h change — the desk's dry powder."""
    payload = get_json(LLAMA_STABLES, ttl=1800)
    if not isinstance(payload, list) or len(payload) < 2:
        return None
    try:
        latest = float(payload[-1]["totalCirculatingUSD"]["peggedUSD"])
        prior = float(payload[-2]["totalCirculatingUSD"]["peggedUSD"])
    except (TypeError, KeyError, ValueError):
        return None
    if prior <= 0:
        return None
    return {"total_usd": latest, "change_pct": (latest / prior - 1.0) * 100.0}


# CoinGecko ids for the assets a crypto desk actually trades. Unmapped symbols
# make VESTA report no-data rather than guessing at an id.
CG_IDS: dict[str, str] = {
    "BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "BNB": "binancecoin",
    "XRP": "ripple", "ADA": "cardano", "AVAX": "avalanche-2", "DOGE": "dogecoin",
    "LINK": "chainlink", "DOT": "polkadot", "MATIC": "matic-network",
    "TON": "the-open-network", "TRX": "tron", "SUI": "sui", "APT": "aptos",
    "ARB": "arbitrum", "OP": "optimism", "NEAR": "near", "INJ": "injective-protocol",
    "SEI": "sei-network", "TIA": "celestia", "LTC": "litecoin", "ATOM": "cosmos",
    "UNI": "uniswap", "AAVE": "aave", "PEPE": "pepe", "WIF": "dogwifcoin",
    "BONK": "bonk", "JUP": "jupiter-exchange-solana", "RNDR": "render-token",
}

# Symbols that are also L1 chains, so their TVL is a real fundamental.
CHAIN_NAMES: dict[str, str] = {
    "BTC": "Bitcoin", "ETH": "Ethereum", "SOL": "Solana", "BNB": "BSC",
    "AVAX": "Avalanche", "TRX": "Tron", "SUI": "Sui", "APT": "Aptos",
    "ARB": "Arbitrum", "OP": "OP Mainnet", "NEAR": "Near", "TON": "Ton",
}


def token_supply(base: str) -> dict[str, float | None] | None:
    """Circulating vs total supply, market cap and FDV. VESTA's raw material."""
    coin_id = CG_IDS.get(base.upper())
    if not coin_id:
        return None
    payload = get_json(CG_MARKETS, ttl=900,
                       params={"vs_currency": "usd", "ids": coin_id})
    if not isinstance(payload, list) or not payload:
        return None
    row = payload[0]

    def num(key: str) -> float | None:
        value = row.get(key)
        try:
            return float(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    return {
        "market_cap_usd": num("market_cap"),
        "fdv_usd": num("fully_diluted_valuation"),
        "circulating_supply": num("circulating_supply"),
        "total_supply": num("total_supply"),
        "max_supply": num("max_supply"),
        "ath_change_pct": num("ath_change_percentage"),
    }


def chain_tvl(base: str) -> float | None:
    """Total value locked on the chain, if this symbol is one."""
    name = CHAIN_NAMES.get(base.upper())
    if not name:
        return None
    payload = get_json(LLAMA_CHAINS, ttl=1800)
    if not isinstance(payload, list):
        return None
    for row in payload:
        if row.get("name") == name:
            try:
                return float(row["tvl"])
            except (TypeError, KeyError, ValueError):
                return None
    return None
