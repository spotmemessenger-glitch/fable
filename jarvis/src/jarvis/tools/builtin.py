"""The starting set of tools.

Deliberately small. Each one is something the assistant genuinely needs on day
one; everything else can be added once it is clear what gets used.
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

from ..memory import Memory
from .registry import Risk, ToolError, registry

_memory: Memory | None = None
_root: Path | None = None

# Reading a file is safe; writing or executing is not. Both are still confined
# to the workspace so a confused agent cannot wander into system directories.
MAX_READ_BYTES = 200_000
COMMAND_TIMEOUT_SECONDS = 120


def bind(memory: Memory, workspace_root: Path) -> None:
    """Give the tools their dependencies. Call once at startup."""
    global _memory, _root
    _memory = memory
    _root = workspace_root.resolve()


def _mem() -> Memory:
    if _memory is None:
        raise ToolError("memory is not initialised; call tools.builtin.bind() first")
    return _memory


def _resolve_in_workspace(raw: str) -> Path:
    """Resolve a path and refuse anything outside the workspace.

    Uses the resolved path for the containment check so that symlinks and
    ../.. traversal cannot escape.
    """
    if _root is None:
        raise ToolError("workspace root is not initialised")
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = _root / candidate
    resolved = candidate.resolve()
    if resolved != _root and _root not in resolved.parents:
        raise ToolError(
            f"path {raw!r} is outside the workspace ({_root}) and is not accessible"
        )
    return resolved


# --------------------------------------------------------------------- memory


@registry.register(
    "remember",
    "Save a durable fact about the owner or their world so you still know it in "
    "future conversations. Use for preferences, projects, people, decisions, and "
    "recurring context. Do not use for things that only matter right now.",
    {
        "type": "object",
        "properties": {
            "subject": {
                "type": "string",
                "description": "Short key for the fact, e.g. 'preferred editor'. "
                "Saving the same subject again replaces the old value.",
            },
            "content": {"type": "string", "description": "The fact itself."},
            "category": {
                "type": "string",
                "enum": ["preference", "project", "person", "decision", "general"],
                "description": "How to classify it.",
            },
        },
        "required": ["subject", "content"],
    },
)
def remember(subject: str, content: str, category: str = "general") -> str:
    _mem().remember(subject, content, category)
    return f"Saved: {subject}"


@registry.register(
    "recall",
    "Search your saved facts about the owner. Use when you need to check what you "
    "already know before answering or before asking them to repeat themselves.",
    {
        "type": "object",
        "properties": {"query": {"type": "string", "description": "What to look for."}},
        "required": ["query"],
    },
)
def recall(query: str) -> str:
    facts = _mem().search_facts(query)
    if not facts:
        return f"Nothing saved matching {query!r}."
    return "\n".join(f.render() for f in facts)


@registry.register(
    "forget",
    "Delete what you know about a subject. Use when the owner asks you to forget "
    "something or tells you a saved fact is wrong.",
    {
        "type": "object",
        "properties": {"subject": {"type": "string"}},
        "required": ["subject"],
    },
    risk=Risk.NOTIFY,
)
def forget(subject: str) -> str:
    n = _mem().forget(subject)
    return f"Forgot {n} fact(s) about {subject!r}." if n else f"Nothing saved for {subject!r}."


@registry.register(
    "search_history",
    "Search past conversations for something that was said. Use when the owner "
    "refers to an earlier discussion you don't have in your current context.",
    {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "limit": {"type": "integer", "description": "Max results, default 8."},
        },
        "required": ["query"],
    },
)
def search_history(query: str, limit: int = 8) -> str:
    hits = _mem().search_history(query, limit=max(1, min(limit, 25)))
    if not hits:
        return f"Nothing in past conversations matching {query!r}."
    return "\n".join(f"[{h['when']}] {h['role']}: {h['content'][:300]}" for h in hits)


@registry.register(
    "review_actions",
    "List what you have recently done with tools. Use when the owner asks what you "
    "did while they were away, or to check your own recent behaviour.",
    {
        "type": "object",
        "properties": {"limit": {"type": "integer", "description": "Default 15."}},
    },
)
def review_actions(limit: int = 15) -> str:
    actions = _mem().recent_actions(limit=max(1, min(limit, 50)))
    if not actions:
        return "No actions recorded yet."
    lines = []
    for a in actions:
        flag = "" if a["approved"] else " (DENIED)"
        lines.append(f"[{a['when']}] {a['tool']}{flag} -> {(a['result'] or '')[:150]}")
    return "\n".join(lines)


# ----------------------------------------------------------------- filesystem


@registry.register(
    "list_directory",
    "List files and folders at a path inside the workspace.",
    {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Defaults to the workspace root."}
        },
    },
)
def list_directory(path: str = ".") -> str:
    target = _resolve_in_workspace(path)
    if not target.is_dir():
        raise ToolError(f"{target} is not a directory")
    entries = sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    if not entries:
        return f"{target} is empty."
    lines = []
    for entry in entries[:200]:
        if entry.is_dir():
            lines.append(f"{entry.name}/")
        else:
            try:
                lines.append(f"{entry.name}  ({entry.stat().st_size:,} bytes)")
            except OSError:
                lines.append(entry.name)
    return "\n".join(lines)


@registry.register(
    "read_file",
    "Read a text file inside the workspace.",
    {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    },
)
def read_file(path: str) -> str:
    target = _resolve_in_workspace(path)
    if not target.is_file():
        raise ToolError(f"{target} is not a file")
    if target.stat().st_size > MAX_READ_BYTES:
        raise ToolError(
            f"{target.name} is {target.stat().st_size:,} bytes, over the "
            f"{MAX_READ_BYTES:,} byte limit. Read a smaller file or ask for a summary."
        )
    try:
        return target.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise ToolError(f"{target.name} is not UTF-8 text") from exc


@registry.register(
    "write_file",
    "Write text to a file inside the workspace, creating or overwriting it.",
    {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "content": {"type": "string"},
        },
        "required": ["path", "content"],
    },
    risk=Risk.CONFIRM,
    confirm_prompt="write {path}",
)
def write_file(path: str, content: str) -> str:
    target = _resolve_in_workspace(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    existed = target.exists()
    target.write_text(content, encoding="utf-8")
    verb = "Overwrote" if existed else "Created"
    return f"{verb} {target} ({len(content):,} chars)"


# -------------------------------------------------------------------- system


@registry.register(
    "run_command",
    "Run a shell command in the workspace and return its output. Use for builds, "
    "tests, git, and package managers. Prefer a specific tool when one exists.",
    {
        "type": "object",
        "properties": {
            "command": {"type": "string"},
            "reason": {
                "type": "string",
                "description": "One short line on why, shown to the owner when asking.",
            },
        },
        "required": ["command", "reason"],
    },
    risk=Risk.CONFIRM,
    confirm_prompt="run: {command}",
)
def run_command(command: str, reason: str = "") -> str:
    if _root is None:
        raise ToolError("workspace root is not initialised")
    started = time.monotonic()
    try:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=str(_root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise ToolError(
            f"command timed out after {COMMAND_TIMEOUT_SECONDS}s: {command}"
        ) from None
    elapsed = time.monotonic() - started
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    parts = [f"exit={proc.returncode} in {elapsed:.1f}s"]
    if out:
        parts.append(f"stdout:\n{out[:6000]}")
    if err:
        parts.append(f"stderr:\n{err[:3000]}")
    return "\n".join(parts)


@registry.register(
    "current_time",
    "Get the current local date and time.",
    {"type": "object", "properties": {}},
)
def current_time() -> str:
    return time.strftime("%A %d %B %Y, %H:%M:%S %Z")


@registry.register(
    "system_status",
    "Read live system information: CPU, memory, disk, battery, uptime, network, "
    "and the top processes by resource use. Read-only — cannot start, stop, or "
    "modify anything. Use this for questions like 'how much RAM am I using', "
    "'what's my disk space', 'what's running', or 'is my CPU under load'.",
    {
        "type": "object",
        "properties": {
            "detail": {
                "type": "string",
                "enum": ["summary", "processes"],
                "description": "'summary' (default) for CPU/RAM/disk/battery/uptime; "
                "'processes' to also list the top resource-consuming processes.",
            },
        },
    },
)
def system_status(detail: str = "summary") -> str:
    import psutil

    vm = psutil.virtual_memory()
    disk = psutil.disk_usage("C:\\" if _is_windows() else "/")
    cpu = psutil.cpu_percent(interval=0.3)
    uptime_s = time.time() - psutil.boot_time()
    uptime_h = uptime_s / 3600

    lines = [
        f"CPU: {cpu:.0f}% across {psutil.cpu_count()} cores",
        f"RAM: {vm.percent:.0f}% used ({vm.used / 2**30:.1f} GB of {vm.total / 2**30:.1f} GB)",
        f"Disk: {disk.percent:.0f}% used, {disk.free / 2**30:.1f} GB free",
        f"Uptime: {uptime_h:.1f} hours",
    ]

    battery = getattr(psutil, "sensors_battery", lambda: None)()
    if battery is not None:
        state = "charging" if battery.power_plugged else "on battery"
        lines.append(f"Battery: {battery.percent:.0f}% ({state})")

    if detail == "processes":
        procs = []
        for p in psutil.process_iter(["name", "cpu_percent", "memory_percent"]):
            try:
                procs.append(p.info)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        top = sorted(procs, key=lambda p: p.get("cpu_percent") or 0, reverse=True)[:8]
        lines.append("Top processes by CPU:")
        for p in top:
            lines.append(
                f"  {p['name']}: {p.get('cpu_percent') or 0:.0f}% CPU, "
                f"{p.get('memory_percent') or 0:.1f}% RAM"
            )

    return "\n".join(lines)


def _is_windows() -> bool:
    import platform

    return platform.system() == "Windows"
