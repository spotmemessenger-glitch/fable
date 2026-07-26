"""Ybot's plugin system.

Drop a `<name>.py` file into ybot-assistant/plugins/ that defines a module-level
PLUGIN dict, and Ybot picks it up automatically — no core edits, no restart-to-wire.
This is the extension point that lets Ybot grow new skills (like the bundled
crypto_desk plugin) the way Claude Code grows via its own plugins.

A plugin file looks like::

    def run(task, progress=None):
        ...
        return {"ok": True, "answer": "..."}      # or {"ok": False, "error": "..."}

    PLUGIN = {
        "name": "Crypto Trading Desk",
        "command": "crypto",          # invoked as "crypto: <task>" in the composer
        "description": "one line shown in the plugins list",
        "run": run,                   # callable(task: str, progress=cb) -> dict
    }

Files whose name starts with "_" are ignored (helpers / libs).
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

_DIR = Path(__file__).resolve().parent / "plugins"


def _load_one(path: Path) -> dict | None:
    try:
        spec = importlib.util.spec_from_file_location(f"ybot_plugin_{path.stem}", path)
        if spec is None or spec.loader is None:
            return None
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        p = getattr(mod, "PLUGIN", None)
        if isinstance(p, dict) and p.get("command") and callable(p.get("run")):
            p.setdefault("name", p["command"])
            p.setdefault("description", "")
            return p
    except Exception:
        return None
    return None


def discover() -> list[dict]:
    """All valid plugins found in plugins/. Re-scans each call so a newly dropped-in
    plugin is picked up without restarting Ybot."""
    if not _DIR.is_dir():
        return []
    out = []
    for f in sorted(_DIR.glob("*.py")):
        if f.name.startswith("_"):
            continue
        p = _load_one(f)
        if p:
            out.append(p)
    return out


def find(command: str) -> dict | None:
    cmd = (command or "").lower().strip()
    for p in discover():
        if p["command"].lower() == cmd:
            return p
    return None


def commands() -> list[str]:
    return [p["command"].lower() for p in discover()]


def summary() -> str:
    plugins = discover()
    if not plugins:
        return ("No plugins installed yet. Drop a <name>.py into ybot-assistant/plugins/ "
                "(with a PLUGIN dict) and I'll pick it up automatically.")
    lines = [f"• {p['name']} — \"{p['command']}: …\" — {p['description']}" for p in plugins]
    return "Installed plugins:\n" + "\n".join(lines)


if __name__ == "__main__":
    print(summary())
