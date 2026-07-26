"""Minimal streaming client for a local Ollama model.

Used when LLM_PROVIDER=ollama so JARVIS can run on a free local model instead of
the paid Anthropic API. Deliberately tiny: text in, streamed text out. No tool
use — small local models are unreliable at it, and dropping tools keeps this
honest about what the free path can actually do.

Talks to Ollama's native /api/chat endpoint (newline-delimited JSON stream).
Requires `ollama serve` to be running (it usually is, as a background service).
"""
from __future__ import annotations

import json
from typing import Any, Iterator

import httpx


def _headers(api_key: str) -> dict[str, str]:
    # A bearer token is only needed for Ollama Cloud (ollama.com); local Ollama
    # ignores it. Never log this value.
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


def stream_chat(
    host: str,
    model: str,
    system: str,
    messages: list[dict[str, Any]],
    *,
    api_key: str = "",
    max_tokens: int = 1024,
    timeout: float = 120.0,
) -> Iterator[str]:
    """Stream assistant text from Ollama, yielding content chunks as they arrive.

    `messages` is OpenAI-style: [{"role": "user"|"assistant", "content": str}, ...].
    Works against a local Ollama or Ollama Cloud (pass api_key for the latter).
    Raises httpx errors if Ollama is unreachable — the caller decides how to
    surface that (JARVIS reports it rather than silently falling back to a paid
    provider).
    """
    payload: dict[str, Any] = {
        "model": model,
        "messages": ([{"role": "system", "content": system}] if system else []) + messages,
        "stream": True,
        "options": {"num_predict": max_tokens},
    }
    url = host.rstrip("/") + "/api/chat"
    with httpx.stream("POST", url, json=payload, headers=_headers(api_key), timeout=timeout) as response:
        response.raise_for_status()
        for line in response.iter_lines():
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            chunk = (obj.get("message") or {}).get("content") or ""
            if chunk:
                yield chunk
            if obj.get("done"):
                break


def is_up(host: str, api_key: str = "", timeout: float = 3.0) -> bool:
    """Quick health check: is the Ollama server reachable?"""
    try:
        r = httpx.get(host.rstrip("/") + "/api/tags", headers=_headers(api_key), timeout=timeout)
        return r.status_code == 200
    except Exception:
        return False
