"""Live TradingView charts — a fast, deterministic shortcut for the operator.

Ybot normally drives the desktop through the screenshot -> decide -> act loop,
which is overkill (and burns tokens/latency) for something as simple as "pull up
the BTC chart". This module opens a live TradingView chart straight in the
default browser, no vision loop and no API key required.

`main.py` checks `parse_chart_goal(goal)` first; if it matches, it opens the
chart and skips the operator entirely.
"""
from __future__ import annotations

import re
import webbrowser

DEFAULT_SYMBOL = "BINANCE:BTCUSDT"

# Friendly words the user is likely to say -> exchange-qualified TV symbols.
_ALIASES = {
    "BTC": "BINANCE:BTCUSDT", "BITCOIN": "BINANCE:BTCUSDT", "XBT": "BINANCE:BTCUSDT",
    "ETH": "BINANCE:ETHUSDT", "ETHEREUM": "BINANCE:ETHUSDT", "ETHER": "BINANCE:ETHUSDT",
    "SOL": "BINANCE:SOLUSDT", "SOLANA": "BINANCE:SOLUSDT",
    "BNB": "BINANCE:BNBUSDT", "XRP": "BINANCE:XRPUSDT", "RIPPLE": "BINANCE:XRPUSDT",
    "DOGE": "BINANCE:DOGEUSDT", "DOGECOIN": "BINANCE:DOGEUSDT",
    "ADA": "BINANCE:ADAUSDT", "CARDANO": "BINANCE:ADAUSDT",
    "AVAX": "BINANCE:AVAXUSDT", "MATIC": "BINANCE:MATICUSDT",
    "LINK": "BINANCE:LINKUSDT", "LTC": "BINANCE:LTCUSDT",
    "GOLD": "TVC:GOLD", "SILVER": "TVC:SILVER",
    "SPX": "SP:SPX", "SP500": "SP:SPX", "NASDAQ": "NASDAQ:IXIC", "NDX": "NASDAQ:NDX",
}

# Words that signal the user wants a chart (whole-word match).
_TRIGGERS = ("chart", "charts", "candles", "candlestick", "candlesticks", "tradingview")

# Filler words to ignore when hunting for the symbol in a phrase.
_STOP = {
    "SHOW", "ME", "THE", "A", "AN", "LIVE", "CHART", "CHARTS", "OPEN", "PULL",
    "UP", "BRING", "OF", "FOR", "ON", "PLEASE", "CANDLES", "CANDLESTICK",
    "CANDLESTICKS", "TRADINGVIEW", "PRICE", "GET", "VIEW", "DISPLAY", "TO",
}


def normalize_symbol(raw: str) -> str:
    """Turn user text into an exchange-qualified TradingView symbol.

    "btc" -> BINANCE:BTCUSDT, "USD/INR" -> FX_IDC:USDINR,
    "BINANCE:ADAUSDT" -> passed through unchanged.
    """
    s = (raw or "").strip().upper()
    if not s:
        return DEFAULT_SYMBOL
    if ":" in s:  # already exchange-qualified
        return s
    if s in _ALIASES:
        return _ALIASES[s]

    fx = re.sub(r"[\s/]", "", s)
    # Six-letter forex pair (e.g. USDINR, EURUSD) that isn't a crypto USDT/USDC pair.
    if re.fullmatch(r"[A-Z]{6}", fx) and not fx.endswith(("USDT", "USDC")):
        return "FX_IDC:" + fx

    core = re.sub(r"[^A-Z0-9]", "", s)
    if not core:
        return DEFAULT_SYMBOL
    # Keep an existing quote only when a real base precedes it (ETHBTC, BTCUSDT).
    # A bare base like "ETH"/"WBTC" must NOT be read as already-quoted.
    if re.fullmatch(r"[A-Z0-9]{2,}(USDT|USDC|USD|BTC|ETH)", core):
        return "BINANCE:" + core
    return "BINANCE:" + core + "USDT"


def chart_url(symbol: str) -> str:
    """Full TradingView live-chart URL for a symbol (friendly or qualified)."""
    return "https://www.tradingview.com/chart/?symbol=" + normalize_symbol(symbol)


def _extract_symbol(text: str) -> str:
    """Best-effort pull of a ticker/pair out of a free-form chart request."""
    upper = text.upper()
    # Prefer an explicit alias word if one appears anywhere.
    for word in re.findall(r"[A-Z0-9/:]+", upper):
        if word in _ALIASES or ":" in word:
            return word
    # Otherwise the first non-filler token that looks like a ticker or pair.
    for word in re.findall(r"[A-Z0-9/]{2,}", upper):
        if word not in _STOP and re.search(r"[A-Z]", word):
            return word
    return "BTC"


def parse_chart_goal(goal: str) -> str | None:
    """If `goal` is a request to open a live chart, return the symbol; else None.

    Matches a chart intent at the start of the goal (so a bigger task that merely
    mentions "chart" mid-sentence isn't hijacked), or the word "tradingview"
    anywhere.
    """
    if not goal:
        return None
    low = goal.strip().lower()
    # Never hijack an authoring task — "make/draw a chart in Excel" is ybot doing
    # real work in an app, not a request to view a live market chart.
    if re.search(
        r"\b(make|create|draw|insert|build|generate|plot|add|edit)\b"
        r"|\b(excel|word|powerpoint|ppt|sheets|slides|docs?|notepad|paint|"
        r"photoshop|illustrator|canva|figma)\b",
        low,
    ):
        return None
    # A chart request from the start: an optional opener + article, then up to two
    # filler/symbol tokens (e.g. "live SOL", "the ethereum"), then a chart word.
    # Capping the filler tokens keeps "open notepad and make a chart in Excel"
    # from matching, since "chart" there is too many tokens deep.
    starts_chart = re.match(
        r"^\s*(?:can you\s+|please\s+)?"
        r"(?:show(?:\s+me)?|open|pull\s+up|bring\s+up|display|view|see|get|load)?\s*"
        r"(?:the\s+|a\s+|an\s+)?(?:live\s+)?(?:price\s+)?"
        r"(?:[a-z0-9/:]+\s+){0,2}"
        r"(?:chart|charts|candles?|candlesticks?)\b",
        low,
    )
    if starts_chart or "tradingview" in low:
        return _extract_symbol(goal)
    return None


def open_chart(symbol: str = "BTC") -> str:
    """Open the live TradingView chart for `symbol` in the default browser.

    Returns the URL that was opened.
    """
    url = chart_url(symbol)
    webbrowser.open(url, new=2)
    return url
