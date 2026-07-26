"""Ybot's photoreal 3D skill: a real reference photo -> an actual neural 3D reconstruction.

Unlike likeness.py (procedural bpy primitives scripted from a text spec — capped at
"recognizable stylized blockout", critic-scored ~1.7/10 for likeness accuracy), this uses
TripoSR: a genuine single-image-to-3D neural network running locally on this machine's GPU.
No uploads, no cloud service, no credits.

Two real repo bugs were fixed in fable/TripoSR/tsr/ to make this work here (see memory /
git history in that repo): torchmcubes can't compile without admin-level CUDA/MSVC
integration, so tsr/models/isosurface.py falls back to scikit-image's marching cubes; and
tsr/bake_texture.py had a CPU/CUDA device-mismatch bug. This module deliberately avoids the
--bake-texture path anyway (xatlas.export() there always writes OBJ text regardless of the
requested extension, and the baked-texture atlas had its own quality issues) and uses plain
per-vertex color output instead, which is simpler and matches the proven-good recipe.

Known limitation (real, not yet solved): re-importing the mesh into Blender and re-rendering
there shows large flat garment regions (e.g. a plain shirt) washed out, even though the raw
vertex-color data isn't blown out — TripoSR's per-vertex surface-point color query measurably
underperforms its own volumetric renderer on large uniform-color surfaces. The native
turntable render (produced by TripoSR itself, via --render) does NOT have this problem and is
the accurate, good-looking proof of quality — always prefer it over the Blender re-render.
"""
from __future__ import annotations

import os
import re
import subprocess
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parent
_TRIPOSR_ROOT = _ROOT.parent / "TripoSR"
_TRIPOSR_PY = Path.home() / ".venvs" / "triposr" / "Scripts" / "python.exe"
_JOBS = _ROOT / "creations" / "photoreal_jobs"

MC_RESOLUTION = int(os.environ.get("PHOTOREAL_MC_RESOLUTION", "320"))


def available() -> bool:
    return _TRIPOSR_PY.exists() and _TRIPOSR_ROOT.exists()


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
    return s[:40] or "photoreal"


# ------------------------------------------------------------- Blender import template
# Embedded (not a separate file) so a job directory is fully self-contained. Proven recipe
# from the overnight session: X-up -> Z-up correction (measured empirically — this export's
# X axis is the "height" axis, NOT glTF's typical Y-up), then a 90deg Z spin to face front.
_BLENDER_IMPORT_PY = r'''
import math, sys
from pathlib import Path
import bpy, mathutils

JOB = Path(sys.argv[sys.argv.index("--") + 1])
OBJ = JOB / "tripo" / "0" / "mesh.obj"

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.obj_import(filepath=str(OBJ))
mesh_obs = [o for o in bpy.context.scene.objects if o.type == "MESH"]

for ob in mesh_obs:
    me = ob.data
    if not me.color_attributes:
        continue
    attr_name = me.color_attributes[0].name
    mat = bpy.data.materials.new("photoreal")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    vcol = nt.nodes.new("ShaderNodeVertexColor")
    vcol.layer_name = attr_name
    # partial compensation for TripoSR's per-vertex color query under-saturating large
    # flat surfaces (see module docstring) -- doesn't fully fix it, but helps.
    hsv = nt.nodes.new("ShaderNodeHueSaturation")
    hsv.inputs["Saturation"].default_value = 1.6
    hsv.inputs["Value"].default_value = 0.75
    nt.links.new(vcol.outputs["Color"], hsv.inputs["Color"])
    gamma = nt.nodes.new("ShaderNodeGamma")
    gamma.inputs["Gamma"].default_value = 1.6
    nt.links.new(hsv.outputs["Color"], gamma.inputs["Color"])
    nt.links.new(gamma.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.85
    try:
        bsdf.inputs["Specular IOR Level"].default_value = 0.0
    except Exception:
        pass
    me.materials.clear()
    me.materials.append(mat)

# measured empirically: X is this export's "height" axis, not glTF's typical Y-up.
for ob in mesh_obs:
    ob.rotation_euler = (0, math.radians(-90), math.radians(90))
bpy.context.view_layer.update()


def bounds():
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for ob in mesh_obs:
        for corner in ob.bound_box:
            w = ob.matrix_world @ mathutils.Vector(corner)
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
    return lo, hi


lo, hi = bounds()
cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
cz = (lo[2] + hi[2]) / 2
height = max(hi[2] - lo[2], 0.5)
dist = height * 1.4

scene = bpy.context.scene
views = {
    "front": (cx, cy - dist, cz),
    "side": (cx - dist, cy, cz),
    "threeq": (cx - dist * 0.7, cy - dist * 0.7, cz + height * 0.1),
}
for name, loc in views.items():
    cam = bpy.data.cameras.new(f"cam_{name}")
    ob = bpy.data.objects.new(f"cam_{name}", cam)
    scene.collection.objects.link(ob)
    ob.location = loc
    target = mathutils.Vector((cx, cy, cz))
    d = target - ob.location
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    cam.lens = 45

sun = bpy.data.lights.new("sky", type="SUN")
sun.energy = 3.0
sun_ob = bpy.data.objects.new("sky", sun)
scene.collection.objects.link(sun_ob)
sun_ob.rotation_euler = (math.radians(55), 0, math.radians(25))

fill = bpy.data.lights.new("fill", type="SUN")
fill.energy = 1.2
fill_ob = bpy.data.objects.new("fill", fill)
scene.collection.objects.link(fill_ob)
fill_ob.rotation_euler = (math.radians(70), 0, math.radians(-110))

world = scene.world or bpy.data.worlds.new("world")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
if bg:
    bg.inputs[0].default_value = (0.92, 0.93, 0.95, 1)
    bg.inputs[1].default_value = 1.0

scene.render.resolution_x = 700
scene.render.resolution_y = 1000
for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    try:
        scene.render.engine = eng
        break
    except Exception:
        continue
try:
    scene.view_settings.view_transform = "Standard"
except Exception:
    pass

(JOB / "blender_renders").mkdir(exist_ok=True)
for name in views:
    scene.camera = bpy.data.objects[f"cam_{name}"]
    scene.render.filepath = str(JOB / "blender_renders" / f"{name}.png")
    bpy.ops.render.render(write_still=True)

bpy.ops.wm.save_as_mainfile(filepath=str(JOB / "model.blend"))
print("BLENDER_IMPORT_DONE")
'''


def _job_dir(description: str) -> Path:
    _JOBS.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    d = _JOBS / f"{_slug(description or 'photoreal')}-{stamp}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def create_from_photo(image_path: str, description: str = "", progress=None) -> dict:
    """A single reference photo -> a real neural 3D reconstruction + Blender import.

    Returns {ok, job_dir, native_front, turntable_mp4, turntable_frames, model_blend,
    model_obj, errors}. `native_front`/`turntable_*` are TripoSR's own renders — the
    accurate, good-looking proof of quality. `model_blend` is importable/viewable but has
    the documented flat-surface color limitation (module docstring).
    """
    def note(msg: str) -> None:
        if progress:
            try:
                progress(msg)
            except Exception:
                pass

    if not available():
        return {"ok": False, "errors": ["TripoSR venv not found — see photoreal.py _TRIPOSR_PY/_TRIPOSR_ROOT"]}
    src = Path(image_path)
    if not src.exists():
        return {"ok": False, "errors": [f"reference photo not found: {image_path}"]}

    job = _job_dir(description)
    tripo_out = job / "tripo"

    note("Running the 3D reconstruction (neural network, ~1-2 min on this GPU)...")
    cmd = [
        str(_TRIPOSR_PY), "run.py", str(src),
        "--output-dir", str(tripo_out),
        "--model-save-format", "obj",
        "--mc-resolution", str(MC_RESOLUTION),
        "--render",
    ]
    proc = subprocess.run(cmd, cwd=str(_TRIPOSR_ROOT), capture_output=True, text=True, timeout=600)
    mesh_obj = tripo_out / "0" / "mesh.obj"
    if not mesh_obj.exists():
        tail = ((proc.stdout or "") + (proc.stderr or ""))[-2000:]
        return {"ok": False, "errors": ["TripoSR did not produce a mesh", tail], "job_dir": str(job)}

    note("Reconstruction done — importing into Blender for a viewable model...")
    blender_script = job / "_blender_import.py"
    blender_script.write_text(_BLENDER_IMPORT_PY, encoding="utf-8")
    bproc = subprocess.run(
        [_blender_exe(), "--background", "--factory-startup", "--python", str(blender_script), "--", str(job)],
        capture_output=True, text=True, timeout=180,
    )
    model_blend = job / "model.blend"

    frames = sorted((tripo_out / "0").glob("render_*.png"))
    return {
        "ok": True,
        "job_dir": str(job),
        "native_front": str(frames[0]) if frames else None,
        "turntable_mp4": str(tripo_out / "0" / "render.mp4"),
        "turntable_frames": [str(f) for f in frames],
        "model_blend": str(model_blend) if model_blend.exists() else None,
        "model_obj": str(mesh_obj),
        "errors": [] if model_blend.exists() else ["Blender import step had no output: " + bproc.stderr[-500:]],
    }


if __name__ == "__main__":
    import json
    import sys

    photo = sys.argv[1] if len(sys.argv) > 1 else ""
    print(json.dumps(create_from_photo(photo), indent=2))
