"""Ybot Assistant — always-on-top desktop window (Phase A: greeting + text command).

Reuses the already-built Ybot operator (../ybot) as the hands/eyes. Voice (ElevenLabs)
and the 3D avatar are added in later phases.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
YBOT = ROOT.parent / "ybot"
sys.path.insert(0, str(YBOT))  # import the operator package as the hands/eyes

# Under some launch paths this process's stdout/stderr is a cp1252-encoded pipe, so a
# diagnostic print() of the model's text (which routinely contains ✓, emoji, en/em
# dashes) raises UnicodeEncodeError. Inside the operator loop that aborts the whole task
# and surfaces as a red error even when the work succeeded. Force UTF-8 with
# errors="replace" so a stray print can never crash a run. No-op when a stream is None
# (pure pythonw) or lacks reconfigure().
for _stream in (sys.stdout, sys.stderr):
    try:
        if _stream is not None and hasattr(_stream, "reconfigure"):
            _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Crash bridge: any uncaught exception (main thread, worker threads, Tk callbacks)
# writes a bundle to ybot/crashes/ and auto-spawns a headless Claude Code triage
# session on it — the operator never has to relay a stack trace by hand.
try:
    from ybot.crash_reporter import install as _install_crash_bridge
    _install_crash_bridge()
except Exception:
    pass  # the bridge must never keep Ybot from starting

import os  # noqa: E402

# WebView2 browser switches:
#  --use-fake-ui-for-media-stream: auto-grant the mic (hands-free voice input).
#  --disable-features=CalculateNativeWinOcclusion: stop Chromium from throwing away
#    the rendered surface when it decides the window is occluded/minimised. Without
#    this, Ybot comes back a solid black rectangle after minimising for a task (or a
#    manual minimise + taskbar restore). Unlike --disable-gpu it keeps WebGL on the
#    GPU, so the 3D avatar is unaffected.
os.environ.setdefault(
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    "--use-fake-ui-for-media-stream --disable-features=CalculateNativeWinOcclusion",
)

import webview  # noqa: E402

from bridge import Bridge  # noqa: E402
from ybot.screen import set_dpi_awareness  # noqa: E402


def main() -> None:
    set_dpi_awareness()  # process-wide; must run before any screen capture
    bridge = Bridge()
    window = webview.create_window(
        "Ybot",
        str(ROOT / "ui" / "index.html"),
        js_api=bridge,
        width=430,
        height=720,
        x=48,
        y=48,
        on_top=True,        # stays above every other window
        frameless=True,     # our own chrome (drag handle + close button)
        easy_drag=False,    # we implement titlebar dragging ourselves (reliable on WebView2)
        background_color="#0B0F14",
    )
    bridge.set_window(window)

    def _on_shown() -> None:
        # The native window exists now — cache its handle for the always-on-top toggle.
        bridge.capture_hwnd()

    try:
        window.events.shown += _on_shown
    except Exception:
        pass
    # http_server serves ui/ over http://127.0.0.1 so the 3D model + CDN modules load
    # (WebView2 blocks fetch of local files from a file:// origin).
    webview.start(http_server=True)


if __name__ == "__main__":
    main()
