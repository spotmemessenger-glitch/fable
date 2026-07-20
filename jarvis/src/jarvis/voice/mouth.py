"""Speech output via ElevenLabs.

Audio is requested as raw PCM and written straight to the sound card through
PyAudio. ElevenLabs' bundled `play()` helper shells out to ffmpeg or mpv, and
neither is installed here — going through PCM removes that dependency entirely
and lowers latency, since there is nothing to decode.

Playback runs on a worker thread so speech can be interrupted mid-sentence.
"""

from __future__ import annotations

import logging
import queue
import threading
from typing import Iterator

log = logging.getLogger(__name__)

# 24 kHz mono 16-bit: ElevenLabs supports it natively and it is a good balance
# of quality against bandwidth for speech.
SAMPLE_RATE = 24_000
PCM_FORMAT = "pcm_24000"


class Mouth:
    """Speaks text aloud. Falls back to printing when TTS is unavailable."""

    def __init__(
        self,
        api_key: str,
        voice_id: str,
        model: str = "eleven_flash_v2_5",
        *,
        enabled: bool = True,
    ) -> None:
        self.model = model
        self.voice_id = voice_id
        self.enabled = bool(enabled and api_key and voice_id)
        self._client = None
        self._audio = None
        self._stream = None
        self._interrupt = threading.Event()
        self._lock = threading.Lock()

        if not self.enabled:
            log.info("Voice output disabled; replies will be printed only.")
            return

        try:
            from elevenlabs.client import ElevenLabs

            self._client = ElevenLabs(api_key=api_key)
        except Exception:
            log.exception("Could not initialise ElevenLabs; falling back to text")
            self.enabled = False

    # ------------------------------------------------------------------ api

    def say(self, text: str) -> None:
        """Speak one chunk of text, blocking until it finishes or is interrupted."""
        text = text.strip()
        if not text:
            return

        print(f"  {text}")

        if not self.enabled or self._client is None:
            return

        self._interrupt.clear()
        try:
            audio = self._client.text_to_speech.stream(
                voice_id=self.voice_id,
                text=text,
                model_id=self.model,
                output_format=PCM_FORMAT,
            )
            self._play_pcm(audio)
        except Exception as exc:  # noqa: BLE001 - never let TTS kill the loop
            log.warning("Speech failed (%s); text was printed instead", exc)

    def interrupt(self) -> None:
        """Stop speaking immediately. Safe to call from another thread."""
        self._interrupt.set()

    def close(self) -> None:
        self.interrupt()
        with self._lock:
            self._close_stream()
            if self._audio is not None:
                try:
                    self._audio.terminate()
                except Exception:  # noqa: BLE001
                    pass
                self._audio = None

    # ------------------------------------------------------------- internals

    def _play_pcm(self, chunks: Iterator[bytes]) -> None:
        import pyaudio

        with self._lock:
            if self._audio is None:
                self._audio = pyaudio.PyAudio()
            self._close_stream()
            self._stream = self._audio.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=SAMPLE_RATE,
                output=True,
            )
            stream = self._stream

        try:
            for chunk in chunks:
                if self._interrupt.is_set():
                    break
                if chunk:
                    stream.write(chunk)
        finally:
            with self._lock:
                self._close_stream()

    def _close_stream(self) -> None:
        if self._stream is None:
            return
        try:
            self._stream.stop_stream()
            self._stream.close()
        except Exception:  # noqa: BLE001
            pass
        self._stream = None


class SpeechQueue:
    """Speaks sentences in order on a background thread.

    Lets the reasoning loop keep generating while earlier sentences are still
    being spoken, which is what makes the reply feel immediate.
    """

    def __init__(self, mouth: Mouth) -> None:
        self.mouth = mouth
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._thread = threading.Thread(target=self._worker, daemon=True)
        self._thread.start()

    def push(self, text: str) -> None:
        self._queue.put(text)

    def wait(self, timeout: float | None = None) -> None:
        """Block until everything queued has been spoken."""
        self._queue.join()

    def interrupt(self) -> None:
        """Drop anything pending and stop the current sentence."""
        while True:
            try:
                self._queue.get_nowait()
                self._queue.task_done()
            except queue.Empty:
                break
        self.mouth.interrupt()

    def stop(self) -> None:
        self._queue.put(None)
        self.mouth.close()

    def _worker(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                self._queue.task_done()
                return
            try:
                self.mouth.say(item)
            except Exception:  # noqa: BLE001
                log.exception("Speech worker error")
            finally:
                self._queue.task_done()
