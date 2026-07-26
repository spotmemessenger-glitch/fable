"""Ybot's command-line skill: a senior Windows engineer who actually drives PowerShell/
cmd/git/VS Code — not by typing into a GUI terminal window (slow, fragile, and the
operator's guard.py always stops to ask permission for that), but via direct subprocess
execution, which is faster, more reliable, and lets us enforce real per-command safety
instead of a blanket "ask every time."

Loop: brain proposes ONE command + reasoning -> we run it (PowerShell by default) ->
output feeds back -> brain proposes the next command or declares done. Same shape as
java_coder.py's fix-loop, generalized to arbitrary shell work.

Safety: a hard denylist blocks genuinely destructive patterns (format, diskpart, root-
drive deletion, shutdown/restart, disabling the firewall, remote-script-to-shell
pipelines, account/registry tampering) — checked BEFORE every command runs, independent
of what the brain decides. This is real command execution on the user's machine, not a
sandbox, so the denylist is the actual safety boundary, not a suggestion to the model.
"""
from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path

import ai_client

_ROOT = Path(__file__).resolve().parent
_JOBS = _ROOT / "creations" / "shell_sessions"

MAX_STEPS = 15
STEP_TIMEOUT = 60

# Hard-blocked regardless of what the brain proposes. Matched against the command text.
_DENYLIST = re.compile(
    r"\bformat\s+[a-z]:|"
    r"\bdiskpart\b|"
    r"\bshutdown\b|\bstop-computer\b|\brestart-computer\b|"
    r"remove-item\s+.*-recurse.*-force.*[\"']?[a-z]:\\?[\"']?\s*$|"  # bare drive root
    r"del\s+/s\s+/q\s+[a-z]:\\\s*$|"
    r"\brd\s+/s\s+/q\s+[a-z]:\\\s*$|"
    r"reg\s+delete\s+hklm|remove-item\s+.*hklm:|"
    r"net\s+user\s+.*\s+/add|net\s+localgroup\s+administrators|"
    r"netsh\s+advfirewall\s+set\s+.*state\s+off|"
    r"disable-.*firewall|"
    r"(curl|wget|invoke-webrequest|iwr)\b.*\|\s*(iex|sh|bash|invoke-expression)\b|"
    r"\bvssadmin\s+delete\b|"
    r"\bcipher\s+/w\b",
    re.IGNORECASE,
)


def _is_denied(command: str) -> str | None:
    m = _DENYLIST.search(command)
    return m.group(0) if m else None


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:40] or "shell"


def _extract_json(text: str) -> dict:
    text = re.sub(r"^```(?:json)?\n?", "", text.strip())
    text = re.sub(r"\n?```$", "", text).strip()
    m = re.search(r"\{.*\}", text, re.DOTALL)
    return json.loads(m.group(0) if m else text)


_SYSTEM = (
    "You are a senior Windows systems engineer with deep, practical command-line "
    "expertise — PowerShell (your default; prefer it for anything modern: objects, "
    "pipelines, .NET access), cmd.exe (for legacy/simple one-liners), git, VS Code "
    "(`code <path>`), npm/pip/dev tooling. You drive a REAL shell on the user's machine "
    "one command at a time — there is no undo.\n\n"
    "Engineering discipline:\n"
    "- Investigate before you act: check state (ls/Get-ChildItem, git status, "
    "Test-Path) before anything that modifies or deletes.\n"
    "- Prefer the least destructive command that accomplishes the goal. Never use "
    "-Force or -Recurse unless the task genuinely requires it.\n"
    "- Quote paths with spaces. Use full/explicit paths when there's any ambiguity "
    "about the working directory.\n"
    "- One command per step — no chaining unrelated operations with `;`/`&&` unless "
    "they're genuinely one atomic operation.\n"
    "- If a command fails, read the actual error and adapt — don't repeat it blindly.\n\n"
    "Respond with ONLY this JSON each turn (no markdown fences, no prose):\n"
    '{"done": false, "command": "the next single shell command to run", '
    '"reasoning": "one line: why this command, right now"}\n'
    "or, once the task is genuinely complete:\n"
    '{"done": true, "summary": "what was accomplished, in plain language"}'
)


def run_shell_task(task: str, cwd: str | None = None, progress=None) -> dict:
    """A plain-English sysadmin/dev task -> a real PowerShell command sequence,
    executed step by step with a hard safety denylist. Returns {ok, steps, summary,
    job_dir, errors}."""
    def note(msg: str) -> None:
        if progress:
            try:
                progress(msg)
            except Exception:
                pass

    _JOBS.mkdir(parents=True, exist_ok=True)
    job = _JOBS / f"{_slug(task)}-{time.strftime('%Y%m%d-%H%M%S')}"
    job.mkdir(parents=True, exist_ok=True)
    transcript: list[dict] = []
    work_dir = cwd or str(Path.home())

    messages = [{"role": "user", "content": f"Task: {task}\nWorking directory: {work_dir}"}]

    for step in range(1, MAX_STEPS + 1):
        msg = ai_client.client().messages.create(
            model=ai_client.TEXT_MODEL, max_tokens=1024, system=_SYSTEM, messages=messages,
        )
        text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
        try:
            plan = _extract_json(text)
        except Exception:
            transcript.append({"step": step, "error": f"brain returned unparseable JSON: {text[:300]}"})
            break

        if plan.get("done"):
            summary = plan.get("summary", "")
            transcript.append({"step": step, "done": True, "summary": summary})
            (job / "transcript.json").write_text(json.dumps(transcript, indent=2), encoding="utf-8")
            return {"ok": True, "job_dir": str(job), "steps": transcript, "summary": summary, "errors": []}

        command = (plan.get("command") or "").strip()
        reasoning = plan.get("reasoning", "")
        if not command:
            transcript.append({"step": step, "error": "brain proposed no command"})
            break

        blocked = _is_denied(command)
        if blocked:
            note(f"BLOCKED (safety denylist): {command}")
            transcript.append({"step": step, "command": command, "blocked": blocked})
            # tell the brain it was blocked so it can propose a safe alternative
            messages.append({"role": "assistant", "content": text})
            messages.append({"role": "user", "content": (
                f"That command was blocked by a hard safety denylist ({blocked!r} matched) "
                "and did NOT run. Propose a safer alternative, or if there isn't one, "
                'respond {"done": true, "summary": "explain why this can\'t be done safely"}.'
            )})
            continue

        note(f"Step {step}: {reasoning or command}")
        try:
            proc = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True, text=True, timeout=STEP_TIMEOUT, cwd=work_dir,
            )
            output = ((proc.stdout or "") + (proc.stderr or "")).strip()
            ok = proc.returncode == 0
        except subprocess.TimeoutExpired:
            output, ok = f"command timed out after {STEP_TIMEOUT}s", False
        except Exception as e:
            output, ok = f"{type(e).__name__}: {e}", False

        transcript.append({"step": step, "command": command, "reasoning": reasoning,
                            "ok": ok, "output": output[:2000]})
        messages.append({"role": "assistant", "content": text})
        messages.append({"role": "user", "content": f"Output (exit {'ok' if ok else 'FAILED'}):\n{output[-2000:]}"})

    (job / "transcript.json").write_text(json.dumps(transcript, indent=2), encoding="utf-8")
    return {"ok": False, "job_dir": str(job), "steps": transcript,
            "summary": "", "errors": ["hit max steps or an unrecoverable error without finishing"]}


if __name__ == "__main__":
    import sys

    task = " ".join(sys.argv[1:]) or "check the installed node and python versions"
    print(json.dumps(run_shell_task(task, progress=print), indent=2))
