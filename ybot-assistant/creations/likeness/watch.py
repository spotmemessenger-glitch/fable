"""Live progress view — run in a GUI Blender: blender --python watch.py

Polls model.blend and reloads it the moment a build round updates it, frames
the model and switches the viewport to material shading. persistent=True keeps
the timer alive across file loads, so one window shows the whole night's
progress hands-free.
"""
import bpy
from pathlib import Path

BLEND = Path(__file__).resolve().parent / "model.blend"
_state = {"mtime": 0.0}


def _show_model() -> None:
    # hide the render rig (cameras/lights) so the viewport is just the character,
    # and frame the selected meshes. Viewer never saves, so this touches nothing.
    for ob in bpy.context.scene.objects:
        is_mesh = ob.type == "MESH"
        try:
            ob.hide_set(not is_mesh)
            ob.select_set(is_mesh)
        except Exception:
            pass
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                for space in area.spaces:
                    if space.type == "VIEW_3D":
                        space.shading.type = "MATERIAL"
                region = next((r for r in area.regions if r.type == "WINDOW"), None)
                if region is None:
                    continue
                try:
                    with bpy.context.temp_override(window=win, area=area, region=region):
                        bpy.ops.view3d.view_selected()
                except Exception:
                    pass


def check() -> float:
    try:
        m = BLEND.stat().st_mtime
        if m > _state["mtime"]:
            _state["mtime"] = m
            bpy.ops.wm.open_mainfile(filepath=str(BLEND), load_ui=False)
            _show_model()
            print(f"[watch] reloaded {BLEND.name}")
    except FileNotFoundError:
        pass
    except Exception as e:  # noqa: BLE001
        print("[watch]", e)
    return 8.0  # poll again in 8s


bpy.app.timers.register(check, first_interval=2.0, persistent=True)
print("[watch] live progress viewer armed")
