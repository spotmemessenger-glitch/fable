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


_WMO_CONDITIONS = {
    0: "Clear", 1: "Mostly Clear", 2: "Partly Cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime Fog",
    51: "Light Drizzle", 53: "Drizzle", 55: "Heavy Drizzle",
    61: "Light Rain", 63: "Rain", 65: "Heavy Rain",
    71: "Light Snow", 73: "Snow", 75: "Heavy Snow",
    80: "Rain Showers", 81: "Rain Showers", 82: "Violent Showers",
    95: "Thunderstorm", 96: "Thunderstorm", 99: "Severe Thunderstorm",
}


class WeatherFeed(Feed):
    """Current + 3-day forecast from Open-Meteo — free, keyless."""

    URL = "https://api.open-meteo.com/v1/forecast"

    def __init__(self, lat: float, lon: float, place: str) -> None:
        super().__init__("weather", interval=1800)
        self.lat, self.lon, self.place = lat, lon, place

    def _fetch(self) -> dict:
        resp = requests.get(
            self.URL,
            params={
                "latitude": self.lat,
                "longitude": self.lon,
                "current": "temperature_2m,weather_code",
                "daily": "temperature_2m_max,temperature_2m_min,weather_code",
                "temperature_unit": "fahrenheit",
                "timezone": "auto",
                "forecast_days": 4,
            },
            timeout=_TIMEOUT,
            headers=_UA,
        )
        resp.raise_for_status()
        data = resp.json()
        cur = data.get("current", {})
        daily = data.get("daily", {})
        days = daily.get("time", [])
        forecast = [
            {
                "day": d,
                "hi": round(daily["temperature_2m_max"][i]),
                "lo": round(daily["temperature_2m_min"][i]),
                "condition": _WMO_CONDITIONS.get(daily["weather_code"][i], "—"),
            }
            for i, d in enumerate(days[1:4], start=1)
        ]
        return {
            "type": "weather",
            "place": self.place,
            "temp_f": round(cur.get("temperature_2m", 0)),
            "condition": _WMO_CONDITIONS.get(cur.get("weather_code"), "—"),
            "forecast": forecast,
            "at": time.time(),
        }


class Feeds:
    """The bundle the server polls."""

    def __init__(self, *, weather_lat: float, weather_lon: float, weather_place: str) -> None:
        self.crypto = CryptoFeed()
        self.forex = ForexFeed()
        self.news = NewsFeed()
        self.weather = WeatherFeed(weather_lat, weather_lon, weather_place)

    def snapshot(self) -> dict:
        return {
            "crypto": self.crypto.get(),
            "forex": self.forex.get(),
            "news": self.news.get(),
            "weather": self.weather.get(),
        }
