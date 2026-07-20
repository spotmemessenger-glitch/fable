"""The voice front end: wake word, listen, think, speak.

State machine:

  SLEEPING  — listening only for a wake word ("Jarvis" / "Hey Jarvis").
  ACTIVE    — wake word heard; acknowledge, then take commands until the owner
              stops talking for a while, then drop back to SLEEPING.

Approval for confirm-tier actions is spoken: the assistant asks, the owner
answers out loud. Nothing that spends money or publishes runs without that yes.
"""

from __future__ import annotations

import logging
import time

from .config import settings
from .app import Session
from .voice import Ears, Mouth, SpeechQueue
from .tools.registry import Tool

log = logging.getLogger(__name__)

ACKNOWLEDGEMENTS = "Yuvraj, at your service."
IDLE_TIMEOUT_SECONDS = 30
AFFIRMATIVES = {"yes", "yeah", "yep", "sure", "do it", "go ahead", "confirm", "okay", "ok"}


def _contains_wake_word(text: str, wake_words: tuple[str, ...]) -> bool:
    lowered = f" {text.lower()} "
    return any(f" {w} " in lowered or lowered.strip() == w for w in wake_words)


def _strip_wake_word(text: str, wake_words: tuple[str, ...]) -> str:
    out = text
    for w in sorted(wake_words, key=len, reverse=True):
        idx = out.lower().find(w)
        if idx != -1:
            out = out[:idx] + out[idx + len(w):]
    return out.strip(" ,.-") .strip()


def run_voice(owner: str = "the owner") -> int:
    from .app import _setup_logging

    _setup_logging(settings.log_path)
    cfg = settings

    ears = Ears(language=cfg.stt_language)
    if not ears.available:
        print("  No microphone available. Run without --voice for text mode.")
        return 1

    mouth = Mouth(cfg.elevenlabs_api_key, cfg.voice_id, cfg.tts_model, enabled=cfg.tts_enabled)
    speech = SpeechQueue(mouth)
    session = Session(cfg, owner=owner)

    # Replace the typed approval gate with a spoken one.
    session.brain.approver = _make_spoken_approver(ears, speech, cfg.wake_words)

    print(f"\n  {cfg.assistant_name} is listening. Say '{cfg.wake_words[0]}' to wake me.")
    print("  Ctrl+C to stop.\n")
    ears.calibrate()

    try:
        _loop(session, ears, speech, cfg)
    except KeyboardInterrupt:
        print("\n  Stopping.")
    finally:
        speech.stop()
        session.close()
    return 0


def _loop(session: Session, ears: Ears, speech: SpeechQueue, cfg) -> None:
    active_until = 0.0

    while True:
        heard = ears.listen()
        if not heard:
            continue

        now = time.monotonic()
        awake = now < active_until

        if not awake:
            if not _contains_wake_word(heard, cfg.wake_words):
                continue
            command = _strip_wake_word(heard, cfg.wake_words)
            speech.push(ACKNOWLEDGEMENTS)
            if not command:
                active_until = now + IDLE_TIMEOUT_SECONDS
                speech.wait()
                continue
        else:
            command = heard

        print(f"  you > {command}")
        speech.interrupt()  # let the owner cut off a previous reply
        spoke = False
        for sentence in session.brain.respond(command):
            speech.push(sentence)
            spoke = True
        if not spoke:
            speech.push("I didn't catch anything to do there.")
        speech.wait()
        active_until = time.monotonic() + IDLE_TIMEOUT_SECONDS


def _make_spoken_approver(ears: Ears, speech: SpeechQueue, wake_words):
    """Build an approver that asks out loud and listens for a yes."""

    def approve(tool: Tool, arguments: dict) -> bool:
        speech.push(f"You want me to {tool.describe_call(arguments)}. Should I?")
        speech.wait()
        answer = ears.listen()
        if not answer:
            speech.push("I didn't hear an answer, so I'll leave it.")
            speech.wait()
            return False
        ok = any(a in answer.lower() for a in AFFIRMATIVES)
        print(f"  [approval] {tool.name}: {'yes' if ok else 'no'} ({answer!r})")
        return ok

    return approve
