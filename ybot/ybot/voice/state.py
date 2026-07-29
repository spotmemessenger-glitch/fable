"""Conversation state machine, including barge-in.

Barge-in is what separates a voice assistant from a kiosk: if the user starts
talking while YBot is talking, YBot stops. Immediately, mid-word — a system that
finishes its sentence first feels like it is not listening, and the user repeats
themselves, and both sides end up talking over each other.

The subtlety is that stopping is not enough. Audio already handed to the speaker
is still playing, so what the user *heard* is not what was generated, and the
transcript must be truncated to the spoken prefix — otherwise the model believes
it said things the user never heard and the conversation quietly desynchronises.

Pure state and callbacks; no audio, no threads, no I/O.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable


class State(str, Enum):
    IDLE = "idle"            # nothing happening
    LISTENING = "listening"  # user is speaking
    THINKING = "thinking"    # model is generating, nothing audible yet
    SPEAKING = "speaking"    # audio is playing


class Event(str, Enum):
    SPEECH_START = "speech_start"
    SPEECH_END = "speech_end"
    REPLY_START = "reply_start"
    AUDIO_START = "audio_start"
    REPLY_DONE = "reply_done"
    CANCEL = "cancel"


@dataclass
class Turn:
    """What was said in one exchange. `spoken` is what the user actually heard."""

    user_text: str = ""
    reply_text: str = ""
    spoken: str = ""
    interrupted: bool = False


@dataclass
class Conversation:
    """Tracks state and enforces the transitions that matter.

    on_stop_audio: called the instant a barge-in is detected. Must cut the
        speaker synchronously — anything queued behind it is already too late.
    on_cancel_work: called when a turn is abandoned, so in-flight generation and
        any running tool are torn down rather than left to complete invisibly.
    """

    on_stop_audio: Callable[[], None] = lambda: None
    on_cancel_work: Callable[[], None] = lambda: None

    state: State = State.IDLE
    turn: Turn = field(default_factory=Turn)
    history: list[Turn] = field(default_factory=list)
    barge_ins: int = 0

    def handle(self, event: Event, text: str = "") -> State:
        """Apply an event. Returns the new state."""
        if event is Event.SPEECH_START:
            self._on_speech_start()
        elif event is Event.SPEECH_END:
            if self.state is State.LISTENING:
                self.turn.user_text = text or self.turn.user_text
                self.state = State.IDLE
        elif event is Event.REPLY_START:
            self.state = State.THINKING
        elif event is Event.AUDIO_START:
            if self.state is State.THINKING:
                self.state = State.SPEAKING
        elif event is Event.REPLY_DONE:
            self._finish(interrupted=False)
        elif event is Event.CANCEL:
            self.on_cancel_work()
            self._finish(interrupted=True)
        return self.state

    def spoke(self, text: str) -> None:
        """Record a chunk that has actually been played to the user."""
        self.turn.spoken = f"{self.turn.spoken} {text}".strip()

    def generated(self, text: str) -> None:
        """Record a chunk the model produced, spoken or not."""
        self.turn.reply_text = f"{self.turn.reply_text} {text}".strip()

    # --- internals ---------------------------------------------------------

    def _on_speech_start(self) -> None:
        # The barge-in case: the user talks over us.
        if self.state in (State.SPEAKING, State.THINKING):
            self.barge_ins += 1
            self.on_stop_audio()
            self.on_cancel_work()
            self._finish(interrupted=True)
        self.state = State.LISTENING
        self.turn = Turn()

    def _finish(self, interrupted: bool) -> None:
        turn = self.turn
        turn.interrupted = interrupted
        if interrupted:
            # The model believes it said reply_text; the user only heard `spoken`.
            # Recording the belief instead of the reality is how the two sides
            # drift — the model later refers back to a sentence nobody heard.
            turn.reply_text = turn.spoken
        if turn.user_text or turn.reply_text:
            self.history.append(turn)
        self.turn = Turn()
        self.state = State.IDLE

    @property
    def is_speaking(self) -> bool:
        return self.state is State.SPEAKING

    @property
    def busy(self) -> bool:
        return self.state in (State.THINKING, State.SPEAKING)
