"""Voice mode: start the speech service and follow the conversation.

ybot runs on Python 3.14; the speech stack needs 3.11 (torch publishes no 3.14
wheels), so the two cannot share an interpreter. `voice/bridge.py` already owns
that split — launching the child, connecting, and tearing it down. This module
is only the console face of it: what the user sees while talking.

Quitting kills the microphone with it. The service is a child process, not a
daemon that outlives the session.
"""
from __future__ import annotations

import os
import sys

from .voice.bridge import VoiceBridge


def run() -> None:
    """Stream the conversation until Ctrl-C."""
    ptt = os.environ.get("YBOT_PTT_KEY", "ctrl+space")
    print("=" * 64)
    print(" Ybot — voice")
    if ptt:
        print(f" Hold {ptt.upper()} to talk. The microphone is ignored otherwise.")
    else:
        print(" CONTINUOUS LISTENING: the microphone is open until you quit.")
    print(" Speak over Ybot at any time — it stops mid-word.")
    print(" Headphones recommended: on open speakers it can hear its own voice.")
    print(" Starting the speech service (first run loads models)…")
    print("=" * 64)

    labels = {
        "transcript": "you  >",
        "reply": "ybot >",
        "error": "  !  ",
    }
    try:
        with VoiceBridge(autostart=True) as bridge:
            for event in bridge.events():
                kind = str(event.get("type", ""))
                text = str(event.get("text", ""))
                if kind == "barge_in":
                    print("      (listening — you interrupted)")
                elif kind == "interrupted":
                    print("      (cut off)")
                elif kind in labels:
                    print(f"{labels[kind]} {text}")
    except KeyboardInterrupt:
        print("\nstopping voice. Microphone released.")
    except Exception as exc:                          # noqa: BLE001
        # Setup problems (missing 3.11 venv, push-to-talk without admin) are
        # the common case here and deserve their message shown plainly rather
        # than as a traceback through the crash reporter.
        print(f"\nvoice could not start: {exc}")


def demo() -> None:
    """What can be checked without a microphone or a running service."""
    from pathlib import Path

    from .voice import bridge

    root = Path(__file__).resolve().parents[1]
    assert (root / "ybot" / "voice" / "service.py").exists(), root
    found = bridge.VOICE_PYTHON.exists()
    print(
        f"voice_mode: ok (service module present, 3.11 interpreter "
        f"{'found' if found else 'MISSING — create ~/.venvs/voice'})"
    )


if __name__ == "__main__":
    if "--demo" in sys.argv:
        demo()
    else:
        run()
