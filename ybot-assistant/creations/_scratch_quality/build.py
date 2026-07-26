# build.py — stylized-realistic likeness, Indian male ~40s, stocky, 1.75 m (7.2 heads).
# Executed inside Blender by pipeline.py (bpy + math injected). Deterministic, headless-safe.
# v2: merged organic forms via metaballs (self-calibrated) converted to smooth meshes.
# Groups: head/body (skin), hair (swept-up pompadour), beard (jaw-wrapping mass), pants.
# Character faces -Y. His right side = world -X (watch on right wrist).
import bpy
import math
from mathutils import Vector

HU = 0.243  # head unit, chin-to-crown

# ---------------------------------------------------------------- materials
def _bsdf(m):
    return m.node_tree.nodes.get("Principled BSDF")


def set_in(node, value, *names):
    """Set first matching node input (defensive across Blender versions)."""
    for n in names:
        inp = node.inputs.get(n)
        if inp is None:
            continue
        try:
            inp.default_value = value
            return True
        except (TypeError, ValueError):
            continue
    return False


def basic_mat(name, color, rough=0.6, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = _bsdf(m)
    set_in(b, (*color, 1.0), "Base Color")
    set_in(b, rough, "Roughness")
    set_in(b, metal, "Metallic")
    return m


def skin_material():
    m = basic_mat("skin", (0.337, 0.166, 0.082), rough=0.55)
    b = _bsdf(m)
    set_in(b, 0.10, "Subsurface Weight", "Subsurface")
    set_in(b, (1.0, 0.45, 0.25), "Subsurface Radius")
    set_in(b, 0.05, "Subsurface Scale")
    return m


def strand_mat(name, base, grey, threshold, rough):
    """Near-black hair with procedural salt-and-pepper grey speckle (deterministic)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = _bsdf(m)
    set_in(b, rough, "Roughness")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    set_in(noise, 80.0, "Scale")
    set_in(noise, 8.0, "Detail")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "CONSTANT"
    e0, e1 = ramp.color_ramp.elements[0], ramp.color_ramp.elements[1]
    e0.position = 0.0
    e0.color = (*base, 1.0)
    e1.position = threshold
    e1.color = (*grey, 1.0)
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    return m


HAIR_BASE = (0.013, 0.010, 0.008)
GREY = (0.35, 0.35, 0.36)
SKIN = skin_material()
HAIR = strand_mat("hair", HAIR_BASE, GREY, 0.64, 0.50)
BEARD = strand_mat("beard", HAIR_BASE, GREY, 0.70, 0.52)
BROW = basic_mat("brow", HAIR_BASE, rough=0.50)
IRIS = basic_mat("iris", (0.040, 0.018, 0.010), rough=0.35)
LIPM = basic_mat("lip", (0.310, 0.120, 0.085), rough=0.50)
AREOLA = basic_mat("areola", (0.130, 0.055, 0.035), rough=0.55)
PANTS = basic_mat("pants", (0.018, 0.018, 0.019), rough=0.85)
SILVER = basic_mat("silver", (0.860, 0.870, 0.880), rough=0.22, metal=1.0)
STRAP = basic_mat("strap", (0.010, 0.010, 0.011), rough=0.60)
GLASS = basic_mat("glass", (0.005, 0.005, 0.006), rough=0.05)

# ---------------------------------------------------------------- metaball infra
def new_mball(name, res):
    md = bpy.data.metaballs.new(name)
    md.resolution = res
    md.render_resolution = res
    md.threshold = 0.6
    ob = bpy.data.objects.new(name, md)
    bpy.context.scene.collection.objects.link(ob)
    return md, ob


def _eval_mesh(ob):
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    return bpy.data.meshes.new_from_object(ob.evaluated_get(deps))


def _calibrate():
    """Measure visible-surface factor of a unit metaball / ellipsoid (version-proof)."""
    md, ob = new_mball("calibB", 0.02)
    e = md.elements.new(type="BALL")
    e.co = (0.0, 0.0, 0.0)
    e.radius = 1.0
    me = _eval_mesh(ob)
    kb = max(abs(v.co.x) for v in me.vertices)
    bpy.data.meshes.remove(me)
    bpy.data.objects.remove(ob)
    bpy.data.metaballs.remove(md)

    md, ob = new_mball("calibE", 0.02)
    e = md.elements.new(type="ELLIPSOID")
    e.co = (0.0, 0.0, 0.0)
    e.radius = 1.0
    e.size_x, e.size_y, e.size_z = 1.0, 0.6, 0.3
    me = _eval_mesh(ob)
    kx = max(abs(v.co.x) for v in me.vertices) / 1.0
    ky = max(abs(v.co.y) for v in me.vertices) / 0.6
    kz = max(abs(v.co.z) for v in me.vertices) / 0.3
    bpy.data.meshes.remove(me)
    bpy.data.objects.remove(ob)
    bpy.data.metaballs.remove(md)
    return kb, kx, ky, kz


KB, KEX, KEY, KEZ = _calibrate()


def ball(md, co, r):
    e = md.elements.new(type="BALL")
    e.co = co
    e.radius = r / KB
    return e


def ell(md, co, rx, ry, rz):
    """Ellipsoid element with desired visible semi-axes rx/ry/rz."""
    e = md.elements.new(type="ELLIPSOID")
    e.co = co
    big = max(rx / KEX, ry / KEY, rz / KEZ)
    e.radius = big
    e.size_x = rx / (KEX * big)
    e.size_y = ry / (KEY * big)
    e.size_z = rz / (KEZ * big)
    return e


def chain(md, p0, p1, r0, r1, n=5):
    """Tapered capsule as a run of blended balls."""
    for i in range(n):
        t = i / (n - 1)
        co = tuple(a + (b - a) * t for a, b in zip(p0, p1))
        ball(md, co, r0 + (r1 - r0) * t)


def mball_mesh(name, res, material, fill):
    md, ob = new_mball(name + "_mb", res)
    fill(md)
    me = _eval_mesh(ob)
    me.name = name
    bpy.data.objects.remove(ob)
    bpy.data.metaballs.remove(md)
    out = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(out)
    me.materials.append(material)
    for p in me.polygons:
        p.use_smooth = True
    return out


# ---------------------------------------------------------------- mass groups
def head_fill(md):
    ell(md, (0, 0.005, 1.640), 0.083, 0.098, 0.105)   # cranium (width 0.70 HU)
    ell(md, (0, -0.045, 1.625), 0.070, 0.055, 0.080)  # forehead / face plane
    ell(md, (0, -0.025, 1.545), 0.068, 0.075, 0.055)  # jaw block
    ball(md, (0, -0.078, 1.522), 0.028)               # bony chin
    for s in (-1, 1):
        ball(md, (s * 0.048, -0.058, 1.585), 0.032)   # fleshy cheeks
        ball(md, (s * 0.013, -0.104, 1.566), 0.009)   # nostril flare
        ell(md, (s * 0.087, 0.012, 1.615), 0.010, 0.028, 0.038)  # ears (exposed)
    ell(md, (0, -0.092, 1.638), 0.052, 0.020, 0.016)  # supraorbital brow shelf
    ell(md, (0, -0.112, 1.588), 0.020, 0.026, 0.032)  # nose wedge
    ell(md, (0, 0.015, 1.475), 0.064, 0.068, 0.055)   # neck top (thick)


def body_fill(md):
    ell(md, (0, 0.020, 1.435), 0.068, 0.072, 0.055)   # neck column ~0.55 HU dia
    ell(md, (0, 0.030, 1.420), 0.115, 0.080, 0.045)   # traps flow, no notch
    ell(md, (0, 0.005, 1.290), 0.160, 0.110, 0.150)   # barrel ribcage
    ell(md, (0, 0.060, 1.280), 0.145, 0.070, 0.140)   # broad slab back
    ell(md, (0, -0.010, 1.180), 0.155, 0.115, 0.100)  # midsection
    ell(md, (0, -0.060, 1.075), 0.165, 0.125, 0.115)  # belly dome (forward-most)
    ell(md, (0, 0.045, 1.100), 0.140, 0.080, 0.090)   # lower back
    for s in (-1, 1):
        ell(md, (s * 0.068, -0.095, 1.315), 0.068, 0.048, 0.058)  # pec
        ball(md, (s * 0.072, -0.098, 1.282), 0.040)               # soft pec droop
        ball(md, (s * 0.198, 0.005, 1.425), 0.052)                # round deltoid
        ell(md, (s * 0.130, 0.010, 1.400), 0.075, 0.085, 0.075)   # shoulder fill
        ball(md, (s * 0.150, 0.015, 1.030), 0.040)                # love handle
        # arm: A-pose ~15 deg out, mild bow; thick upper arm, ordinary wrist
        chain(md, (s * 0.200, 0.005, 1.410), (s * 0.278, 0.000, 1.120), 0.052, 0.044, 5)
        ball(md, (s * 0.278, 0.000, 1.120), 0.043)                # elbow
        chain(md, (s * 0.278, -0.002, 1.120), (s * 0.315, -0.015, 0.845), 0.040, 0.025, 5)
        ell(md, (s * 0.325, -0.030, 0.785), 0.030, 0.045, 0.062)  # hand
        ell(md, (s * 0.100, -0.048, 0.034), 0.048, 0.105, 0.034)  # foot


def hair_fill(md):
    ell(md, (0, -0.048, 1.770), 0.075, 0.055, 0.055)  # front lift (swept up ~7 cm)
    ell(md, (0, 0.015, 1.735), 0.100, 0.115, 0.075)   # main dome, wider than face
    for s in (-1, 1):
        ball(md, (s * 0.075, 0.015, 1.700), 0.045)    # side puff above ear line
    ell(md, (0, 0.085, 1.680), 0.075, 0.055, 0.085)   # back bell
    ball(md, (0, 0.100, 1.600), 0.034)                # nape taper
    # choppy crown clumps, swept back and slightly to his left (+X)
    ball(md, (0.025, -0.010, 1.800), 0.036)
    ball(md, (-0.020, 0.035, 1.795), 0.036)
    ball(md, (0.015, 0.075, 1.770), 0.034)
    ball(md, (-0.045, -0.030, 1.780), 0.032)


def beard_fill(md):
    for s in (-1, 1):
        ell(md, (s * 0.082, -0.005, 1.600), 0.016, 0.036, 0.050)  # sideburn to hair
        ball(md, (s * 0.070, -0.055, 1.560), 0.032)               # cheek beard
        ell(md, (s * 0.058, -0.075, 1.522), 0.034, 0.045, 0.045)  # jawline mass
        ball(md, (s * 0.032, -0.096, 1.545), 0.013)               # mouth-corner bridge
    ell(md, (0, -0.088, 1.492), 0.050, 0.052, 0.046)  # boxy chin mass, projects fwd
    ell(md, (0, -0.040, 1.470), 0.055, 0.058, 0.038)  # under-jaw / upper neck
    ell(md, (0, -0.105, 1.558), 0.032, 0.018, 0.012)  # full connected mustache


def pants_fill(md):
    ell(md, (0, -0.020, 1.010), 0.175, 0.130, 0.048)  # waistband roll below navel
    ell(md, (0, 0.005, 0.940), 0.185, 0.135, 0.105)   # hips ~1.55 HU wide
    ball(md, (0, -0.005, 0.845), 0.058)               # crotch fill
    for s in (-1, 1):
        ball(md, (s * 0.075, 0.095, 0.900), 0.062)    # glutes
        chain(md, (s * 0.092, -0.005, 0.880), (s * 0.102, -0.010, 0.520), 0.070, 0.052, 6)
        ball(md, (s * 0.103, -0.012, 0.500), 0.048)   # knee
        chain(md, (s * 0.104, 0.000, 0.460), (s * 0.104, 0.008, 0.150), 0.047, 0.029, 6)
        ball(md, (s * 0.106, 0.020, 0.400), 0.044)    # calf bulge
        ell(md, (s * 0.104, 0.002, 0.110), 0.033, 0.035, 0.038)  # tapered ankle cuff


mball_mesh("head", 0.010, SKIN, head_fill)
mball_mesh("body", 0.020, SKIN, body_fill)
mball_mesh("hair", 0.013, HAIR, hair_fill)
mball_mesh("beard", 0.010, BEARD, beard_fill)
mball_mesh("pants", 0.020, PANTS, pants_fill)


# ---------------------------------------------------------------- detail meshes
def tag(name, material, scale=None, rot=None):
    ob = bpy.context.active_object
    ob.name = name
    if scale:
        ob.scale = scale
    if rot:
        ob.rotation_euler = rot
    ob.data.materials.append(material)
    for p in ob.data.polygons:
        p.use_smooth = True
    return ob


for s, side in ((-1, "R"), (1, "L")):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.0115, segments=20, ring_count=12,
                                         location=(s * 0.033, -0.094, 1.618))
    tag(f"eye_{side}", IRIS)  # deep-set dark eyes under the brow shelf
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=20, ring_count=12,
                                         location=(s * 0.036, -0.110, 1.643))
    tag(f"brow_{side}", BROW, scale=(0.030, 0.009, 0.007), rot=(0, s * 0.10, 0))
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=16, ring_count=8,
                                         location=(s * 0.098, -0.135, 1.288))
    tag(f"areola_{side}", AREOLA, scale=(0.011, 0.0045, 0.011))

bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=16, ring_count=8,
                                     location=(0, -0.113, 1.548))
tag("lip", LIPM, scale=(0.021, 0.0065, 0.0055))  # exposed lower lip in the beard

# silver chain resting at clavicles / upper chest
bpy.ops.mesh.primitive_torus_add(major_radius=0.095, minor_radius=0.0065,
                                 major_segments=72, minor_segments=12,
                                 location=(0, -0.005, 1.400))
tag("chain", SILVER, scale=(1.0, 1.4, 1.0), rot=(math.radians(25), 0, 0))

# black sport watch, RIGHT wrist (-X side)
WROT = (0.055, -0.134, 0.0)  # match forearm tilt
bpy.ops.mesh.primitive_cylinder_add(radius=0.030, depth=0.026, vertices=24,
                                    location=(-0.318, -0.016, 0.850))
tag("watch_band", STRAP, rot=WROT)
bpy.ops.mesh.primitive_cylinder_add(radius=0.016, depth=0.008, vertices=24,
                                    location=(-0.349, -0.016, 0.850))
tag("watch_case", basic_mat("case", (0.010, 0.010, 0.011), rough=0.30),
    rot=(0, math.radians(90), 0))
bpy.ops.mesh.primitive_cylinder_add(radius=0.0135, depth=0.003, vertices=24,
                                    location=(-0.3545, -0.016, 0.850))
tag("watch_glass", GLASS, rot=(0, math.radians(90), 0))

# jogger drawstrings at the waistband
for s in (-1, 1):
    bpy.ops.mesh.primitive_cylinder_add(radius=0.004, depth=0.070, vertices=10,
                                        location=(s * 0.020, -0.148, 0.972))
    tag(f"drawstring_{'L' if s > 0 else 'R'}", PANTS, rot=(0.08, 0, 0))


# ---------------------------------------------------------------- normalize height
def normalize():
    """Skull crown (no hair) to exactly 1.75 m, lowest point to z=0."""
    bpy.context.view_layer.update()
    head = bpy.data.objects["head"]
    top = max((head.matrix_world @ Vector(c)).z for c in head.bound_box)
    s = 1.75 / top
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    for o in meshes:
        o.location = tuple(c * s for c in o.location)
        o.scale = tuple(c * s for c in o.scale)
    bpy.context.view_layer.update()
    zmin = min((o.matrix_world @ Vector(c)).z
               for o in (bpy.data.objects["body"], bpy.data.objects["pants"])
               for c in o.bound_box)
    for o in meshes:
        o.location.z -= zmin
    bpy.context.view_layer.update()


normalize()
print("BUILD_OK objects=%d calib=%.3f/%.3f,%.3f,%.3f"
      % (len(bpy.context.scene.objects), KB, KEX, KEY, KEZ))
