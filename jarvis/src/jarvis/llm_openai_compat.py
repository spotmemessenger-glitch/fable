"""Streaming client for OpenAI-compatible chat APIs.

Used when LLM_PROVIDER=cerebras. Cerebras serves gpt-oss-120b — the same model
JARVIS already runs through Ollama Cloud — on much faster hardware, free at
14,400 requests/day. The wire format is plain OpenAI /chat/completions SSE, so
this module also works unchanged against Groq or OpenRouter if we ever point it
there; only the base URL and model name change.

Mirrors llm_ollama.stream_chat's signature deliberately, so brain.py can pick a
client without special-casing the call site. Like that module: text in, streamed
text out, no tool use. The free path stays honest about what it can do.
"""
from __future__ import annotations

import json
from typing import Any, Iterator

import httpx

_DONE = "[DONE]"


def _headers(api_key: str) -> dict[str, str]:
    # Never log this value.
    return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}


def stream_chat(
    base_url: str,
    model: str,
    system: str,
    messages: list[dict[str, Any]],
    *,
    api_key: str = "",
    max_tokens: int = 1024,
    timeout: float = 120.0,
) -> Iterator[str]:
    """Stream assistant text, yielding content chunks as they arrive.

    `messages` is OpenAI-style: [{"role": "user"|"assistant", "content": str}, ...].
    Raises httpx errors if the provider is unreachable — the caller decides how
    to surface that. JARVIS reports it rather than silently falling back to a
    paid provider.
    """
    payload: dict[str, Any] = {
        "model": model,
        "messages": ([{"role": "system", "content": system}] if system else []) + messages,
        "stream": True,
        # Cerebras follows current OpenAI naming; `max_tokens` is deprecated there.
        "max_completion_tokens": max_tokens,
    }
    url = base_url.rstrip("/") + "/chat/completions"
    with httpx.stream("POST", url, json=payload, headers=_headers(api_key), timeout=timeout) as response:
        response.raise_for_status()
        for line in response.iter_lines():
            if not line or not line.startswith("data:"):
                continue
            data = line[len("data:"):].strip()
            if data == _DONE:
                break
            try:
                obj = json.loads(data)
            except json.JSONDecodeError:
                continue
            choices = obj.get("choices") or []
            if not choices:
                continue
            chunk = (choices[0].get("delta") or {}).get("content") or ""
            if chunk:
                yield chunk


def is_up(base_url: str, api_key: str = "", timeout: float = 5.0) -> bool:
    """Quick health check: does the provider answer with a valid key?"""
    try:
        r = httpx.get(base_url.rstrip("/") + "/models", headers=_headers(api_key), timeout=timeout)
        return r.status_code == 200
    except Exception:
        return False
