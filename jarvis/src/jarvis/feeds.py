"""Live data feeds for the HUD: crypto, forex, and news.

All sources are free and keyless so the HUD works with zero extra signup:
  crypto — CoinGecko simple-price API
  forex  — frankfurter.app (ECB rates)
  news   — Google News RSS (top stories + business)

Each feed caches its last good result and serves it when a fetch fails, so a
flaky network degrades the HUD gracefully instead of blanking it.
"""

from __future__ import annotations

import logging
import re
import threading
import time
import xml.etree.ElementTree as ET

import requests

log = logging.getLogger(__name__)

_TIMEOUT = 10
_UA = {"User-Agent": "jarvis-hud/0.1 (personal assistant dashboard)"}

# Headlines matching any of these get flagged as potentially market-moving.
_ALERT_PATTERN = re.compile(
    r"\b(fed|federal reserve|rbi|reserve bank|rate (cut|hike)|interest rate"
    r"|inflation|cpi|gdp|recession|crash|plunge|surge|sanction|tariff"
    r"|bitcoin|crypto|sebi|nifty|sensex|stock market|oil price|opec"
    r"|earnings|default|bailout|war|stimulus|budget)\b",
    re.IGNORECASE,
)


class Feed:
    """A polled data source with a cache and a minimum refresh interval."""

    def __init__(self, name: str, interval: float) -> None:
        self.name = name
        self.interval = interval
        self._cached: dict | None = None
        self._fetched_at = 0.0
        self._lock = threading.Lock()

    def get(self) -> dict | None:
        with self._lock:
            fresh = time.monotonic() - self._fetched_at < self.interval
            if fresh and self._cached is not None:
                return self._cached
        try:
            data = self._fetch()
        except Exception as exc:  # noqa: BLE001 - feeds must never crash the app
            log.warning("feed %s failed: %s", self.name, exc)
            return self._cached
        with self._lock:
            self._cached = data
            self._fetched_at = time.monotonic()
        return data

    def _fetch(self) -> dict:
        raise NotImplementedError


class CryptoFeed(Feed):
    """Spot prices with 24h change from CoinGecko."""

    COINS = "bitcoin,ethereum,solana"
    URL = (
        "https://api.coingecko.com/api/v3/simple/price"
        f"?ids={COINS}&vs_currencies=usd,inr&include_24hr_change=true"
    )
    LABELS = {"bitcoin": "BTC", "ethereum": "ETH", "solana": "SOL"}

    def __init__(self) -> None:
        super().__init__("crypto", interval=60)

    def _fetch(self) -> dict:
        resp = requests.get(self.URL, timeout=_TIMEOUT, headers=_UA)
        resp.raise_for_status()
        raw = resp.json()
        out = []
        for coin, label in self.LABELS.items():
            row = raw.get(coin)
            if not row:
                continue
            out.append(
                {
                    "symbol": label,
                    "usd": row.get("usd"),
                    "inr": row.get("inr"),
                    "change_24h": round(row.get("usd_24h_change") or 0.0, 2),
                }
            )
        return {"type": "crypto", "items": out, "at": time.time()}


class ForexFeed(Feed):
    """Reference FX rates from frankfurter.app (ECB data, updated daily)."""

    URL = "https://api.frankfurter.app/latest?from=USD&to=INR,EUR,GBP,JPY"

    def __init__(self) -> None:
        super().__init__("forex", interval=1800)

    def _fetch(self) -> dict:
        resp = requests.get(self.URL, timeout=_TIMEOUT, headers=_UA)
        resp.raise_for_status()
        rates = resp.json().get("rates", {})
        items = [
            {"pair": f"USD/{code}", "rate": value} for code, value in rates.items()
        ]
        return {"type": "forex", "items": items, "at": time.time()}


class NewsFeed(Feed):
    """Headlines from Google News RSS, with market-moving detection."""

    URLS = (
        "https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en",
        "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-IN&gl=IN&ceid=IN:en",
    )
    MAX_ITEMS = 18

    def __init__(self) -> None:
        super().__init__("news", interval=300)

    def _fetch(self) -> dict:
        seen: set[str] = set()
        items: list[dict] = []
        for url in self.URLS:
            try:
                resp = requests.get(url, timeout=_TIMEOUT, headers=_UA)
                resp.raise_for_status()
                root = ET.fromstring(resp.content)
            except Exception as exc:  # noqa: BLE001 - one bad feed shouldn't kill both
                log.warning("news source failed (%s): %s", url[:60], exc)
                continue
            for item in root.iter("item"):
                title = (item.findtext("title") or "").strip()
                if not title or title.lower() in seen:
                    continue
                seen.add(title.lower())
                items.append(
                    {
                        "title": title,
                        "alert": bool(_ALERT_PATTERN.search(title)),
                        "when": (item.findtext("pubDate") or "")[:22],
                    }
                )
        # Alerts first, newest ordering otherwise preserved from the feed.
        items.sort(key=lambda i: not i["alert"])
        return {"type": "news", "items": items[: self.MAX_ITEMS], "at": time.time()}


class Feeds:
    """The bundle the server polls."""

    def __init__(self) -> None:
        self.crypto = CryptoFeed()
        self.forex = ForexFeed()
        self.news = NewsFeed()

    def snapshot(self) -> dict:
        return {
            "crypto": self.crypto.get(),
            "forex": self.forex.get(),
            "news": self.news.get(),
        }
