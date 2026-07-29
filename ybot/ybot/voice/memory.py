"""Three-layer conversation memory.

    short-term  last N raw turns, verbatim, in RAM        -> immediate context
    working     facts pinned for the current task, in RAM -> what we are doing
    long-term   append-only JSONL on disk                 -> across sessions

Deliberately not a vector database. Voice turns are short and recency-weighted,
so an exact recent window plus keyword recall beats embedding latency on the
one path where latency is audible. Swap `LongTerm.search` for a vector query
(chromadb is installed) if recall quality ever becomes the bottleneck.
"""
from __future__ import annotations

import json
from collections import deque
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

MEMORY_DIR = Path(__file__).resolve().parents[2] / "voice_memory"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(frozen=True)
class Turn:
    role: str          # "user" | "assistant"
    text: str
    ts: str = field(default_factory=_now)
    tags: tuple[str, ...] = ()


class ShortTerm:
    """Verbatim rolling window of the most recent turns."""

    def __init__(self, capacity: int = 12) -> None:
        self._buf: deque[Turn] = deque(maxlen=capacity)

    def add(self, turn: Turn) -> None:
        self._buf.append(turn)

    def recent(self, n: int | None = None) -> list[Turn]:
        turns = list(self._buf)
        return turns if n is None else turns[-n:]

    def clear(self) -> None:
        self._buf.clear()


class Working:
    """Facts pinned for the current task. Survives turns, dies with the task."""

    def __init__(self) -> None:
        self._facts: dict[str, str] = {}
        self.goal: str | None = None

    def pin(self, key: str, value: str) -> None:
        self._facts[key] = value

    def unpin(self, key: str) -> None:
        self._facts.pop(key, None)

    def snapshot(self) -> dict[str, str]:
        return dict(self._facts)

    def reset(self, goal: str | None = None) -> None:
        self._facts.clear()
        self.goal = goal


class LongTerm:
    """Append-only JSONL. Durable, greppable, trivially inspectable."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or (MEMORY_DIR / "longterm.jsonl")
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def add(self, turn: Turn) -> None:
        rec = asdict(turn)
        rec["tags"] = list(turn.tags)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def search(self, query: str, limit: int = 5) -> list[Turn]:
        """Case-insensitive keyword recall, newest first."""
        if not self.path.exists() or not query.strip():
            return []
        needles = [w for w in query.lower().split() if len(w) > 2]
        if not needles:
            return []
        hits: list[Turn] = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue  # a truncated final line must not kill recall
            text = str(rec.get("text", ""))
            if any(n in text.lower() for n in needles):
                hits.append(
                    Turn(
                        rec.get("role", "user"),
                        text,
                        rec.get("ts", ""),
                        tuple(rec.get("tags", [])),
                    )
                )
        return hits[-limit:][::-1]


class MemoryManager:
    """Facade over the three layers. Write once, land in the right places."""

    def __init__(self, longterm_path: Path | None = None, short_capacity: int = 12) -> None:
        self.short = ShortTerm(short_capacity)
        self.working = Working()
        self.long = LongTerm(longterm_path)

    def record(self, role: str, text: str, tags: tuple[str, ...] = ()) -> Turn:
        turn = Turn(role, text, tags=tags)
        self.short.add(turn)
        self.long.add(turn)
        return turn

    def context(self, query: str = "", recent_n: int = 6) -> dict[str, object]:
        """Everything the intent manager needs to interpret the next utterance."""
        return {
            "goal": self.working.goal,
            "facts": self.working.snapshot(),
            "recent": [(t.role, t.text) for t in self.short.recent(recent_n)],
            "recalled": [t.text for t in self.long.search(query)] if query else [],
        }


def demo() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        m = MemoryManager(longterm_path=Path(td) / "lt.jsonl", short_capacity=3)
        m.working.reset(goal="open notepad")
        m.working.pin("app", "notepad")
        for i in range(5):
            m.record("user", f"message about kittens {i}")

        # short-term must evict beyond capacity, long-term must not
        assert len(m.short.recent()) == 3, m.short.recent()
        assert len(m.long.search("kittens", limit=99)) == 5

        ctx = m.context(query="kittens")
        assert ctx["goal"] == "open notepad"
        assert ctx["facts"] == {"app": "notepad"}
        assert ctx["recalled"], "long-term recall returned nothing"

        # a corrupt trailing line must not break recall
        with (Path(td) / "lt.jsonl").open("a", encoding="utf-8") as fh:
            fh.write("{truncated\n")
        assert len(m.long.search("kittens", limit=99)) == 5
    print("memory: ok (short evicts, long persists, corrupt line survived)")


if __name__ == "__main__":
    demo()
