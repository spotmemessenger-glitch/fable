"""Convert the source FBX avatar into a web-ready GLB, run inside Blender.

    blender --background --python build_glb.py

WHY GLB

The renderer is three.js in a window ybot owns, so the model has to be a format
a browser loads directly. FBX is not that. GLB also embeds the textures, which
matters here: the source ships loose JPEG/PNG files that an FBX references by
relative path, and one moved folder turns the avatar grey.

WHAT MUST SURVIVE THE CONVERSION

The whole point of this model is its 67 facial shape keys — the 15 Oculus
visemes are what make lip sync real rather than a jaw flapping to volume. glTF
calls them morph targets, and the exporter drops them unless asked, so
export_morph is explicit here and the result is asserted, not assumed.
"""
import sys
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parent
FBX = ROOT / "source" / "source" / "Catwalk Idle.fbx"
OUT = ROOT / "avatar.glb"

# The 15 Oculus visemes this rig carries. If a conversion silently loses these,
# lip sync degrades to nothing and the failure would only show up on screen.
VISEMES = ["sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR",
           "aa", "E", "ih", "oh", "ou"]


def main() -> None:
    if not FBX.exists():
        raise SystemExit(f"source model missing: {FBX}")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(FBX))

    # NO manual scaling. Mixamo authors in centimetres, but Blender's FBX
    # importer already applies that conversion, so the scene arrives at human
    # size in metres. Multiplying by 0.01 again produced a 1.7 CENTIMETRE
    # woman who rendered as a black screen — small enough to sit inside the
    # camera's near plane. The height assertion at the end of this script is
    # what makes that failure loud instead of a mystery.

    before = {
        m.name: len(m.data.shape_keys.key_blocks)
        for m in bpy.data.objects if m.type == "MESH" and m.data.shape_keys
    }

    bpy.ops.export_scene.gltf(
        filepath=str(OUT),
        export_format="GLB",
        export_morph=True,               # the visemes; without this, no lip sync
        export_skins=True,               # the 73-bone rig
        export_animations=True,          # the idle clip
        export_yup=True,
        export_apply=False,              # modifiers must not flatten shape keys
    )

    size_mb = OUT.stat().st_size / 1024 / 1024
    print(f"[build] wrote {OUT.name} ({size_mb:.1f} MB)")
    print(f"[build] shape keys carried in: {before}")

    # Verify against the FILE, not against intent: re-import and count.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(OUT))
    after = {}
    for m in bpy.data.objects:
        if m.type == "MESH" and m.data.shape_keys:
            after[m.name] = [k.name for k in m.data.shape_keys.key_blocks]

    head = next((v for k, v in after.items() if "Head" in k), [])
    missing = [v for v in VISEMES if v not in head]
    if missing:
        raise SystemExit(f"[build] FAIL visemes lost in export: {missing}")

    # Height check, because a wrongly scaled model does not error — it renders
    # a black screen or fills the view with a nostril, and both look like a
    # camera bug rather than an asset bug.
    zs = [
        (obj.matrix_world @ v.co).z
        for obj in bpy.data.objects if obj.type == "MESH"
        for v in obj.data.vertices
    ]
    height = max(zs) - min(zs) if zs else 0.0
    # Deliberately a wide range. The renderer frames its camera from the
    # model's own bounds, so exact stature is irrelevant — what this catches is
    # a unit blunder of the kind that already happened once: an extra 0.01
    # scale produced a 1.7 CENTIMETRE model that sat inside the camera's near
    # plane and rendered as a plain black screen, which reads as a broken
    # renderer rather than a broken asset.
    if not 0.5 <= height <= 5.0:
        raise SystemExit(
            f"[build] FAIL exported height {height:.3f} units — off by a unit "
            "conversion. Blender's FBX importer already handles Mixamo's "
            "centimetres; do not scale again."
        )

    anims = [a.name for a in bpy.data.actions]
    print(f"[build] verified: head has {len(head)} morph targets, all 15 visemes present")
    print(f"[build] height {height:.2f} m, animations: {anims}")
    print("[build] OK")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exc:
        print(exc)
        sys.exit(1)
