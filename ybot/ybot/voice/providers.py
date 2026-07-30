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


ELEVEN_API = "https://api.elevenlabs.io/v1"
# Flash is the low-latency model; measured 196 ms to first audio byte on a warm
# connection from here, against ~1.3 s cold. That gap is TLS setup, not the
# model, which is why the client below is created once and kept.
ELEVEN_TTS_MODEL = os.environ.get("YBOT_ELEVEN_TTS_MODEL", "eleven_flash_v2_5")
ELEVEN_STT_MODEL = os.environ.get("YBOT_ELEVEN_STT_MODEL", "scribe_v1")
# Sarah — calm and neutral, chosen to wear well over a long working session.
ELEVEN_VOICE = os.environ.get("YBOT_ELEVEN_VOICE", "EXAVITQu4vr4xnSDxMaL")


def _eleven_key() -> str:
    key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not key:
        raise RuntimeError(
            "ELEVENLABS_API_KEY is unset. It lives in fable/.env; ybot loads that "
            "file too, so running from either directory works."
        )
    return key


@register_tts("elevenlabs")
def _eleven() -> TTSProvider:
    """Streaming TTS. Yields audio as it arrives, so speech starts mid-sentence.

    The whole point is time-to-FIRST-chunk: waiting for a complete utterance
    adds a second of silence to every reply, and silence is what makes an
    assistant feel like software. Nothing here buffers the full response.
    """
    import httpx

    class _E:
        name = "elevenlabs"

        def __init__(self) -> None:
            self._key = _eleven_key()
            # One client for the process: a fresh TLS handshake per utterance
            # costs more than the model does.
            self._http = httpx.Client(
                timeout=httpx.Timeout(30.0, connect=10.0),
                headers={"xi-api-key": self._key},
            )

        def stream(self, text: str, style: "SpeakingStyle") -> Iterator[np.ndarray]:
            if not text.strip():
                return
            # SpeakingStyle is provider-agnostic; map what ElevenLabs accepts and
            # ignore the rest (pitch/pause are Piper-side concepts).
            settings = {
                "stability": max(0.0, min(1.0, 0.5 / max(style.energy, 0.1))),
                "similarity_boost": 0.75,
                "speed": max(0.7, min(1.2, 1.0 / max(style.length_scale, 0.1))),
            }
            url = f"{ELEVEN_API}/text-to-speech/{ELEVEN_VOICE}/stream?output_format=pcm_16000"
            body = {"text": text, "model_id": ELEVEN_TTS_MODEL, "voice_settings": settings}
            tail = b""
            with self._http.stream("POST", url, json=body) as resp:
                if resp.status_code != 200:
                    raise RuntimeError(
                        f"elevenlabs tts {resp.status_code}: {resp.read()[:200]!r}"
                    )
                for chunk in resp.iter_bytes():
                    if not chunk:
                        continue
                    # PCM16 frames can split across chunks; carry the odd byte
                    # rather than emitting a sample built from half of two.
                    buf = tail + chunk
                    usable = len(buf) - (len(buf) % 2)
                    tail = buf[usable:]
                    if usable:
                        yield np.frombuffer(buf[:usable], dtype=np.int16).astype(np.float32) / 32768.0

    return _E()


@register_stt("elevenlabs")
def _eleven_stt() -> STTProvider:
    """Scribe. One request per utterance — the VAD decides where those end.

    Measured ~750 ms for a short clip, which is why utterances are segmented
    aggressively: a shorter clip is a shorter wait, and the perceived latency
    of the whole loop is dominated by this call.
    """
    import io
    import wave

    import httpx

    class _S:
        name = "elevenlabs"

        def __init__(self) -> None:
            self._key = _eleven_key()
            self._http = httpx.Client(
                timeout=httpx.Timeout(60.0, connect=10.0),
                headers={"xi-api-key": self._key},
            )

        def transcribe(self, pcm: np.ndarray) -> str:
            if pcm.size == 0:
                return ""
            pcm16 = np.clip(pcm, -1.0, 1.0)
            pcm16 = (pcm16 * 32767.0).astype(np.int16)
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(SAMPLE_RATE)
                w.writeframes(pcm16.tobytes())
            buf.seek(0)
            resp = self._http.post(
                f"{ELEVEN_API}/speech-to-text",
                files={"file": ("utterance.wav", buf.read(), "audio/wav")},
                data={"model_id": ELEVEN_STT_MODEL},
            )
            if resp.status_code != 200:
                raise RuntimeError(
                    f"elevenlabs stt {resp.status_code}: {resp.text[:200]}"
                )
            return str(resp.json().get("text", "")).strip()

    return _S()


from .style import SpeakingStyle  # noqa: E402  (circular-safe: type only at runtime)


def demo() -> None:
    """Round-trip the cloud pair: speak a sentence, then transcribe that audio.

    This module went in without a self-check while every other voice module had
    one — and it is the module that touches real services, so it is the one most
    likely to break. The check is a genuine round trip rather than a mock: only
    real audio proves the PCM framing, the sample rate and the style mapping all
    agree. Skipped (not failed) without a key, so the offline path still passes.
    """
    import time

    registry = available()
    assert "elevenlabs" in registry["tts"], registry
    assert "elevenlabs" in registry["stt"], registry
    assert "whisper" in registry["stt"], registry

    if not os.environ.get("ELEVENLABS_API_KEY"):
        print("providers: ok (registry only — ELEVENLABS_API_KEY unset, cloud round trip skipped)")
        return

    phrase = "The quick brown fox jumps over the lazy dog."
    tts = get_tts("elevenlabs")
    t0 = time.time()
    first_at: float | None = None
    chunks: list[np.ndarray] = []
    for chunk in tts.stream(phrase, SpeakingStyle()):
        if first_at is None:
            first_at = time.time() - t0
        assert chunk.dtype == np.float32, chunk.dtype
        assert np.abs(chunk).max() <= 1.0001, "PCM must be normalised to [-1, 1]"
        chunks.append(chunk)
    assert chunks, "TTS produced no audio"
    audio = np.concatenate(chunks)
    seconds = audio.size / SAMPLE_RATE
    assert 0.5 < seconds < 15, f"implausible duration {seconds:.2f}s"
    # Streaming is the feature; a single chunk means we buffered the whole reply.
    assert len(chunks) > 1, "expected incremental chunks, got one blob"

    heard = get_stt("elevenlabs").transcribe(audio).lower()
    assert "quick brown fox" in heard, f"round trip lost the words: {heard!r}"
    print(
        f"providers: ok (first audio {first_at * 1000:.0f}ms, {len(chunks)} chunks, "
        f"{seconds:.1f}s, transcribed {heard!r})"
    )


if __name__ == "__main__":
    demo()
