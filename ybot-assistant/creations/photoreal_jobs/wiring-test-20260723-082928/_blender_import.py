
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
