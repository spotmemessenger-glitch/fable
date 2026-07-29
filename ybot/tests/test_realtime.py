"""OpenAI Realtime protocol handling — no socket, no microphone, no API key.

The session is fed scripted server events and its outbound events are captured,
so the behaviour that decides whether the voice feels right is verifiable here.
"""
from __future__ import annotations

import base64
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ybot.voice.openai_realtime import (  # noqa: E402
    SAMPLE_RATE,
    RealtimeError,
    RealtimeSession,
    Tool,
    audio_ms,
)
from ybot.voice.state import State  # noqa: E402
from ybot.voice.tools import TaskRunner, build_tools  # noqa: E402


def pcm(ms: int) -> bytes:
    """`ms` milliseconds of silence as PCM16 mono."""
    return b"\x00\x00" * int(SAMPLE_RATE * ms / 1000)


def audio_delta(ms: int) -> dict:
    return {"type": "response.audio.delta", "delta": base64.b64encode(pcm(ms)).decode()}


class Harness:
    def __init__(self, **kw):
        self.sent: list[dict] = []
        self.played: list[bytes] = []
        self.stops = 0
        self.session = RealtimeSession(
            send=self.sent.append,
            play=self.played.append,
            stop_audio=self._stop,
            **kw,
        )

    def _stop(self) -> None:
        self.stops += 1

    def feed(self, *events: dict) -> None:
        for e in events:
            self.session.handle(e)

    def types(self) -> list[str]:
        return [e["type"] for e in self.sent]

    def last(self, type_: str) -> dict:
        return next(e for e in reversed(self.sent) if e["type"] == type_)


# --- session setup ---------------------------------------------------------

def test_start_configures_server_vad_and_tools():
    h = Harness(tools={"t": Tool("t", "d", {"type": "object"}, lambda a: "ok")})
    h.session.start()
    cfg = h.last("session.update")["session"]
    assert cfg["audio"]["input"]["turn_detection"]["type"] == "server_vad"
    assert [t["name"] for t in cfg["tools"]] == ["t"]


def test_audio_ms_conversion():
    assert audio_ms(len(pcm(500))) == 500


# --- playback and state ----------------------------------------------------

def test_audio_deltas_reach_the_speaker():
    h = Harness()
    h.feed({"type": "response.created"}, audio_delta(100))
    assert h.played and h.session.convo.state is State.SPEAKING


def test_response_done_completes_the_turn():
    h = Harness()
    h.feed(
        {"type": "response.created"},
        audio_delta(50),
        {"type": "response.audio_transcript.done", "transcript": "All done."},
        {"type": "response.done"},
    )
    turn = h.session.convo.history[-1]
    assert not turn.interrupted and turn.reply_text == "All done."


# --- barge-in --------------------------------------------------------------

def test_barge_in_stops_playback_and_truncates_to_what_was_heard():
    """The server knows what it sent; only we know what was played."""
    h = Harness()
    h.feed(
        {"type": "response.created"},
        {"type": "response.output_item.added", "item": {"type": "message", "id": "msg_1"}},
        audio_delta(300),
        {"type": "input_audio_buffer.speech_started"},
    )

    assert h.stops == 1, "playback must be cut immediately"
    trunc = h.last("conversation.item.truncate")
    assert trunc["item_id"] == "msg_1"
    assert trunc["audio_end_ms"] == 300, "must report PLAYED audio, not sent audio"
    assert h.session.convo.state is State.LISTENING


def test_barge_in_cancels_the_in_flight_response():
    h = Harness()
    h.feed(
        {"type": "response.created"},
        {"type": "response.output_item.added", "item": {"type": "message", "id": "m"}},
        audio_delta(100),
        {"type": "input_audio_buffer.speech_started"},
    )
    assert "response.cancel" in h.types()


def test_no_truncate_when_nothing_was_played():
    """Interrupting during thinking must not claim audio was heard."""
    h = Harness()
    h.feed({"type": "response.created"}, {"type": "input_audio_buffer.speech_started"})
    assert "conversation.item.truncate" not in h.types()


def test_speech_start_while_idle_is_not_a_barge_in():
    h = Harness()
    h.feed({"type": "input_audio_buffer.speech_started"})
    assert h.stops == 0 and "response.cancel" not in h.types()


# --- function calling ------------------------------------------------------

def test_tool_call_runs_and_returns_output():
    calls = []
    tool = Tool("open_app", "d", {"type": "object"}, lambda a: f"opened {a['name']}")
    h = Harness(tools={"open_app": tool})
    h.feed({
        "type": "response.function_call_arguments.done",
        "call_id": "c1", "name": "open_app", "arguments": '{"name": "notepad"}',
    })

    item = h.last("conversation.item.create")["item"]
    assert item["call_id"] == "c1" and item["output"] == "opened notepad"
    assert h.types()[-1] == "response.create", "model must be prompted to speak the result"


def test_streamed_tool_arguments_are_reassembled():
    h = Harness(tools={"t": Tool("t", "d", {"type": "object"}, lambda a: a.get("x", "?"))})
    h.feed(
        {"type": "response.function_call_arguments.delta", "call_id": "c", "delta": '{"x": "he'},
        {"type": "response.function_call_arguments.delta", "call_id": "c", "delta": 'llo"}'},
        {"type": "response.function_call_arguments.done", "call_id": "c", "name": "t"},
    )
    assert h.last("conversation.item.create")["item"]["output"] == "hello"


def test_a_failing_tool_does_not_kill_the_conversation():
    def boom(_args):
        raise RuntimeError("device offline")

    h = Harness(tools={"t": Tool("t", "d", {"type": "object"}, boom)})
    h.feed({"type": "response.function_call_arguments.done",
            "call_id": "c", "name": "t", "arguments": "{}"})
    assert "device offline" in h.last("conversation.item.create")["item"]["output"]
    assert h.types()[-1] == "response.create"


def test_unknown_tool_is_reported_not_crashed():
    h = Harness()
    h.feed({"type": "response.function_call_arguments.done",
            "call_id": "c", "name": "nope", "arguments": "{}"})
    assert "No such tool" in h.last("conversation.item.create")["item"]["output"]


def test_malformed_arguments_do_not_raise():
    h = Harness(tools={"t": Tool("t", "d", {"type": "object"}, lambda a: f"got {a}")})
    h.feed({"type": "response.function_call_arguments.done",
            "call_id": "c", "name": "t", "arguments": "{not json"})
    assert h.last("conversation.item.create")["item"]["output"] == "got {}"


def test_server_error_surfaces():
    h = Harness()
    with pytest.raises(RealtimeError, match="rate limited"):
        h.feed({"type": "error", "error": {"message": "rate limited"}})


def test_unknown_event_is_ignored():
    """New server event types must not crash an older client."""
    Harness().feed({"type": "response.some_future_thing", "x": 1})


# --- background tasks ------------------------------------------------------

def test_desktop_work_does_not_block_the_conversation():
    """A voice assistant that goes silent while working is broken."""
    release = threading.Event()
    runner = TaskRunner(run_goal=lambda g: (release.wait(2), "finished")[1])
    tools = build_tools(runner)

    t0 = time.perf_counter()
    out = tools["do_on_computer"].run({"goal": "open notepad"})
    elapsed = time.perf_counter() - t0

    assert elapsed < 0.2, "must return immediately, not wait for the desktop"
    assert "Started task" in out and "do not claim it is finished" in out
    assert runner.running

    release.set()
    runner.tasks[list(runner.tasks)[0]]._thread.join(timeout=2)
    assert tools["check_task"].run({}) .startswith("done")


def test_failed_task_is_reported_not_swallowed():
    def boom(_goal):
        raise RuntimeError("app crashed")

    runner = TaskRunner(run_goal=boom)
    task = runner.start("do a thing")
    task._thread.join(timeout=2)
    assert task.state == "failed" and "app crashed" in runner.status()


def test_recall_tool_only_exists_when_memory_is_wired():
    assert "recall" not in build_tools(TaskRunner(run_goal=lambda g: ""))
    assert "recall" in build_tools(TaskRunner(run_goal=lambda g: ""), recall=lambda q: "x")


def test_empty_goal_is_rejected_without_starting_work():
    runner = TaskRunner(run_goal=lambda g: "should not run")
    build_tools(runner)["do_on_computer"].run({"goal": "  "})
    assert not runner.tasks
