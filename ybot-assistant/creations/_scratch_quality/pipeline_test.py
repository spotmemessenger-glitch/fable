import math
from pathlib import Path
import bpy, mathutils

ROOT = Path(__file__).resolve().parent
REF_FACE = ROOT / "face-front-masked.png"


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def run_build():
    code = (ROOT / "build.py").read_text(encoding="utf-8")
    exec(compile(code, "build.py", "exec"), {"bpy": bpy, "math": math, "__name__": "__build__"})


def scene_bounds():
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


def add_camera_rig():
    lo, hi = scene_bounds()
    cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    cz = (lo[2] + hi[2]) / 2
    height = max(hi[2] - lo[2], 0.5)
    dist = max(height * 1.35, 1.2)
    views = {
        "front": (cx, cy - dist, cz),
        "head": (cx, cy - dist * 0.45, hi[2] - height * 0.10),
    }
    scene = bpy.context.scene
    cams = {}
    for name, loc in views.items():
        cam = bpy.data.cameras.new(f"cam_{name}")
        ob = bpy.data.objects.new(f"cam_{name}", cam)
        scene.collection.objects.link(ob)
        ob.location = loc
        target = mathutils.Vector((cx, cy, hi[2] - height * 0.10 if name == "head" else cz))
        d = target - ob.location
        ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        cam.lens = 60 if name == "head" else 42
        cams[name] = ob
    return cams, (cx, cy, cz, height)


def add_studio_lighting(center):
    cx, cy, cz, height = center
    scene = bpy.context.scene
    # KEY — warm-white, 45deg front-side, largest
    key = bpy.data.lights.new("key", type="AREA")
    key.energy = 550
    key.size = 2.2
    key.color = (1.0, 0.98, 0.94)
    key_ob = bpy.data.objects.new("key", key)
    scene.collection.objects.link(key_ob)
    key_ob.location = (cx - 1.6, cy - 2.2, cz + height * 0.55)
    d = mathutils.Vector((cx, cy, cz + height * 0.15)) - key_ob.location
    key_ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    # FILL — cool, opposite side, soft/weak (opens shadows without flattening)
    fill = bpy.data.lights.new("fill", type="AREA")
    fill.energy = 180
    fill.size = 3.0
    fill.color = (0.92, 0.95, 1.0)
    fill_ob = bpy.data.objects.new("fill", fill)
    scene.collection.objects.link(fill_ob)
    fill_ob.location = (cx + 2.0, cy - 1.4, cz + height * 0.35)
    d = mathutils.Vector((cx, cy, cz)) - fill_ob.location
    fill_ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    # RIM — behind, separates silhouette from background
    rim = bpy.data.lights.new("rim", type="AREA")
    rim.energy = 260
    rim.size = 1.5
    rim.color = (1.0, 1.0, 1.0)
    rim_ob = bpy.data.objects.new("rim", rim)
    scene.collection.objects.link(rim_ob)
    rim_ob.location = (cx + 0.3, cy + 2.3, cz + height * 0.75)
    d = mathutils.Vector((cx, cy, cz + height * 0.3)) - rim_ob.location
    rim_ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    # soft ambient sky so shadows are never pure black
    sun = bpy.data.lights.new("sky", type="SUN")
    sun.energy = 0.6
    sun.angle = math.radians(8)
    sun_ob = bpy.data.objects.new("sky", sun)
    scene.collection.objects.link(sun_ob)
    sun_ob.rotation_euler = (math.radians(60), 0, math.radians(20))


def make_face_ortho_camera(head_ob):
    """A dedicated orthographic camera sized exactly to the head's own bounding box
    and centered on it. Orthographic + exact-fit framing makes the projection
    deterministic (no perspective/FOV guesswork), so the photo lands aligned."""
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for corner in head_ob.bound_box:
        w = head_ob.matrix_world @ mathutils.Vector(corner)
        for i in range(3):
            lo[i] = min(lo[i], w[i])
            hi[i] = max(hi[i], w[i])
    cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    top_z = hi[2]
    face_h = hi[2] - lo[2]

    img = bpy.data.images.load(str(REF_FACE))
    img_w, img_h = img.size[0], img.size[1]
    img_aspect = img_w / img_h  # width/height

    cam = bpy.data.cameras.new("cam_faceproj")
    cam.type = "ORTHO"
    # frame the FULL image height against the head's height so top-of-crop -> crown,
    # bottom-of-crop -> chin (matches how man-front-head.png was cropped: hairline-to-neck)
    cam.ortho_scale = face_h
    ob = bpy.data.objects.new("cam_faceproj", cam)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = (cx, lo[1] - 0.6, top_z - face_h / 2)
    ob.rotation_euler = (math.radians(90), 0, 0)  # aim -Y (world convention used above)
    return ob, img, img_aspect


def project_face_photo(head):
    """Camera-project the real reference face photo onto the 'head' mesh's skin
    material, faded by facing angle so it reads as skin at grazing angles instead
    of stretching/smearing. This is what actually makes the front view resemble
    the person, instead of a flat generic skin tone."""
    if head is None or not REF_FACE.exists():
        return False
    cam_ob, img, img_aspect = make_face_ortho_camera(head)
    mod = head.modifiers.new("FaceProject", type="UV_PROJECT")
    uv = head.data.uv_layers.new(name="face_proj") if not head.data.uv_layers else head.data.uv_layers[0]
    mod.uv_layer = uv.name
    mod.projector_count = 1
    mod.projectors[0].object = cam_ob
    mod.aspect_x = 1.0
    mod.aspect_y = 1.0 / img_aspect if img_aspect else 1.0
    mat = head.data.materials[0] if head.data.materials else None
    if mat is None:
        return False
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if bsdf is None:
        return False
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.extension = "CLIP"  # outside the projected frame -> fully transparent, no wrap/tile
    uvmap = nt.nodes.new("ShaderNodeUVMap")
    uvmap.uv_map = uv.name
    nt.links.new(uvmap.outputs["UV"], tex.inputs["Vector"])

    # Falloff = (1-Fresnel) so it fades at grazing angles, MULTIPLIED by the photo's
    # own baked alpha (a soft oval mask) so background/edge pixels never paint onto
    # the geometry regardless of viewing angle — this is what kills the halo.
    fres = nt.nodes.new("ShaderNodeFresnel")
    fres.inputs["IOR"].default_value = 1.2
    invert = nt.nodes.new("ShaderNodeMath")
    invert.operation = "SUBTRACT"
    invert.inputs[0].default_value = 1.0
    nt.links.new(fres.outputs["Fac"], invert.inputs[1])
    combined = nt.nodes.new("ShaderNodeMath")
    combined.operation = "MULTIPLY"
    nt.links.new(invert.outputs["Value"], combined.inputs[0])
    nt.links.new(tex.outputs["Alpha"], combined.inputs[1])

    mix = nt.nodes.new("ShaderNodeMixRGB")
    mix.blend_type = "MIX"
    current_base = None
    for link in list(nt.links):
        if link.to_node == bsdf and link.to_socket.name == "Base Color":
            current_base = link.from_socket
            nt.links.remove(link)
    base_color_val = bsdf.inputs["Base Color"].default_value[:3]
    if current_base is None:
        rgb = nt.nodes.new("ShaderNodeRGB")
        rgb.outputs[0].default_value = (*base_color_val, 1.0)
        current_base = rgb.outputs[0]
    nt.links.new(current_base, mix.inputs["Color1"])
    nt.links.new(tex.outputs["Color"], mix.inputs["Color2"])
    nt.links.new(combined.outputs["Value"], mix.inputs["Fac"])
    nt.links.new(mix.outputs["Color"], bsdf.inputs["Base Color"])

    # the photo already shows real eyes — the separate modeled iris balls double up
    for nm in ("eye_L", "eye_R"):
        ob = bpy.data.objects.get(nm)
        if ob:
            ob.hide_render = True
    return True


def render_views():
    scene = bpy.context.scene
    scene.render.resolution_x = 800
    scene.render.resolution_y = 1100
    world = scene.world or bpy.data.worlds.new("world")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.90, 0.91, 0.93, 1)
        bg.inputs[1].default_value = 1.0
    for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = eng
            break
        except Exception:
            continue
    try:
        scene.eevee.use_raytracing = True
    except Exception:
        pass
    for attr, val in (("use_gtao", True), ("use_ssr", True)):
        try:
            setattr(scene.eevee, attr, val)
        except Exception:
            pass
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except Exception as e:
        print("colormgmt fail", e)
    (ROOT / "renders").mkdir(exist_ok=True)
    for ob in list(bpy.context.scene.objects):
        if ob.type == "CAMERA":
            scene.camera = ob
            name = ob.name.replace("cam_", "")
            scene.render.filepath = str(ROOT / "renders" / f"{name}.png")
            bpy.ops.render.render(write_still=True)
            print("rendered", name)


clear_scene()
run_build()
cams, center = add_camera_rig()
add_studio_lighting(center)
ok = project_face_photo(bpy.data.objects.get("head"))
print("face_projected:", ok)
render_views()
print("DONE")
