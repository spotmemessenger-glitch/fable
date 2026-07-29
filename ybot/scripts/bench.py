"""Microbenchmark the local (non-API) hot paths. Run on the target Windows machine.

    python scripts/bench.py

Answers three questions with numbers, so optimisation choices are evidence-led:

  1. Where does a screen capture actually spend its time?
  2. How much cheaper is change-detection if the digest skips the LANCZOS resize?
     wait_change() polls every 50 ms and each poll currently runs the FULL
     pipeline purely to decide "did anything move?" — that is the loop's local
     hot path, and it does not need a pretty image.
  3. How long does one accessibility-tree walk take on the foreground window?
     Cost scales with window complexity, so try it against Notepad AND a browser.

Nothing here clicks or types. It is safe to run at any time.
"""
from __future__ import annotations

import hashlib
import io
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mss  # noqa: E402
from PIL import Image  # noqa: E402

from ybot.screen import set_dpi_awareness  # noqa: E402

REPEATS = 20


def timed(fn, repeats: int = REPEATS) -> tuple[float, float]:
    """Return (median_ms, max_ms). Median resists a one-off scheduler hiccup."""
    samples = []
    for _ in range(repeats):
        t0 = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - t0) * 1000.0)
    return statistics.median(samples), max(samples)


def row(label: str, med: float, mx: float, note: str = "") -> None:
    print(f"  {label:<38}{med:>8.1f}ms  (max {mx:>6.1f}ms)  {note}")


def bench_capture(sct, mon, target_width: int) -> None:
    print("\n[1] Capture pipeline — one full frame, stage by stage")

    raw = sct.grab(mon)
    img_full = Image.frombytes("RGB", raw.size, raw.rgb)
    nw, nh = img_full.size
    sw = min(target_width, nw)
    sh = int(round(nh * sw / nw))
    print(f"  native {nw}x{nh} -> sent {sw}x{sh}")

    row("grab", *timed(lambda: sct.grab(mon)))
    row("frombytes", *timed(lambda: Image.frombytes("RGB", raw.size, raw.rgb)))
    row("resize LANCZOS", *timed(lambda: img_full.resize((sw, sh), Image.LANCZOS)))

    img_small = img_full.resize((sw, sh), Image.LANCZOS)
    row("digest blake2b (on sent img)", *timed(lambda: hashlib.blake2b(img_small.tobytes(), digest_size=16).digest()))

    def encode():
        buf = io.BytesIO()
        img_small.save(buf, format="PNG")
        return buf.getvalue()

    med, mx = timed(encode)
    row("encode PNG", med, mx, f"{len(encode())//1024} KB")


def bench_change_detection(sct, mon, target_width: int) -> None:
    """The polling path: how cheaply can we answer 'did the screen change?'"""
    print("\n[2] Change detection — cost per wait_change() poll")

    raw = sct.grab(mon)
    img_full = Image.frombytes("RGB", raw.size, raw.rgb)
    nw, nh = img_full.size
    sw = min(target_width, nw)
    sh = int(round(nh * sw / nw))

    def current():
        r = sct.grab(mon)
        im = Image.frombytes("RGB", r.size, r.rgb)
        if (sw, sh) != im.size:
            im = im.resize((sw, sh), Image.LANCZOS)
        return hashlib.blake2b(im.tobytes(), digest_size=16).digest()

    def raw_bytes():
        """Hash the grab's bytes directly — no PIL object built at all."""
        r = sct.grab(mon)
        return hashlib.blake2b(r.rgb, digest_size=16).digest()

    def reduced(factor: int = 8):
        """Box-downsample: integer averaging, far cheaper than LANCZOS."""
        r = sct.grab(mon)
        im = Image.frombytes("RGB", r.size, r.rgb)
        return hashlib.blake2b(im.reduce(factor).tobytes(), digest_size=16).digest()

    def nearest():
        r = sct.grab(mon)
        im = Image.frombytes("RGB", r.size, r.rgb)
        return hashlib.blake2b(im.resize((160, 90), Image.NEAREST).tobytes(), digest_size=16).digest()

    base_med, base_mx = timed(current)
    row("current (LANCZOS + hash)", base_med, base_mx, "<- what wait_change does now")
    for label, fn in (
        ("hash raw grab bytes", raw_bytes),
        ("Image.reduce(8) + hash", reduced),
        ("NEAREST 160x90 + hash", nearest),
    ):
        med, mx = timed(fn)
        speedup = base_med / med if med else 0
        row(label, med, mx, f"{speedup:.1f}x faster")

    print("\n  A poll costs this much every 50ms while waiting for the screen to settle.")
    print(f"  wait_change(1.2s) worst case ~{int(1200 / max(base_med + 50, 1))} polls "
          f"= ~{int(1200 / max(base_med + 50, 1) * base_med)}ms of CPU on change detection alone.")


def bench_uia() -> None:
    print("\n[3] Accessibility tree — foreground window walk")
    try:
        from ybot.uia import UIA
    except Exception as e:
        print(f"  skipped: {e}")
        return

    uia = UIA()
    try:
        med, mx = timed(uia.inspect, repeats=5)
    except Exception as e:
        print(f"  failed: {e}")
        return
    n = len(uia.inspect())
    row("uia.inspect()", med, mx, f"{n} interactive elements")
    print("  Run this again with a browser or IDE focused — cost scales with tree size,")
    print("  and this call sits on the loop's critical path before every ui_click.")


def main() -> None:
    set_dpi_awareness()
    target_width = 1280
    with mss.mss() as sct:
        mon = sct.monitors[1]
        print("=" * 74)
        print(" ybot local latency benchmark")
        print("=" * 74)
        bench_capture(sct, mon, target_width)
        bench_change_detection(sct, mon, target_width)
    bench_uia()
    print("\nNote: none of this includes the model round trip, which is measured")
    print("live by YBOT_PERF=1 as agent.api_call. Compare the two before optimising.")


if __name__ == "__main__":
    main()
