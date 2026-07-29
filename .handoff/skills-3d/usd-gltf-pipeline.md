---
name: usd-gltf-pipeline
description: Build and inspect OpenUSD stages and glTF/GLB assets — scene graphs, layers, references, material binding and asset pipelines. Use for USD composition, glTF export/validation, scene interchange between DCC tools, or designing an asset pipeline. Verified with usd-core 26.8 / pygltflib 1.16.5.
---

# USD & glTF pipelines

Interpreter: `C:\Users\yuv\.venvs\threed\Scripts\python.exe`

Rule of thumb: **USD is the authoring/interchange master; glTF is the delivery
format.** Author in USD, publish to glTF.

## USD — verified material binding

```python
from pxr import Usd, UsdGeom, UsdShade, Sdf

stage = Usd.Stage.CreateNew('scene.usda')
mesh  = UsdGeom.Mesh.Define(stage, '/M')
mat   = UsdShade.Material.Define(stage, '/Mat')
sh    = UsdShade.Shader.Define(stage, '/Mat/S')
sh.CreateIdAttr('UsdPreviewSurface')
sh.CreateInput('diffuseColor', Sdf.ValueTypeNames.Color3f).Set((1, 0, 0))
mat.CreateSurfaceOutput().ConnectToSource(sh.ConnectableAPI(), 'surface')
UsdShade.MaterialBindingAPI(mesh).Bind(mat)
stage.GetRootLayer().Save()
```

Note the exact shapes that trip people up:
- Typed inputs need an `Sdf.ValueTypeNames.*`, not a bare Python value.
- `ConnectToSource` takes `(shader.ConnectableAPI(), 'outputName')` — the
  single-argument form is long deprecated.
- Binding goes through `MaterialBindingAPI`, not a direct relationship.

## File extensions matter

| Ext | Meaning |
|---|---|
| `.usda` | ASCII — readable, diffable, debuggable |
| `.usdc` | binary crate — fast, compact |
| `.usd`  | either, resolved at runtime |
| `.usdz` | zipped, uncompressed, for AR delivery |

Author `.usda` while developing so you can read and diff the result; ship
`.usdc`/`.usdz`.

## Composition — the actual point of USD

```python
stage.GetRootLayer().subLayerPaths.append('base.usda')      # layering
prim = stage.DefinePrim('/Inst'); prim.GetReferences().AddReference('asset.usda')
UsdGeom.Xformable(prim).AddTranslateOp().Set((5, 0, 0))
over = stage.OverridePrim('/Inst/Sub')                       # non-destructive edit
```
Strength order (strongest first): **local opinion → sublayer → reference →
payload**. Use *payloads* not references for heavy assets so they can be
unloaded.

Traverse with `for p in stage.Traverse(): print(p.GetPath(), p.GetTypeName())`.

## glTF

```python
import pygltflib
g = pygltflib.GLTF2().load('cube.glb')
print(len(g.meshes), len(g.nodes), len(g.materials))
```

Export from Blender (see [[blender-automation]]):
`bpy.ops.export_scene.gltf(filepath='out.glb')`

glTF constraints worth designing around:
- **PBR metallic-roughness only.** No specular-glossiness in core spec.
- `.glb` is a single binary — prefer it for delivery; `.gltf`+`.bin`+textures
  for debugging.
- Y-up, right-handed, metres. Blender is Z-up — the exporter converts, but
  **USD and CAD sources often need an explicit rotation**.
- No procedural geometry, no modifiers — everything must be baked.

## Pipeline shape that works

```
CAD (STEP)  ─┐
Blender      ├─→ USD master ─→ glTF/GLB ─→ web / engine
Scans        ─┘   (layers,       (baked,
                   variants)      optimised)
```
Keep the USD master non-destructive with overrides and variants; bake and
decimate only at the glTF publish step via [[mesh-optimization]].
