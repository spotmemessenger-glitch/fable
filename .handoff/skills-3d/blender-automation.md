---
name: blender-automation
description: Drive Blender headlessly from Python (bpy) for modelling, modifiers, geometry nodes, rendering and export. Use when automating Blender, writing bpy scripts, batch-processing .blend files, procedural generation, or rendering without the GUI. Verified against Blender 5.2.0 LTS on this machine.
---

# Blender automation (bpy)

Blender 5.2.0 LTS is installed at
`C:\Program Files\Blender Foundation\Blender 5.2\blender.exe`. It is NOT on PATH.
There is no pip `bpy` module here — always drive Blender's own interpreter.

## Running headless

```bash
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --python script.py
# inline:
"…\blender.exe" --background --python-expr "import bpy; print(bpy.app.version_string)"
# with args after --:
"…\blender.exe" -b -P script.py -- --out C:\tmp\a.glb
```
`--background` (`-b`) means no GUI. Parse your own argv after `--` via
`sys.argv[sys.argv.index('--')+1:]`.

## The rules that actually bite

1. **`bpy.ops` depends on context.** Operators act on the active object /
   selection, and in `--background` there may be no sensible context. Prefer the
   data API (`bpy.data.*`, `obj.modifiers.new(...)`) over `bpy.ops` wherever a
   data-level equivalent exists. Ops are for things with no data equivalent.
2. **Names are not unique handles.** Adding a second cube yields `Cube.001`.
   Never look objects up by a hard-coded name — capture
   `bpy.context.active_object` immediately after creation.
3. **Modifiers are lazy.** `len(obj.data.vertices)` reports the *pre-modifier*
   cage (a subsurfed cube still reports 8). To read evaluated geometry use the
   dependency graph:
   ```python
   dg = bpy.context.evaluated_depsgraph_get()
   ev = obj.evaluated_get(dg)
   mesh = ev.to_mesh()          # real post-modifier geometry
   ```
4. **Start from a known state** — the default scene ships a cube, camera and
   light:
   ```python
   bpy.ops.wm.read_factory_settings(use_empty=True)
   ```

## Verified pattern

```python
import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2)
obj = bpy.context.active_object
m = obj.modifiers.new('Sub', 'SUBSURF'); m.levels = 2
bpy.ops.export_scene.gltf(filepath=r'C:\out\cube.glb')
```

## Geometry Nodes from Python

```python
mod = obj.modifiers.new('GN', 'NODES')
ng = bpy.data.node_groups.new('Proc', 'GeometryNodeTree')
ng.interface.new_socket('Geometry', in_out='INPUT',  socket_type='NodeSocketGeometry')
ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
mod.node_group = ng
```
The `interface.new_socket` API is Blender 4.0+; older `ng.inputs.new` snippets
found online will fail on 5.2.

## Rendering

```python
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'GPU'          # GTX 1050 Ti, 4 GB — keep samples modest
sc.cycles.samples = 128
sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
sc.render.filepath = r'C:\out\frame.png'
bpy.ops.render.render(write_still=True)
```
On 4 GB VRAM, Cycles GPU will fall back to CPU or fail on heavy scenes. Prefer
`EEVEE_NEXT` for previews and keep textures ≤2K.

## When NOT to use Blender

For parametric/CAD solids use [[cad-parametric-modeling]] (real B-rep + STEP).
For batch mesh repair/decimation without a GUI, [[mesh-optimization]] via trimesh
is far faster than launching Blender per file.
