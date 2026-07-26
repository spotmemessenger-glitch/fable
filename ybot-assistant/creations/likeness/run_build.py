"""Driver: run Blender headless on pipeline.py and report result.json.

Usage: python run_build.py   (from any cwd; all paths are absolute)
Exit code 0 iff the pipeline reported ok.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BLENDER = r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"


def main() -> int:
    result_file = ROOT / "result.json"
    if result_file.exists():
        result_file.unlink()
    proc = subprocess.run(
        [BLENDER, "--background", "--factory-startup", "--python", str(ROOT / "pipeline.py")],
        capture_output=True, text=True, timeout=600,
    )
    tail = ((proc.stdout or "") + (proc.stderr or ""))[-2200:]
    if result_file.exists():
        res = json.loads(result_file.read_text(encoding="utf-8"))
    else:
        res = {"ok": False, "errors": ["pipeline wrote no result.json", tail[-800:]]}
    print(json.dumps({"ok": res.get("ok"), "renders": res.get("renders", []),
                      "errors": res.get("errors", []), "blend": res.get("blend"),
                      "glb": res.get("glb")}, indent=2))
    if not res.get("ok"):
        print("---- blender output tail ----")
        print(tail)
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
