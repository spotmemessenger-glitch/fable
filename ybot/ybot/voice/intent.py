"""Conversation and intent manager.

Classifies each utterance into a routable Intent before any LLM call. Cheap
deterministic rules run first; only genuinely ambiguous input needs the model.
That keeps the common case (wake word, stop, a simple command) near zero
latency, which is the whole point on a voice path.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum


class Domain(str, Enum):
    CODING = "coding"
    RESEARCH = "research"
    BROWSER = "browser"
    UIUX = "uiux"
    FILESYSTEM = "filesystem"
    THREED = "3d"
    TRADING = "trading"
    DESKTOP = "desktop"
    CHITCHAT = "chitchat"
    CONTROL = "control"       # stop / cancel / sleep
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class Intent:
    domain: Domain
    text: str
    confidence: float
    slots: dict[str, str] = field(default_factory=dict)
    urgency: float = 0.0


CONTROL_WORDS = {"stop", "cancel", "abort", "quiet", "shut up", "never mind", "nevermind"}

# Ordered: first match wins, so narrow patterns sit above broad ones. CONTROL is
# first on purpose - "cancel the chart" must stop work, not open a chart.
RULES: tuple[tuple[Domain, re.Pattern[str]], ...] = (
    (Domain.CONTROL, re.compile(r"\b(stop|cancel|abort|never ?mind|quiet)\b", re.I)),
    (Domain.TRADING, re.compile(r"\b(chart|price|buy|sell|portfolio|ticker|btc|eth|sol)\b", re.I)),
    (Domain.THREED, re.compile(r"\b(blender|mesh|3d|render|uv|cad|step file)\b", re.I)),
    (Domain.BROWSER, re.compile(r"\b(browse|website|url|google|search online)\b", re.I)),
    (Domain.FILESYSTEM, re.compile(r"\b(file|folder|directory|rename|delete|move|copy)\b", re.I)),
    (Domain.CODING, re.compile(r"\b(code|function|bug|refactor|test|commit|repo|compile)\b", re.I)),
    (Domain.UIUX, re.compile(r"\b(design|layout|ui|ux|figma|mockup|wireframe)\b", re.I)),
    (Domain.RESEARCH, re.compile(r"\b(research|find out|look up|compare|what is|who is)\b", re.I)),
    (Domain.DESKTOP, re.compile(r"\b(click|type|open|close|window|screenshot|app)\b", re.I)),
)

URGENT = re.compile(r"\b(now|immediately|quick|hurry|asap|urgent)\b", re.I)


class IntentManager:
    """Rule-first classifier. `llm` is an optional fallback callable."""

    def __init__(self, llm=None) -> None:  # noqa: ANN001
        self._llm = llm

    def classify(self, text: str, context: dict | None = None) -> Intent:
        clean = text.strip()
        if not clean:
            return Intent(Domain.UNKNOWN, clean, 0.0)

        urgency = 1.0 if URGENT.search(clean) else 0.0

        if clean.lower() in CONTROL_WORDS:
            return Intent(Domain.CONTROL, clean, 1.0, urgency=1.0)

        for domain, pat in RULES:
            if pat.search(clean):
                conf = 0.9 if domain is Domain.CONTROL else 0.75
                return Intent(domain, clean, conf, urgency=urgency)

        if self._llm is not None:
            guess = self._llm(clean, context or {})
            try:
                return Intent(Domain(guess), clean, 0.6, urgency=urgency)
            except ValueError:
                pass  # model returned a domain we do not know; fall through

        return Intent(Domain.CHITCHAT, clean, 0.3, urgency=urgency)


def demo() -> None:
    im = IntentManager()
    assert im.classify("stop").domain is Domain.CONTROL
    assert im.classify("show me the BTC chart").domain is Domain.TRADING
    assert im.classify("open blender and render this").domain is Domain.THREED
    assert im.classify("refactor this function").domain is Domain.CODING
    assert im.classify("").domain is Domain.UNKNOWN
    assert im.classify("do it now").urgency == 1.0
    # control must outrank a domain keyword in the same sentence
    assert im.classify("cancel the chart").domain is Domain.CONTROL
    print("intent: ok (control precedence held)")


if __name__ == "__main__":
    demo()
