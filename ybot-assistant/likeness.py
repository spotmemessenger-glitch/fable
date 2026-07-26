"""Ybot's durable 3D-likeness skill: reference photo(s) -> Blender character model.

Reusable, self-contained (embeds its own Blender-side templates so it never depends on
any ad-hoc working folder). Pipeline per job:
  1. analyze()  - Claude vision reads the reference image(s) -> a modeling spec
  2. build      - Claude writes a bpy character script from the spec
  3. render     - headless Blender executes it, renders 5 views, exports .blend + .glb
  4. critique() - Claude vision compares renders vs reference -> numeric fixes
  5. patch      - Claude rewrites the bpy script to apply the fixes
  Steps 3-5 repeat for `rounds` iterations or until the critique score is high enough.

Brain = Claude (Anthropic API, vision). Hands = headless Blender 5.2 (bpy). Eyes = the
rendered PNGs Claude reads back each round. No GUI clicking anywhere in the loop.
"""
from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import time
from pathlib import Path

from dotenv import load_dotenv

import ai_client

load_dotenv()

_ROOT = Path(__file__).resolve().parent
_JOBS = _ROOT / "creations" / "likeness_jobs"

GOOD_ENOUGH_SCORE = 8.2
MAX_ROUNDS_DEFAULT = 3


def _blender_exe() -> str:
    env = os.environ.get("BLENDER_EXE")
    if env and Path(env).exists():
        return env
    base = Path(r"C:\Program Files\Blender Foundation")
    if base.exists():
        cands = sorted(base.glob("Blender */blender.exe"), reverse=True)
        if cands:
            return str(cands[0])
    return "blender"


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:40] or "likeness"


_MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}


def _image_block(path: Path) -> dict:
    media = _MEDIA_TYPES.get(path.suffix.lower(), "image/png")
    data = base64.b64encode(path.read_bytes()).decode()
    return {"type": "image", "source": {"type": "base64", "media_type": media, "data": data}}


def _extract_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\n?", "", text)
    text = re.sub(r"\n?```$", "", text).strip()
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        text = m.group(0)
    return json.loads(text)


# --------------------------------------------------------------- pipeline templates
# Embedded so a job folder is fully self-contained — no dependency on any other file.

_PIPELINE_PY = r'''
import json, math, traceback
from pathlib import Path
import bpy, mathutils

ROOT = Path(__file__).resolve().parent
RENDERS = ROOT / "renders"
RESULT = {"ok": False, "errors": [], "renders": [], "blend": None, "glb": None}

def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def run_build():
    code = (ROOT / "build.py").read_text(encoding="utf-8")
    exec(compile(code, "build.py", "exec"), {"bpy": bpy, "math": math, "__name__": "__build__"})

def scene_bounds():
    lo = [1e9]*3; hi = [-1e9]*3
    for ob in bpy.context.scene.objects:
        if ob.type != "MESH":
            continue
        for corner in ob.bound_box:
            w = ob.matrix_world @ mathutils.Vector(corner)
            for i in range(3):
                lo[i] = min(lo[i], w[i]); hi[i] = max(hi[i], w[i])
    return lo, hi

def add_camera_rig():
    lo, hi = scene_bounds()
    cx, cy = (lo[0]+hi[0])/2, (lo[1]+hi[1])/2
    cz = (lo[2]+hi[2])/2
    height = max(hi[2]-lo[2], 0.5)
    dist = max(height*1.35, 1.2)
    views = {
        "front": (cx, cy-dist, cz), "side": (cx-dist, cy, cz), "back": (cx, cy+dist, cz),
        "threeq": (cx-dist*0.72, cy-dist*0.72, cz+height*0.08),
        "head": (cx, cy-dist*0.45, hi[2]-height*0.10),
    }
    scene = bpy.context.scene
    for name, loc in views.items():
        cam = bpy.data.cameras.new(f"cam_{name}")
        ob = bpy.data.objects.new(f"cam_{name}", cam)
        scene.collection.objects.link(ob)
        ob.location = loc
        target = mathutils.Vector((cx, cy, hi[2]-height*0.10 if name == "head" else cz))
        d = target - ob.location
        ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        cam.lens = 60 if name == "head" else 42
    sun = bpy.data.lights.new("sun", type="SUN"); sun.energy = 3.0
    sun_ob = bpy.data.objects.new("sun", sun); scene.collection.objects.link(sun_ob)
    sun_ob.rotation_euler = (math.radians(50), math.radians(-20), math.radians(30))
    key = bpy.data.lights.new("key", type="AREA"); key.energy = 400; key.size = 3
    key_ob = bpy.data.objects.new("key", key); scene.collection.objects.link(key_ob)
    key_ob.location = (cx-2, cy-3, cz+height*0.4)
    d = mathutils.Vector((cx, cy, cz)) - key_ob.location
    key_ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()

def render_views():
    scene = bpy.context.scene
    scene.render.resolution_x = 640; scene.render.resolution_y = 900
    world = scene.world or bpy.data.worlds.new("world")
    scene.world = world; world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.92, 0.93, 0.95, 1); bg.inputs[1].default_value = 1.0
    engine_set = False
    for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = eng; engine_set = True; break
        except Exception:
            continue
    if not engine_set:
        scene.render.engine = "BLENDER_WORKBENCH"
    if scene.render.engine == "BLENDER_WORKBENCH":
        scene.display.shading.light = "STUDIO"; scene.display.shading.color_type = "MATERIAL"
    RENDERS.mkdir(exist_ok=True)
    for ob in list(bpy.context.scene.objects):
        if ob.type == "CAMERA":
            scene.camera = ob
            name = ob.name.replace("cam_", "")
            scene.render.filepath = str(RENDERS / f"{name}.png")
            try:
                bpy.ops.render.render(write_still=True)
                RESULT["renders"].append(scene.render.filepath)
            except Exception as e:
                RESULT["errors"].append(f"render {name}: {e}")

def export():
    blend = ROOT / "model.blend"; glb = ROOT / "model.glb"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend))
    RESULT["blend"] = str(blend)
    try:
        for ob in bpy.context.scene.objects:
            ob.select_set(ob.type == "MESH")
        bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True)
        RESULT["glb"] = str(glb)
    except Exception as e:
        RESULT["errors"].append(f"glb export: {e}")

def main():
    try:
        clear_scene(); run_build(); add_camera_rig(); render_views(); export()
        RESULT["ok"] = bool(RESULT["renders"]) and not any(e.startswith("render") for e in RESULT["errors"])
    except Exception:
        RESULT["errors"].append(traceback.format_exc()[-1800:])
    (ROOT / "result.json").write_text(json.dumps(RESULT, indent=2), encoding="utf-8")
    print("PIPELINE_RESULT " + json.dumps({"ok": RESULT["ok"], "n_renders": len(RESULT["renders"])}))

main()
'''

_WATCH_PY = r'''
import bpy
from pathlib import Path
BLEND = Path(__file__).resolve().parent / "model.blend"
_state = {"mtime": 0.0}

def _show_model():
    for ob in bpy.context.scene.objects:
        is_mesh = ob.type == "MESH"
        try:
            ob.hide_set(not is_mesh); ob.select_set(is_mesh)
        except Exception:
            pass
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                for space in area.spaces:
                    if space.type == "VIEW_3D":
                        space.shading.type = "MATERIAL"
                region = next((r for r in area.regions if r.type == "WINDOW"), None)
                if region is None:
                    continue
                try:
                    with bpy.context.temp_override(window=win, area=area, region=region):
                        bpy.ops.view3d.view_selected()
                except Exception:
                    pass

def check():
    try:
        m = BLEND.stat().st_mtime
        if m > _state["mtime"]:
            _state["mtime"] = m
            bpy.ops.wm.open_mainfile(filepath=str(BLEND), load_ui=False)
            _show_model()
            print(f"[watch] reloaded {BLEND.name}")
    except FileNotFoundError:
        pass
    except Exception as e:
        print("[watch]", e)
    return 6.0

bpy.app.timers.register(check, first_interval=2.0, persistent=True)
print("[watch] live progress viewer armed")
'''


def _job_dir(description: str) -> Path:
    _JOBS.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    d = _JOBS / f"{_slug(description or 'likeness')}-{stamp}"
    d.mkdir(parents=True, exist_ok=True)
    (d / "renders").mkdir(exist_ok=True)
    (d / "history").mkdir(exist_ok=True)
    (d / "pipeline.py").write_text(_PIPELINE_PY, encoding="utf-8")
    (d / "watch.py").write_text(_WATCH_PY, encoding="utf-8")
    return d


def open_live_viewer(job_dir: Path) -> None:
    """Pop a GUI Blender that auto-reloads model.blend as each round updates it."""
    try:
        subprocess.Popen([_blender_exe(), "--python", str(job_dir / "watch.py")])
    except Exception:
        pass


_ANALYZE_SYSTEM = (
    "You are a character-modeling art director briefing a technical artist who will build "
    "a STYLIZED-REALISTIC 3D character in Blender using primitive-based procedural geometry "
    "(spheres/cylinders/tori scaled and merged, subsurf, no sculpting). You will never achieve "
    "a photoreal scan — the goal is the closest recognizable likeness achievable with that "
    "technique. Write an exhaustive MODELING SPEC covering: global proportions in head-units "
    "(assume 1.75m total height unless the photos suggest otherwise) — head size, shoulder "
    "width, chest/belly depth, arm and leg thickness and length, neck thickness; head & face — "
    "skull shape, brow, nose, ears, and the EXACT hairstyle silhouette and beard/facial-hair "
    "shape and coverage if any; exact colors as linear RGB 0-1 floats for skin, hair, and "
    "primary clothing; distinctive accessories (jewelry, watches, glasses); what to exaggerate "
    "at a primitive-blockout level for recognizability. Be extremely concrete and numeric."
)


def analyze(image_paths: list[Path], description: str = "") -> str:
    content = [_image_block(p) for p in image_paths]
    content.append({
        "type": "text",
        "text": (f"Reference photos of a subject to model in 3D. {description}\n"
                  "Write the modeling spec now.").strip(),
    })
    msg = ai_client.client().messages.create(
        model=ai_client.TEXT_MODEL, max_tokens=2000, system=_ANALYZE_SYSTEM,
        messages=[{"role": "user", "content": content}],
    )
    return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()


_BUILD_SYSTEM = (
    "You are an expert Blender technical artist writing PURE bpy Python that will be exec()'d "
    "inside a running Blender session (bpy, math already available; do NOT import bpy/math "
    "yourself, do NOT call bpy.ops that need a GUI context, no random/no seeds). Build a "
    "character from primitives (spheres/cylinders/tori) positioned, scaled and rotated to "
    "form an organic, proportioned humanoid silhouette matching the spec — merge/overlap "
    "shapes so there are no visible gaps, smooth-shade every mesh at the end. Create simple "
    "Principled BSDF materials matching the spec's colors. The character must be ~1.75m tall, "
    "standing in a relaxed A-pose, centered at the origin, feet at z=0. Output ONLY raw Python "
    "— no markdown fences, no prose."
)


def generate_build_script(spec: str) -> str:
    msg = ai_client.client().messages.create(
        model=ai_client.TEXT_MODEL, max_tokens=4096, system=_BUILD_SYSTEM,
        messages=[{"role": "user", "content": f"Modeling spec:\n{spec}\n\nWrite build.py now."}],
    )
    code = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
    code = re.sub(r"^```(?:python)?\n?", "", code)
    code = re.sub(r"\n?```$", "", code).strip()
    return code


def run_blender(job_dir: Path, timeout: int = 300) -> dict:
    result_file = job_dir / "result.json"
    if result_file.exists():
        result_file.unlink()
    proc = subprocess.run(
        [_blender_exe(), "--background", "--factory-startup", "--python", str(job_dir / "pipeline.py")],
        capture_output=True, text=True, timeout=timeout, cwd=str(job_dir),
    )
    if result_file.exists():
        res = json.loads(result_file.read_text(encoding="utf-8"))
    else:
        tail = ((proc.stdout or "") + (proc.stderr or ""))[-1500:]
        res = {"ok": False, "errors": ["no result.json", tail], "renders": []}
    return res


_CRITIC_SYSTEM = (
    "You are a brutally honest character-likeness critic. You will see RENDERED IMAGES of a "
    "primitive-based 3D model, then REFERENCE PHOTOS of the real subject. Score how close the "
    "model's silhouette, proportions, hair/facial-hair shape, and colors are to the reference, "
    "0-10 (be harsh; a generic mannequin is a 2-3; 8+ means genuinely recognizable). Then list "
    "concrete, NUMERIC, bpy-actionable fixes (e.g. \"hair: scale z 0.85 -> 1.15, move location "
    "z +0.03\", \"skin base color -> (0.42,0.26,0.16)\"). Respond with ONLY this JSON: "
    '{"score": <0-10 number>, "fixes": ["...", "..."]}'
)


def critique(job_dir: Path, ref_paths: list[Path]) -> dict:
    render_names = ["front.png", "side.png", "back.png", "threeq.png", "head.png"]
    renders = [job_dir / "renders" / n for n in render_names if (job_dir / "renders" / n).exists()]
    content = [{"type": "text", "text": "MODEL RENDERS:"}]
    content += [_image_block(p) for p in renders]
    content.append({"type": "text", "text": "REFERENCE PHOTOS:"})
    content += [_image_block(p) for p in ref_paths]
    content.append({"type": "text", "text": "Score and list fixes now — JSON only."})
    msg = ai_client.client().messages.create(
        model=ai_client.TEXT_MODEL, max_tokens=1500, system=_CRITIC_SYSTEM,
        messages=[{"role": "user", "content": content}],
    )
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
    try:
        return _extract_json(text)
    except Exception:
        return {"score": 0, "fixes": []}


_PATCH_SYSTEM = (
    "You are the same Blender technical artist. You will be given the CURRENT build.py and a "
    "list of critique fixes. Rewrite the ENTIRE build.py applying every fix faithfully — keep "
    "everything that wasn't flagged. Same constraints as before: pure bpy/math exec()'d "
    "in-session, no imports, no GUI-context ops, smooth-shade at the end, ~1.75m tall, A-pose, "
    "centered, feet at z=0. Output ONLY raw Python, no markdown fences, no prose."
)


def patch_build_script(current_script: str, fixes: list[str]) -> str:
    msg = ai_client.client().messages.create(
        model=ai_client.TEXT_MODEL, max_tokens=4096, system=_PATCH_SYSTEM,
        messages=[{"role": "user", "content": (
            f"CURRENT build.py:\n```python\n{current_script}\n```\n\n"
            f"FIXES TO APPLY:\n{json.dumps(fixes, indent=1)}\n\nWrite the full updated build.py now."
        )}],
    )
    code = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
    code = re.sub(r"^```(?:python)?\n?", "", code)
    code = re.sub(r"\n?```$", "", code).strip()
    return code


def build_from_images(
    image_paths: list[str],
    description: str = "",
    rounds: int = MAX_ROUNDS_DEFAULT,
    open_viewer: bool = True,
    progress=None,
) -> dict:
    """Full pipeline: reference photo(s) -> iteratively-refined Blender character.

    `progress`, if given, is called with a short status string after each phase — bridge.py
    wires this to speak/log updates so you can follow along without reading logs.
    """
    def note(msg: str) -> None:
        if progress:
            try:
                progress(msg)
            except Exception:
                pass

    refs = [Path(p) for p in image_paths if Path(p).exists()]
    if not refs:
        return {"ok": False, "error": "no valid reference images"}

    job_dir = _job_dir(description)
    if open_viewer:
        open_live_viewer(job_dir)

    note("Studying the reference photos…")
    spec = analyze(refs, description)
    (job_dir / "spec.txt").write_text(spec, encoding="utf-8")

    note("Sculpting the first blockout…")
    script = generate_build_script(spec)
    (job_dir / "build.py").write_text(script, encoding="utf-8")
    res = run_blender(job_dir)

    history = []
    best_score = -1.0
    for attempt in range(3):  # recover from a broken first script
        if res.get("ok"):
            break
        note(f"Fixing a build error (attempt {attempt + 1})…")
        err_tail = "\n".join(res.get("errors", []))[-1200:]
        script = patch_build_script(script, [f"The script errored, fix it: {err_tail}"])
        (job_dir / "build.py").write_text(script, encoding="utf-8")
        res = run_blender(job_dir)

    for round_i in range(1, rounds + 1):
        if not res.get("ok"):
            break
        note(f"Comparing round {round_i} against the reference photos…")
        crit = critique(job_dir, refs)
        score = float(crit.get("score", 0))
        fixes = crit.get("fixes") or []
        history.append({"round": round_i, "score": score, "fixes": fixes})
        hist_dir = job_dir / "history" / f"round{round_i}"
        hist_dir.mkdir(exist_ok=True)
        for f in (job_dir / "renders").glob("*.png"):
            (hist_dir / f.name).write_bytes(f.read_bytes())
        best_score = max(best_score, score)
        if score >= GOOD_ENOUGH_SCORE or not fixes or round_i == rounds:
            break
        note(f"Round {round_i}: {score:.1f}/10 — refining ({len(fixes)} fixes)…")
        script = patch_build_script(script, fixes)
        (job_dir / "build.py").write_text(script, encoding="utf-8")
        res = run_blender(job_dir)

    return {
        "ok": bool(res.get("ok")),
        "job_dir": str(job_dir),
        "blend": res.get("blend"),
        "glb": res.get("glb"),
        "renders": res.get("renders", []),
        "score": best_score,
        "rounds_run": len(history),
        "history": history,
        "errors": res.get("errors", []),
    }
