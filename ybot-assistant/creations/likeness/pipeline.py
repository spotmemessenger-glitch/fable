"""Runs INSIDE Blender (--background --python pipeline.py).

Every run: execute build.py (the evolving character script), save .blend,
render front/side/back/three-quarter views for critique, export GLB, and
write result.json so the driver can report success/failure precisely.
"""
import json
import math
import traceback
from pathlib import Path

import bpy
import mathutils

ROOT = Path(__file__).resolve().parent
RENDERS = ROOT / "renders"
RESULT = {"ok": False, "errors": [], "renders": [], "blend": None, "glb": None}


def clear_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def run_build() -> None:
    code = (ROOT / "build.py").read_text(encoding="utf-8")
    exec(compile(code, "build.py", "exec"), {"bpy": bpy, "math": math, "__name__": "__build__"})


def scene_bounds():
    """World-space bounds of all mesh objects."""
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for ob in bpy.context.scene.objects:
        if ob.type != "MESH":
            continue
        for corner in ob.bound_box:
            w = ob.matrix_world @ mathutils.Vector(corner)
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
    return lo, hi


def add_camera_rig() -> None:
    """Cameras + soft studio light aimed at the model, framed from its bounds."""
    lo, hi = scene_bounds()
    cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    cz = (lo[2] + hi[2]) / 2
    height = max(hi[2] - lo[2], 0.5)
    dist = max(height * 1.35, 1.2)

    views = {
        "front": (cx, cy - dist, cz),
        "side": (cx - dist, cy, cz),
        "back": (cx, cy + dist, cz),
        "threeq": (cx - dist * 0.72, cy - dist * 0.72, cz + height * 0.08),
        "head": (cx, cy - dist * 0.45, hi[2] - height * 0.10),
    }
    scene = bpy.context.scene
    for name, loc in views.items():
        cam = bpy.data.cameras.new(f"cam_{name}")
        ob = bpy.data.objects.new(f"cam_{name}", cam)
        scene.collection.objects.link(ob)
        ob.location = loc
        target = mathutils.Vector((cx, cy, hi[2] - height * 0.10 if name == "head" else cz))
        d = target - ob.location
        ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        cam.lens = 60 if name == "head" else 42

    sun = bpy.data.lights.new("sun", type="SUN")
    sun.energy = 3.0
    sun_ob = bpy.data.objects.new("sun", sun)
    scene.collection.objects.link(sun_ob)
    sun_ob.rotation_euler = (math.radians(50), math.radians(-20), math.radians(30))

    key = bpy.data.lights.new("key", type="AREA")
    key.energy = 400
    key.size = 3
    key_ob = bpy.data.objects.new("key", key)
    scene.collection.objects.link(key_ob)
    key_ob.location = (cx - 2, cy - 3, cz + height * 0.4)
    d = mathutils.Vector((cx, cy, cz)) - key_ob.location
    key_ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def render_views() -> None:
    scene = bpy.context.scene
    scene.render.resolution_x = 640
    scene.render.resolution_y = 900
    scene.render.film_transparent = False
    world = scene.world or bpy.data.worlds.new("world")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.92, 0.93, 0.95, 1)
        bg.inputs[1].default_value = 1.0
    # EEVEE first (real materials); fall back to Workbench with MATERIAL colors.
    engine_set = False
    for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = eng
            engine_set = True
            break
        except Exception:  # noqa: BLE001
            continue
    if not engine_set:
        scene.render.engine = "BLENDER_WORKBENCH"
    if scene.render.engine == "BLENDER_WORKBENCH":
        scene.display.shading.light = "STUDIO"
        scene.display.shading.color_type = "MATERIAL"
    print("RENDER_ENGINE", scene.render.engine)
    RENDERS.mkdir(exist_ok=True)
    for ob in list(bpy.context.scene.objects):
        if ob.type == "CAMERA":
            scene.camera = ob
            name = ob.name.replace("cam_", "")
            scene.render.filepath = str(RENDERS / f"{name}.png")
            try:
                bpy.ops.render.render(write_still=True)
                RESULT["renders"].append(scene.render.filepath)
            except Exception as e:  # noqa: BLE001
                RESULT["errors"].append(f"render {name}: {e}")


def export() -> None:
    blend = ROOT / "model.blend"
    glb = ROOT / "model.glb"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend))
    RESULT["blend"] = str(blend)
    try:
        for ob in bpy.context.scene.objects:
            ob.select_set(ob.type == "MESH")
        bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True)
        RESULT["glb"] = str(glb)
    except Exception as e:  # noqa: BLE001
        RESULT["errors"].append(f"glb export: {e}")


def main() -> None:
    try:
        clear_scene()
        run_build()
        add_camera_rig()
        render_views()
        export()
        RESULT["ok"] = bool(RESULT["renders"]) and not any(
            e.startswith("render") for e in RESULT["errors"]
        )
    except Exception:  # noqa: BLE001
        RESULT["errors"].append(traceback.format_exc()[-1800:])
    (ROOT / "result.json").write_text(json.dumps(RESULT, indent=2), encoding="utf-8")
    print("PIPELINE_RESULT " + json.dumps(
        {"ok": RESULT["ok"], "n_renders": len(RESULT["renders"]), "errors": RESULT["errors"][:2]}
    ))


main()
