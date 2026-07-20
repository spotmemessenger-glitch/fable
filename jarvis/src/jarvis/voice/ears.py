"""Speech input via the microphone.

Uses SpeechRecognition for microphone capture plus energy-based silence
detection, and Google's free web recognizer as the default speech-to-text
backend so the core has zero extra dependencies to start. The transcribe()
method is deliberately a thin seam: swap in local Whisper or ElevenLabs Scribe
later without touching the rest of the app.
"""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)


class Ears:
    """Listens on the microphone and returns transcribed text."""

    def __init__(
        self,
        language: str = "auto",
        *,
        phrase_time_limit: int = 30,
        pause_threshold: float = 1.5,
    ) -> None:
        self.language = language
        self.phrase_time_limit = phrase_time_limit
        self._recognizer = None
        self._mic = None
        self.available = False

        try:
            import speech_recognition as sr

            self._sr = sr
            self._recognizer = sr.Recognizer()
            # Tuned for a desktop mic in a normally quiet room. calibrate()
            # refines this against the actual room noise.
            self._recognizer.energy_threshold = 300
            self._recognizer.dynamic_energy_threshold = True
            # How long a silence must last before we decide the utterance is
            # over. Too low and natural mid-sentence pauses cut the owner off;
            # 1.5s tolerates thinking pauses without feeling sluggish.
            self._recognizer.pause_threshold = pause_threshold
            # Padding of quiet audio kept around the speech so words at the
            # edges aren't clipped. Must be <= pause_threshold.
            self._recognizer.non_speaking_duration = min(0.7, pause_threshold)
            self._mic = sr.Microphone()
            self.available = True
        except Exception:  # noqa: BLE001
            log.exception("Microphone unavailable; voice input is off")

    def calibrate(self, seconds: float = 1.0) -> None:
        if not self.available:
            return
        try:
            with self._mic as source:
                self._recognizer.adjust_for_ambient_noise(source, duration=seconds)
        except Exception:  # noqa: BLE001
            log.warning("Ambient calibration failed; using default threshold")

    def listen(self) -> str | None:
        """Capture one utterance and transcribe it. None if nothing was heard."""
        if not self.available:
            return None
        try:
            with self._mic as source:
                audio = self._recognizer.listen(
                    source,
                    timeout=None,
                    phrase_time_limit=self.phrase_time_limit,
                )
        except Exception:  # noqa: BLE001
            log.exception("Microphone capture failed")
            return None
        return self.transcribe(audio)

    def transcribe(self, audio) -> str | None:
        """Turn captured audio into text. The swappable STT seam."""
        try:
            kwargs = {}
            if self.language and self.language != "auto":
                kwargs["language"] = self.language
            text = self._recognizer.recognize_google(audio, **kwargs)
            return text.strip() or None
        except self._sr.UnknownValueError:
            return None
        except self._sr.RequestError as exc:
            log.warning("STT backend error: %s", exc)
            return None
