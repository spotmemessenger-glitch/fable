"""Ybot plugin: Freqtrade control + expertise.

Freqtrade is a standalone Python trading bot — Ybot can't *be* it, but it can drive the
official Docker image (freqtradeorg/freqtrade) as a control panel and answer freqtrade
questions through the brain. Usage: "freqtrade: status | logs | stop | <question>".

Boundary: this never writes a trading config, never supplies exchange keys, and never
starts live trading — status/logs/stop and expertise only. Starting a configured bot
stays the user's action.
"""
from __future__ import annotations

import subprocess

import ai_client

IMAGE = "freqtradeorg/freqtrade:stable"
CONTAINER = "freqtrade"


def _docker(*args, timeout=30):
    try:
        p = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
        return ((p.stdout or "") + (p.stderr or "")).strip(), p.returncode == 0
    except Exception as e:
        return f"{type(e).__name__}: {e}", False


def _image_present() -> bool:
    out, ok = _docker("images", IMAGE.split(":")[0], "--format", "{{.Repository}}")
    return ok and "freqtrade" in out


_SYSTEM = (
    "You are a Freqtrade expert (config.json, custom Strategy classes, indicators via "
    "technical/ta-lib, backtesting, hyperopt, FreqAI, dry-run vs live, the REST API/FreqUI, "
    "and the freqtradeorg/freqtrade Docker image). Answer concretely with config snippets, "
    "strategy code, and exact CLI. Emphasize dry-run first. You are NOT a financial advisor: "
    "never give personalized buy/sell/hold advice on a specific asset."
)


def run(task: str, progress=None) -> dict:
    def note(m):
        if progress:
            try:
                progress(m)
            except Exception:
                pass

    verb = (task.strip().split(None, 1)[0].lower() if task.strip() else "status")

    if verb == "status":
        img = "pulled" if _image_present() else "NOT pulled yet"
        ps, _ = _docker("ps", "-a", "--filter", f"name={CONTAINER}", "--format", "{{.Names}}: {{.Status}}")
        return {"ok": True, "answer": (
            f"Freqtrade Docker image ({IMAGE}): {img}\n"
            f"Container '{CONTAINER}': {ps or 'none'}\n\n"
            "To actually run it you need a config.json + a Strategy + your exchange keys "
            "(start in dry-run). I won't start live trading for you."
        )}
    if verb == "logs":
        note("reading freqtrade logs…")
        out, ok = _docker("logs", "--tail", "50", CONTAINER)
        return {"ok": ok, "answer": out[-1600:]} if ok else {"ok": False, "error": out[:300]}
    if verb in ("stop", "kill"):
        out, ok = _docker("stop", CONTAINER)
        return {"ok": ok, "answer": f"Stopped container '{CONTAINER}'."} if ok else {"ok": False, "error": out[:300]}

    # Anything else = a freqtrade question -> brain (free route)
    note("asking the freqtrade expert…")
    try:
        msg = ai_client.client().messages.create(
            model=ai_client.TEXT_MODEL, max_tokens=1400, system=_SYSTEM,
            messages=[{"role": "user", "content": task}],
        )
        answer = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
        return {"ok": True, "answer": answer}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


PLUGIN = {
    "name": "Freqtrade",
    "command": "freqtrade",
    "description": "Control the freqtrade Docker bot (status/logs/stop) + a freqtrade expert (config, strategies, backtesting, FreqAI). Analysis only.",
    "run": run,
}


if __name__ == "__main__":
    import json
    import sys

    t = " ".join(sys.argv[1:]) or "status"
    print(json.dumps(run(t, progress=lambda m: print("..", m)), indent=2))
