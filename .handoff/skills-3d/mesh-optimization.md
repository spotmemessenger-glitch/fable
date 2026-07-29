---
name: mesh-optimization
description: Mesh repair, decimation, retopology, normals, UVs and format conversion using trimesh, Open3D and PyMeshLab. Use when reducing polycount, fixing non-manifold or non-watertight geometry, generating LODs, converting mesh formats, or preparing scanned/generated meshes for production. Verified with trimesh 4.12.2 / open3d 0.19.0 / pymeshlab 2025.7.
---

# Mesh processing & optimization

Interpreter: `C:\Users\yuv\.venvs\threed\Scripts\python.exe`

**Critical local note:** `simplify_quadric_decimation` requires the
`fast-simplification` package. It is installed here, but on a fresh env trimesh
imports fine and only fails at the decimation call — install it up front.

## Verified pattern

```python
import trimesh
m = trimesh.creation.icosphere(subdivisions=4)      # 5120 faces
d = m.simplify_quadric_decimation(face_count=200)   # -> 200 faces
trimesh.repair.fix_normals(d)
print(d.is_watertight)                              # True
```

## Diagnose before you fix

```python
m.is_watertight      # closed manifold?
m.is_winding_consistent
m.euler_number
m.volume             # meaningless / negative if normals are inverted
len(m.split(only_watertight=False))   # stray disconnected shells
```
A **negative volume means flipped normals**, not a broken mesh. Check this
before any repair — it is the most common false alarm on imported assets.

## Repair ladder — cheapest first

```python
m.update_faces(m.unique_faces())          # duplicate faces
m.update_faces(m.nondegenerate_faces())   # zero-area faces
m.merge_vertices()                        # split verts / cracks
trimesh.repair.fix_normals(m)             # consistent winding
trimesh.repair.fill_holes(m)              # small holes only
```
`fill_holes` handles small boundaries; large gaps need Poisson reconstruction
(Open3D) or manual retopology.

## Decimation and LODs

```python
lods = [m.simplify_quadric_decimation(face_count=int(len(m.faces)*r))
        for r in (1.0, 0.5, 0.25, 0.1)]
```
Quadric decimation preserves silhouette but **destroys UV seams** at high
ratios. Below ~25% expect texture stretching — bake to the LOD or retopologise.

## Open3D — scans and point clouds

```python
import open3d as o3d
pcd = mesh.sample_points_poisson_disk(5000)
pcd.estimate_normals()
rec, _ = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(pcd, depth=9)
rec = rec.filter_smooth_taubin(number_of_iterations=10)   # keeps volume
```
Use **Taubin**, not Laplacian, smoothing — Laplacian shrinks the model.

## PyMeshLab — heavy filters

```python
import pymeshlab
ms = pymeshlab.MeshSet(); ms.load_new_mesh('in.obj')
ms.meshing_remove_duplicate_vertices()
ms.meshing_repair_non_manifold_edges()
ms.meshing_isotropic_explicit_remeshing(targetlen=pymeshlab.PercentageValue(1))
ms.save_current_mesh('out.obj')
```
`meshing_isotropic_explicit_remeshing` is the practical retopology tool here —
it produces even triangles suited to deformation and baking.

## Format conversion

trimesh handles STL/OBJ/PLY/GLB/GLTF/3MF/DAE natively:
```python
trimesh.load('in.stl').export('out.glb')
```
**Do not use pyassimp** — it is installed but non-functional (missing the native
assimp library). trimesh + [[usd-gltf-pipeline]] cover every format needed.

Related: [[cad-parametric-modeling]] for exact solids, [[game-ready-3d-assets]]
for budgets and baking.
