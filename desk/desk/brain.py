"""Conversational brains — the seats can now listen and answer back.

Until now a seat could only *emit*: collect() produced a Reading and narrate()
turned it into one spoken line. There was no way to ask a seat a question. This
adds that, without weakening the safety argument that makes the desk usable.

The rule that keeps this safe:

    A brain may only TALK ABOUT a Reading. It may never produce one.

Sizing, stops and vetoes still read Reading.signal and Reading.metrics, which
are computed in Python from real data. A brain's reply is prose that lands in
front of the operator and nowhere else. If a model hallucinates a number here,
it misinforms a human who can push back — it does not move money. That is a
different and much smaller blast radius than letting a model decide.

Each seat carries its own rolling history, so "and what about ETH?" resolves
against what that seat just said rather than starting cold.
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any

from .roster import BY_NAME, Seat

log = logging.getLogger(__name__)

MAX_TURNS = 12          # per seat; trimmed in pairs so history starts on "user"
REPLY_TOKENS = 400
HTTP_TIMEOUT = 30

# Deterministic routing. Cheap, predictable, and debuggable — an LLM router
# would be one more thing that can be wrong for reasons nobody can inspect.
# Longest keyword wins, so "open interest" beats "interest".
ROUTES: dict[str, tuple[str, ...]] = {
    "TIDE":      ("regime", "risk on", "risk off", "dominance", "fear", "greed", "market cap", "chop"),
    "KRAKEN":    ("on-chain", "onchain", "exchange flow", "inflow", "outflow", "whale", "holder", "stablecoin"),
    "COIL":      ("funding", "open interest", "perp", "perpetual", "long short", "liquidation", "squeeze", "leverage"),
    "CHARTIST":  ("chart", "trend", "support", "resistance", "rsi", "macd", "moving average", "ema", "breakout", "level"),
    "SIGMA":     ("volatility", "vol", "atr", "correlation", "probability", "deviation", "variance", "sigma"),
    "VESTA":     ("tokenomics", "supply", "unlock", "vesting", "emission", "dilut", "treasury", "tvl", "revenue"),
    "CASSANDRA": ("risk of", "what could go wrong", "bear case", "against", "counter", "devil", "wrong", "worry"),
    "HOUND":     ("new pair", "new token", "fresh", "launch", "scan meme", "find meme", "trending"),
    "GEIGER":    ("rug", "honeypot", "mint authority", "freeze", "lp lock", "safe", "scam", "contract"),
    "BALLAST":   ("meme size", "degen", "how much meme", "meme exposure"),
    "VIPER":     ("slippage", "route", "jupiter", "take profit", "trailing", "dump", "exit meme"),
    "SENTINEL":  ("risk", "size", "position size", "how big", "how much should",
                  "stop", "exposure", "limit", "veto", "drawdown"),
    "PILOT":     ("order", "fill", "spread", "depth", "orderbook", "execution"),
    "LEDGER":    ("track record", "hit rate", "score", "journal", "history", "how accurate", "past call"),
}


@dataclass
class SeatBrain:
    """One seat's conversational self. Grounded in that seat's own Reading."""

    seat: Seat
    settings: Any
    history: list[dict[str, str]] = field(default_factory=list)

    def _system(self, reading: Any, portfolio: dict[str, Any] | None,
                symbol: str = "") -> str:
        lines = [
            f"You are {self.seat.name}, the {self.seat.role} seat on a crypto trading desk.",
            f"Your remit: {self.seat.brief}",
            f"Your data comes from: {self.seat.sources}.",
            "",
            "You are speaking aloud to the desk operator. Be direct and brief —",
            "two or three sentences unless asked for more. No preamble, no",
            "'great question', no bullet lists. Speak like a colleague on a desk.",
            "",
            "ABSOLUTE RULES:",
            "1. Every number you state must appear in YOUR READING below. If a",
            "   number is not there, say you do not have it. Never estimate,",
            "   never recall a figure from training, never round a missing value",
            "   into existence.",
            "2. You do not place trades and you do not approve them. Sentinel",
            "   sizes and vetoes in code. If asked to trade, say who does it.",
            "3. If your reading is stale, thin, or missing, lead with that.",
            "4. Stay in your remit. If the question belongs to another seat,",
            "   say which seat and answer only your part.",
        ]

        if reading is None:
            lines += ["", "YOUR READING: none taken yet this session. Say so plainly."]
            return "\n".join(lines)

        # Naming the asset is not decoration. Without it seats disowned their
        # own numbers ("I have no SOL data") or invented other departments to
        # refer the question to, because a bare metric says nothing about what
        # it measures. Market-wide seats are told so explicitly, so they stop
        # apologising for not having a per-symbol view they were never meant
        # to have.
        if symbol:
            lines += ["", f"THE DESK IS DISCUSSING: {symbol}.",
                      "The reading below IS your reading for that asset. If your",
                      "remit is market-wide rather than per-asset, say how the",
                      "broad picture bears on it — do not claim you lack data,",
                      "and never refer the question to a desk that does not exist."]

        lines += ["", f"YOUR READING (state={reading.state}, "
                      f"signal={reading.signal:+.2f}, confidence={reading.confidence:.2f}):"]
        for fact in reading.facts:
            lines.append(f"  - {fact}")
        if reading.metrics:
            lines.append("  metrics: " + ", ".join(
                f"{k}={v}" for k, v in list(reading.metrics.items())[:14]))
        if reading.missing:
            lines.append("  MISSING (you do not have these): " + ", ".join(reading.missing))
        if portfolio:
            lines.append(f"  book: {portfolio}")
        return "\n".join(lines)

    def ask(self, question: str, reading: Any = None,
            portfolio: dict[str, Any] | None = None,
            symbol: str = "") -> str:
        """Answer `question` as this seat, grounded in `reading`."""
        provider = self.settings.llm_provider
        if provider == "none":
            return self._offline(reading)

        self.history.append({"role": "user", "content": question})
        self._trim()
        try:
            reply = _call(provider, self._system(reading, portfolio, symbol),
                          self.history, self.settings)
        except Exception:
            log.warning("%s brain call failed", self.seat.name, exc_info=True)
            self.history.pop()          # don't keep an unanswered turn
            return self._offline(reading)

        if not reply:
            self.history.pop()
            return self._offline(reading)
        self.history.append({"role": "assistant", "content": reply})
        return reply

    def _offline(self, reading: Any) -> str:
        """No model, or the model failed. Say something true from the Reading."""
        if reading is None:
            return f"{self.seat.name} has taken no reading yet."
        if not reading.usable:
            return f"{self.seat.name} has no usable data right now ({reading.state})."
        head = reading.facts[0] if reading.facts else "no facts computed"
        return (f"{self.seat.name}: {head}. Signal {reading.signal:+.2f}, "
                f"confidence {reading.confidence:.2f}.")

    def _trim(self) -> None:
        """Keep the last MAX_TURNS messages, always starting on a user turn."""
        if len(self.history) <= MAX_TURNS:
            return
        cut = len(self.history) - MAX_TURNS
        while cut < len(self.history) and self.history[cut]["role"] != "user":
            cut += 1
        self.history = self.history[cut:]


def route(question: str) -> str:
    """Which seat should field this question. HELM when nothing matches."""
    text = question.lower()
    # An explicitly named seat always wins over a keyword match.
    for name in BY_NAME:
        if re.search(rf"\b{name.lower()}\b", text):
            return name
    best_seat, best_len = "HELM", 0
    for name, keywords in ROUTES.items():
        for kw in keywords:
            if kw in text and len(kw) > best_len:
                best_seat, best_len = name, len(kw)
    return best_seat


class DeskBrains:
    """Every seat's brain, plus the routing that picks who answers."""

    def __init__(self, settings: Any) -> None:
        self.settings = settings
        self.brains: dict[str, SeatBrain] = {
            seat.name: SeatBrain(seat, settings) for seat in BY_NAME.values()
        }

    def ask(self, question: str, readings: dict[str, Any] | None = None,
            portfolio: dict[str, Any] | None = None,
            seat: str | None = None, symbol: str = "") -> dict[str, Any]:
        """Route `question` to a seat and return its reply.

        `readings` is HELM's per-seat Reading map from the last cycle. A seat
        with no reading still answers — it says it has nothing, which is the
        honest response and far better than improvising.
        """
        name = (seat or route(question)).upper()
        if name not in self.brains:
            name = "HELM"
        brain = self.brains[name]
        reading = (readings or {}).get(name)
        text = brain.ask(question, reading, portfolio, symbol)
        return {
            "seat": name,
            "text": text,
            "grounded": reading is not None and getattr(reading, "usable", False),
            "missing": list(getattr(reading, "missing", []) or []),
        }

    def reset(self, seat: str | None = None) -> None:
        """Clear conversation history — one seat, or the whole desk."""
        targets = [seat.upper()] if seat else list(self.brains)
        for name in targets:
            if name in self.brains:
                self.brains[name].history = []


# --------------------------------------------------------------------------
# provider plumbing — mirrors narrate.py, but multi-turn
# --------------------------------------------------------------------------

def _call(provider: str, system: str, history: list[dict[str, str]],
          settings: Any) -> str | None:
    if provider == "anthropic":
        return _anthropic(system, history, settings)
    if provider == "ollama":
        return _ollama(system, history, settings)
    log.warning("unknown DESK_LLM_PROVIDER %r", provider)
    return None


def _anthropic(system: str, history: list[dict[str, str]], settings: Any) -> str | None:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    import requests
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"},
        json={"model": settings.llm_model, "max_tokens": REPLY_TOKENS,
              "system": system, "messages": history},
        timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    blocks = resp.json().get("content", [])
    return "".join(b.get("text", "") for b in blocks).strip() or None


def _ollama(system: str, history: list[dict[str, str]], settings: Any) -> str | None:
    host = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
    # Ollama Cloud (ollama.com) needs a bearer token; a local server ignores it.
    key = os.environ.get("OLLAMA_API_KEY", "")
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    import requests
    resp = requests.post(
        f"{host.rstrip('/')}/api/chat",
        headers=headers,
        json={"model": settings.llm_model, "stream": False,
              "messages": [{"role": "system", "content": system}] + history},
        timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    return (resp.json().get("message") or {}).get("content", "").strip() or None
