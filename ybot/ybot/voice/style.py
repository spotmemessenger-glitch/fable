"""Emotion + speaking-style engine.

Maps an intent / emotional label onto concrete synthesis parameters. Kept
provider-agnostic: each TTS provider reads whichever fields it supports and
ignores the rest.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SpeakingStyle:
    name: str = "neutral"
    length_scale: float = 1.0   # >1 slower, <1 faster
    pitch_shift: float = 0.0    # semitones
    energy: float = 1.0         # 0-2 loudness / intensity multiplier
    pause_scale: float = 1.0    # inter-sentence pause multiplier


STYLES: dict[str, SpeakingStyle] = {
    "neutral": SpeakingStyle("neutral"),
    "calm": SpeakingStyle("calm", length_scale=1.12, energy=0.85, pause_scale=1.25),
    "urgent": SpeakingStyle("urgent", length_scale=0.85, energy=1.35, pause_scale=0.7),
    "friendly": SpeakingStyle("friendly", length_scale=0.97, pitch_shift=0.8, energy=1.1),
    "apologetic": SpeakingStyle("apologetic", length_scale=1.1, pitch_shift=-0.6, energy=0.8),
    "confident": SpeakingStyle("confident", length_scale=0.94, energy=1.2),
}


def for_context(
    *, is_error: bool = False, is_confirmation: bool = False, urgency: float = 0.0
) -> SpeakingStyle:
    """Pick a style from conversation context rather than a hard-coded label.

    Deliberately rule-based: an extra LLM call per utterance would add latency
    on the one path where latency is most audible.
    """
    if is_error:
        return STYLES["apologetic"]
    if urgency >= 0.7:
        return STYLES["urgent"]
    if is_confirmation:
        return STYLES["confident"]
    return STYLES["friendly"]


def demo() -> None:
    assert for_context(is_error=True).name == "apologetic"
    assert for_context(urgency=0.9).name == "urgent"
    assert for_context(is_confirmation=True).name == "confident"
    assert for_context().name == "friendly"
    # urgent must actually speak faster than calm, not just carry a label
    assert STYLES["urgent"].length_scale < STYLES["calm"].length_scale
    print("style: ok")


if __name__ == "__main__":
    demo()
