"""Persistent memory backed by SQLite with full-text search.

Two kinds of memory, deliberately separated:

  facts    — durable statements about the user and their world. Small, curated,
             injected into the system prompt on every turn. This is what makes
             the assistant feel like it knows you.
  episodes — the raw conversation log. Large, searchable on demand, never
             loaded wholesale.

SQLite with FTS5 was chosen over a vector database because it ships with
Python, needs no server, no embedding model, and no API calls. Semantic search
can be layered on later without changing this interface.
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS facts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    subject     TEXT NOT NULL,
    content     TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT 'general',
    confidence  REAL NOT NULL DEFAULT 1.0,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL,
    superseded  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject) WHERE superseded = 0;
CREATE INDEX IF NOT EXISTS idx_facts_active  ON facts(superseded, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    subject, content, category,
    content='facts', content_rowid='id', tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, subject, content, category)
    VALUES (new.id, new.subject, new.content, new.category);
END;

CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, subject, content, category)
    VALUES ('delete', old.id, old.subject, old.content, old.category);
END;

CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, subject, content, category)
    VALUES ('delete', old.id, old.subject, old.content, old.category);
    INSERT INTO facts_fts(rowid, subject, content, category)
    VALUES (new.id, new.subject, new.content, new.category);
END;

CREATE TABLE IF NOT EXISTS episodes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id, id);

CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
    content, content='episodes', content_rowid='id', tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
    INSERT INTO episodes_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS actions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tool       TEXT NOT NULL,
    arguments  TEXT NOT NULL,
    result     TEXT,
    approved   INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_actions_time ON actions(created_at DESC);
"""


@dataclass(frozen=True)
class Fact:
    id: int
    subject: str
    content: str
    category: str
    updated_at: float

    def render(self) -> str:
        return f"- [{self.category}] {self.subject}: {self.content}"


class Memory:
    """Durable store for facts, conversation history, and an action audit log."""

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    # ---------------------------------------------------------------- facts

    def remember(
        self,
        subject: str,
        content: str,
        category: str = "general",
        confidence: float = 1.0,
    ) -> int:
        """Store a fact, superseding any existing active fact on the same subject.

        Superseding rather than overwriting keeps the history — useful when the
        assistant gets something wrong and you want to see what it believed.
        """
        now = time.time()
        subject = subject.strip()
        with self._conn:
            self._conn.execute(
                "UPDATE facts SET superseded = 1, updated_at = ? "
                "WHERE subject = ? COLLATE NOCASE AND superseded = 0",
                (now, subject),
            )
            cursor = self._conn.execute(
                "INSERT INTO facts (subject, content, category, confidence, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (subject, content.strip(), category.strip() or "general", confidence, now, now),
            )
        return int(cursor.lastrowid)

    def forget(self, subject: str) -> int:
        """Mark every active fact on a subject as superseded. Returns rows affected."""
        with self._conn:
            cursor = self._conn.execute(
                "UPDATE facts SET superseded = 1, updated_at = ? "
                "WHERE subject = ? COLLATE NOCASE AND superseded = 0",
                (time.time(), subject.strip()),
            )
        return cursor.rowcount

    def active_facts(self, limit: int = 60) -> list[Fact]:
        rows = self._conn.execute(
            "SELECT id, subject, content, category, updated_at FROM facts "
            "WHERE superseded = 0 ORDER BY updated_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [Fact(**dict(row)) for row in rows]

    def search_facts(self, query: str, limit: int = 10) -> list[Fact]:
        match = _fts_query(query)
        if not match:
            return []
        rows = self._conn.execute(
            "SELECT f.id, f.subject, f.content, f.category, f.updated_at "
            "FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid "
            "WHERE facts_fts MATCH ? AND f.superseded = 0 "
            "ORDER BY rank LIMIT ?",
            (match, limit),
        ).fetchall()
        return [Fact(**dict(row)) for row in rows]

    # ------------------------------------------------------------- episodes

    def log_turn(self, session_id: str, role: str, content: str) -> None:
        if not content.strip():
            return
        with self._conn:
            self._conn.execute(
                "INSERT INTO episodes (session_id, role, content, created_at) "
                "VALUES (?, ?, ?, ?)",
                (session_id, role, content, time.time()),
            )

    def recent_turns(self, session_id: str, limit: int = 20) -> list[dict[str, str]]:
        rows = self._conn.execute(
            "SELECT role, content FROM episodes WHERE session_id = ? "
            "ORDER BY id DESC LIMIT ?",
            (session_id, limit),
        ).fetchall()
        return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]

    def search_history(self, query: str, limit: int = 10) -> list[dict[str, str]]:
        match = _fts_query(query)
        if not match:
            return []
        rows = self._conn.execute(
            "SELECT e.role, e.content, e.created_at FROM episodes_fts "
            "JOIN episodes e ON e.id = episodes_fts.rowid "
            "WHERE episodes_fts MATCH ? ORDER BY rank LIMIT ?",
            (match, limit),
        ).fetchall()
        return [
            {
                "role": r["role"],
                "content": r["content"],
                "when": time.strftime("%Y-%m-%d %H:%M", time.localtime(r["created_at"])),
            }
            for r in rows
        ]

    # --------------------------------------------------------------- audit

    def log_action(
        self,
        session_id: str,
        tool: str,
        arguments: dict,
        result: str | None = None,
        approved: bool = True,
    ) -> None:
        """Record every tool invocation so you can review what it did unattended."""
        with self._conn:
            self._conn.execute(
                "INSERT INTO actions (session_id, tool, arguments, result, approved, "
                "created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    tool,
                    json.dumps(arguments, ensure_ascii=False, default=str)[:4000],
                    (result or "")[:4000],
                    int(approved),
                    time.time(),
                ),
            )

    def recent_actions(self, limit: int = 30) -> list[dict]:
        rows = self._conn.execute(
            "SELECT tool, arguments, result, approved, created_at FROM actions "
            "ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [
            {
                "tool": r["tool"],
                "arguments": r["arguments"],
                "result": r["result"],
                "approved": bool(r["approved"]),
                "when": time.strftime("%Y-%m-%d %H:%M", time.localtime(r["created_at"])),
            }
            for r in rows
        ]

    def stats(self) -> dict[str, int]:
        def count(table: str, where: str = "") -> int:
            sql = f"SELECT COUNT(*) AS n FROM {table} {where}"
            return int(self._conn.execute(sql).fetchone()["n"])

        return {
            "facts": count("facts", "WHERE superseded = 0"),
            "facts_superseded": count("facts", "WHERE superseded = 1"),
            "episodes": count("episodes"),
            "actions": count("actions"),
        }


def _fts_query(raw: str) -> str:
    """Turn free text into a safe FTS5 query.

    FTS5 treats a pile of punctuation as syntax and raises on malformed input,
    so each word is quoted and joined with OR. Quoting also stops a stray
    double-quote in user speech from breaking the query.
    """
    words = [w.strip('"').strip() for w in raw.split()]
    terms = [f'"{w}"' for w in words if len(w) > 1 and any(c.isalnum() for c in w)]
    return " OR ".join(terms)
