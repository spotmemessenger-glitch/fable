"""Voice-activity detection and utterance segmentation.

Turns a continuous frame stream into discrete utterances using webrtcvad plus
hangover logic. Raw per-frame VAD flickers badly on natural speech, so a naive
"first silent frame ends the utterance" rule cuts people off mid-sentence.
Two guards fix that: N consecutive speech frames to open, and a trailing
silence window to close.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Iterator

import numpy as np
import webrtcvad

from .mic import FRAME_MS, SAMPLE_RATE


@dataclass(frozen=True)
class VADConfig:
    aggressiveness: int = 2      # 0 permissive .. 3 aggressive
    start_frames: int = 3        # consecutive speech frames that open an utterance
    end_silence_ms: int = 600    # trailing silence that closes it
    max_utterance_s: float = 30.0
    pre_roll_frames: int = 5     # frames kept before onset, saves clipped first words


class UtteranceSegmenter:
    def __init__(self, cfg: VADConfig | None = None) -> None:
        self.cfg = cfg or VADConfig()
        self._vad = webrtcvad.Vad(self.cfg.aggressiveness)
        self._end_frames = max(1, self.cfg.end_silence_ms // FRAME_MS)
        self._max_frames = int(self.cfg.max_utterance_s * 1000 / FRAME_MS)

    def is_speech(self, frame: np.ndarray) -> bool:
        pcm16 = (np.clip(frame, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
        return self._vad.is_speech(pcm16, SAMPLE_RATE)

    def segment(self, frames: Iterable[np.ndarray]) -> Iterator[np.ndarray]:
        """Yield one concatenated float32 array per detected utterance."""
        pre: list[np.ndarray] = []
        buf: list[np.ndarray] = []
        speaking = False
        run = 0
        silence = 0

        for frame in frames:
            speech = self.is_speech(frame)

            if not speaking:
                pre.append(frame)
                if len(pre) > self.cfg.pre_roll_frames:
                    pre.pop(0)
                run = run + 1 if speech else 0
                if run >= self.cfg.start_frames:
                    speaking, buf, silence = True, list(pre), 0
                    pre = []
                continue

            buf.append(frame)
            silence = 0 if speech else silence + 1
            if silence >= self._end_frames or len(buf) >= self._max_frames:
                yield np.concatenate(buf)
                speaking, buf, run, silence = False, [], 0, 0


def demo() -> None:
    from .mic import FRAME_SAMPLES

    quiet = np.zeros(FRAME_SAMPLES, dtype=np.float32)
    seg = UtteranceSegmenter(VADConfig(end_silence_ms=60, start_frames=1))
    # pure silence must never produce an utterance
    assert list(seg.segment([quiet] * 20)) == []
    # segmentation must terminate on a finite stream rather than hang
    seg2 = UtteranceSegmenter(VADConfig(end_silence_ms=60, start_frames=1))
    assert list(seg2.segment([quiet] * 10)) == []
    print("vad: ok (silence produced 0 utterances, stream terminated)")


if __name__ == "__main__":
    demo()
