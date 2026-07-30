"""Interruptible audio playback — the half of barge-in that actually cuts sound.

Two things make an assistant feel like software rather than a person: silence
before it answers, and being unable to stop it once it starts. This module owns
the second one.

WHY A DEDICATED PLAYER

The previous playback loop checked a flag between chunks:

    for chunk in tts.stream(...):
        if self._stop.is_set(): break
        out.write(chunk)

That cannot interrupt anything, for two independent reasons. The flag was the
service's SHUTDOWN event, which nothing sets when the user speaks; and
`out.write()` blocks until the device has room, so by the time the loop looks at
the flag again, seconds of audio are already queued inside PortAudio and will
play out regardless. Stopping the producer does not stop the sound.

So interruption has to reach the device: `abort()` discards the queued buffer
immediately, where `stop()` politely drains it — the difference between cutting
someone off mid-word (what a person does) and finishing your sentence at them.

ECHO, HONESTLY

With open speakers the microphone hears this playback and can interrupt on the
assistant's own voice. There is no echo cancellation here (RNNoise/Krisp are not
installed), so `Speaker.playing` is exposed for the mic side to gate on, and
headphones remain the reliable answer. Documented rather than hidden.
"""
from __future__ import annotations

import threading
import time
from typing import Iterable, Iterator

import numpy as np

SAMPLE_RATE = 16_000
# Write in small blocks so the loop notices an interrupt quickly. 1024 samples
# at 16 kHz is 64 ms — under the ~100 ms where a pause stops feeling immediate.
BLOCK = 1024


class Speaker:
    """Streams float32 PCM to the output device and can be cut off mid-word."""

    def __init__(self, sample_rate: int = SAMPLE_RATE, block: int = BLOCK) -> None:
        self.sample_rate = sample_rate
        self.block = block
        self._interrupt = threading.Event()
        self._playing = threading.Event()
        self._stream = None
        self._lock = threading.Lock()

    @property
    def playing(self) -> bool:
        """True while audio is going out — the mic side gates on this."""
        return self._playing.is_set()

    def interrupt(self) -> None:
        """Stop now. Safe from another thread, and a no-op when idle."""
        self._interrupt.set()
        with self._lock:
            stream = self._stream
        if stream is not None:
            try:
                stream.abort()      # discard what is queued; stop() would drain it
            except Exception:       # noqa: BLE001 - device already closing
                pass

    def play(self, chunks: Iterable[np.ndarray]) -> bool:
        """Play a chunk stream. Returns True if it finished, False if interrupted.

        The return value matters to the caller: an interrupted reply should not
        be recorded as something the user heard.
        """
        import sounddevice as sd

        self._interrupt.clear()
        self._playing.set()
        completed = True
        try:
            stream = sd.OutputStream(
                samplerate=self.sample_rate, channels=1, dtype="float32",
                blocksize=self.block,
            )
            with self._lock:
                self._stream = stream
            stream.start()
            try:
                for chunk in chunks:
                    if self._interrupt.is_set():
                        completed = False
                        break
                    audio = np.asarray(chunk, dtype=np.float32).reshape(-1)
                    for i in range(0, audio.size, self.block):
                        if self._interrupt.is_set():
                            completed = False
                            break
                        stream.write(audio[i : i + self.block])
                    if not completed:
                        break
            finally:
                with self._lock:
                    self._stream = None
                try:
                    stream.close()
                except Exception:      # noqa: BLE001 - already aborted
                    pass
        finally:
            self._playing.clear()
        return completed


class BargeInWatcher:
    """Watches mic frames while the assistant talks and interrupts on speech.

    Deliberately stricter than the segmenter that starts a normal turn: a false
    positive here truncates the assistant mid-sentence, which is worse than a
    slightly late interruption. Hence both a consecutive-frame requirement and
    an energy floor — room noise and a distant TV clear one of those but rarely
    both.
    """

    def __init__(self, speaker: Speaker, segmenter, frames_to_trigger: int = 3,
                 energy_floor: float = 0.015) -> None:
        self.speaker = speaker
        self.segmenter = segmenter
        self.frames_to_trigger = frames_to_trigger
        self.energy_floor = energy_floor
        self._run = 0

    def feed(self, frame: np.ndarray) -> bool:
        """Feed one mic frame. Returns True if this frame triggered the interrupt."""
        if not self.speaker.playing:
            self._run = 0
            return False
        loud = float(np.sqrt(np.mean(np.square(frame)))) >= self.energy_floor
        if loud and self.segmenter.is_speech(frame):
            self._run += 1
        else:
            self._run = 0
        if self._run >= self.frames_to_trigger:
            self._run = 0
            self.speaker.interrupt()
            return True
        return False


def _tone(seconds: float, freq: float = 220.0) -> Iterator[np.ndarray]:
    """Chunked test tone, yielded like a TTS stream rather than as one blob."""
    total = int(seconds * SAMPLE_RATE)
    t = np.arange(total, dtype=np.float32) / SAMPLE_RATE
    wave = (0.2 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    for i in range(0, total, BLOCK):
        yield wave[i : i + BLOCK]


def demo() -> None:
    """Prove interruption actually cuts audio short, by timing it.

    A flag that flips proves nothing — the old code had one of those and could
    not interrupt anything. What matters is that a 6-second utterance stops
    after well under a second of real time.
    """
    import sounddevice as sd

    try:
        sd.query_devices(kind="output")
    except Exception as exc:                      # noqa: BLE001
        print(f"player: skipped (no output device: {exc})")
        return

    speaker = Speaker()
    threading.Timer(0.4, speaker.interrupt).start()
    t0 = time.time()
    completed = speaker.play(_tone(6.0))
    elapsed = time.time() - t0
    assert not completed, "play() reported success despite being interrupted"
    assert elapsed < 2.0, f"interrupt took {elapsed:.2f}s — buffered audio still drained"
    assert not speaker.playing, "playing flag stuck after interrupt"

    # And an uninterrupted run must still finish and report so.
    t0 = time.time()
    assert speaker.play(_tone(0.5)) is True, "short clip should complete"
    assert time.time() - t0 >= 0.3, "clip finished implausibly fast — was it played?"

    # Watcher stays silent while nothing is playing (no self-triggering at idle).
    class _AlwaysSpeech:
        def is_speech(self, frame): return True

    watcher = BargeInWatcher(speaker, _AlwaysSpeech())
    loud = np.full(480, 0.5, dtype=np.float32)
    assert not any(watcher.feed(loud) for _ in range(10)), "interrupted while idle"

    print(f"player: ok (6s utterance cut at {elapsed:.2f}s, idle watcher quiet)")


if __name__ == "__main__":
    demo()
