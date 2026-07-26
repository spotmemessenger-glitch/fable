import bpy
import bmesh
import math

# Clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()
for m in list(bpy.data.meshes):
    bpy.data.meshes.remove(m)

import sys
out = sys.argv[sys.argv.index('--') + 1]

# Gear parameters
num_teeth = 10
inner_r = 1.0
outer_r = 1.35
thickness = 0.4

mesh = bpy.data.meshes.new("Gear")
bm = bmesh.new()

steps = num_teeth * 4
verts_top = []
verts_bot = []
for i in range(steps):
    ang = (i / steps) * 2 * math.pi
    phase = i % 4
    # tooth profile: 0,1 = outer (tooth), 2,3 = inner (valley)
    if phase in (1, 2):
        r = outer_r
    else:
        r = inner_r
    x = r * math.cos(ang)
    y = r * math.sin(ang)
    vt = bm.verts.new((x, y, thickness / 2))
    vb = bm.verts.new((x, y, -thickness / 2))
    verts_top.append(vt)
    verts_bot.append(vb)

bm.verts.ensure_lookup_table()

# Side walls
for i in range(steps):
    j = (i + 1) % steps
    bm.faces.new((verts_top[i], verts_top[j], verts_bot[j], verts_bot[i]))

# Top and bottom faces
bm.faces.new(verts_top)
bm.faces.new(list(reversed(verts_bot)))

bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
bm.to_mesh(mesh)
bm.free()

gear_obj = bpy.data.objects.new("Gear", mesh)
bpy.context.collection.objects.link(gear_obj)

# Center bore hole via boolean cylinder
bpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=thickness * 2, vertices=16, location=(0, 0, 0))
bore = bpy.context.active_object
bool_mod = gear_obj.modifiers.new("Bore", 'BOOLEAN')
bool_mod.operation = 'DIFFERENCE'
bool_mod.object = bore
bpy.context.view_layer.objects.active = gear_obj
bpy.ops.object.modifier_apply(modifier="Bore")
bpy.data.objects.remove(bore, do_unlink=True)

# Hub (raised cylinder in center)
bpy.ops.mesh.primitive_cylinder_add(radius=0.55, depth=thickness * 1.6, vertices=16, location=(0, 0, 0))
hub = bpy.context.active_object
hub.name = "Hub"

# Hub bore
bpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=thickness * 4, vertices=16, location=(0, 0, 0))
hub_bore = bpy.context.active_object
bm2 = hub.modifiers.new("HubBore", 'BOOLEAN')
bm2.operation = 'DIFFERENCE'
bm2.object = hub_bore
bpy.context.view_layer.objects.active = hub
bpy.ops.object.modifier_apply(modifier="HubBore")
bpy.data.objects.remove(hub_bore, do_unlink=True)

# Materials
gear_mat = bpy.data.materials.new("GearMetal")
gear_mat.use_nodes = True
bsdf = gear_mat.node_tree.nodes.get("Principled BSDF")
bsdf.inputs["Base Color"].default_value = (0.45, 0.45, 0.5, 1.0)
bsdf.inputs["Metallic"].default_value = 0.9
bsdf.inputs["Roughness"].default_value = 0.4
gear_obj.data.materials.append(gear_mat)

hub_mat = bpy.data.materials.new("HubMetal")
hub_mat.use_nodes = True
hbsdf = hub_mat.node_tree.nodes.get("Principled BSDF")
hbsdf.inputs["Base Color"].default_value = (0.7, 0.5, 0.3, 1.0)
hbsdf.inputs["Metallic"].default_value = 0.8
hbsdf.inputs["Roughness"].default_value = 0.5
hub.data.materials.append(hub_mat)

# Join hub into gear
bpy.ops.object.select_all(action='DESELECT')
gear_obj.select_set(True)
hub.select_set(True)
bpy.context.view_layer.objects.active = gear_obj
bpy.ops.object.join()

bpy.ops.export_scene.gltf(filepath=out, export_format='GLB')
try:
    import bpy as _bpy
    _bpy.ops.wm.save_as_mainfile(filepath=r'C:\Users\yuv\fable\ybot-assistant\creations\a-low-poly-gear-with-10-teeth-and-a-hub-20260723-011133.blend')
except Exception as _e:
    print('save .blend failed:', _e)
