"""Shared AI client for Ybot's text/vision brains — blender.py, likeness.py.

NOT used by the desktop operator (bridge.py's _run), which needs Anthropic's
computer-use tool specifically and always calls Anthropic directly regardless.

Routes through OmniRoute's free Gemini tier (http://localhost:20128, an
Anthropic-Messages-compatible endpoint — same `anthropic` SDK, just a different
base_url + model string) whenever OMNIROUTE_API_KEY is set, saving Anthropic credit
for the operator. Falls back to direct Anthropic if OmniRoute isn't configured.
"""
from __future__ import annotations

import os
from pathlib import Path

import anthropic
from dotenv import load_dotenv

load_dotenv()

_ROOT = Path(__file__).resolve().parent


def _read_env_var(name: str) -> str:
    v = os.environ.get(name, "")
    if v:
        return v
    for env in (_ROOT / ".env", _ROOT.parent / "ybot" / ".env", _ROOT.parent / ".env"):
        try:
            for ln in env.read_text(encoding="utf-8").splitlines():
                if ln.startswith(f"{name}="):
                    return ln.split("=", 1)[1].strip()
        except FileNotFoundError:
            pass
    return ""


OMNIROUTE_KEY = _read_env_var("OMNIROUTE_API_KEY")
OMNIROUTE_BASE = _read_env_var("OMNIROUTE_BASE_URL") or "http://localhost:20128"
ANTHROPIC_KEY = _read_env_var("ANTHROPIC_API_KEY")

USING_OMNIROUTE = bool(OMNIROUTE_KEY)
TEXT_MODEL = "gemini/gemini-3.5-flash" if USING_OMNIROUTE else "claude-opus-4-8"


def client() -> anthropic.Anthropic:
    """Anthropic-SDK client — routed through OmniRoute's free Gemini tier when
    available, else direct Anthropic. Same SDK either way; only base_url/model differ."""
    if USING_OMNIROUTE:
        return anthropic.Anthropic(api_key=OMNIROUTE_KEY, base_url=OMNIROUTE_BASE)
    if not ANTHROPIC_KEY:
        raise RuntimeError("Neither OMNIROUTE_API_KEY nor ANTHROPIC_API_KEY is set")
    return anthropic.Anthropic(api_key=ANTHROPIC_KEY)
