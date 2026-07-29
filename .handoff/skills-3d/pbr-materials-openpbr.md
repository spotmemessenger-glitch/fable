---
name: pbr-materials-openpbr
description: Author physically-based materials with MaterialX and OpenPBR — shading graphs, texture sets, and correct PBR parameter values. Use when creating or debugging materials, building shader graphs, choosing metallic/roughness values, or transferring materials between renderers. Verified with MaterialX 1.39.5 (open_pbr_surface available).
---

# PBR materials — MaterialX & OpenPBR

Interpreter: `C:\Users\yuv\.venvs\threed\Scripts\python.exe`
Spec reference cloned at `fable/3d-reference/OpenPBR/`.

## Verified

```python
import MaterialX as mx
doc = mx.createDocument()
srf = doc.addNode('open_pbr_surface', 'srf', 'surfaceshader')
print(mx.getVersionString())     # 1.39.5
```
`open_pbr_surface` exists in 1.39.5 — this is the current industry surface model
(ASWF), superseding ad-hoc per-renderer uber-shaders.

## Building a graph

```python
doc = mx.createDocument()
ng  = doc.addNodeGraph('NG')
tex = ng.addNode('image', 'basecolor_tex', 'color3')
tex.addInput('file', 'filename').setValueString('textures/albedo.png')
out = ng.addOutput('out', 'color3'); out.setConnectedNode(tex)

srf = doc.addNode('open_pbr_surface', 'srf', 'surfaceshader')
srf.addInput('base_color', 'color3').setConnectedOutput(out)
srf.addInput('base_metalness', 'float').setValue(0.0)
srf.addInput('specular_roughness', 'float').setValue(0.4)

mtl = doc.addNode('surfacematerial', 'mat', 'material')
mtl.addInput('surfaceshader', 'surfaceshader').setNodeName('srf')
mx.writeToXmlFile(doc, 'mat.mtlx')
print(mx.getValidationErrors := doc.validate())   # ALWAYS validate
```
`doc.validate()` returns `(bool, message)` — check it. Silent type mismatches
are the usual cause of a material that loads but renders black.

## Parameter values that are physically correct

**Metalness is binary in reality** — 0.0 or 1.0. Intermediate values are only
for blend masks (worn edges), never "a bit shiny".

| Material | base_color (linear sRGB) | metalness | roughness |
|---|---|---|---|
| Gold | 1.00, 0.77, 0.34 | 1.0 | 0.1–0.3 |
| Silver | 0.97, 0.96, 0.92 | 1.0 | 0.05–0.2 |
| Iron | 0.56, 0.57, 0.58 | 1.0 | 0.3–0.6 |
| Plastic | any | 0.0 | 0.2–0.5 |
| Rough concrete | ~0.5 grey | 0.0 | 0.8–0.95 |

**Dielectric base_color must stay in 0.02–0.9.** Real materials are never pure
black or pure white — values outside that break energy conservation and look
wrong under every light.

## Colour space — the #1 source of wrong-looking renders

| Map | Colour space |
|---|---|
| base color / albedo / emissive | **sRGB** |
| roughness, metalness, AO, height, displacement | **linear / raw** |
| normal map | **linear / raw** |

Tagging a roughness map as sRGB is the most common PBR bug; it silently makes
surfaces far too glossy.

## Normal maps

OpenGL (**+Y up**) vs DirectX (**−Y down**). Blender, glTF and USD expect
OpenGL. Unreal expects DirectX. If lighting looks inverted on the vertical axis,
flip the green channel — don't re-bake.

## Portability

MaterialX → renderer support varies. For **glTF delivery** you are constrained to
metallic-roughness with base color, metallic, roughness, normal, occlusion and
emissive — no more (see [[usd-gltf-pipeline]]). Author rich in MaterialX, bake
down to those six for delivery.

USD's `UsdPreviewSurface` is the lowest common denominator and is what to bind
for maximum compatibility.
