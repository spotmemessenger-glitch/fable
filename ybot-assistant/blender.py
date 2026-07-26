"""Ybot's 3D brain — turn a plain-English description into a Blender-built mesh.

Claude writes a Blender Python (bpy) script from the description; we run Blender 5.2
headless (`--background`) to execute it and export a .glb (+ an editable .blend). No GUI
clicking — the brain writes the code, Blender runs it. This is the reliable route: driving
Blender's UI with mouse/keyboard is fragile, scripting it is deterministic.
"""
from __future__ import annotations

import os
import re
import subprocess
import time
from pathlib import Path

from dotenv import load_dotenv

import ai_client

load_dotenv()

_ROOT = Path(__file__).resolve().parent
_CREATIONS = _ROOT / "creations"
_SCRIPTS = _CREATIONS / "_scripts"


def _blender_exe() -> str:
    """Locate blender.exe — env override, then the newest Program Files install, then PATH."""
    env = os.environ.get("BLENDER_EXE")
    if env and Path(env).exists():
        return env
    base = Path(r"C:\Program Files\Blender Foundation")
    if base.exists():
        cands = sorted(base.glob("Blender */blender.exe"), reverse=True)
        if cands:
            return str(cands[0])
    return "blender"


_SYSTEM = (
    "You are an expert Blender technical artist who writes Blender Python (bpy) scripts. "
    "Given a plain-English description of a 3D object, output ONE complete Python script that "
    "runs inside Blender via `blender --background --python`. Hard requirements:\n"
    "- Output ONLY raw Python. No markdown fences, no prose, no explanation.\n"
    "- First clear the default scene (select all + delete, and purge orphan meshes).\n"
    "- Build the described model with bpy — primitives, mesh edits, modifiers, and materials "
    "with sensible base colours. Give it real, recognizable geometry, not just a cube.\n"
    "- Read the export path from argv: import sys; out = sys.argv[sys.argv.index('--') + 1].\n"
    "- Export GLB at the end: bpy.ops.export_scene.gltf(filepath=out, export_format='GLB').\n"
    "- Target the Blender 4.x/5.x API and keep it deterministic (no random seeds).\n"
    "- Never call bpy.ops that need a GUI context that --background lacks; prefer data API "
    "(bpy.data / bmesh) when an operator would fail headless."
)


def generate_script(description: str) -> str:
    """Ask the brain (OmniRoute/Gemini, or Anthropic if unavailable) for a complete
    bpy script that builds `description` and exports a GLB."""
    msg = ai_client.client().messages.create(
        model=ai_client.TEXT_MODEL,
        max_tokens=4096,
        system=_SYSTEM,
        messages=[{"role": "user", "content": f"Build this in Blender: {description}"}],
    )
    code = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
    # strip accidental markdown fences if the model added them anyway
    code = re.sub(r"^```(?:python)?\n?", "", code)
    code = re.sub(r"\n?```$", "", code).strip()
    # safety net: guarantee an export even if the model forgot it
    if "export_scene.gltf" not in code:
        code += (
            "\nimport sys, bpy\n"
            "out = sys.argv[sys.argv.index('--') + 1]\n"
            "bpy.ops.export_scene.gltf(filepath=out, export_format='GLB')\n"
        )
    return code


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:40] or "model"


def create(description: str, timeout: int = 240) -> dict:
    """Description -> .glb via headless Blender.

    Returns {ok, out, blend, log, script}. `out` is the .glb path (None on failure),
    `blend` the editable .blend, `script` the generated bpy script, `log` Blender's tail output.
    """
    _CREATIONS.mkdir(exist_ok=True)
    _SCRIPTS.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    slug = _slug(description)
    out_glb = _CREATIONS / f"{slug}-{stamp}.glb"
    out_blend = _CREATIONS / f"{slug}-{stamp}.blend"

    script = generate_script(description)
    # append a .blend save so the result stays editable in Blender later
    script += (
        "\ntry:\n"
        "    import bpy as _bpy\n"
        f"    _bpy.ops.wm.save_as_mainfile(filepath=r'{out_blend}')\n"
        "except Exception as _e:\n"
        "    print('save .blend failed:', _e)\n"
    )
    script_path = _SCRIPTS / f"{slug}-{stamp}.py"
    script_path.write_text(script, encoding="utf-8")

    cmd = [
        _blender_exe(), "--background", "--factory-startup",
        "--python", str(script_path), "--", str(out_glb),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        log = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
    except subprocess.TimeoutExpired:
        return {"ok": False, "out": None, "blend": None,
                "log": f"Blender timed out after {timeout}s", "script": str(script_path)}
    except FileNotFoundError:
        return {"ok": False, "out": None, "blend": None,
                "log": "blender.exe not found — set BLENDER_EXE", "script": str(script_path)}

    ok = out_glb.exists()
    return {
        "ok": ok,
        "out": str(out_glb) if ok else None,
        "blend": str(out_blend) if out_blend.exists() else None,
        "log": log[-2500:],
        "script": str(script_path),
    }


if __name__ == "__main__":
    import json
    import sys

    desc = " ".join(sys.argv[1:]) or "a low-poly gear with 10 teeth"
    print(json.dumps(create(desc), indent=2))
