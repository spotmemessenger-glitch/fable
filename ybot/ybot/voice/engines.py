"""Adapter boundary for the hardware-bound half of the pipeline.

Speech recognition and synthesis are the two pieces that need a microphone, a
speaker, and a vendor. Everything else in `ybot.voice` is pure logic and is
tested without any of them. These Protocols are the seam: implement one against
Whisper, Azure, Deepgram, ElevenLabs, Piper, or the Windows built-ins, and the
pipeline above does not change.

Two requirements the interfaces exist to enforce:

  - STT streams. A recogniser that returns only a final transcript makes
    barge-in impossible to detect early and adds its whole processing time to
    perceived latency.
  - TTS is cancellable. `stop()` must cut audio already handed to the speaker,
    synchronously. A synthesiser that can only be left to finish cannot support
    barge-in at all, whatever the rest of the system does.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Protocol, runtime_checkable


@dataclass
class Transcript:
    """One recognition update. `final` marks the end of an utterance."""

    text: str
    final: bool = False
    confidence: float = 1.0


@runtime_checkable
class SpeechRecognizer(Protocol):
    """Streaming STT. Must yield partials, not just finals."""

    def listen(self) -> Iterator[Transcript]:
        """Yield transcripts as the user speaks. Blocks until the stream ends."""
        ...

    def stop(self) -> None:
        """Stop capturing."""
        ...


@runtime_checkable
class SpeechSynthesizer(Protocol):
    """Streaming, interruptible TTS."""

    def speak(self, text: str) -> None:
        """Queue text and begin playing. Returns without waiting for playback."""
        ...

    def stop(self) -> None:
        """Cut playback immediately, discarding anything queued. Must be sync."""
        ...

    @property
    def speaking(self) -> bool:
        ...


class NullSynthesizer:
    """Test double: records what was spoken, plays nothing.

    Used by the test suite so the whole pipeline can be exercised on a machine
    with no audio device.
    """

    def __init__(self) -> None:
        self.spoken: list[str] = []
        self.stopped = 0
        self._speaking = False

    def speak(self, text: str) -> None:
        self.spoken.append(text)
        self._speaking = True

    def stop(self) -> None:
        self.stopped += 1
        self._speaking = False

    @property
    def speaking(self) -> bool:
        return self._speaking


class ScriptedRecognizer:
    """Test double: replays a fixed sequence of transcripts."""

    def __init__(self, updates: list[Transcript]) -> None:
        self.updates = updates
        self.stopped = 0

    def listen(self) -> Iterator[Transcript]:
        yield from self.updates

    def stop(self) -> None:
        self.stopped += 1
