"""Ybot's persistent memory — supermemory.ai (cloud, free tier).

Ybot currently has NO memory across restarts: every relaunch starts from zero. This
wraps supermemory's REST API (verified against its live OpenAPI spec, not guessed) so
Ybot can remember facts across sessions and recall them when relevant.

Self-hosting was attempted first (matches this project's local-first pattern) but
supermemory's installer needs a working WSL bash, which this machine's WSL doesn't have
(and Docker Desktop's engine isn't running either) — so this uses the hosted free tier
instead. Requires SUPERMEMORY_API_KEY in .env.
"""
from __future__ import annotations

import os
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv()

_ROOT = Path(__file__).resolve().parent
_BASE = "https://api.supermemory.ai/v4"
_CONTAINER = "ybot"  # tags all of Ybot's memories so they never mix with other apps


def _api_key() -> str:
    key = os.environ.get("SUPERMEMORY_API_KEY", "")
    if key:
        return key
    for env in (_ROOT / ".env", _ROOT.parent / "ybot" / ".env", _ROOT.parent / ".env"):
        try:
            for ln in env.read_text(encoding="utf-8").splitlines():
                if ln.startswith("SUPERMEMORY_API_KEY="):
                    return ln.split("=", 1)[1].strip()
        except FileNotFoundError:
            pass
    return ""


def available() -> bool:
    return bool(_api_key())


def _headers() -> dict:
    return {"Authorization": f"Bearer {_api_key()}", "Content-Type": "application/json"}


def remember(fact: str, *, permanent: bool = False) -> dict:
    """Store a fact. `permanent=True` marks it static (never summarized/decayed)."""
    if not available():
        return {"ok": False, "error": "SUPERMEMORY_API_KEY not set"}
    r = httpx.post(
        f"{_BASE}/memories",
        headers=_headers(),
        json={"memories": [{"content": fact, "isStatic": permanent}], "containerTag": _CONTAINER},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    return {"ok": True, "document_id": data.get("documentId"), "memories": data.get("memories", [])}


def recall(query: str, *, limit: int = 5, threshold: float = 0.6) -> dict:
    """Semantic search over everything Ybot has remembered."""
    if not available():
        return {"ok": False, "error": "SUPERMEMORY_API_KEY not set", "results": []}
    r = httpx.post(
        f"{_BASE}/search",
        headers=_headers(),
        json={"q": query, "containerTag": _CONTAINER, "limit": limit, "threshold": threshold},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    return {"ok": True, "results": data.get("results", [])}


if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) < 3:
        print("usage: python memory.py remember <fact> | recall <query>")
        raise SystemExit(1)
    action, text = sys.argv[1], " ".join(sys.argv[2:])
    result = remember(text) if action == "remember" else recall(text)
    print(json.dumps(result, indent=2))
