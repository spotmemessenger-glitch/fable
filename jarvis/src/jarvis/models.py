"""Model catalog + Ollama endpoint resolution for the HUD model picker.

Lists every model JARVIS can think with — the Anthropic tiers plus every Ollama
model (local machine and Ollama Cloud) — as one flat list the UI renders in a
dropdown. Local and cloud Ollama models live on different endpoints, so this
also resolves a chosen Ollama model id to the host + auth token it needs (only
Ollama Cloud carries a bearer token; local Ollama ignores it).
"""

from __future__ import annotations

import httpx

from .config import Settings

LOCAL_OLLAMA = "http://localhost:11434"
CLOUD_OLLAMA = "https://ollama.com"

# Anthropic tiers JARVIS can run on, best-first. (id, dropdown label)
ANTHROPIC_MODELS: tuple[tuple[str, str], ...] = (
    ("claude-fable-5", "Fable 5 · heaviest"),
    ("claude-opus-4-8", "Opus 4.8"),
    ("claude-sonnet-5", "Sonnet 5"),
    ("claude-haiku-4-5-20251001", "Haiku 4.5 · fastest"),
)

# Cerebras free tier. Same gpt-oss-120b as Ollama Cloud, much faster silicon.
CEREBRAS_MODELS: tuple[tuple[str, str], ...] = (
    ("gpt-oss-120b", "gpt-oss 120B"),
    ("llama3.1-8b", "Llama 3.1 8B"),
)


def _ollama_tags(host: str, api_key: str) -> list[str]:
    """Model names served by an Ollama endpoint, or [] if it's unreachable."""
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        r = httpx.get(host.rstrip("/") + "/api/tags", headers=headers, timeout=8)
        if r.status_code == 200:
            return [m.get("name", "") for m in (r.json() or {}).get("models", []) if m.get("name")]
    except Exception:  # noqa: BLE001 - a down endpoint just contributes no models
        pass
    return []


def catalog(settings: Settings) -> list[dict]:
    """Every model the picker can offer: Anthropic tiers, Cerebras, Ollama.

    Anthropic tiers are listed only when a key is configured (otherwise picking
    one would just 401), and Cerebras only when its key is set. Local Ollama
    models are listed before cloud ones, and a name served both locally and in
    the cloud resolves to local.
    """
    out: list[dict] = []
    if settings.anthropic_api_key:
        for mid, label in ANTHROPIC_MODELS:
            out.append({"id": mid, "label": label, "provider": "anthropic", "kind": "api"})

    # Cerebras is a fixed short list rather than a live query — the free tier
    # serves only these two, and an extra round-trip every time the picker opens
    # isn't worth it.
    if settings.cerebras_api_key:
        for mid, label in CEREBRAS_MODELS:
            out.append(
                {
                    "id": mid,
                    "label": label,
                    "provider": "cerebras",
                    "kind": "cloud",
                    "host": settings.cerebras_base_url,
                }
            )

    seen: set[str] = set()
    for name in _ollama_tags(LOCAL_OLLAMA, ""):
        if name not in seen:
            seen.add(name)
            out.append({"id": name, "label": name, "provider": "ollama", "kind": "local", "host": LOCAL_OLLAMA})
    if settings.ollama_api_key:
        for name in _ollama_tags(CLOUD_OLLAMA, settings.ollama_api_key):
            if name not in seen:
                seen.add(name)
                out.append({"id": name, "label": name, "provider": "ollama", "kind": "cloud", "host": CLOUD_OLLAMA})
    return out


def resolve_ollama(settings: Settings, model: str) -> tuple[str, str]:
    """Return (host, api_key) for an Ollama model id.

    Cloud models carry the bearer token; local ones get an empty token. Falls
    back to the configured host/key if the model isn't in the live catalog.
    """
    for m in catalog(settings):
        if m["provider"] == "ollama" and m["id"] == model:
            return m["host"], (settings.ollama_api_key if m["kind"] == "cloud" else "")
    return settings.ollama_host, settings.ollama_api_key
