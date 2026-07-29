"""DPI-aware screen capture, downscale, and coordinate scaling (Windows).

Capture itself is cheap (~105 ms); what costs is shipping a 1280x720 PNG to the
model — roughly 1,230 image tokens EVERY step against ~336 for the same window
read from the accessibility tree. So this module exists to help the operator
send pixels as rarely as possible: `metrics()` hands back the dimensions needed
for coordinate maths without grabbing anything, and `capture(only_if_changed=True)`
returns None when the screen is pixel-identical to the last frame sent, which
also skips the PNG encode (the expensive half of a capture).
"""
from __future__ import annotations

import ctypes
import hashlib
import io
import time
from dataclasses import dataclass

import mss
from PIL import Image

from .perf import count, span


def set_dpi_awareness() -> None:
    """Make screenshot pixels line up with click coordinates on scaled displays.

    MUST be called before pyautogui/mss initialize, or clicks land in the wrong
    place whenever the Windows display scale is not 100%.
    """
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


@dataclass
class Frame:
    """A captured screen: PNG bytes plus the native vs sent dimensions."""

    png: bytes
    native_w: int
    native_h: int
    sent_w: int
    sent_h: int

    def to_native(self, x: float, y: float) -> tuple[int, int]:
        """Map a coordinate the model returned (in sent space) to real screen pixels."""
        nx = int(round(x * self.native_w / self.sent_w))
        ny = int(round(y * self.native_h / self.sent_h))
        return nx, ny


class Screen:
    def __init__(self, target_width: int):
        self.target_width = target_width
        self._sct = mss.mss()
        self._mon = self._sct.monitors[1]  # [0] is the virtual all-monitor box; [1] is primary
        self._last_digest: bytes | None = None

    @property
    def native_size(self) -> tuple[int, int]:
        return self._mon["width"], self._mon["height"]

    def sent_size(self) -> tuple[int, int]:
        nw, nh = self.native_size
        if nw > self.target_width:
            return self.target_width, int(round(nh * self.target_width / nw))
        return nw, nh

    def metrics(self) -> Frame:
        """Dimensions only — no grab, no encode. Enough to scale coordinates.

        Actions need `to_native()` and nothing else, so capturing a full frame
        before executing one was ~105 ms and a 252 KB PNG thrown away each time.
        """
        nw, nh = self.native_size
        sw, sh = self.sent_size()
        return Frame(b"", nw, nh, sw, sh)

    def capture(self, only_if_changed: bool = False) -> Frame | None:
        """Grab the screen. With only_if_changed, returns None if nothing moved.

        The digest is taken on the downscaled image BEFORE encoding, so an
        unchanged screen costs just the grab and skips both the PNG encode and
        ~1,230 image tokens. It is an exact hash — a one-pixel difference counts
        as a change — so this can never hide a real update from the model.
        """
        with span("screen.capture"):
            with span("screen.capture.grab"):
                raw = self._sct.grab(self._mon)
            with span("screen.capture.frombytes"):
                img = Image.frombytes("RGB", raw.size, raw.rgb)
            nw, nh = img.size
            sw, sh = self.sent_size()
            with span("screen.capture.resize"):
                if (sw, sh) != (nw, nh):
                    img = img.resize((sw, sh), Image.LANCZOS)

            with span("screen.capture.digest"):
                digest = hashlib.blake2b(img.tobytes(), digest_size=16).digest()
            if only_if_changed and digest == self._last_digest:
                count("screen.capture.unchanged")
                return None
            self._last_digest = digest

            with span("screen.capture.encode"):
                buf = io.BytesIO()
                img.save(buf, format="PNG")
            count("screen.capture.frames_sent")
            return Frame(buf.getvalue(), nw, nh, sw, sh)

    def wait_change(self, timeout: float = 1.2, poll: float = 0.05) -> Frame | None:
        """Event-ish settle: return the frame as soon as the screen CHANGES.

        Replaces fixed sleeps between actions — a fast app continues in ~100 ms
        instead of a worst-case wait, and a slow one gets the full deadline
        before being declared unchanged. None = nothing moved within timeout,
        which callers should treat as a real signal (the action missed).
        """
        with span("screen.wait_change"):
            deadline = time.monotonic() + timeout
            while True:
                count("screen.wait_change.polls")
                frame = self.capture(only_if_changed=True)
                if frame is not None:
                    return frame
                if time.monotonic() >= deadline:
                    count("screen.wait_change.timeouts")
                    return None
                time.sleep(poll)
