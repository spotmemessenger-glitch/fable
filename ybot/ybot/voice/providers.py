"""Pluggable STT / TTS provider registry.

Every provider implements a Protocol, so third-party services drop in without
touching the pipeline. Selection is by name via env vars:

    YBOT_STT_PROVIDER=whisper|faster-whisper|<custom>
    YBOT_TTS_PROVIDER=piper|kokoro|coqui|elevenlabs|<custom>
"""
from __future__ import annotations

import os
from typing import Callable, Iterator, Protocol, runtime_checkable

import numpy as np

SAMPLE_RATE = 16_000


@runtime_checkable
class STTProvider(Protocol):
    """Speech-to-text. `transcribe` takes mono float32 PCM at SAMPLE_RATE."""

    name: str

    def transcribe(self, pcm: np.ndarray) -> str: ...


@runtime_checkable
class TTSProvider(Protocol):
    """Text-to-speech. `stream` yields PCM chunks so playback starts early."""

    name: str

    def stream(self, text: str, style: "SpeakingStyle") -> Iterator[np.ndarray]: ...


# --------------------------------------------------------------------------
# registry
# --------------------------------------------------------------------------
_STT: dict[str, Callable[[], STTProvider]] = {}
_TTS: dict[str, Callable[[], TTSProvider]] = {}


def register_stt(name: str) -> Callable[[Callable[[], STTProvider]], Callable[[], STTProvider]]:
    def deco(factory: Callable[[], STTProvider]) -> Callable[[], STTProvider]:
        _STT[name] = factory
        return factory

    return deco


def register_tts(name: str) -> Callable[[Callable[[], TTSProvider]], Callable[[], TTSProvider]]:
    def deco(factory: Callable[[], TTSProvider]) -> Callable[[], TTSProvider]:
        _TTS[name] = factory
        return factory

    return deco


def get_stt(name: str | None = None) -> STTProvider:
    key = (name or os.environ.get("YBOT_STT_PROVIDER", "whisper")).strip().lower()
    if key not in _STT:
        raise KeyError(f"unknown STT provider {key!r}; have {sorted(_STT)}")
    return _STT[key]()


def get_tts(name: str | None = None) -> TTSProvider:
    key = (name or os.environ.get("YBOT_TTS_PROVIDER", "piper")).strip().lower()
    if key not in _TTS:
        raise KeyError(f"unknown TTS provider {key!r}; have {sorted(_TTS)}")
    return _TTS[key]()


def available() -> dict[str, list[str]]:
    return {"stt": sorted(_STT), "tts": sorted(_TTS)}


# --------------------------------------------------------------------------
# built-in providers — imported lazily so a missing optional dep only breaks
# that one provider, never the whole service.
# --------------------------------------------------------------------------
@register_stt("whisper")
def _whisper() -> STTProvider:
    import whisper

    class _W:
        name = "whisper"

        def __init__(self) -> None:
            size = os.environ.get("YBOT_WHISPER_MODEL", "base.en")
            self._m = whisper.load_model(size)

        def transcribe(self, pcm: np.ndarray) -> str:
            # whisper wants float32 mono @16k, which is exactly what mic.py emits
            out = self._m.transcribe(pcm, fp16=False, language="en")
            return str(out.get("text", "")).strip()

    return _W()


@register_tts("piper")
def _piper() -> TTSProvider:
    from piper import PiperVoice  # type: ignore

    class _P:
        name = "piper"

        def __init__(self) -> None:
            path = os.environ.get("YBOT_PIPER_VOICE", "")
            if not path:
                raise RuntimeError(
                    "YBOT_PIPER_VOICE is unset — download a .onnx voice from "
                    "https://huggingface.co/rhasspy/piper-voices and point at it."
                )
            self._v = PiperVoice.load(path)

        def stream(self, text: str, style: "SpeakingStyle") -> Iterator[np.ndarray]:
            for chunk in self._v.synthesize_stream_raw(text, length_scale=style.length_scale):
                yield np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0

    return _P()


@register_tts("elevenlabs")
def _eleven() -> TTSProvider:
    """Third-party example — shows the shape a plug-in provider takes."""

    class _E:
        name = "elevenlabs"

        def __init__(self) -> None:
            self._key = os.environ.get("ELEVENLABS_API_KEY", "")
            if not self._key:
                raise RuntimeError("ELEVENLABS_API_KEY is unset")

        def stream(self, text: str, style: "SpeakingStyle") -> Iterator[np.ndarray]:
            raise NotImplementedError(
                "SCAFFOLD: wire the ElevenLabs streaming endpoint here. "
                "Yield float32 PCM chunks at SAMPLE_RATE."
            )

    return _E()


from .style import SpeakingStyle  # noqa: E402  (circular-safe: type only at runtime)
