"""Crash bridge: Ybot -> Claude Code, with no human in the loop.

Any uncaught exception becomes a structured bundle in crashes/inbox/<id>/ and —
rate-limited — spawns a HEADLESS Claude Code session (`claude -p`) pointed at
that bundle with authority to diagnose and fix. The operator never has to relay
a stack trace; the brain that wrote the code reads the crash directly.

Design rules:
  * The reporter itself must NEVER raise — a crash reporter that crashes is a
    prank, not a tool. Every step is wrapped.
  * No secrets in bundles: environment capture records which key NAMES are set,
    never values.
  * Dedupe by fingerprint (exc type + top frames): a crash loop produces ONE
    triage session and a rising count, not a fleet of Claudes.
  * Spawn budget: max 3 triage sessions per hour, one at a time (.triage.lock).
    Bundles are always written even when a spawn is skipped.

Folder layout (fable/ybot/crashes/):
  ALERTS.md          the active board — my sessions check this via memory
  inbox/<id>/        crash.json, traceback.txt, triage.md (verdict)
  triaged/<id>/      moved here by the triage session when done
  logs/<id>.log      triage session stdout — deliberately OUTSIDE the bundle, so the
                     session holding it open cannot block its own move to triaged/
  .state.json        fingerprints + spawn timestamps (dedupe/budget)
  .triage.lock       pid+ts of the running triage session
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

YBOT_ROOT = Path(__file__).resolve().parent.parent          # .../fable/ybot
CRASHES = YBOT_ROOT / "crashes"
INBOX = CRASHES / "inbox"
LOGS = CRASHES / "logs"
STATE = CRASHES / ".state.json"
LOCK = CRASHES / ".triage.lock"
ALERTS = CRASHES / "ALERTS.md"

DEDUPE_WINDOW_S = 3600        # same fingerprint within an hour = same incident
SPAWN_BUDGET = 3              # max triage sessions per rolling hour
LOCK_STALE_S = 1800           # a triage older than 30 min is presumed dead
TRIAGE_MODEL = os.environ.get("YBOT_TRIAGE_MODEL", "claude-sonnet-5")

# Key NAMES whose presence (never value) is worth knowing during triage.
KEY_NAMES = ("ANTHROPIC_API_KEY", "OLLAMA_API_KEY", "ELEVENLABS_API_KEY",
             "OPERATOR_PROVIDER", "OPERATOR_MODEL", "OPERATOR_OLLAMA_MODEL")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _state() -> dict:
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:
        return {"fingerprints": {}, "spawns": []}


def _save_state(s: dict) -> None:
    try:
        STATE.write_text(json.dumps(s, indent=1), encoding="utf-8")
    except Exception:
        pass


def _fingerprint(exc_type, tb) -> str:
    frames = traceback.extract_tb(tb)[-5:]
    sig = getattr(exc_type, "__name__", str(exc_type)) + "|" + "|".join(
        f"{Path(f.filename).name}:{f.name}" for f in frames)
    return hashlib.sha1(sig.encode()).hexdigest()[:10]


def _alert_line(bundle_id: str, exc_type: str, msg: str, count: int, spawned: bool) -> None:
    try:
        CRASHES.mkdir(parents=True, exist_ok=True)
        if not ALERTS.exists():
            ALERTS.write_text(
                "# Ybot crash alerts — active board\n\n"
                "Claude: on seeing this file, triage every [OPEN] line "
                "(bundle in inbox/<id>/), then mark it [FIXED]/[DIAGNOSED].\n\n",
                encoding="utf-8")
        status = "triage spawned" if spawned else "triage skipped (budget/dup)"
        with ALERTS.open("a", encoding="utf-8") as f:
            f.write(f"- [OPEN] {_now()} `{bundle_id}` {exc_type}: "
                    f"{msg[:100]} (count {count}, {status})\n")
    except Exception:
        pass


def _lock_is_stale() -> bool:
    """A lock is stale when old, or when its triage already wrote its verdict.

    (The lock names the bundle it guards; if that bundle's triage.md exists in
    inbox/ or triaged/, the session finished but died before its cleanup step.)
    """
    try:
        if time.time() - LOCK.stat().st_mtime > LOCK_STALE_S:
            return True
        guarded = LOCK.read_text(encoding="utf-8").split()[0]
        for root in (INBOX, CRASHES / "triaged"):
            if (root / guarded / "triage.md").exists():
                return True
    except Exception:
        pass
    return False


def _spawn_triage(bundle: Path) -> bool:
    """Launch a detached headless Claude Code session on this crash. True if spawned."""
    try:
        claude = shutil.which("claude") or shutil.which("claude.cmd")
        if not claude:
            return False
        # one triage at a time; a stale lock (dead session) is replaced
        if LOCK.exists() and not _lock_is_stale():
            return False
        LOCK.write_text(f"{bundle.name} {_now()}", encoding="utf-8")

        prompt = (
            "You are Ybot's crash-triage engineer, auto-spawned by ybot/crash_reporter.py "
            f"because Ybot just crashed. The crash bundle is at: {bundle}\n"
            "1. Read crash.json and traceback.txt there.\n"
            "2. Find the root cause in this repository (fable/ybot).\n"
            "3. If the fix is clear and low-risk, IMPLEMENT it (edit the code). If it is "
            "risky or ambiguous, do not guess — write the recommended fix instead.\n"
            "4. Write <bundle>/triage.md: root cause, what you changed (files:lines) or "
            "recommend, and whether Ybot needs a restart to load it.\n"
            "5. In crashes/ALERTS.md change this bundle's [OPEN] to [FIXED] or [DIAGNOSED].\n"
            "6. Move the bundle directory from crashes/inbox/ to crashes/triaged/.\n"
            "7. Delete crashes/.triage.lock as your last step.\n"
            "Rules: touch only what the crash implicates; never commit; never store secrets."
        )
        flags = 0
        if os.name == "nt":
            flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        # The log lives OUTSIDE the bundle: it is the triage session's own stdout and
        # stays open for that session's whole life. Inside the bundle it would lock the
        # directory, and on Windows the session could never carry out its own step 6
        # (move the bundle to triaged/). Closing the parent's copy once the child has
        # inherited it also keeps a still-running Ybot from leaking the handle.
        LOGS.mkdir(parents=True, exist_ok=True)
        with (LOGS / f"{bundle.name}.log").open("w", encoding="utf-8") as log:
            subprocess.Popen(
                [claude, "-p", prompt, "--model", TRIAGE_MODEL,
                 "--permission-mode", "acceptEdits"],
                cwd=str(YBOT_ROOT), stdout=log, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, creationflags=flags, close_fds=True)
        return True
    except Exception:
        try:
            LOCK.unlink(missing_ok=True)
        except Exception:
            pass
        return False


def report_exception(exc_type, exc, tb, source: str = "ybot") -> None:
    """Capture one crash: bundle + alert + (budgeted) auto-triage. Never raises."""
    try:
        fp = _fingerprint(exc_type, tb)
        now = time.time()
        state = _state()

        seen = state["fingerprints"].get(fp)
        if seen and now - seen.get("last", 0) < DEDUPE_WINDOW_S:
            seen["count"] = seen.get("count", 1) + 1
            seen["last"] = now
            _save_state(state)
            _alert_line(seen.get("bundle", fp), getattr(exc_type, "__name__", "?"),
                        str(exc), seen["count"], spawned=False)
            return

        bundle_id = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + fp
        bundle = INBOX / bundle_id
        bundle.mkdir(parents=True, exist_ok=True)

        (bundle / "traceback.txt").write_text(
            "".join(traceback.format_exception(exc_type, exc, tb)), encoding="utf-8")
        (bundle / "crash.json").write_text(json.dumps({
            "id": bundle_id,
            "ts": _now(),
            "source": source,
            "exc_type": getattr(exc_type, "__name__", str(exc_type)),
            "exc_msg": str(exc)[:500],
            "fingerprint": fp,
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "argv": sys.argv,
            "cwd": os.getcwd(),
            "keys_present": {k: bool(os.environ.get(k)) for k in KEY_NAMES},
        }, indent=1), encoding="utf-8")

        state["spawns"] = [t for t in state.get("spawns", []) if now - t < 3600]
        may_spawn = len(state["spawns"]) < SPAWN_BUDGET
        spawned = _spawn_triage(bundle) if may_spawn else False
        if spawned:
            state["spawns"].append(now)

        state["fingerprints"][fp] = {"count": 1, "last": now, "bundle": bundle_id}
        _save_state(state)
        _alert_line(bundle_id, getattr(exc_type, "__name__", "?"), str(exc), 1, spawned)
    except Exception:
        pass  # the reporter never raises


def install() -> None:
    """Route every uncaught exception (main thread, threads, Tk) to the bridge."""
    prev_hook = sys.excepthook

    def _hook(exc_type, exc, tb):
        report_exception(exc_type, exc, tb, source="main")
        try:
            prev_hook(exc_type, exc, tb)
        except Exception:
            pass
    sys.excepthook = _hook

    try:
        prev_thread = threading.excepthook

        def _thook(args):
            report_exception(args.exc_type, args.exc_value, args.exc_traceback,
                             source=f"thread:{getattr(args.thread, 'name', '?')}")
            try:
                prev_thread(args)
            except Exception:
                pass
        threading.excepthook = _thook
    except Exception:
        pass

    # Tk swallows callback exceptions; route them here too if Tk is in play.
    try:
        import tkinter

        def _tk_hook(self, exc_type, exc, tb):
            report_exception(exc_type, exc, tb, source="tk-callback")
            try:
                traceback.print_exception(exc_type, exc, tb)
            except Exception:
                pass
        tkinter.Tk.report_callback_exception = _tk_hook
    except Exception:
        pass
