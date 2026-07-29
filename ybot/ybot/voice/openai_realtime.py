"""OpenAI Realtime API session — the ChatGPT voice, wired to ybot's tools.

Realtime is speech-to-speech: it does recognition, reasoning, and synthesis
server-side, with its own VAD. That means it REPLACES the local chunker (audio
arrives already synthesised) and takes over turn detection. What it does not
have is your machine — so ybot keeps the half your spec says it should own:
memory, planning, and the tools that actually do work.

    mic ──audio──> OpenAI Realtime ──audio──> speaker
                        │    ▲
                 function_call │ result
                        ▼    │
                     ybot tools (desktop, browser, files)

This module is the protocol layer and nothing else. It takes a `send` callable
and is fed server events one at a time, so the whole thing is testable with no
socket, no microphone, and no API key. Transport and audio I/O are the caller's
job — see `SESSION_TRANSPORT` at the bottom for the shape.

Event names verified against the openai-python SDK's api.md (Realtime section).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable

from .state import Conversation, Event

MODEL = "gpt-realtime-2"
WS_URL = "wss://api.openai.com/v1/realtime"

# 24 kHz mono PCM16 is the Realtime default in both directions.
SAMPLE_RATE = 24_000
BYTES_PER_SAMPLE = 2


def audio_ms(pcm_bytes: int) -> int:
    """Milliseconds of PCM16 mono audio in a byte count."""
    return int(pcm_bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE) * 1000)


@dataclass
class Tool:
    """A ybot capability exposed to the model as a callable function."""

    name: str
    description: str
    parameters: dict
    run: Callable[[dict], str]

    def schema(self) -> dict:
        return {
            "type": "function",
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }


@dataclass
class RealtimeSession:
    """Drives one Realtime conversation.

    send: serialises a client event to the server (websocket send).
    play: hands decoded PCM to the speaker.
    stop_audio: cuts playback immediately — must be synchronous, or barge-in
        does not work no matter what the server is told.
    """

    send: Callable[[dict], None]
    play: Callable[[bytes], None] = lambda _b: None
    stop_audio: Callable[[], None] = lambda: None
    tools: dict[str, Tool] = field(default_factory=dict)
    instructions: str = ""
    voice: str = "marin"

    convo: Conversation = field(init=False)
    # Audio actually handed to the speaker for the current response. This is the
    # number the server needs on a barge-in: it knows what it SENT, only we know
    # what was PLAYED, and the difference is what the user never heard.
    played_bytes: int = field(default=0, init=False)
    current_item_id: str | None = field(default=None, init=False)
    transcript: str = field(default="", init=False)
    _pending_args: dict[str, str] = field(default_factory=dict, init=False)

    def __post_init__(self) -> None:
        self.convo = Conversation(
            on_stop_audio=self._cut_playback,
            on_cancel_work=lambda: self.send({"type": "response.cancel"}),
        )

    # --- outbound ----------------------------------------------------------

    def start(self) -> None:
        """Configure the session. Server VAD does turn detection for us."""
        self.send({
            "type": "session.update",
            "session": {
                "type": "realtime",
                "output_modalities": ["audio"],
                "instructions": self.instructions,
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                        "turn_detection": {"type": "server_vad", "interrupt_response": True},
                    },
                    "output": {
                        "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                        "voice": self.voice,
                    },
                },
                "tools": [t.schema() for t in self.tools.values()],
            },
        })

    def send_audio(self, pcm: bytes) -> None:
        import base64

        self.send({
            "type": "input_audio_buffer.append",
            "audio": base64.b64encode(pcm).decode(),
        })

    def say(self, text: str) -> None:
        """Inject a spoken line — progress updates while a tool runs."""
        self.send({
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text}],
            },
        })

    # --- inbound -----------------------------------------------------------

    def handle(self, event: dict) -> None:
        """Process one server event."""
        kind = event.get("type", "")
        handler = getattr(self, "_on_" + kind.replace(".", "_"), None)
        if handler is not None:
            handler(event)

    def _on_input_audio_buffer_speech_started(self, _e: dict) -> None:
        """The user started talking. If we were speaking, this is a barge-in."""
        if self.convo.busy:
            self._truncate_to_what_was_heard()
        self.convo.handle(Event.SPEECH_START)

    def _on_input_audio_buffer_speech_stopped(self, _e: dict) -> None:
        self.convo.handle(Event.SPEECH_END)

    def _on_response_created(self, _e: dict) -> None:
        self.convo.handle(Event.REPLY_START)
        self.played_bytes = 0
        self.transcript = ""

    def _on_response_output_item_added(self, e: dict) -> None:
        item = e.get("item") or {}
        if item.get("type") == "message":
            self.current_item_id = item.get("id")

    def _on_response_audio_delta(self, e: dict) -> None:
        import base64

        pcm = base64.b64decode(e.get("delta", ""))
        if not pcm:
            return
        if not self.convo.is_speaking:
            self.convo.handle(Event.AUDIO_START)
        self.play(pcm)
        self.played_bytes += len(pcm)

    def _on_response_audio_transcript_delta(self, e: dict) -> None:
        delta = e.get("delta", "")
        self.transcript += delta
        self.convo.generated(delta)

    def _on_response_audio_transcript_done(self, e: dict) -> None:
        # The authoritative text of the reply. Assigned rather than appended:
        # the deltas above already accumulated it, and appending again would
        # record the sentence twice. Everything transcribed has by now been
        # queued for playback, so it counts as spoken.
        final = e.get("transcript") or self.transcript
        self.transcript = final
        self.convo.turn.reply_text = final
        self.convo.spoke(final)

    def _on_conversation_item_input_audio_transcription_completed(self, e: dict) -> None:
        self.convo.turn.user_text = e.get("transcript", "")

    def _on_response_function_call_arguments_delta(self, e: dict) -> None:
        call_id = e.get("call_id", "")
        self._pending_args[call_id] = self._pending_args.get(call_id, "") + e.get("delta", "")

    def _on_response_function_call_arguments_done(self, e: dict) -> None:
        """Run the tool and hand the result back, then let the model speak it."""
        call_id = e.get("call_id", "")
        name = e.get("name", "")
        raw = e.get("arguments") or self._pending_args.pop(call_id, "") or "{}"
        try:
            args = json.loads(raw)
        except json.JSONDecodeError:
            args = {}

        tool = self.tools.get(name)
        if tool is None:
            output = f"No such tool: {name}"
        else:
            try:
                output = tool.run(args)
            except Exception as exc:  # a failed tool must not kill the conversation
                output = f"Tool {name} failed: {exc}"

        self.send({
            "type": "conversation.item.create",
            "item": {
                "type": "function_call_output",
                "call_id": call_id,
                "output": output,
            },
        })
        self.send({"type": "response.create"})

    def _on_response_done(self, _e: dict) -> None:
        self.convo.handle(Event.REPLY_DONE)
        self.current_item_id = None

    def _on_error(self, e: dict) -> None:
        err = e.get("error") or {}
        raise RealtimeError(err.get("message") or str(e))

    # --- barge-in ----------------------------------------------------------

    def _cut_playback(self) -> None:
        self.stop_audio()

    def _truncate_to_what_was_heard(self) -> None:
        """Tell the server how much of its audio actually reached the user.

        Without this the server keeps the full response in conversation history
        and the model believes it said a tail the user never heard — it then
        refers back to it, and the conversation quietly desynchronises. The
        server knows what it SENT; only we know what was PLAYED.
        """
        if self.current_item_id is None or self.played_bytes <= 0:
            return
        self.send({
            "type": "conversation.item.truncate",
            "item_id": self.current_item_id,
            "content_index": 0,
            "audio_end_ms": audio_ms(self.played_bytes),
        })


class RealtimeError(RuntimeError):
    pass


# --- transport ------------------------------------------------------------
#
# Deliberately not implemented here: it needs a socket, a microphone, and a
# speaker, none of which can be tested in CI. The loop is small:
#
#     from openai import AsyncOpenAI
#     client = AsyncOpenAI(api_key=SETTINGS.openai_api_key)
#     async with client.realtime.connect(model=MODEL) as conn:
#         session = RealtimeSession(
#             send=lambda ev: conn.send(ev),
#             play=speaker.write,          # sounddevice OutputStream
#             stop_audio=speaker.abort,    # MUST drop already-queued audio
#             tools=ybot_tools(),
#         )
#         session.start()
#         async for event in conn:
#             session.handle(event.model_dump())
#
# The one requirement that is easy to get wrong: `stop_audio` must discard
# audio already handed to the output device. A stream that merely stops
# accepting new data keeps playing the buffer, and the user hears the
# assistant talk over them after interrupting.
SESSION_TRANSPORT = __doc__
