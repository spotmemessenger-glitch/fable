---
name: game-ready-3d-assets
description: Produce game-ready 3D assets — polygon budgets, LOD chains, UV layout, texture atlasing, normal-map baking and real-time optimisation. Use when preparing assets for a game engine or realtime/web delivery, or when an asset is too heavy, has bad UVs, or needs baking.
---

# Game-ready asset creation

Realtime is a budget discipline. "Looks good" is not the bar — "looks good
within budget" is.

## Polygon budgets (triangles, current-gen realtime)

| Asset | Budget |
|---|---|
| Hero character | 40k–100k |
| NPC | 8k–25k |
| Weapon / prop (hero) | 5k–20k |
| Environment prop | 500–5k |
| Background / set dressing | 100–1k |
| **Mobile / web (glTF)** | quarter these |

Triangles matter far less than **draw calls and material count**. One 20k-tri
mesh with one material beats ten 2k-tri meshes with ten materials. Merge and
atlas aggressively.

## The high-to-low workflow

1. **High-poly** — sculpt/subdivide freely, millions of tris, no UVs needed.
2. **Low-poly** — retopologise to budget. Silhouette carries the shape.
3. **UV unwrap** the low-poly.
4. **Bake** high → low: normal, AO, curvature.
5. **Texture** the low-poly using the baked maps.

The low-poly is what ships; the high-poly only ever contributes baked detail.
Retopology tooling here: `meshing_isotropic_explicit_remeshing` in PyMeshLab,
see [[mesh-optimization]].

## UV rules

- **Texel density must be consistent** across an asset, or some areas look
  blurry next to sharp ones. Pick a target (e.g. 512 px/m) and hold it.
- Keep islands ≥4 px apart; bleed/padding prevents seam artefacts at low mips.
- **Hide seams** where they will not be seen — under arms, behind objects, along
  hard normal breaks.
- Mirror UVs to halve texture cost on symmetric assets, but move mirrored shells
  to a second UDIM tile if you need unique wear/damage.
- **Lightmap UVs are a separate channel** (UV1), must be non-overlapping, and
  need more padding than the albedo channel.

## Normal-map baking — why bakes fail

Almost all bake artefacts come from three causes:

1. **Cage/ray distance wrong** — rays miss the high-poly or hit the wrong
   surface. Widen or tighten the cage.
2. **Smoothing groups vs UV seams mismatched.** Rule: **every hard edge must be
   a UV seam.** Ignoring this bakes visible gradients along hard edges.
3. **Wrong tangent basis** — the baker's basis must match the engine's, or
   detail lights incorrectly. Bake with the target engine's basis (Mikk-TSpace
   for Blender/glTF/Unity).

## LOD chains

```python
lods = [m.simplify_quadric_decimation(face_count=int(len(m.faces)*r))
        for r in (1.0, 0.5, 0.25, 0.1)]
```
Switch roughly at 50 %, 25 %, 10 % of screen coverage. Decimation **destroys UV
seams below ~25 %** — bake to the LOD or accept stretching on distant LODs only.

## Textures

- Power-of-two dimensions. 2K hero, 1K prop, 512 background.
- Compress: BC7 (albedo), BC5 (normal), BC4 (single-channel masks).
- **Pack single-channel maps into RGB channels** — roughness/metal/AO in one
  texture (ORM) cuts sampler count by three.
- Mobile/web: halve everything, prefer KTX2/Basis.

## Delivery

glTF for web/engine-agnostic ([[usd-gltf-pipeline]]), with everything baked —
no modifiers, no procedural nodes, Y-up, metres.
