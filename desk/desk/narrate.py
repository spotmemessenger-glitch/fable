"""Narration and voice — the only place a language model is allowed near the desk.

compose() builds a spoken line purely from the deterministic Readings, so the
desk is fully usable with no model and no keys. llm_polish() optionally rewords
that line for naturalness, and is explicitly told to change no number. speak()
optionally sends it to ElevenLabs in the seat's own voice.

Nothing here is ever parsed back into a decision — narration is output only.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


def stance_word(signal: float) -> str:
    if signal >= 0.35:
        return "long"
    if signal <= -0.35:
        return "short"
    if abs(signal) < 0.12:
        return "flat"
    return "leaning long" if signal > 0 else "leaning short"


def compose(symbol: str, consensus: float, ruling: Any, readings: dict[str, Any],
            action: str) -> str:
    """A HELM summary built only from Readings. No model involved."""
    parts = [f"{symbol}: the desk is {stance_word(consensus)}, "
             f"conviction {consensus:+.2f}."]

    # the two strongest directional voices, for colour
    directional = [(n, r) for n, r in readings.items()
                   if r.usable and n not in ("SENTINEL", "PILOT", "LEDGER")]
    directional.sort(key=lambda kv: abs(kv[1].signal) * kv[1].confidence, reverse=True)
    for name, r in directional[:2]:
        if r.facts:
            parts.append(f"{name}: {r.facts[0]}.")

    cass = readings.get("CASSANDRA")
    if cass and cass.usable and cass.facts:
        parts.append(f"Cassandra: {cass.facts[0]}.")

    if ruling.approved:
        parts.append("Sentinel approves — " + (ruling.reasons[0] if ruling.reasons else "sized."))
    else:
        why = ruling.reasons[0] if ruling.reasons else "no trade"
        parts.append(f"Sentinel holds: {why}.")

    if action == "bought":
        parts.append("Pilot filled the entry.")
    elif action.startswith("exit:"):
        parts.append(f"Pilot closed the position ({action.split(':', 1)[1]}).")

    return " ".join(parts)


# --------------------------------------------------------------------------
# optional model polish — off unless DESK_LLM_PROVIDER is set
# --------------------------------------------------------------------------

def llm_polish(text: str, facts: list[str], settings: Any,
               language: str = "auto") -> str:
    """Reword `text` naturally. Returns the input unchanged on any problem."""
    provider = settings.llm_provider
    if provider == "none":
        return text
    lang = "the language the operator used" if language == "auto" else language
    system = ("You are a trading-desk analyst. Reword the briefing as one or two "
              "natural spoken sentences in " + lang + ". Do NOT add, remove, or "
              "change any number, ticker, or direction. Facts:\n- " + "\n- ".join(facts))
    try:
        if provider == "anthropic":
            return _anthropic(system, text, settings) or text
        if provider == "ollama":
            return _ollama(system, text, settings) or text
    except Exception:
        log.warning("llm polish failed; using deterministic text", exc_info=True)
    return text


def _anthropic(system: str, text: str, settings: Any) -> str | None:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    import requests
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"},
        json={"model": settings.llm_model, "max_tokens": 200,
              "system": system, "messages": [{"role": "user", "content": text}]},
        timeout=20)
    resp.raise_for_status()
    blocks = resp.json().get("content", [])
    return "".join(b.get("text", "") for b in blocks).strip() or None


def _ollama(system: str, text: str, settings: Any) -> str | None:
    host = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
    # Ollama Cloud (ollama.com) needs a bearer token; a local server ignores it.
    key = os.environ.get("OLLAMA_API_KEY", "")
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    import requests
    resp = requests.post(f"{host.rstrip('/')}/api/chat", headers=headers, json={
        "model": settings.llm_model, "stream": False,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": text}]}, timeout=30)
    resp.raise_for_status()
    return (resp.json().get("message") or {}).get("content", "").strip() or None


# --------------------------------------------------------------------------
# optional voice — off unless DESK_VOICE=1
# --------------------------------------------------------------------------

_VOICES_CACHE: dict[str, Any] | None = None


def _voices(settings: Any) -> dict[str, Any]:
    global _VOICES_CACHE
    if _VOICES_CACHE is None:
        try:
            _VOICES_CACHE = json.loads(Path(settings.voices_file).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _VOICES_CACHE = {}
    return _VOICES_CACHE


def synthesize(seat: str, text: str, settings: Any) -> bytes | None:
    """Raw mp3 bytes of `text` in this seat's voice, or None.

    Deliberately NOT gated on DESK_VOICE: the office asks for a seat's voice
    explicitly, per utterance. Returns None when there is no API key or the
    seat has no voice_id, so every caller degrades to text.
    """
    key = os.environ.get("ELEVENLABS_API_KEY")
    cfg = _voices(settings).get(seat)
    if not key or not cfg or not cfg.get("voice_id"):
        return None
    import requests
    try:
        resp = requests.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{cfg['voice_id']}",
            headers={"xi-api-key": key, "content-type": "application/json"},
            json={"text": text, "model_id": settings.elevenlabs_model,
                  "voice_settings": {"stability": cfg.get("stability", 0.5),
                                     "similarity_boost": cfg.get("similarity_boost", 0.75),
                                     "speed": cfg.get("speed", 1.0)}},
            timeout=30)
        resp.raise_for_status()
    except Exception:
        log.warning("elevenlabs synth failed for %s", seat, exc_info=True)
        return None
    return resp.content


def speak(seat: str, text: str, settings: Any) -> Path | None:
    """Synthesize `text` in the seat's voice and write it to state/voice/.

    A no-op (returns None) unless DESK_VOICE=1, an API key is present, and the
    seat has a non-empty voice_id in voices.json.
    """
    if not settings.voice_enabled:
        return None
    audio = synthesize(seat, text, settings)
    if audio is None:
        return None
    out_dir = Path(settings.state_dir) / "voice"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{seat.lower()}.mp3"
    path.write_bytes(audio)
    return path
