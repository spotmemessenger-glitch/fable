"""Central configuration. Reads ANTHROPIC_API_KEY and optional overrides from .env."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()  # ybot/.env, if present
# Also load the workspace-root .env (fable/.env) so the free-model settings —
# OLLAMA_API_KEY especially — are picked up without copying them into ybot/.
_WORKSPACE_ENV = Path(__file__).resolve().parents[2] / ".env"
if _WORKSPACE_ENV.exists():
    load_dotenv(_WORKSPACE_ENV, override=False)


@dataclass(frozen=True)
class Settings:
    api_key: str = os.environ.get("ANTHROPIC_API_KEY", "")
    # Point the Anthropic-compatible client at a gateway (e.g. ZenMux) to run
    # computer-use on a different provider's balance. Empty = api.anthropic.com.
    anthropic_base_url: str = os.environ.get("ANTHROPIC_BASE_URL", "")
    # "smart" = deepest reasoning (Opus), "fast" = ~2x lower latency per step (Sonnet).
    # Both support the computer-use tool. Fast is the DEFAULT everywhere now: per-step
    # latency dominates a desktop task, and most steps are mechanical (click this menu,
    # type that path) rather than hard reasoning. Set OPERATOR_MODEL to override.
    model: str = os.environ.get("OPERATOR_MODEL", "claude-sonnet-5")
    smart_model: str = os.environ.get("OPERATOR_SMART_MODEL", "claude-opus-4-8")
    fast_model: str = os.environ.get("OPERATOR_FAST_MODEL", "claude-sonnet-5")
    fable_model: str = os.environ.get("OPERATOR_FABLE_MODEL", "claude-fable-5")
    # Provider: "anthropic" (computer-use, paid) or "ollama" (free vision loop).
    # Ollama can't do Anthropic computer-use, so the ollama path runs a separate
    # screenshot -> JSON-action loop (ollama_operator.py) on a vision model.
    provider: str = os.environ.get("OPERATOR_PROVIDER", "anthropic").strip().lower()
    ollama_model: str = os.environ.get("OPERATOR_OLLAMA_MODEL", "gemma4:31b")
    ollama_host: str = os.environ.get("OPERATOR_OLLAMA_HOST", "")
    ollama_api_key: str = os.environ.get("OLLAMA_API_KEY", "")
    # Computer-use tool version + beta header. These are the CURRENT pair, but
    # they are not universal — see computer_tool_for(): the accepted version
    # depends on the model, and sending the wrong one fails the request outright
    # rather than degrading. Override both together if a new pairing ships
    # before this code knows about it.
    beta_flag: str = os.environ.get("OPERATOR_BETA_FLAG", "computer-use-2025-11-24")
    tool_type: str = os.environ.get("OPERATOR_TOOL_TYPE", "computer_20251124")
    # Screenshots are downscaled to this width before sending (cost + accuracy).
    target_width: int = int(os.environ.get("OPERATOR_TARGET_WIDTH", "1280"))
    # Sleep pyautogui inserts after EVERY input call. Its own default is 0.1 s, which
    # made a single click cost 0.2 s of doing nothing. Raise only if an app drops input.
    action_pause: float = float(os.environ.get("OPERATOR_ACTION_PAUSE", "0.02"))
    max_steps: int = int(os.environ.get("OPERATOR_MAX_STEPS", "300"))
    max_tokens: int = 4096
    kill_hotkey: str = os.environ.get("OPERATOR_KILL_HOTKEY", "ctrl+alt+q")
    # Only the most recent N screenshots stay in context; older ones are pruned.
    keep_recent_images: int = 3

    @property
    def use_ollama(self) -> bool:
        return self.provider == "ollama"

    def validate(self) -> None:
        if self.use_ollama:
            return  # local Ollama needs no key; a cloud key is optional (checked at call time)
        if not self.api_key:
            raise SystemExit(
                "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key. "
                "(Or set OPERATOR_PROVIDER=ollama to run the free vision operator.)"
            )


SETTINGS = Settings()


# --------------------------------------------------------------- tool pairing
#
# The computer-use tool is versioned, and a model only accepts the version it
# shipped with. Send the wrong one and the API rejects the request:
#
#   400 'claude-sonnet-4-5-20250929' does not support tool types:
#       computer_20251124
#
# That is a hard failure on EVERY step, not a degraded run, so the version has
# to follow the model rather than sit in one global constant. The newer tool
# arrived with Opus 4.5; note that "sonnet-4-5" is older than "opus-4-5"
# despite the matching number, which is exactly the trap a version-number
# comparison would fall into — hence explicit prefixes.
NEW_TOOL = ("computer_20251124", "computer-use-2025-11-24")
LEGACY_TOOL = ("computer_20250124", "computer-use-2025-01-24")

_NEW_TOOL_PREFIXES = (
    "claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8",
    "claude-opus-5", "claude-sonnet-5", "claude-haiku-5",
    "claude-fable-5", "claude-mythos-5",
)


def computer_tool_for(model: str) -> tuple[str, str]:
    """(tool_type, beta_flag) the given model will actually accept.

    Explicit env overrides win — a new pairing can ship before this list knows
    about it, and being stuck behind a hardcoded guess is what caused the
    original outage.
    """
    if os.environ.get("OPERATOR_TOOL_TYPE") and os.environ.get("OPERATOR_BETA_FLAG"):
        return SETTINGS.tool_type, SETTINGS.beta_flag
    name = (model or "").lower()
    return NEW_TOOL if name.startswith(_NEW_TOOL_PREFIXES) else LEGACY_TOOL


def other_tool_version(tool_type: str) -> tuple[str, str]:
    """The opposite pairing, for the retry after a version rejection."""
    return LEGACY_TOOL if tool_type == NEW_TOOL[0] else NEW_TOOL
