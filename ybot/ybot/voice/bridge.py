"""Ybot-side client for the voice microservice.

IMPORTANT: this module runs inside ybot on Python 3.14 and therefore imports
**stdlib only**. The voice stack (torch, whisper, sounddevice) lives in the
3.11 venv behind service.py and must never be imported from here.

Usage from ybot:

    from ybot.voice.bridge import VoiceBridge
    with VoiceBridge() as vb:
        for event in vb.events():
            if event["type"] == "transcript":
                goal = event["text"]
"""
from __future__ import annotations

import json
import socket
import subprocess
import sys
from pathlib import Path
from typing import Iterator

HOST, PORT = "127.0.0.1", 8765
VOICE_PYTHON = Path(r"C:\Users\yuv\.venvs\voice\Scripts\python.exe")


def service_running(timeout: float = 0.4) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((HOST, PORT)) == 0


def start_service(cwd: Path | None = None) -> subprocess.Popen[bytes]:
    """Launch the voice service on its own interpreter.

    Raises rather than silently degrading: a missing 3.11 venv is a setup
    error the operator needs to see, not something to paper over.
    """
    if not VOICE_PYTHON.exists():
        raise RuntimeError(
            f"voice interpreter not found at {VOICE_PYTHON}. The voice stack needs "
            "Python 3.11 (torch has no 3.14 wheels). Create it with: "
            "py -3.11 -m venv %USERPROFILE%\\.venvs\\voice"
        )
    root = cwd or Path(__file__).resolve().parents[2]
    # stdout is DISCARDED, not piped. The service prints a line per event, and
    # a PIPE nobody drains fills its ~64 KB buffer and then blocks the child
    # mid-conversation — a hang that would look like the microphone dying.
    # Events arrive over the socket anyway; stderr stays attached so a
    # traceback or a setup error is still visible in the console.
    return subprocess.Popen(
        [str(VOICE_PYTHON), "-m", "ybot.voice.service"],
        cwd=str(root),
        stdout=subprocess.DEVNULL,
    )


class VoiceBridge:
    """Subscribes to the voice service event stream."""

    def __init__(self, autostart: bool = False) -> None:
        self.autostart = autostart
        self._sock: socket.socket | None = None
        self._proc: subprocess.Popen[bytes] | None = None

    def __enter__(self) -> "VoiceBridge":
        if not service_running() and self.autostart:
            self._proc = start_service()
        self._sock = socket.create_connection((HOST, PORT), timeout=10)
        return self

    def __exit__(self, *exc: object) -> None:
        if self._sock is not None:
            self._sock.close()
            self._sock = None
        if self._proc is not None:
            self._proc.terminate()
            self._proc = None

    def events(self) -> Iterator[dict]:
        """Yield decoded events. Partial lines are buffered across recv calls."""
        if self._sock is None:
            raise RuntimeError("VoiceBridge used outside a with-block")
        buf = b""
        while True:
            chunk = self._sock.recv(4096)
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    yield json.loads(line.decode("utf-8"))
                except json.JSONDecodeError:
                    continue   # never let one bad frame kill the stream


def demo() -> None:
    # stdlib-only guarantee: this must hold on ybot's 3.14 interpreter
    for banned in ("numpy", "torch", "sounddevice", "webrtcvad"):
        assert banned not in sys.modules, f"{banned} leaked into the 3.14 bridge"

    assert isinstance(service_running(), bool)

    vb = VoiceBridge()
    try:
        next(vb.events())
    except RuntimeError as exc:
        assert "outside a with-block" in str(exc)
    else:
        raise AssertionError("events() must refuse to run unconnected")

    print("bridge: ok (stdlib-only, refuses use outside with-block)")


if __name__ == "__main__":
    demo()
