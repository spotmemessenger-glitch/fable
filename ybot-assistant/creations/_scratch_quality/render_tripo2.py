import math
from pathlib import Path
import bpy, mathutils

ROOT = Path(__file__).resolve().parent
OBJ = ROOT / "tripo_out_vc" / "0" / "mesh.obj"  # trimesh export: "v x y z r g b" per line

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.obj_import(filepath=str(OBJ))

mesh_obs = [o for o in bpy.context.scene.objects if o.type == "MESH"]

# wire the imported vertex-color attribute into Base Color (no external texture needed)
for ob in mesh_obs:
    me = ob.data
    if not me.color_attributes:
        continue
    attr_name = me.color_attributes[0].name
    mat = bpy.data.materials.new("tripo_vcol")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    vcol = nt.nodes.new("ShaderNodeVertexColor")
    vcol.layer_name = attr_name
    # TripoSR's per-vertex surface-point color query (used for the exportable mesh)
    # measurably under-saturates large flat regions vs its own volumetric renderer
    # (confirmed: mean torso linear color ~0.24 here vs near-black in the native
    # turntable render). Boost contrast/saturation to compensate so the Blender
    # viewport reads correctly instead of washed-out.
    hsv = nt.nodes.new("ShaderNodeHueSaturation")
    hsv.inputs["Saturation"].default_value = 1.6
    hsv.inputs["Value"].default_value = 0.75
    nt.links.new(vcol.outputs["Color"], hsv.inputs["Color"])
    gamma = nt.nodes.new("ShaderNodeGamma")
    gamma.inputs["Gamma"].default_value = 1.6  # darken midtones further
    nt.links.new(hsv.outputs["Color"], gamma.inputs["Color"])
    nt.links.new(gamma.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.85
    try:
        bsdf.inputs["Specular IOR Level"].default_value = 0.0
    except Exception:
        pass
    me.materials.clear()
    me.materials.append(mat)

# same X-up -> Z-up correction determined empirically, plus face-forward Z spin
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
    "back": (cx, cy + dist, cz),
    "side": (cx - dist, cy, cz),
    "threeq": (cx - dist * 0.7, cy - dist * 0.7, cz + height * 0.1),
    "head": (cx, cy - dist * 0.35, hi[2] - height * 0.12),
}
for name, loc in views.items():
    cam = bpy.data.cameras.new(f"cam_{name}")
    ob = bpy.data.objects.new(f"cam_{name}", cam)
    scene.collection.objects.link(ob)
    ob.location = loc
    target = mathutils.Vector((cx, cy, hi[2] - height * 0.12 if name == "head" else cz))
    d = target - ob.location
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    cam.lens = 65 if name == "head" else 45

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

(ROOT / "tripo_renders2").mkdir(exist_ok=True)
for name in views:
    scene.camera = bpy.data.objects[f"cam_{name}"]
    scene.render.filepath = str(ROOT / "tripo_renders2" / f"{name}.png")
    bpy.ops.render.render(write_still=True)
    print("rendered", name)

bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / "tripo_model_vcol.blend"))
print("DONE")
