import math
from pathlib import Path
import bpy, mathutils

ROOT = Path(__file__).resolve().parent
# TripoSR's --bake-texture path uses xatlas.export(), which always writes plain OBJ
# text regardless of the requested extension — "mesh.glb" here is genuinely OBJ data.
# Copy it to a real .obj path so Blender's importer recognizes the format, and there's
# no accompanying .mtl, so we wire the baked texture.png to it manually below.
SRC = ROOT / "tripo_out_best" / "0" / "mesh.glb"
OBJ = ROOT / "tripo_out_best" / "0" / "mesh_real.obj"
OBJ.write_bytes(SRC.read_bytes())
TEXTURE = ROOT / "tripo_out_best" / "0" / "texture.png"

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.obj_import(filepath=str(OBJ))

mesh_obs = [o for o in bpy.context.scene.objects if o.type == "MESH"]

# wire the baked texture onto the imported mesh (no .mtl was written alongside it)
if TEXTURE.exists() and mesh_obs:
    img = bpy.data.images.load(str(TEXTURE))
    mat = bpy.data.materials.new("tripo_baked")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    for ob in mesh_obs:
        ob.data.materials.clear()
        ob.data.materials.append(mat)

# orient: measured raw bounds show X is the "height" axis here (extent ~1.0 vs
# ~0.24-0.29 for Y/Z) -- this export uses X-up, not the glTF-typical Y-up. Rotate
# -90deg about Y to bring X-up into Blender's Z-up while preserving foot->head order.
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
try:
    bsdf.inputs["Roughness"].default_value = 0.9
    bsdf.inputs["Specular IOR Level"].default_value = 0.0
except Exception:
    pass

(ROOT / "tripo_renders").mkdir(exist_ok=True)
for name in views:
    scene.camera = bpy.data.objects[f"cam_{name}"]
    scene.render.filepath = str(ROOT / "tripo_renders" / f"{name}.png")
    bpy.ops.render.render(write_still=True)
    print("rendered", name)

# save a .blend for the live viewer / further editing
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / "tripo_model.blend"))
print("DONE")
