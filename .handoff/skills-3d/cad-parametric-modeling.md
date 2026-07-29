---
name: cad-parametric-modeling
description: Precision parametric CAD modelling with CadQuery and build123d on the OCCT B-rep kernel, exporting STEP/BREP for engineering and manufacturing. Use for hard-surface mechanical parts, product design, tolerances, fillets/chamfers, boolean solids, or any CAD-quality (not polygon) modelling. Verified with cadquery 2.8.0 / build123d 0.11.1.
---

# Parametric CAD (CadQuery / build123d / OCCT)

Installed in `C:\Users\yuv\.venvs\threed`. This is a true **B-rep** kernel
(Open CASCADE), not polygons — surfaces are exact, so STEP output is
manufacturable. Use this, not Blender, whenever dimensions must be exact.

```
C:\Users\yuv\.venvs\threed\Scripts\python.exe your_part.py
```

## Verified pattern

```python
import cadquery as cq
r = (cq.Workplane('XY')
       .box(10, 10, 5)
       .faces('>Z').workplane()
       .hole(3))
s = r.val()
print(s.Volume(), len(s.Faces()))   # 464.7, 7
r.val().exportStep('part.step')
```

## Selectors — the core skill

CadQuery is a fluent chain; **selectors** choose what the next op applies to.

| Selector | Meaning |
|---|---|
| `.faces('>Z')` | face furthest along +Z |
| `.faces('<Z')` | furthest along −Z |
| `.faces('\|Z')` | faces *parallel* to Z |
| `.edges('#Z')` | edges perpendicular to Z |
| `.faces('>Z').edges('%CIRCLE')` | circular edges on the top face |
| `.vertices('>XY')` | extreme vertex |

Chain them to narrow: `.faces('>Z').edges('>X')`.

## Fillets and chamfers

```python
r = r.edges('|Z').fillet(1.0)      # vertical edges only
r = r.faces('>Z').chamfer(0.5)
```
**Fillet radius must be smaller than adjacent geometry** or OCCT throws
`StdFail_NotDone`. If a fillet fails, reduce the radius or apply it before
subsequent booleans — order matters in B-rep.

## Parametric design

Drive everything from named values so parts stay editable:

```python
def bracket(w=40, h=25, t=4, hole=5):
    return (cq.Workplane('XY').box(w, h, t)
              .faces('>Z').workplane()
              .pushPoints([(-w/3, 0), (w/3, 0)])
              .hole(hole)
              .edges('|Z').fillet(3))
bracket(60).val().exportStep('bracket.step')
```

## Export

| Format | Call | Use |
|---|---|---|
| STEP | `.exportStep('p.step')` | manufacturing, CAD interchange — **exact** |
| STL  | `cq.exporters.export(r, 'p.stl')` | 3D printing — tessellated |
| glTF | export STL/STEP → convert via [[mesh-optimization]] | realtime/web |

STEP preserves exact surfaces; STL/glTF are lossy tessellations. Export STEP as
the master, tessellate downstream.

## build123d

Same OCCT kernel, Pythonic builder syntax instead of fluent chaining. Prefer it
for complex parts where CadQuery chains get unreadable:

```python
from build123d import *
with BuildPart() as p:
    Box(10, 10, 5)
    with Locations((0, 0)): Hole(radius=1.5)
    fillet(p.edges().filter_by(Axis.Z), 1)
```

## Limits

No direct mesh sculpting or organic modelling — use Blender for that.
IFC/BIM work uses `ifcopenshell` 0.8.5 (also installed).
