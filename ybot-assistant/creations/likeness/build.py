# build.py — stylized-realistic likeness, Indian male ~40s, stocky, 1.75 m (~7.5 heads).
# Executed inside Blender by pipeline.py (bpy + math injected). Deterministic, headless-safe.
# v5: round-4 critique applied — shoulders widened x1.35 with delt caps r=0.07 at +/-0.21,
# thick arms (upper 0.055 / forearm 0.045) hanging beside+in front of torso, +15% length,
# belly flattened (y x0.55, z x0.8), pecs high/wide/flat (+0.04 z, z x0.6, x x1.3),
# hips narrowed x0.85, legs tapered 0.09->0.065->0.07->0.04 on a +/-0.10 stance,
# long flat feet, head moved back 0.03 with thick neck, skull wider (x1.12, z0.95),
# hair compressed (z0.55, x1.15) swept up-and-BACK with occiput/nape coverage,
# near-black NON-metallic hair/beard (metallic 0, rough 0.6/0.65), full connected
# beard to cheekbones with flat underside + visible mouth, separate straight brows,
# broad nose + bridge, protruding ears, deep tan skin (0.148,0.055,0.022 linear),
# black pants, chain raised to neck base, sun key at 45deg + rim, grey 0.55 world.
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


def basic_mat(name, color, rough=0.6, metal=0.0, spec=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = _bsdf(m)
    set_in(b, (*color, 1.0), "Base Color")
    set_in(b, rough, "Roughness")
    set_in(b, metal, "Metallic")
    if spec is not None:
        set_in(b, spec, "Specular IOR Level", "Specular")
    return m


def skin_material(name, color, rough):
    """Deep warm tan skin: spec 0.30, warm subsurface so shadows go brown not pink."""
    m = basic_mat(name, color, rough=rough)
    b = _bsdf(m)
    set_in(b, 0.30, "Specular IOR Level", "Specular")
    set_in(b, 0.0, "Metallic")
    set_in(b, 0.08, "Subsurface Weight", "Subsurface")
    set_in(b, (0.9, 0.35, 0.18), "Subsurface Radius")
    set_in(b, 0.05, "Subsurface Scale")
    return m


def strand_mat(name, base, grey, threshold, rough):
    """Near-black NON-metallic hair with sparse silver speckle (deterministic)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = _bsdf(m)
    set_in(b, rough, "Roughness")
    set_in(b, 0.0, "Metallic")
    set_in(b, 0.25, "Specular IOR Level", "Specular")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    set_in(noise, 150.0, "Scale")
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


GREY = (0.30, 0.30, 0.32)                # sparse silver strand fleck (salt & pepper)
# deep warm tan South-Asian skin, linear approx of sRGB (0.42,0.26,0.16)
SKIN_HEAD = skin_material("skin_head", (0.148, 0.055, 0.022), rough=0.45)
SKIN_BODY = skin_material("skin_body", (0.140, 0.052, 0.021), rough=0.55)
# near-black hair, matte; beard a hair darker-warm than scalp hair
HAIR = strand_mat("hair", (0.035, 0.030, 0.028), GREY, 0.96, 0.60)
BEARD = strand_mat("beard", (0.045, 0.038, 0.032), GREY, 0.96, 0.65)
BROW = basic_mat("brow", (0.05, 0.05, 0.05), rough=0.65)
IRIS = basic_mat("iris", (0.09, 0.05, 0.03), rough=0.35)   # near-black brown
SCLERA = basic_mat("sclera", (0.85, 0.83, 0.80), rough=0.30)
LIPM = basic_mat("lip", (0.30, 0.16, 0.13), rough=0.55)
AREOLA = basic_mat("areola", (0.28, 0.16, 0.11), rough=0.50)
PANTS = basic_mat("pants", (0.030, 0.030, 0.033), rough=0.75, spec=0.2)  # soft black cotton
DRAWSTRING = basic_mat("drawstring", (0.06, 0.06, 0.062), rough=0.90)
SILVER = basic_mat("silver", (0.85, 0.87, 0.90), rough=0.15, metal=1.0)
STRAP = basic_mat("strap", (0.02, 0.02, 0.02), rough=0.70)  # matte black watch band
GLASS = basic_mat("glass", (0.005, 0.005, 0.006), rough=0.10)

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


def chain(md, p0, p1, r0, r1, n=0):
    """Tapered capsule as a run of densely overlapped balls (spacing < 0.4*r)."""
    dist = math.sqrt(sum((b - a) ** 2 for a, b in zip(p0, p1)))
    if n <= 0:
        n = max(6, int(dist / (0.35 * min(r0, r1))) + 1)
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


# ---------------------------------------------------------------- head transform
# Critique r4: skull wider (x1.12) and less stretched (z0.95); head moved BACK
# 0.03 so the ear sits over the shoulder (was thrust forward). Pivot at chin.
HEAD_SX, HEAD_SY, HEAD_SZ = 1.004, 0.996, 1.022
HEAD_DY, HEAD_DZ = 0.05, -0.01
HPZ = 1.52  # pivot z (chin level)


def hco(x, y, z):
    """Head-space coordinate → world, applying head scale/shift about the pivot."""
    return (x * HEAD_SX, y * HEAD_SY + HEAD_DY, HPZ + (z - HPZ) * HEAD_SZ + HEAD_DZ)


def hr3(rx, ry, rz):
    return (rx * HEAD_SX, ry * HEAD_SY, rz * HEAD_SZ)


def hr(r):
    return r * (HEAD_SX + HEAD_SY + HEAD_SZ) / 3.0


# ---------------------------------------------------------------- mass groups
def head_fill(md):
    # broad round skull (wider x, less egg)
    ell(md, hco(0, 0.005, 1.640), *hr3(0.0896, 0.098, 0.0998))
    ell(md, hco(0, -0.045, 1.625), *hr3(0.070, 0.055, 0.080))  # forehead / face plane
    ell(md, hco(0, -0.025, 1.545), *hr3(0.068, 0.075, 0.055))  # jaw block
    ball(md, hco(0, -0.078, 1.522), hr(0.028))                 # bony chin
    for s in (-1, 1):
        ball(md, hco(s * 0.052, -0.055, 1.575), hr(0.038))     # full cheeks, jaw level
    # supraorbital brow shelf
    ell(md, hco(0, -0.092, 1.638), *hr3(0.052, 0.020, 0.016))
    # nose: broad base (x1.6), more projection (y1.2), base lowered
    ell(md, hco(0, -0.104, 1.585), *hr3(0.033, 0.020, 0.020))
    # nose bridge continuity up to the brow (no button-sphere read)
    ell(md, hco(0, -0.096, 1.612), *hr3(0.013, 0.013, 0.026))
    # short thick neck top — thick trapezius-to-neck transition
    ell(md, hco(0, 0.015, 1.480), *hr3(0.100, 0.105, 0.058))


def body_fill(md):
    # neck column: short and THICK (r x1.2 again per r4 back-view critique)
    ell(md, (0, 0.020, 1.450), 0.114, 0.120, 0.052)
    # traps: wider, sloping into the delts
    ell(md, (0, 0.030, 1.425), 0.120, 0.085, 0.055)
    # ribcage widened toward x1.35 at clavicle/deltoid height
    ell(md, (0, 0.010, 1.360), 0.200, 0.095, 0.070)   # clavicle-level slab
    ell(md, (0, 0.010, 1.290), 0.185, 0.110, 0.150)   # ribcage
    ell(md, (0, 0.048, 1.280), 0.165, 0.070, 0.140)   # slab back
    ell(md, (0, -0.010, 1.180), 0.155, 0.095, 0.100)  # midsection (straighter side)
    # belly: forward protrusion x0.55, height x0.8 — mild paunch only
    ell(md, (0, -0.048, 1.165), 0.185, 0.041, 0.088)
    ell(md, (0, 0.038, 1.100), 0.140, 0.070, 0.090)   # lower back
    for s in (-1, 1):
        # pecs: high, wide, FLAT slabs blending into the shoulder line
        ell(md, (s * 0.099, -0.112, 1.370), 0.088, 0.050, 0.035)
        # shoulders: clear deltoid caps r=0.07 at +/-0.21 (shoulder ~1.55x hip)
        ball(md, (s * 0.210, 0.005, 1.390), 0.070)                # deltoid cap
        ell(md, (s * 0.148, 0.010, 1.375), 0.085, 0.085, 0.068)   # shoulder fill
        ell(md, (s * 0.180, 0.005, 1.385), 0.060, 0.060, 0.055)   # delt-chest bridge
        ball(md, (s * 0.130, 0.015, 1.030), 0.036)                # love handle
        # arms: THICK (upper r 0.055 -> forearm 0.045), +15% length, hanging
        # beside and slightly in front of the torso silhouette
        chain(md, (s * 0.215, 0.010, 1.380), (s * 0.230, 0.000, 1.090), 0.055, 0.046)
        ball(md, (s * 0.230, 0.000, 1.090), 0.046)                # elbow
        chain(md, (s * 0.230, 0.000, 1.090), (s * 0.238, -0.005, 0.845), 0.045, 0.032)
        ball(md, (s * 0.238, -0.005, 0.840), 0.032)               # wrist at upper-mid thigh
        # hands: long and flat — fingertips reach mid-thigh
        ell(md, (s * 0.240, -0.010, 0.760), 0.032, 0.030, 0.075)
        ball(md, (s * 0.100, 0.005, 0.090), 0.040)                # ankle r=0.04
        # feet: long (fwd) and wide on a +/-0.10 stance; no under-foot disc
        ell(md, (s * 0.100, -0.070, 0.045), 0.060, 0.135, 0.040)
        ball(md, (s * 0.102, -0.185, 0.035), 0.030)               # toe box


HAIRP = 1.665  # scalp pivot for the compressed pompadour


def hairco(x, y, z):
    """Hair-space: widen x1.15, compress z0.55 above scalp, shear top BACKWARD
    (~12 deg) and shift the whole mass +0.03 back — swept up-and-back."""
    z2 = HAIRP + (z - HAIRP) * 0.55 if z > HAIRP else z
    y2 = y + 0.03 + max(0.0, z2 - HAIRP) * 0.21
    return hco(x * 1.15, y2, z2)


def hair_fill(md):
    # broad low brushed-up mass, not a cone; follows skull curvature
    ell(md, hairco(0, 0.045, 1.760), *hr3(0.088, 0.110, 0.075))  # main dome
    ell(md, hairco(0, -0.012, 1.780), *hr3(0.070, 0.058, 0.055))  # front lift, swept back
    # lowered front hairline fringe across the forehead
    ell(md, hairco(0, -0.048, 1.688), *hr3(0.062, 0.026, 0.022))
    for s in (-1, 1):
        ball(md, hairco(s * 0.074, 0.025, 1.690), hr(0.040))     # side puff / temple
        ell(md, hairco(s * 0.070, 0.030, 1.655), *hr3(0.032, 0.045, 0.040))
        ell(md, hairco(s * 0.063, 0.032, 1.618), *hr3(0.023, 0.040, 0.030))
    ell(md, hairco(0, 0.085, 1.690), *hr3(0.064, 0.052, 0.058))  # back bell
    # rear coverage down the occiput to the nape (~0.05 below ear line)
    ell(md, hco(0, 0.100, 1.610), *hr3(0.062, 0.040, 0.045))
    ell(md, hco(0, 0.092, 1.575), *hr3(0.048, 0.030, 0.028))
    # choppy crown clumps, swept back
    ball(md, hairco(0.021, 0.010, 1.800), hr(0.027))
    ball(md, hairco(-0.017, 0.050, 1.798), hr(0.027))
    ball(md, hairco(0.013, 0.090, 1.778), hr(0.025))
    ball(md, hairco(-0.036, -0.012, 1.785), hr(0.024))


def beard_fill(md):
    # full connected beard: sideburns in front of the ears down the cheeks to a
    # fuller, slightly squared chin mass with a flat underside; mouth left open.
    for s in (-1, 1):
        # sideburn strip from hairline down, merging hair and beard
        ell(md, hco(s * 0.092, 0.008, 1.612), *hr3(0.018, 0.040, 0.055))
        # cheek beard up to cheekbone level (x1.35 wider than r3)
        ell(md, hco(s * 0.080, -0.040, 1.598), *hr3(0.026, 0.040, 0.048))
        ell(md, hco(s * 0.062, -0.065, 1.528), *hr3(0.036, 0.050, 0.042))  # jawline
        ball(md, hco(s * 0.044, -0.086, 1.532), hr(0.014))       # mouth-corner link
    # chin mass: fuller, lower (z x1.2), flat underside → rounded-trapezoid
    ell(md, hco(0, -0.078, 1.492), *hr3(0.052, 0.055, 0.046))
    ell(md, hco(0, -0.060, 1.470), *hr3(0.048, 0.050, 0.020))    # flat bottom
    ell(md, hco(0, -0.025, 1.488), *hr3(0.054, 0.062, 0.030))    # under-jaw
    # mustache: THIN, above the lip line — mouth stays visible below it
    ell(md, hco(0, -0.102, 1.560), *hr3(0.036, 0.016, 0.010))


def pants_fill(md):
    # hips narrowed x0.85 — shoulders stay clearly wider than hips
    ell(md, (0, -0.025, 1.010), 0.141, 0.128, 0.048)  # waistband roll below navel
    ell(md, (0, -0.005, 0.940), 0.150, 0.132, 0.105)  # hips
    ball(md, (0, -0.010, 0.845), 0.058)               # crotch fill
    for s in (-1, 1):
        ball(md, (s * 0.064, 0.064, 0.885), 0.052)    # glutes
        # legs: clear thigh->knee->calf->ankle taper on a +/-0.10 stance
        chain(md, (s * 0.088, -0.005, 0.880), (s * 0.105, -0.010, 0.520), 0.090, 0.065)
        ball(md, (s * 0.105, -0.012, 0.500), 0.065)   # knee
        chain(md, (s * 0.105, 0.000, 0.460), (s * 0.100, 0.005, 0.130), 0.070, 0.040)
        ball(md, (s * 0.108, 0.018, 0.400), 0.068)    # calf bulge
        ell(md, (s * 0.100, 0.002, 0.105), 0.042, 0.046, 0.048)  # ankle cuff


mball_mesh("head", 0.010, SKIN_HEAD, head_fill)
mball_mesh("body", 0.020, SKIN_BODY, body_fill)
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
    # eyeball: warm off-white sclera with a near-black-brown iris cap in front
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.011, segments=20, ring_count=12,
                                         location=hco(s * 0.033, -0.101, 1.620))
    tag(f"eye_{side}", SCLERA)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.0055, segments=16, ring_count=10,
                                         location=hco(s * 0.033, -0.1095, 1.620))
    tag(f"iris_{side}", IRIS)
    # brows: two SEPARATE straight-ish bars, slight inward-down furrow tilt (~8 deg)
    bx, by, bz = hco(s * 0.033, -0.106, 1.641)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=20, ring_count=12,
                                         location=(bx, by, bz - 0.012))
    tag(f"brow_{side}", BROW, scale=(0.018, 0.007, 0.006),
        rot=(0, -s * math.radians(8), 0))
    # ears: clearly protruding at eye-line height, visible from the front
    ex, ey, ez = hco(s * 0.100, 0.012, 1.618)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=16, ring_count=10,
                                         location=(ex, ey, ez))
    tag(f"ear_{side}", SKIN_HEAD, scale=(0.012, 0.026, 0.030))
    # areola discs on the lifted pecs
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=16, ring_count=8,
                                         location=(s * 0.115, -0.152, 1.358))
    tag(f"areola_{side}", AREOLA, scale=(0.011, 0.0045, 0.011))

# lower lip: visible in the mouth opening between mustache and chin beard
bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=16, ring_count=8,
                                     location=hco(0, -0.108, 1.545))
tag("lip", LIPM, scale=(0.016, 0.005, 0.005))

# thin silver chain resting at the base of the neck / collarbones
bpy.ops.mesh.primitive_torus_add(major_radius=0.095, minor_radius=0.007,
                                 major_segments=72, minor_segments=12,
                                 location=(0, -0.028, 1.445))
tag("chain", SILVER, scale=(1.0, 1.30, 1.0), rot=(math.radians(35), 0, 0))

# black smartwatch, RIGHT wrist (-X side); matte band + small metallic case
WROT = (0.04, -0.02, 0.0)
bpy.ops.mesh.primitive_cylinder_add(radius=0.037, depth=0.022, vertices=24,
                                    location=(-0.238, -0.005, 0.862))
tag("watch_band", STRAP, rot=WROT)
bpy.ops.mesh.primitive_cylinder_add(radius=0.015, depth=0.008, vertices=24,
                                    location=(-0.276, -0.005, 0.862))
tag("watch_case", basic_mat("case", (0.05, 0.05, 0.055), rough=0.20, metal=1.0),
    rot=(0, math.radians(90), 0))
bpy.ops.mesh.primitive_cylinder_add(radius=0.0125, depth=0.003, vertices=24,
                                    location=(-0.2815, -0.005, 0.862))
tag("watch_glass", GLASS, rot=(0, math.radians(90), 0))

# jogger drawstrings at the waistband
for s in (-1, 1):
    bpy.ops.mesh.primitive_cylinder_add(radius=0.004, depth=0.070, vertices=10,
                                        location=(s * 0.020, -0.148, 0.972))
    tag(f"drawstring_{'L' if s > 0 else 'R'}", DRAWSTRING, rot=(0.08, 0, 0))


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


# ---------------------------------------------------------------- lighting
# Critique r4: sun key at ~45 deg strength 3.5 (warm ~5500K), rim ~1.0 from
# back-left so black hair/beard/pants separate, modest fill, grey 0.55 world.
def _aim(ob, target):
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def _sun(name, energy, loc, target, color):
    li = bpy.data.lights.new(name, type="SUN")
    li.energy = energy
    li.color = color
    li.angle = math.radians(3.0)
    ob = bpy.data.objects.new(name, li)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    _aim(ob, target)
    return ob


def _area(name, energy, size, loc, target, color=None):
    li = bpy.data.lights.new(name, type="AREA")
    li.energy = energy
    li.size = size
    if color is not None:
        li.color = color
    ob = bpy.data.objects.new(name, li)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    _aim(ob, target)
    return ob


def add_lights():
    # key sun 45 deg front-left, ~5500K warm white
    _sun("build_key", 3.5, (-2.0, -2.0, 2.9), (0.0, 0.0, 1.1), (1.0, 0.945, 0.878))
    _area("build_fill", 250.0, 3.0, (2.0, -1.6, 1.3), (0.0, 0.0, 1.1))
    _sun("build_rim", 1.0, (-1.7, 2.2, 2.6), (0.0, 0.0, 1.3), (0.9, 0.95, 1.0))


add_lights()

# grey studio backdrop so the darkened skin/hair read against a mid background
try:
    w = bpy.context.scene.world
    if w is None:
        w = bpy.data.worlds.new("World")
        bpy.context.scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes.get("Background")
    if bg is not None:
        set_in(bg, (0.55, 0.55, 0.55, 1.0), "Color")
        set_in(bg, 1.0, "Strength")
except Exception as exc:
    print("WORLD_SKIP:", exc)

# slightly higher contrast so darkened materials keep shadow detail
try:
    vs = bpy.context.scene.view_settings
    for look in ("AgX - Medium High Contrast", "Medium High Contrast",
                 "Filmic - Medium High Contrast"):
        try:
            vs.look = look
            break
        except TypeError:
            continue
except Exception as exc:  # never fail the build over a view-transform name
    print("VIEW_LOOK_SKIP:", exc)

print("BUILD_OK objects=%d calib=%.3f/%.3f,%.3f,%.3f"
      % (len(bpy.context.scene.objects), KB, KEX, KEY, KEZ))
