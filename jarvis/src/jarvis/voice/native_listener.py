"""Fully autonomous native voice listener.

Runs entirely on this machine — no browser, no permission popup, no clicking.
It listens on the microphone continuously in a background thread:

  1. captures each utterance with energy-based silence detection
  2. transcribes it with ElevenLabs Scribe (accurate on accented English)
  3. if it contains the wake word, plays a spoken acknowledgement, then treats
     the rest of that phrase — or the next utterance — as the command
  4. runs the command through the brain and speaks the reply

Everything is driven through the same hub the HUD uses, so the on-screen console
and the audio-reactive core light up in sync with the spoken conversation.
"""

from __future__ import annotations

import io
import logging
import re
import threading
import time

log = logging.getLogger(__name__)

WAKE_RE = re.compile(
    r"\b(?:hey|hi|ok|okay)?\s*(?:jarvis|jervis|travis|charvis|jarvi|service)\b",
    re.IGNORECASE,
)
COMMAND_WINDOW_S = 12.0


class NativeListener:
    """Continuous mic → Scribe → brain loop, on a daemon thread."""

    def __init__(self, hub, language: str = "auto") -> None:
        self.hub = hub
        self.language = language
        self.available = False
        self._stop = threading.Event()
        self._sr = None
        self._recognizer = None
        self._mic = None
        self._await_until = 0.0
        self._last_cmd = ""
        self._last_cmd_at = 0.0

        try:
            import speech_recognition as sr

            self._sr = sr
            r = sr.Recognizer()
            r.energy_threshold = 300
            r.dynamic_energy_threshold = True
            r.pause_threshold = 1.3
            r.non_speaking_duration = 0.6
            self._recognizer = r
            self._mic = sr.Microphone()
            self.available = True
        except Exception:  # noqa: BLE001
            log.warning("Native mic unavailable; browser voice remains the input")

    # ------------------------------------------------------------------ api

    def start(self) -> bool:
        if not self.available:
            return False
        threading.Thread(target=self._run, daemon=True).start()
        return True

    def stop(self) -> None:
        self._stop.set()

    # ------------------------------------------------------------- internals

    def _run(self) -> None:
        try:
            with self._mic as source:
                self._recognizer.adjust_for_ambient_noise(source, duration=1.0)
        except Exception:  # noqa: BLE001
            log.warning("Ambient calibration failed; using defaults")
        log.info("Native listener online; waiting for the wake word")

        while not self._stop.is_set():
            audio = self._capture()
            if audio is None:
                continue
            # Don't transcribe our own voice: skip while JARVIS is speaking.
            if self.hub.speaking:
                continue
            text = self._transcribe(audio)
            if text:
                self._handle(text)

    def _capture(self):
        try:
            with self._mic as source:
                return self._recognizer.listen(
                    source, timeout=None, phrase_time_limit=15
                )
        except Exception:  # noqa: BLE001
            log.exception("Mic capture failed; retrying")
            time.sleep(0.5)
            return None

    def _transcribe(self, audio) -> str | None:
        """Prefer Scribe (accurate); fall back to the free recognizer."""
        try:
            wav = audio.get_wav_data()
        except Exception:  # noqa: BLE001
            wav = None
        if wav and self.hub.stt is not None:
            text = self.hub.stt(wav, mime="audio/wav")
            if text:
                return text.strip()
        # fallback
        try:
            return (self._recognizer.recognize_google(audio) or "").strip() or None
        except Exception:  # noqa: BLE001
            return None

    def _handle(self, text: str) -> None:
        now = time.monotonic()
        if text == self._last_cmd and now - self._last_cmd_at < 4:
            return
        has_wake = bool(WAKE_RE.search(text))
        in_window = now < self._await_until

        if has_wake:
            command = WAKE_RE.sub(" ", text)
            command = re.sub(r"\s+", " ", command).strip(" ,.-").strip()
            if command:
                self._await_until = 0
                self._dispatch(command)
            else:
                # bare wake word: acknowledge, open a command window
                self._await_until = now + COMMAND_WINDOW_S
                self.hub.wake()
            return
        if in_window:
            self._await_until = now + COMMAND_WINDOW_S
            self._dispatch(text)
            return
        # otherwise ignore ambient chatter (no wake word)

    def _dispatch(self, command: str) -> None:
        self._last_cmd = command
        self._last_cmd_at = time.monotonic()
        self.hub.cast({"type": "user_said", "text": command})
        # wait for any acknowledgement audio to clear, then run the command
        while self.hub.busy and not self._stop.is_set():
            time.sleep(0.1)
        self.hub.handle_command(command, want_audio=True)
