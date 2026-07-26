"""Ybot's graphify integration: query a codebase knowledge graph.

Graphify's graph-BUILDING step is agent-orchestrated (structural AST extraction run
in parallel with LLM-driven semantic extraction, merged by a host agent like Claude
Code) — not a single CLI call, so it isn't faithfully replicable as a Ybot subprocess
wrapper. This module wraps the parts that ARE plain deterministic CLI commands:
querying a graph.json that already exists (built earlier by Claude Code via
`/graphify .`, or any other graphify-compatible host).
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def _graphify_exe() -> str:
    found = shutil.which("graphify")
    return found or "graphify"


def available() -> bool:
    try:
        subprocess.run([_graphify_exe(), "--help"], capture_output=True, timeout=10)
        return True
    except Exception:
        return False


def _run(args: list[str], graph_path: str | None = None, timeout: int = 30) -> dict:
    cmd = [_graphify_exe(), *args]
    if graph_path:
        cmd += ["--graph", graph_path]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return {"ok": proc.returncode == 0, "output": (proc.stdout or "") + (proc.stderr or "")}
    except Exception as e:
        return {"ok": False, "output": f"{type(e).__name__}: {e}"}


def path(a: str, b: str, graph_path: str | None = None) -> dict:
    """Shortest path between two nodes in an existing graph.json."""
    return _run(["path", a, b], graph_path)


def explain(node: str, graph_path: str | None = None) -> dict:
    """Plain-language explanation of a node and its neighbors."""
    return _run(["explain", node], graph_path)


def has_graph(project_dir: str) -> bool:
    return (Path(project_dir) / "graphify-out" / "graph.json").exists()
