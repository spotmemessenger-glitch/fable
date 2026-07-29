"""Pick the smallest model that can answer, and skip the model entirely when possible.

Three tiers, cheapest first:

  LOCAL   — no model call at all. "stop", "cancel", "louder" are control, not
            conversation, and routing them through an LLM adds a round trip to
            something that must feel instant.
  FAST    — Sonnet. Greetings, acknowledgements, short factual answers, and the
            mechanical desktop steps that make up most of a task.
  SMART   — Opus. Planning, architecture, debugging, research, anything spanning
            many steps or needing real reasoning.

Deliberately keyword-driven rather than model-driven: asking a model which model
to use costs the latency the routing was meant to save. Misroutes are cheap in
one direction only — FAST answering something hard is recoverable (escalate),
SMART answering "hello" is a second of dead air the user always notices. So the
rules bias toward FAST and escalate on evidence.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum


class Tier(str, Enum):
    LOCAL = "local"
    FAST = "fast"
    SMART = "smart"


# Control phrases: handled in-process, never sent to a model.
CONTROL = {
    "stop": "stop", "stop it": "stop", "cancel": "stop", "quiet": "stop",
    "shut up": "stop", "never mind": "stop", "abort": "stop",
    "wait": "pause", "hold on": "pause", "pause": "pause",
    "continue": "resume", "go on": "resume", "carry on": "resume", "resume": "resume",
    "louder": "louder", "speak up": "louder",
    "quieter": "quieter", "softer": "quieter",
    "slower": "slower", "faster": "faster",
    "repeat": "repeat", "say that again": "repeat", "what did you say": "repeat",
}

_SMART = re.compile(
    r"\b(architect|architecture|design|refactor|debug|diagnose|analys|analyz|"
    r"research|compare|evaluate|plan|strategy|migrate|optimi[sz]e|"
    r"why (is|does|did|are)|explain how|trade-?off|implement|write (a|the) (code|script|program)|"
    r"review|audit|investigate)\b",
    re.IGNORECASE,
)

_MULTI_STEP = re.compile(r"\b(then|after that|and then|first.*then|for each|all of the)\b", re.IGNORECASE)

_TRIVIAL = re.compile(
    r"^(hi|hey|hello|yo|thanks|thank you|ok|okay|cool|nice|great|sure|yes|yeah|no|nope|"
    r"good morning|good evening|good night|bye|goodbye)\b[\s!.?]*$",
    re.IGNORECASE,
)


@dataclass
class Route:
    tier: Tier
    reason: str
    control: str | None = None   # set when tier is LOCAL


def route(utterance: str, *, busy: bool = False) -> Route:
    """Choose a tier for one user utterance.

    busy: a task is running, so control words are far more likely to mean
        "stop the task" than to be conversational filler.
    """
    text = utterance.strip()
    if not text:
        return Route(Tier.LOCAL, "empty utterance", control="noop")

    key = text.lower().strip(" .!?,")
    if key in CONTROL:
        return Route(Tier.LOCAL, f"control phrase {key!r}", control=CONTROL[key])

    # While busy, a bare "stop" embedded in a short phrase still means stop.
    if busy and len(key.split()) <= 3:
        for phrase, cmd in CONTROL.items():
            if re.search(rf"\b{re.escape(phrase)}\b", key):
                return Route(Tier.LOCAL, f"control phrase {phrase!r} while busy", control=cmd)

    if _TRIVIAL.match(text):
        return Route(Tier.FAST, "greeting or acknowledgement")

    if _SMART.search(text):
        return Route(Tier.SMART, "reasoning verb present")

    if _MULTI_STEP.search(text) or len(text.split()) > 40:
        return Route(Tier.SMART, "multi-step or long request")

    return Route(Tier.FAST, "default: most requests are mechanical")


def escalate(previous: Route, reason: str = "fast model could not complete") -> Route:
    """Move up a tier after evidence, not suspicion."""
    if previous.tier is Tier.SMART:
        return previous
    return Route(Tier.SMART, reason)
