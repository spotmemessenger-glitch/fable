"""Fully autonomous native voice listener.

Runs entirely on this machine — no browser, no permission popup, no clicking.
It listens on the microphone continuously in a background thread:

  1. captures each utterance with energy-based silence detection
  2. transcribes it with ElevenLabs Scribe (accurate on accented English)
  3. if it contains the wake word, plays a spoken acknowledgement, then treats
     the rest of that phrase — or the next utterance — as the command
  4. runs the command through the brain and speaks the reply

Everything is driven through the same hub the HUD uses, so the on-screen console
and the audio-reactive core light up in sync with the spoken conversation.
"""

from __future__ import annotations

import audioop
import logging
import re
import threading
import time

log = logging.getLogger(__name__)

# Wake word — deliberately generous, because speech-to-text mangles "Jarvis"
# badly across accents: Jahavah, Jehovah, Java's, Javis, Jervis, Driver's, etc.
# Better to wake on a near-miss than to ignore the owner. Matches an optional
# lead-in (hey/hi/ok/a) then almost any j-word that sounds like Jarvis.
WAKE_RE = re.compile(
    r"\b(?:hey|hi|ok|okay|a|jai)?\s*"
    r"(?:j[aeu][hr]?[aveiw]+[sz]?h?|jerv\w*|jarv\w*|jahav\w*|jehov\w*|jav[aei]?s?|"
    r"charvis|harvis|travis|driver'?s|service|jaan|john)\b",
    re.IGNORECASE,
)
# Puts JARVIS back to sleep (wake word required again). Plain English, not
# fuzzy like WAKE_RE, since these words aren't as prone to accent-mangling.
SLEEP_RE = re.compile(
    r"\b(go\s*to\s*sleep|goodnight|good\s*night|stop\s*listening|"
    r"that'?s\s*all(?:\s*for\s*now)?|sleep\s*now|you\s*can\s*sleep)\b",
    re.IGNORECASE,
)


class NativeListener:
    """Continuous mic → Scribe → brain loop, on a daemon thread."""

    def __init__(self, hub, language: str = "auto") -> None:
        self.hub = hub
        self.language = language
        self.available = False
        self._stop = threading.Event()
        self._sr = None
        self._recognizer = None
        self._mic = None
        # Once woken, stays attentive indefinitely — every utterance is a
        # command, no need to repeat "Hey Jarvis" — until a sleep phrase is
        # heard. This is a persistent state, not a timeout.
        self._awake = False
        self._last_cmd = ""
        self._last_cmd_at = 0.0

        try:
            import speech_recognition as sr

            self._sr = sr
            r = sr.Recognizer()
            # This machine's mic input level runs very low (measured peak
            # ~100-300 out of 32767) — a threshold tuned for a normal mic
            # would never trigger. Start low and let dynamic adjustment tune
            # up from there rather than down from an unreachable value.
            r.energy_threshold = 50
            r.dynamic_energy_threshold = True
            r.dynamic_energy_ratio = 1.3
            r.pause_threshold = 1.3
            r.non_speaking_duration = 0.6
            self._recognizer = r
            self._mic = sr.Microphone()
            self.available = True
            try:
                names = sr.Microphone.list_microphone_names()
                idx = self._mic.device_index
                log.info(
                    "using mic device #%s: %r  (all inputs: %s)",
                    idx, names[idx] if idx is not None and idx < len(names) else "default",
                    ", ".join(f"{i}:{n}" for i, n in enumerate(names)),
                )
            except Exception:  # noqa: BLE001
                pass
        except Exception:  # noqa: BLE001
            log.warning("Native mic unavailable; browser voice remains the input")

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
        try:
            with self._mic as source:
                self._recognizer.adjust_for_ambient_noise(source, duration=1.0)
        except Exception:  # noqa: BLE001
            log.warning("Ambient calibration failed; using defaults")
        log.info("Native listener online; waiting for the wake word")

        while not self._stop.is_set():
            # Never START listening while JARVIS is talking — recognizer.listen()
            # blocks until speech-like audio arrives, so if we call it while
            # speech is about to start, it captures JARVIS's own voice off the
            # speakers as if it were the owner's command. Wait it out first.
            while self.hub.speaking and not self._stop.is_set():
                time.sleep(0.1)
            audio = self._capture()
            if audio is None:
                continue
            # Also drop anything that finished capturing while JARVIS started
            # speaking mid-utterance (rare, but the check above alone can't
            # catch a race that begins after listen() is already blocking).
            if self.hub.speaking:
                continue
            audio = self._boost(audio)
            text = self._transcribe(audio)
            if text:
                self._handle(text)
            else:
                log.info("captured audio but no transcript came back")

    # Target peak amplitude (of int16 range 32767) after boosting. This
    # machine's mic runs unusually quiet at the hardware/driver level even
    # with Windows' own volume at 100% (measured peak ~100-300 raw) — likely
    # "Microphone Boost" disabled in the driver, which isn't reachable from
    # here. A high software gain cap compensates fully in code instead.
    _TARGET_PEAK = 19000
    _MAX_GAIN = 250.0
    _NOISE_FLOOR = 12  # below this raw peak, treat as silence — don't amplify hiss

    def _boost(self, audio):
        """Digitally amplify quiet audio before it reaches the transcriber.

        This machine's microphone input runs very quiet at the OS level
        (peak ~100-300/32767 measured directly). Rather than depend on the
        user finding and raising a Windows mixer slider, boost the signal in
        software so a normal speaking voice reaches a level Scribe can
        actually parse. Silence stays silence — gain is clamped, so this
        does not manufacture speech from noise.
        """
        try:
            raw = audio.get_raw_data()
            peak = audioop.max(raw, audio.sample_width) or 1
            rms = audioop.rms(raw, audio.sample_width)
            dur = len(raw) / (audio.sample_rate * audio.sample_width)
            if peak < self._NOISE_FLOOR:
                log.info("captured %.1fs, peak=%d — below noise floor, skipping", dur, peak)
                return audio
            gain = min(self._MAX_GAIN, max(1.0, self._TARGET_PEAK / peak))
            boosted = audioop.mul(raw, audio.sample_width, gain)
            log.info(
                "captured %.1fs, peak=%d rms=%d -> gain x%.1f (boosted peak=%d)",
                dur, peak, rms, gain, min(32767, peak * gain),
            )
            return self._sr.AudioData(boosted, audio.sample_rate, audio.sample_width)
        except Exception:  # noqa: BLE001
            log.exception("gain boost failed; using raw audio")
            return audio

    def _capture(self):
        try:
            with self._mic as source:
                return self._recognizer.listen(
                    source, timeout=None, phrase_time_limit=15
                )
        except Exception:  # noqa: BLE001
            log.exception("Mic capture failed; retrying")
            time.sleep(0.5)
            return None

    def _transcribe(self, audio) -> str | None:
        """Prefer Scribe (accurate); fall back to the free recognizer."""
        try:
            wav = audio.get_wav_data()
        except Exception:  # noqa: BLE001
            wav = None
        if wav and self.hub.stt is not None:
            text = self.hub.stt(wav, mime="audio/wav")
            if text:
                return text.strip()
        # fallback
        try:
            return (self._recognizer.recognize_google(audio) or "").strip() or None
        except Exception:  # noqa: BLE001
            return None

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
            # Already attentive — everything heard is a command. The wake
            # word is optional here; strip it if present out of habit.
            command = WAKE_RE.sub(" ", text) if has_wake else text
            command = re.sub(r"\s+", " ", command).strip(" ,.-").strip()
            if command:
                self._dispatch(command)
            return

        if not has_wake:
            return  # asleep, no wake word — ignore ambient chatter

        command = WAKE_RE.sub(" ", text)
        command = re.sub(r"\s+", " ", command).strip(" ,.-").strip()
        self._awake = True
        if has_sleep and not command.strip():
            # "Hey Jarvis, go to sleep" in the same breath as waking.
            self._go_to_sleep()
        elif command:
            self._dispatch(command)
        else:
            # bare wake word: acknowledge, stay attentive until told to sleep
            self.hub.wake()
            # hub.wake() replies on a background thread; give it a moment to
            # actually start speaking before we loop back to listening, or
            # we'll capture the start of our own acknowledgement.
            time.sleep(0.5)

    def _go_to_sleep(self) -> None:
        self._awake = False
        self.hub.announce("Going to sleep, boss. Say Hey Jarvis when you need me.")
        time.sleep(0.5)

    def _dispatch(self, command: str) -> None:
        self._last_cmd = command
        self._last_cmd_at = time.monotonic()
        self.hub.cast({"type": "user_said", "text": command})
        # wait for any acknowledgement audio to clear, then run the command
        while self.hub.busy and not self._stop.is_set():
            time.sleep(0.1)
        self.hub.handle_command(command, want_audio=True)
