"""Voice layer: streaming conversation logic, independent of any audio vendor.

The pure-logic core lives here and is fully tested without a microphone:

    chunker.Chunker      cut a token stream into speakable chunks, early
    state.Conversation   turn state and barge-in, including spoken-vs-generated
    router.route         pick the smallest capable model, or skip the model
    engines              Protocols for STT/TTS, plus test doubles

Audio capture and playback are deliberately not implemented here — they are the
vendor-specific half, behind `engines.SpeechRecognizer` / `SpeechSynthesizer`.
"""
from .chunker import Chunker
from .engines import (
    NullSynthesizer,
    ScriptedRecognizer,
    SpeechRecognizer,
    SpeechSynthesizer,
    Transcript,
)
from .openai_realtime import RealtimeError, RealtimeSession, Tool
from .router import Route, Tier, route
from .state import Conversation, Event, State, Turn
from .tools import VOICE_INSTRUCTIONS, Task, TaskRunner, build_tools

__all__ = [
    "Chunker",
    "Conversation",
    "Event",
    "NullSynthesizer",
    "RealtimeError",
    "RealtimeSession",
    "Route",
    "ScriptedRecognizer",
    "SpeechRecognizer",
    "SpeechSynthesizer",
    "State",
    "Task",
    "TaskRunner",
    "Tier",
    "Tool",
    "Transcript",
    "Turn",
    "VOICE_INSTRUCTIONS",
    "build_tools",
    "route",
]
