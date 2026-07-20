"""Tests for the parts most likely to break silently.

The history-trimming test guards the specific bug that made the previous JARVIS
start failing after ~10 exchanges: a slice that left an assistant message (or an
orphaned tool_result) at the head of the conversation, which the API rejects.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from jarvis.memory import Memory  # noqa: E402
from jarvis.tools.registry import Registry, Risk  # noqa: E402


# ------------------------------------------------------------------- memory


@pytest.fixture()
def memory(tmp_path: Path) -> Memory:
    return Memory(tmp_path / "test.db")


def test_remember_and_recall(memory: Memory):
    memory.remember("favourite editor", "VS Code", "preference")
    hits = memory.search_facts("editor")
    assert len(hits) == 1
    assert hits[0].content == "VS Code"


def test_remember_supersedes_same_subject(memory: Memory):
    memory.remember("city", "Mumbai")
    memory.remember("city", "Bangalore")
    active = memory.active_facts()
    cities = [f for f in active if f.subject == "city"]
    assert len(cities) == 1
    assert cities[0].content == "Bangalore"
    assert memory.stats()["facts_superseded"] == 1


def test_forget(memory: Memory):
    memory.remember("secret", "value")
    assert memory.forget("secret") == 1
    assert memory.search_facts("secret") == []


def test_fts_survives_punctuation(memory: Memory):
    memory.remember("note", "uses C++ and .NET, e.g. for work")
    # A query full of FTS metacharacters must not raise.
    assert memory.search_facts('what about C++ "stuff" (things)?') is not None


def test_history_search(memory: Memory):
    memory.log_turn("s1", "user", "let's talk about the golden mesh section")
    memory.log_turn("s1", "assistant", "sure, the mesh gradient")
    hits = memory.search_history("golden mesh")
    assert any("golden mesh" in h["content"] for h in hits)


def test_action_audit(memory: Memory):
    memory.log_action("s1", "write_file", {"path": "x.txt"}, "Created x.txt", True)
    memory.log_action("s1", "run_command", {"command": "rm -rf /"}, "denied", False)
    actions = memory.recent_actions()
    assert len(actions) == 2
    assert actions[0]["approved"] is False  # most recent first


# ---------------------------------------------------------- history trimming


class _FakeSettings:
    max_history_pairs = 3  # -> limit of 6 messages


def _trim(history: list[dict]) -> list[dict]:
    """Reimplements Brain._trim_history against a list, to test the invariant
    without constructing a real Anthropic client."""
    from jarvis.brain import Brain

    brain = Brain.__new__(Brain)
    brain.settings = _FakeSettings()
    brain._history = history
    brain._trim_history()
    return brain._history


def test_trim_keeps_head_valid_after_many_turns():
    # Simulate 20 alternating turns — the scenario that broke the old version.
    history: list[dict] = []
    for i in range(20):
        history.append({"role": "user", "content": f"u{i}"})
        history.append({"role": "assistant", "content": f"a{i}"})
    trimmed = _trim(history)

    assert trimmed, "history should not be emptied"
    assert trimmed[0]["role"] == "user", "first message must be a user turn"
    assert len(trimmed) <= 6


def test_trim_drops_orphaned_tool_result_at_head():
    # A tool_result whose tool_use has been trimmed away must not lead.
    history = [
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "x", "content": "r"}]},
        {"role": "assistant", "content": "ok"},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
    ]
    trimmed = _trim(history)
    assert trimmed[0]["role"] == "user"
    first = trimmed[0]["content"]
    if isinstance(first, list):
        assert not any(b.get("type") == "tool_result" for b in first)


def test_trim_handles_short_history():
    history = [{"role": "user", "content": "hi"}]
    assert _trim(history) == history


# ----------------------------------------------------------------- registry


def test_registry_blocks_blocked_tools():
    reg = Registry()

    @reg.register("danger", "nope", {"type": "object", "properties": {}}, risk=Risk.BLOCKED)
    def danger() -> str:
        return "should never run"

    assert reg.run("danger", {}).startswith("Error:")
    # Blocked tools are hidden from the model entirely.
    assert all(s["name"] != "danger" for s in reg.specs())


def test_registry_reports_unknown_tool():
    reg = Registry()
    assert "no tool named" in reg.run("ghost", {})


def test_registry_surfaces_handler_errors():
    reg = Registry()

    @reg.register("boom", "raises", {"type": "object", "properties": {}})
    def boom() -> str:
        raise ValueError("kaboom")

    assert "kaboom" in reg.run("boom", {})
