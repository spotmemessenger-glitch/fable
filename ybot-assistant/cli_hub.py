"""Ybot's CLI-Anything integration: control GUI software via generated agent-native
CLIs instead of clicking through it (complements blender.py's headless bpy scripting —
this generalizes the same idea to any software CLI-Anything has a CLI for: GIMP,
LibreOffice, Audacity, OBS Studio, 100+ others).

Thin subprocess wrapper around the `cli-hub` tool (pip install cli-anything-hub).
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def _cli_hub_exe() -> str:
    found = shutil.which("cli-hub")
    if found:
        return found
    # pip installs the script here without adding it to PATH on this machine
    guess = Path(r"C:\Users\yuv\AppData\Local\Python\pythoncore-3.14-64\Scripts\cli-hub.exe")
    if guess.exists():
        return str(guess)
    return "cli-hub"


def available() -> bool:
    try:
        subprocess.run([_cli_hub_exe(), "--version"], capture_output=True, timeout=10)
        return True
    except Exception:
        return False


def run(args: list[str], timeout: int = 60) -> dict:
    """Run a cli-hub subcommand (install/launch/search/list/info/...) and return output."""
    try:
        proc = subprocess.run([_cli_hub_exe(), *args], capture_output=True, text=True, timeout=timeout)
        return {"ok": proc.returncode == 0, "output": (proc.stdout or "") + (proc.stderr or "")}
    except Exception as e:
        return {"ok": False, "output": f"{type(e).__name__}: {e}"}


def search(query: str) -> dict:
    return run(["search", query])


def install(name: str) -> dict:
    return run(["install", name], timeout=180)


def launch(name: str, extra_args: list[str] | None = None) -> dict:
    return run(["launch", name, *(extra_args or [])], timeout=30)
