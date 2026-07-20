"""Configuration loaded from the environment.

Every knob lives here so nothing else in the codebase reads os.environ
directly. Import `settings` and use it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

# The .env sits at the workspace root, one level above the jarvis package.
PACKAGE_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_ROOT.parent.parent
WORKSPACE_ROOT = PROJECT_ROOT.parent

load_dotenv(WORKSPACE_ROOT / ".env", override=True)
load_dotenv(PROJECT_ROOT / ".env", override=True)


class ConfigError(RuntimeError):
    """Raised when required configuration is missing or unusable."""


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a whole number, got {raw!r}") from exc


def _env_bool(name: str, default: bool) -> bool:
    raw = _env(name).lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    """Immutable snapshot of configuration."""

    anthropic_api_key: str
    elevenlabs_api_key: str
    voice_id: str

    # Two tiers: a fast model for conversation, a strong one for hard reasoning
    # and delegation. Routing between them lives in brain.py.
    model: str
    heavy_model: str
    max_tokens: int

    # Conversation history is trimmed in PAIRS. Trimming by raw message count
    # can orphan an assistant message at the head of the list, which the API
    # rejects because the first message must have the "user" role.
    max_history_pairs: int

    assistant_name: str
    wake_words: tuple[str, ...]
    tts_model: str
    tts_enabled: bool
    stt_language: str

    data_dir: Path
    db_path: Path
    log_path: Path

    workspace_root: Path = field(default=WORKSPACE_ROOT)

    @property
    def has_voice_output(self) -> bool:
        return bool(self.elevenlabs_api_key and self.voice_id and self.tts_enabled)


def load_settings() -> Settings:
    anthropic_key = _env("ANTHROPIC_API_KEY")
    if not anthropic_key:
        raise ConfigError(
            "ANTHROPIC_API_KEY is not set. Add it to the .env file at "
            f"{WORKSPACE_ROOT / '.env'} — see .env.example for the format."
        )

    data_dir = Path(_env("JARVIS_DATA_DIR") or (PROJECT_ROOT / "data"))
    data_dir.mkdir(parents=True, exist_ok=True)

    wake_raw = _env("JARVIS_WAKE_WORDS", "jarvis,hey jarvis")
    wake_words = tuple(w.strip().lower() for w in wake_raw.split(",") if w.strip())
    if not wake_words:
        raise ConfigError("JARVIS_WAKE_WORDS resolved to an empty list.")

    return Settings(
        anthropic_api_key=anthropic_key,
        elevenlabs_api_key=_env("ELEVENLABS_API_KEY"),
        voice_id=_env("JARVIS_VOICE_ID"),
        model=_env("JARVIS_MODEL", "claude-sonnet-5"),
        heavy_model=_env("JARVIS_HEAVY_MODEL", "claude-fable-5"),
        max_tokens=_env_int("JARVIS_MAX_TOKENS", 4096),
        max_history_pairs=_env_int("JARVIS_MAX_HISTORY_PAIRS", 12),
        assistant_name=_env("JARVIS_NAME", "Jarvis"),
        wake_words=wake_words,
        tts_model=_env("JARVIS_TTS_MODEL", "eleven_flash_v2_5"),
        tts_enabled=_env_bool("JARVIS_TTS_ENABLED", True),
        stt_language=_env("JARVIS_STT_LANGUAGE", "auto"),
        data_dir=data_dir,
        db_path=Path(_env("JARVIS_DB_PATH") or (data_dir / "jarvis.db")),
        log_path=Path(_env("JARVIS_LOG_PATH") or (data_dir / "jarvis.log")),
    )


settings = load_settings()
