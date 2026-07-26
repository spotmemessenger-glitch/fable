"""Ybot's Java coding skill: a plain-English task -> real, compiled, run-verified Java.

Not a persona/prompt trick — this actually writes .java files to disk, compiles them
with javac, runs the result, and feeds compiler/runtime errors back to the model for a
fix-and-retry loop (same proven pattern as likeness.py's critique loop). Brain runs on
the free OmniRoute/Gemini route via ai_client.py (pure code generation, no desktop
control needed, so it doesn't touch Anthropic credit).

No Maven/Gradle on this machine (checked) — this targets single/few-file javac-buildable
programs (the vast majority of "write me a Java program that does X" requests), not
multi-module Maven projects. If the user asks for a real Maven/Gradle project, say so
honestly rather than faking a mvn call that doesn't exist here.
"""
from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path

import ai_client

_ROOT = Path(__file__).resolve().parent
_JOBS = _ROOT / "creations" / "java_projects"

MAX_FIX_ROUNDS = 2


def _jdk_bin() -> Path | None:
    """Locate a working JDK's bin/ dir — JAVA_HOME, then this machine's known Adoptium
    install (found once, hardcoded as a fast path), then PATH."""
    import os

    home = os.environ.get("JAVA_HOME")
    if home and (Path(home) / "bin" / "javac.exe").exists():
        return Path(home) / "bin"
    known = Path(r"C:\Program Files\Eclipse Adoptium")
    if known.exists():
        cands = sorted(known.glob("jdk-*"), reverse=True)
        for c in cands:
            if (c / "bin" / "javac.exe").exists():
                return c / "bin"
    import shutil

    javac = shutil.which("javac")
    if javac:
        return Path(javac).parent
    return None


def available() -> bool:
    return _jdk_bin() is not None


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:40] or "java"


def _extract_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\n?", "", text)
    text = re.sub(r"\n?```$", "", text).strip()
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        text = m.group(0)
    return json.loads(text)


_SYSTEM = (
    "You are a senior Java engineer writing modern, idiomatic Java 17 for a real "
    "javac-compiled project (no Maven/Gradle available — plain .java files only). "
    "Follow these conventions strictly:\n"
    "- Immutability by default: prefer `final` fields, records for simple data carriers, "
    "no unnecessary mutation.\n"
    "- Clear, focused classes with meaningful names — no god classes.\n"
    "- Explicit exception handling at boundaries; never swallow exceptions silently.\n"
    "- Use modern Java 17 features where they genuinely help (records, sealed types, "
    "pattern matching, switch expressions, text blocks) — don't force them in.\n"
    "- Package-private/private by default; only expose what callers need.\n"
    "- Javadoc only on public APIs where the WHY isn't obvious from the name — never "
    "restate what the code already says.\n"
    "- Include a `public static void main` in exactly one class so the program is "
    "runnable and self-demonstrating (print what it does, or assert expected behavior).\n"
    "- No placeholder/TODO code — everything must actually compile and run.\n\n"
    'Respond with ONLY this JSON (no markdown fences, no prose):\n'
    '{"files": [{"path": "relative/File.java", "content": "..."}], '
    '"main_class": "fully.qualified.ClassName", "notes": "one-line summary of what was built"}\n'
    "`path` mirrors the package declaration (e.g. package com.ybot.demo -> "
    '"com/ybot/demo/File.java"). `main_class` is the fully-qualified name to run with '
    "`java -cp <out> <main_class>` — omit it (null) only if the task genuinely has no "
    "runnable entry point (e.g. a library with no demo)."
)

_FIX_SYSTEM = (
    "You are the same senior Java engineer. Your previous files failed to compile or run. "
    "Fix the problem and return the COMPLETE corrected file set — same JSON contract as "
    "before: {\"files\": [...], \"main_class\": ..., \"notes\": \"what you fixed\"}."
)


def _ask_for_plan(task: str) -> dict:
    msg = ai_client.client().messages.create(
        model=ai_client.TEXT_MODEL, max_tokens=4096, system=_SYSTEM,
        messages=[{"role": "user", "content": f"Task: {task}\n\nWrite the Java now."}],
    )
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
    return _extract_json(text)


def _ask_for_fix(task: str, plan: dict, error_output: str) -> dict:
    msg = ai_client.client().messages.create(
        model=ai_client.TEXT_MODEL, max_tokens=4096, system=_FIX_SYSTEM,
        messages=[{"role": "user", "content": (
            f"Original task: {task}\n\n"
            f"Files you wrote:\n{json.dumps(plan.get('files', []), indent=1)}\n\n"
            f"Compiler/runtime error:\n{error_output[-2000:]}\n\nFix it now."
        )}],
    )
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
    return _extract_json(text)


def _write_files(job: Path, files: list[dict]) -> Path:
    src = job / "src"
    src.mkdir(exist_ok=True)
    for f in files:
        p = src / f["path"]
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f["content"], encoding="utf-8")
    return src


def _compile_and_run(job: Path, src: Path, main_class: str | None, bin_dir: Path) -> dict:
    out = job / "out"
    out.mkdir(exist_ok=True)
    java_files = [str(p) for p in src.rglob("*.java")]
    if not java_files:
        return {"ok": False, "stage": "compile", "output": "no .java files were written"}

    javac = subprocess.run(
        [str(bin_dir / "javac.exe"), "-d", str(out), *java_files],
        capture_output=True, text=True, timeout=60,
    )
    if javac.returncode != 0:
        return {"ok": False, "stage": "compile", "output": javac.stderr or javac.stdout}

    if not main_class:
        return {"ok": True, "stage": "compile", "output": "compiled (no runnable main_class given)"}

    run = subprocess.run(
        [str(bin_dir / "java.exe"), "-cp", str(out), main_class],
        capture_output=True, text=True, timeout=30,
    )
    if run.returncode != 0:
        return {"ok": False, "stage": "run", "output": run.stderr or run.stdout}
    return {"ok": True, "stage": "run", "output": run.stdout}


def write_java(task: str, progress=None) -> dict:
    """Plain-English task -> real, compiled, run-verified Java program.

    Returns {ok, job_dir, files, main_class, notes, compile_output, run_output, errors}.
    """
    def note(msg: str) -> None:
        if progress:
            try:
                progress(msg)
            except Exception:
                pass

    bin_dir = _jdk_bin()
    if bin_dir is None:
        return {"ok": False, "errors": ["No JDK found on this machine (checked JAVA_HOME, "
                                         "Eclipse Adoptium, PATH)"]}

    _JOBS.mkdir(parents=True, exist_ok=True)
    job = _JOBS / f"{_slug(task)}-{time.strftime('%Y%m%d-%H%M%S')}"
    job.mkdir(parents=True, exist_ok=True)

    note("Writing the Java source...")
    plan = _ask_for_plan(task)
    if not plan.get("files"):
        return {"ok": False, "job_dir": str(job), "errors": ["the brain returned no files"]}

    result = None
    for attempt in range(MAX_FIX_ROUNDS + 1):
        src = _write_files(job, plan["files"])
        note(f"Compiling{' (attempt ' + str(attempt + 1) + ')' if attempt else ''}...")
        result = _compile_and_run(job, src, plan.get("main_class"), bin_dir)
        if result["ok"]:
            break
        if attempt < MAX_FIX_ROUNDS:
            note(f"{result['stage']} failed — asking for a fix...")
            plan = _ask_for_fix(task, plan, result["output"])

    return {
        "ok": bool(result and result["ok"]),
        "job_dir": str(job),
        "files": [f["path"] for f in plan.get("files", [])],
        "main_class": plan.get("main_class"),
        "notes": plan.get("notes", ""),
        "stage": result["stage"] if result else None,
        "output": result["output"] if result else None,
        "errors": [] if (result and result["ok"]) else [f"{result['stage']} failed: {result['output'][:500]}" if result else "unknown failure"],
    }


if __name__ == "__main__":
    import sys

    task = " ".join(sys.argv[1:]) or "a program that prints the first 20 Fibonacci numbers"
    print(json.dumps(write_java(task, progress=print), indent=2))
