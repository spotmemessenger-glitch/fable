"""Voice microservice: the full mic -> speech loop, in one process.

    mic -> VAD -> STT -> intent -> orchestrator -> style -> TTS -> speaker

Runs on the Python 3.11 voice venv (torch has no 3.14 wheels, and ybot itself
is 3.14). Ybot talks to it through voice/bridge.py over a localhost socket.

Run:
    C:\\Users\\yuv\\.venvs\\voice\\Scripts\\python.exe -m ybot.voice.service
"""
from __future__ import annotations

import json
import os
import socket
import threading
from dataclasses import dataclass
from typing import Callable

from . import style as style_mod
from .intent import Domain, IntentManager
from .memory import MemoryManager
from .mic import SAMPLE_RATE, MicrophoneManager
from .orchestrator import Orchestrator
from .player import BargeInWatcher, Speaker
from .vad import UtteranceSegmenter, VADConfig

HOST, PORT = "127.0.0.1", 8765

# Virtual-key codes for the keys a push-to-talk combo is likely to use.
# https://learn.microsoft.com/windows/win32/inputdev/virtual-key-codes
_VK = {
    "ctrl": 0x11, "control": 0x11, "shift": 0x10, "alt": 0x12, "menu": 0x12,
    "space": 0x20, "tab": 0x09, "capslock": 0x14, "esc": 0x1B, "escape": 0x1B,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
    "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}


def _vk_for(name: str) -> int:
    """Virtual-key code for one key name; single characters map by ordinal."""
    key = name.strip().lower()
    if key in _VK:
        return _VK[key]
    if len(key) == 1:
        return ord(key.upper())
    raise ValueError(f"unknown key {name!r} in push-to-talk combo")


def _win_key_held(combo: str):  # noqa: ANN202
    """Return a predicate: are ALL keys in this combo held down right now?

    GetAsyncKeyState's high bit is the "currently down" flag. The low bit means
    "pressed since the last call" and is deliberately ignored — it would latch
    a single tap into an open microphone, which is the opposite of a hold gate.
    """
    import ctypes

    user32 = ctypes.windll.user32          # noqa: SLF001 - the Win32 surface
    codes = [_vk_for(part) for part in combo.split("+") if part.strip()]
    if not codes:
        raise ValueError(f"empty push-to-talk combo: {combo!r}")

    def held(_combo: str | None = None) -> bool:
        return all(user32.GetAsyncKeyState(c) & 0x8000 for c in codes)

    held()          # probe now rather than mid-conversation
    return held


@dataclass
class VoiceConfig:
    device: int | None = None
    stt_provider: str | None = None
    tts_provider: str | None = None
    speak: bool = True
    vad: VADConfig | None = None
    # Push-to-talk: audio is only considered while this key is held. Default ON
    # because an always-open microphone is a decision the user should opt into,
    # not inherit. Set ptt_key to "" for continuous listening.
    ptt_key: str = os.environ.get("YBOT_PTT_KEY", "ctrl+space")


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
        self.speaker = Speaker(SAMPLE_RATE)
        self.barge = BargeInWatcher(self.speaker, self.segmenter)
        self._stt = None
        self._tts = None
        self._stop = threading.Event()
        self._speaking: threading.Thread | None = None
        self._subscribers: list[socket.socket] = []
        self._ptt = self._load_ptt()

    def _load_ptt(self):  # noqa: ANN202
        """Resolve the push-to-talk key checker, or None when disabled.

        Uses GetAsyncKeyState, not a keyboard hook and not RegisterHotKey.

        The distinction matters for HOLD-to-talk specifically. Win32's hotkey
        APIs — RegisterHotKey, and the older WM_SETHOTKEY — deliver a message
        when a key is PRESSED; neither tells you when it is released, so a
        "hold to speak" gate built on them has to guess when you stopped, and
        guesses wrong. Low-level hooks (what the `keyboard` package installs)
        do see both edges but want elevated rights on Windows, which is a
        miserable requirement for a desktop assistant.

        GetAsyncKeyState answers a different question — "is this key down right
        now" — which is exactly the question a hold gate asks, needs no
        elevation, and no dependency beyond ctypes.
        """
        if not self.cfg.ptt_key:
            return None
        try:
            return _win_key_held(self.cfg.ptt_key)
        except Exception as exc:                      # noqa: BLE001
            raise RuntimeError(
                f"push-to-talk key {self.cfg.ptt_key!r} unusable ({exc}). "
                "Set YBOT_PTT_KEY='' to listen continuously — an always-open "
                "microphone should be a deliberate choice, so this will not "
                "quietly fall back to one."
            ) from exc

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
        """Start speaking and return immediately.

        Non-blocking on purpose. The old version played to completion inside the
        turn, which meant the microphone loop stopped pulling frames for the
        duration — so nothing could hear an interruption, and "barge-in" was
        structurally impossible no matter what flags were checked. Playback now
        runs alongside listening, and player.Speaker is what actually cuts it.
        """
        if not self.cfg.speak or not text.strip():
            return
        self.speaker.interrupt()          # never let two replies overlap
        if self._speaking and self._speaking.is_alive():
            self._speaking.join(timeout=1.0)

        def _play() -> None:
            try:
                finished = self.speaker.play(self.tts().stream(text, st))
                if not finished:
                    self._emit({"type": "interrupted", "text": text})
            except Exception as exc:                  # noqa: BLE001
                self._emit({"type": "error", "text": f"TTS unavailable: {exc}"})

        self._speaking = threading.Thread(target=_play, daemon=True)
        self._speaking.start()

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

    def _listen_frames(self, mic):  # noqa: ANN001, ANN202
        """Mic frames, with playback echo held back and barge-in watched for.

        While the assistant is talking, an open speaker feeds its own voice
        straight back into the microphone. Passing those frames to the segmenter
        would make it transcribe itself and answer its own reply. So during
        playback frames go only to the barge-in watcher, which is deliberately
        stricter (energy floor plus consecutive speech frames). The moment it
        fires, playback is cut and frames flow normally again — that frame
        included, so the interrupting words start the next utterance.

        Cost, stated plainly: the first few frames of an interruption are spent
        deciding it IS an interruption, so a barged-in sentence can lose its
        first word. Headphones remove the whole problem; real echo cancellation
        (RNNoise/Krisp) is the fix that would let this be less cautious.
        """
        for frame in mic.frames():
            if not self._mic_open():
                continue
            if self.speaker.playing:
                if not self.barge.feed(frame):
                    continue
                self._emit({"type": "barge_in", "text": ""})
            yield frame

    def _mic_open(self) -> bool:
        """Push-to-talk gate. Always true when no key is configured.

        The audio stream stays running either way — starting and stopping the
        device on every keypress costs hundreds of milliseconds and would clip
        the first word. Frames are simply discarded while the key is up, so
        nothing unspoken reaches the segmenter, the network or the log.
        """
        if not self.cfg.ptt_key or self._ptt is None:
            return True
        return bool(self._ptt(self.cfg.ptt_key))

    def run(self) -> None:
        threading.Thread(target=self.serve_subscribers, daemon=True).start()
        print(f"voice service listening on {HOST}:{PORT}; speak into the mic.")
        with MicrophoneManager(self.cfg.device) as mic:
            for utterance in self.segmenter.segment(self._listen_frames(mic)):
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
