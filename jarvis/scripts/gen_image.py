"""Generate the JARVIS core image via Gemini image generation.

Tries the current Gemini image models with the environment's key. Saves the
first successful image to ui/assets/core-gen.png. Prints a clear status so we
know whether the key/quota actually works before building around it.
"""

from __future__ import annotations

import base64
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT.parent / ".env", override=True)

KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
if not KEY:
    print("NO_KEY")
    sys.exit(2)

PROMPT = (
    "A premium futuristic Iron Man inspired AI core illustration, neon holographic "
    "blueprint style. Front-facing armored robotic bust (helmet, shoulders, chest) "
    "centered, filling ~75% of the frame. Rendered as glowing neon vector outlines "
    "with intricate mechanical panel lines, circuitry and engineering detail; the "
    "interior is deep matte black. Color scheme: vibrant crimson red (#ff2333) primary "
    "outlines with luminous gold (#ffd54a) secondary accents. Fierce glowing golden "
    "eyes with horizontal lens-flare streaks. A large layered circular arc reactor on "
    "the chest with bright blue-white plasma core and rotating golden rings emitting "
    "volumetric light and sparks. Fine blueprint grid and faint HUD markings in the "
    "background, digital scanlines, cinematic neon bloom, soft energy haze, perfectly "
    "symmetrical composition. High contrast, luxury sci-fi, 8K wallpaper quality. "
    "No text, no logos, no watermark."
)

MODELS = [
    "gemini-2.5-flash-image",
    "gemini-2.5-flash-image-preview",
    "gemini-2.0-flash-preview-image-generation",
]

OUT = ROOT / "ui" / "assets" / "core-gen.png"
OUT.parent.mkdir(parents=True, exist_ok=True)


def try_model(model: str) -> bool:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    body = {
        "contents": [{"parts": [{"text": PROMPT}]}],
        "generationConfig": {"responseModalities": ["IMAGE"]},
    }
    try:
        r = requests.post(url, params={"key": KEY}, json=body, timeout=120)
    except Exception as exc:  # noqa: BLE001
        print(f"{model}: REQUEST_ERROR {exc}")
        return False
    if r.status_code != 200:
        print(f"{model}: HTTP {r.status_code} {r.text[:240]}")
        return False
    data = r.json()
    try:
        parts = data["candidates"][0]["content"]["parts"]
    except (KeyError, IndexError):
        print(f"{model}: NO_PARTS {str(data)[:240]}")
        return False
    for p in parts:
        inline = p.get("inlineData") or p.get("inline_data")
        if inline and inline.get("data"):
            OUT.write_bytes(base64.b64decode(inline["data"]))
            print(f"OK {model} -> {OUT} ({OUT.stat().st_size} bytes)")
            return True
    print(f"{model}: NO_IMAGE_PART")
    return False


for m in MODELS:
    if try_model(m):
        sys.exit(0)
print("ALL_FAILED")
sys.exit(1)
