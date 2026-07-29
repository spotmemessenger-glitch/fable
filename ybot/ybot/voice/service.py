"""Voice microservice: the full mic -> speech loop, in one process.

    mic -> VAD -> STT -> intent -> orchestrator -> style -> TTS -> speaker

Runs on the Python 3.11 voice venv (torch has no 3.14 wheels, and ybot itself
is 3.14). Ybot talks to it through voice/bridge.py over a localhost socket.

Run:
    C:\\Users\\yuv\\.venvs\\voice\\Scripts\\python.exe -m ybot.voice.service
"""
from __future__ import annotations

import json
import socket
import threading
from dataclasses import dataclass
from typing import Callable

import numpy as np
import sounddevice as sd

from . import style as style_mod
from .intent import Domain, IntentManager
from .memory import MemoryManager
from .mic import SAMPLE_RATE, MicrophoneManager
from .orchestrator import Orchestrator
from .vad import UtteranceSegmenter, VADConfig

HOST, PORT = "127.0.0.1", 8765


@dataclass
class VoiceConfig:
    device: int | None = None
    stt_provider: str | None = None
    tts_provider: str | None = None
    speak: bool = True
    vad: VADConfig | None = None


class VoiceService:
    """Owns the pipeline. Providers are resolved lazily so the loop can start
    (and report a clear error) even when a model or voice file is missing."""

    def __init__(
        self,
        cfg: VoiceConfig | None = None,
        approver: Callable[[str], bool] | None = None,
    ) -> None:
        self.cfg = cfg or VoiceConfig()
        self.memory = MemoryManager()
        self.intents = IntentManager()
        self.orch = Orchestrator(approver=approver)
        self.segmenter = UtteranceSegmenter(self.cfg.vad)
        self._stt = None
        self._tts = None
        self._stop = threading.Event()
        self._subscribers: list[socket.socket] = []

    # ---------------------------------------------------------------- providers
    def stt(self):  # noqa: ANN201
        if self._stt is None:
            from .providers import get_stt

            self._stt = get_stt(self.cfg.stt_provider)
        return self._stt

    def tts(self):  # noqa: ANN201
        if self._tts is None:
            from .providers import get_tts

            self._tts = get_tts(self.cfg.tts_provider)
        return self._tts

    # ---------------------------------------------------------------- output
    def _emit(self, payload: dict) -> None:
        line = (json.dumps(payload) + "\n").encode("utf-8")
        for s in list(self._subscribers):
            try:
                s.sendall(line)
            except OSError:
                self._subscribers.remove(s)   # a dead client must not stall the loop
        print(f"[{payload.get('type')}] {payload.get('text', '')}")

    def speak(self, text: str, st: style_mod.SpeakingStyle) -> None:
        if not self.cfg.speak or not text.strip():
            return
        try:
            with sd.OutputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32") as out:
                for chunk in self.tts().stream(text, st):
                    if self._stop.is_set():
                        break            # barge-in: stop mid-sentence
                    out.write(np.asarray(chunk, dtype=np.float32))
        except Exception as exc:                      # noqa: BLE001
            self._emit({"type": "error", "text": f"TTS unavailable: {exc}"})

    # ---------------------------------------------------------------- turn
    def handle(self, transcript: str) -> None:
        if not transcript.strip():
            return
        self.memory.record("user", transcript)
        self._emit({"type": "transcript", "text": transcript})

        ctx = self.memory.context(query=transcript)
        intent = self.intents.classify(transcript, ctx)

        if intent.domain is Domain.CONTROL:
            self._stop.set()                          # interrupt current speech
            self._stop.clear()
            reply = "Stopped."
        else:
            reply = self.orch.dispatch(intent)

        d = self.orch.plan(intent)
        self.memory.record("assistant", reply, tags=(intent.domain.value,))
        self._emit(
            {
                "type": "reply",
                "text": reply,
                "domain": intent.domain.value,
                "agent": d.route.agent,
            }
        )

        self.speak(
            reply,
            style_mod.for_context(
                is_error=reply.lower().startswith(("no handler", "cancelled")),
                is_confirmation=intent.domain is Domain.DESKTOP,
                urgency=intent.urgency,
            ),
        )

    # ---------------------------------------------------------------- loops
    def serve_subscribers(self) -> None:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind((HOST, PORT))
        srv.listen(5)
        while not self._stop.is_set():
            try:
                conn, _ = srv.accept()
                self._subscribers.append(conn)
            except OSError:
                break

    def run(self) -> None:
        threading.Thread(target=self.serve_subscribers, daemon=True).start()
        print(f"voice service listening on {HOST}:{PORT}; speak into the mic.")
        with MicrophoneManager(self.cfg.device) as mic:
            for utterance in self.segmenter.segment(mic.frames()):
                try:
                    text = self.stt().transcribe(utterance)
                except Exception as exc:              # noqa: BLE001
                    self._emit({"type": "error", "text": f"STT unavailable: {exc}"})
                    continue
                self.handle(text)
                if mic.dropped:
                    self._emit(
                        {"type": "error", "text": f"dropped {mic.dropped} audio frames"}
                    )


def demo() -> None:
    """Offline check of the turn pipeline: no mic, no models, no audio out."""
    svc = VoiceService(VoiceConfig(speak=False), approver=lambda r: False)
    seen: list[dict] = []
    svc._emit = lambda p: seen.append(p)          # type: ignore[method-assign]
    svc.orch.register("desktop-operator", lambda i: "clicked it")

    svc.handle("click the start button")
    kinds = [s["type"] for s in seen]
    assert kinds == ["transcript", "reply"], kinds
    assert seen[1]["domain"] == "desktop"
    assert seen[1]["text"] == "clicked it"

    seen.clear()
    svc.handle("delete that folder")               # approval denied above
    assert seen[1]["text"] == "Cancelled - not approved."

    seen.clear()
    svc.handle("")                                  # empty must be a no-op
    assert seen == []
    assert len(svc.memory.short.recent()) == 4      # 2 turns x (user+assistant)
    print("service: ok (turn pipeline, approval denial, empty no-op)")


if __name__ == "__main__":
    import sys

    if "--demo" in sys.argv:
        demo()
    else:
        VoiceService().run()
