"""Voice for Ybot Assistant — ElevenLabs TTS + speech-to-text.

Transcription prefers Deepgram nova-3 (the same low-latency engine JARVIS streams) when a
DEEPGRAM_API_KEY is present, then Google Gemini, and finally ElevenLabs Scribe — each falls
through to the next if its key is missing or the call errors.
"""
from __future__ import annotations

import base64
import os
from pathlib import Path

import httpx

_ENV = Path(__file__).resolve().parent / ".env"
_BASE = "https://api.elevenlabs.io/v1"

# George — warm, captivating middle-aged British storyteller (fits the old-man avatar).
VOICE_ID = os.environ.get("ELEVEN_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")
TTS_MODEL = os.environ.get("ELEVEN_TTS_MODEL", "eleven_flash_v2_5")  # low latency
STT_MODEL = os.environ.get("ELEVEN_STT_MODEL", "scribe_v1")
GEMINI_STT_MODEL = os.environ.get("GEMINI_STT_MODEL", "gemini-flash-latest")


def _api_key() -> str:
    if os.environ.get("ELEVENLABS_API_KEY"):
        return os.environ["ELEVENLABS_API_KEY"]
    try:
        for ln in _ENV.read_text(encoding="utf-8").splitlines():
            if ln.startswith("ELEVENLABS_API_KEY="):
                return ln.split("=", 1)[1].strip()
    except FileNotFoundError:
        pass
    return ""


def tts(text: str) -> bytes:
    """Text -> MP3 audio bytes. Returns b'' if no key or empty text."""
    key = _api_key()
    if not key or not (text or "").strip():
        return b""
    r = httpx.post(
        f"{_BASE}/text-to-speech/{VOICE_ID}",
        headers={"xi-api-key": key, "accept": "audio/mpeg"},
        json={
            "text": text,
            "model_id": TTS_MODEL,
            "voice_settings": {"stability": 0.4, "similarity_boost": 0.75},
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.content


def _gemini_key() -> str:
    return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""


def _stt_gemini(audio: bytes, mime: str) -> str:
    """Transcribe with Gemini. Raises on any failure so the caller can fall back."""
    key = _gemini_key()
    if not key:
        raise RuntimeError("no gemini key")
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_STT_MODEL}:generateContent?key={key}"
    )
    prompt = (
        "Transcribe the spoken audio verbatim. Return ONLY the exact words spoken, with no "
        "quotes, labels, or commentary. If there is no clear speech, return nothing."
    )
    body = {
        "contents": [{"parts": [
            {"text": prompt},
            {"inline_data": {"mime_type": mime, "data": base64.b64encode(audio).decode()}},
        ]}],
        "generationConfig": {"temperature": 0},
    }
    r = httpx.post(url, json=body, timeout=60)
    r.raise_for_status()
    data = r.json() or {}
    parts = (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts")) or []
    text = "".join(p.get("text", "") for p in parts).strip()
    return text


def _stt_eleven(audio: bytes, filename: str, mime: str) -> str:
    key = _api_key()
    if not key or not audio:
        return ""
    r = httpx.post(
        f"{_BASE}/speech-to-text",
        headers={"xi-api-key": key},
        data={"model_id": STT_MODEL},
        files={"file": (filename, audio, mime)},
        timeout=60,
    )
    r.raise_for_status()
    return (r.json() or {}).get("text", "").strip()


def _deepgram_key() -> str:
    if os.environ.get("DEEPGRAM_API_KEY"):
        return os.environ["DEEPGRAM_API_KEY"]
    try:
        for ln in _ENV.read_text(encoding="utf-8").splitlines():
            if ln.startswith("DEEPGRAM_API_KEY="):
                return ln.split("=", 1)[1].strip()
    except FileNotFoundError:
        pass
    return ""


def _stt_deepgram(audio: bytes, mime: str) -> str:
    """Transcribe with Deepgram nova-3 (same engine JARVIS streams). Raises on failure."""
    key = _deepgram_key()
    if not key:
        raise RuntimeError("no deepgram key")
    r = httpx.post(
        "https://api.deepgram.com/v1/listen",
        params={"model": "nova-3", "smart_format": "true", "punctuate": "true"},
        headers={"Authorization": f"Token {key}", "Content-Type": mime or "audio/webm"},
        content=audio,
        timeout=60,
    )
    r.raise_for_status()
    data = r.json() or {}
    channels = ((data.get("results") or {}).get("channels")) or []
    alts = (channels[0].get("alternatives") if channels else []) or []
    return alts[0].get("transcript", "").strip() if alts else ""


def stt(audio: bytes, filename: str = "audio.webm", mime: str = "audio/webm") -> str:
    """Audio bytes -> transcript. Deepgram nova-3 first (most accurate / lowest latency),
    then Gemini, then ElevenLabs Scribe."""
    if not audio:
        return ""
    if _deepgram_key():
        try:
            text = _stt_deepgram(audio, mime)
            if text:
                return text
        except Exception:
            pass  # fall through to Gemini
    if _gemini_key():
        try:
            text = _stt_gemini(audio, mime)
            if text:
                return text
        except Exception:
            pass  # fall through to ElevenLabs
    return _stt_eleven(audio, filename, mime)
