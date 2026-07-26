"""Streaming voice listener via Deepgram — low-latency replacement for the
record-then-transcribe approach in native_listener.py.

The old flow: capture a whole utterance, THEN upload it for transcription,
THEN react. The latency was entirely serial. This flow streams raw microphone
audio to Deepgram continuously; Deepgram transcribes AS the audio arrives and
its own endpointing detects end-of-speech far faster and more precisely than
the previous energy-threshold approach — so JARVIS reacts the moment a
sentence actually finishes, not after an extra record+upload round trip.

The wake/sleep/dispatch state machine (WAKE_RE, SLEEP_RE, _handle, _dispatch,
_go_to_sleep) is unchanged from native_listener.py on purpose — it was already
built and verified there; this file only swaps HOW text reaches that logic.
"""

from __future__ import annotations

import logging
import re
import threading
import time

log = logging.getLogger(__name__)

# Wake word — deliberately generous, because speech-to-text mangles "Jarvis"
# badly across accents: Jahavah, Jehovah, Java's, Javis, Jervis, Driver's,
# Jobiz (seen from Deepgram specifically at very low mic volume), etc. Better
# to wake on a near-miss than to ignore the owner.
WAKE_RE = re.compile(
    r"\b(?:hey|hi|ok|okay|a|jai)?\s*"
    r"(?:j[aoeu][hb]?[aveiw]+[sz]?h?|jerv\w*|jarv\w*|jahav\w*|jehov\w*|jav[aei]?s?|"
    r"charvis|harvis|travis|driver'?s|service|jaan|john|jobiz)\b",
    re.IGNORECASE,
)
SLEEP_RE = re.compile(
    r"\b(go\s*to\s*sleep|goodnight|good\s*night|stop\s*listening|"
    r"that'?s\s*all(?:\s*for\s*now)?|sleep\s*now|you\s*can\s*sleep)\b",
    re.IGNORECASE,
)

SAMPLE_RATE = 16000
CHUNK_FRAMES = 1600  # 100ms at 16kHz mono 16-bit — a realistic live-mic chunk size


class DeepgramListener:
    """Continuous mic -> Deepgram streaming -> brain loop, on a daemon thread."""

    def __init__(self, hub, language: str = "auto") -> None:
        self.hub = hub
        self.language = language
        self.available = False
        self._stop = threading.Event()
        self._client = None
        self._pa = None
        self._pyaudio = None
        # Persistent across sessions, same semantics as native_listener.py.
        self._awake = False
        self._last_cmd = ""
        self._last_cmd_at = 0.0

        import os

        key = os.environ.get("DEEPGRAM_API_KEY", "").strip()
        if not key:
            log.warning("DEEPGRAM_API_KEY not set; Deepgram listener unavailable")
            return
        try:
            import pyaudio
            from deepgram import DeepgramClient

            self._pyaudio = pyaudio
            self._pa = pyaudio.PyAudio()
            self._pa.get_default_input_device_info()  # raises if no mic
            self._client = DeepgramClient(api_key=key)
            self.available = True
        except Exception:  # noqa: BLE001
            log.warning("Deepgram/mic unavailable; falling back to Scribe listener", exc_info=True)

    # ------------------------------------------------------------------ api

    def start(self) -> bool:
        if not self.available:
            return False
        threading.Thread(target=self._run, daemon=True).start()
        return True

    def stop(self) -> None:
        self._stop.set()

    # ------------------------------------------------------------- internals

    def _run(self) -> None:
        log.info("Deepgram listener online (streaming); waiting for the wake word")
        while not self._stop.is_set():
            # Never open a session while JARVIS is talking, or the mic starts
            # streaming its own voice back to Deepgram as if it were a command.
            while self.hub.speaking and not self._stop.is_set():
                time.sleep(0.1)
            if self._stop.is_set():
                break
            try:
                self._listen_session()
            except Exception:  # noqa: BLE001
                log.exception("Deepgram session error; reconnecting")
                time.sleep(0.5)

    def _dg_language(self) -> str:
        # Deepgram wants a real language code; "auto" isn't one for nova-3
        # streaming. Multi/auto-detect is a separate feature — default to
        # English until that's built.
        return "en" if self.language in ("auto", "", None) else self.language

    def _listen_session(self) -> None:
        """One streaming connection: open mic + Deepgram, react to results,
        end the session cleanly after one finished utterance or on interrupt."""
        stream = self._pa.open(
            format=self._pyaudio.paInt16,
            channels=1,
            rate=SAMPLE_RATE,
            input=True,
            frames_per_buffer=CHUNK_FRAMES,
        )
        stop_session = threading.Event()
        segments: list[str] = []

        try:
            with self._client.listen.v1.connect(
                model="nova-3",
                language=self._dg_language(),
                encoding="linear16",
                sample_rate=SAMPLE_RATE,
                channels=1,
                interim_results=True,
                smart_format=True,
                punctuate=True,
                endpointing=300,
                utterance_end_ms=1500,
                vad_events=True,
            ) as connection:

                def sender() -> None:
                    while not stop_session.is_set() and not self._stop.is_set():
                        if self.hub.speaking:
                            break
                        try:
                            data = stream.read(CHUNK_FRAMES, exception_on_overflow=False)
                        except Exception:  # noqa: BLE001
                            break
                        try:
                            connection.send_media(self._boost(data))
                        except Exception:  # noqa: BLE001
                            break
                    try:
                        connection.send_close_stream()
                    except Exception:  # noqa: BLE001
                        pass

                threading.Thread(target=sender, daemon=True).start()

                # Deepgram finalizes each natural speech segment as soon as it
                # detects a pause (endpointing=300), which is far shorter than
                # a person's mid-sentence pauses/fillers. Treating the first
                # is_final as "the user is done talking" split one continuous
                # thought into several disconnected fragments. Instead, we
                # accumulate every is_final segment and only act once
                # UtteranceEnd fires — Deepgram's dedicated signal that the
                # speaker has actually stopped.
                for msg in connection:
                    if self._stop.is_set() or self.hub.speaking:
                        stop_session.set()
                        break
                    cls = type(msg).__name__
                    if cls == "ListenV1Results" and msg.is_final:
                        alts = msg.channel.alternatives if msg.channel else []
                        text = (alts[0].transcript or "").strip() if alts else ""
                        if text:
                            segments.append(text)
                    elif cls == "ListenV1UtteranceEnd":
                        full = " ".join(segments).strip()
                        segments = []
                        if full:
                            self._handle(full)
                            stop_session.set()
                            break
        finally:
            stop_session.set()
            try:
                stream.stop_stream()
                stream.close()
            except Exception:  # noqa: BLE001
                pass

    # Light safety-net boost, only for the quietest chunks. Deepgram's own
    # normalization handles this machine's quiet mic (~130-500 raw peak) with
    # 98-100% confidence unboosted — verified directly before building this.
    # Only right at the extreme edge (~100-150 peak) did accuracy start to
    # slip, so a small fixed boost there is enough; nothing like the heavy
    # adaptive gain native_listener.py needed for Scribe.
    _QUIET_FLOOR = 200
    _QUIET_GAIN = 3.0

    def _boost(self, chunk: bytes) -> bytes:
        try:
            import audioop

            peak = audioop.max(chunk, 2)
            if 0 < peak < self._QUIET_FLOOR:
                return audioop.mul(chunk, 2, self._QUIET_GAIN)
        except Exception:  # noqa: BLE001
            pass
        return chunk

    # ---------------------------------------------------- state machine
    # Identical logic to native_listener.py's _handle/_dispatch/_go_to_sleep —
    # kept in sync deliberately; this is the same well-tested state machine,
    # just fed by streaming Deepgram finals instead of a recorded utterance.

    def _handle(self, text: str) -> None:
        now = time.monotonic()
        has_wake = bool(WAKE_RE.search(text))
        has_sleep = bool(SLEEP_RE.search(text))
        log.info("heard %r  (wake=%s, awake=%s, sleep=%s)", text, has_wake, self._awake, has_sleep)
        if text == self._last_cmd and now - self._last_cmd_at < 4:
            return

        if self._awake:
            if has_sleep:
                self._go_to_sleep()
                return
            command = WAKE_RE.sub(" ", text) if has_wake else text
            command = re.sub(r"\s+", " ", command).strip(" ,.-").strip()
            if command:
                self._dispatch(command)
            return

        if not has_wake:
            return

        command = WAKE_RE.sub(" ", text)
        command = re.sub(r"\s+", " ", command).strip(" ,.-").strip()
        self._awake = True
        if has_sleep and not command.strip():
            self._go_to_sleep()
        elif command:
            self._dispatch(command)
        else:
            self.hub.wake()
            time.sleep(0.5)

    def _go_to_sleep(self) -> None:
        self._awake = False
        self.hub.announce("Going to sleep, boss. Say Hey Jarvis when you need me.")
        time.sleep(0.5)

    def _dispatch(self, command: str) -> None:
        self._last_cmd = command
        self._last_cmd_at = time.monotonic()
        self.hub.cast({"type": "user_said", "text": command})
        while self.hub.busy and not self._stop.is_set():
            time.sleep(0.1)
        self.hub.handle_command(command, want_audio=True)
