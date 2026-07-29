"""Microphone manager: device selection plus a continuous float32 frame stream."""
from __future__ import annotations

import queue
from dataclasses import dataclass
from typing import Iterator

import numpy as np
import sounddevice as sd

SAMPLE_RATE = 16_000
FRAME_MS = 30                                   # webrtcvad accepts 10/20/30 only
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000  # 480


@dataclass(frozen=True)
class Device:
    index: int
    name: str
    channels: int


def list_devices() -> list[Device]:
    return [
        Device(i, str(d["name"]), int(d["max_input_channels"]))
        for i, d in enumerate(sd.query_devices())
        if d["max_input_channels"] > 0
    ]


class MicrophoneManager:
    """Yields fixed-size mono float32 frames at 16 kHz.

    Audio arrives on PortAudio's own thread, so frames are handed over a
    bounded queue: a slow consumer then drops audio instead of growing memory
    without limit. Drops are counted rather than silently ignored so the
    service can report them as a health signal.
    """

    def __init__(self, device: int | None = None, max_queued_frames: int = 100) -> None:
        self.device = device
        self._q: queue.Queue[np.ndarray] = queue.Queue(maxsize=max_queued_frames)
        self._stream: sd.InputStream | None = None
        self.dropped = 0

    def _callback(self, indata, frames, time_info, status) -> None:  # noqa: ANN001
        try:
            self._q.put_nowait(indata[:, 0].copy())
        except queue.Full:
            self.dropped += 1

    def __enter__(self) -> "MicrophoneManager":
        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            blocksize=FRAME_SAMPLES,
            device=self.device,
            callback=self._callback,
        )
        self._stream.start()
        return self

    def __exit__(self, *exc: object) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None

    def frames(self, timeout: float = 1.0) -> Iterator[np.ndarray]:
        while True:
            try:
                yield self._q.get(timeout=timeout)
            except queue.Empty:
                if self._stream is None:
                    return
                continue


def demo() -> None:
    devs = list_devices()
    assert devs, "no input devices found"
    assert FRAME_SAMPLES == 480, FRAME_SAMPLES
    print(f"mic: ok ({len(devs)} input devices, frame={FRAME_SAMPLES} samples)")


if __name__ == "__main__":
    demo()
