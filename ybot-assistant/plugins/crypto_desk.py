"""Ybot plugin: Crypto Trading Desk — hugoguerrap/crypto-claude-desk, adapted for Ybot.

The upstream project is a Claude Code plugin (7 expert agent personas + 10 crypto MCP
data servers + skills). Ybot isn't a Claude Code / MCP host, so it can't run the live
MCP data tools — but the 7 agent personas and the skills are markdown expertise, and
those DO transfer: this plugin routes a "crypto: <question>" to the most relevant agent
persona / skill and answers through Ybot's brain (ai_client, free Gemini route).

So Ybot gains the crypto-desk's *reasoning* (technical analysis, risk, portfolio,
sentiment, on-chain framing) without the live-data half. Analysis and code only —
never personalized buy/sell/hold advice on a specific asset.
"""
from __future__ import annotations

import re
from pathlib import Path

import ai_client

_LIB = Path(__file__).resolve().parent / "crypto_desk_lib"
_STOP = {
    "the", "a", "an", "of", "for", "and", "to", "in", "on", "with", "my", "me",
    "how", "do", "i", "is", "are", "use", "using", "get", "what", "can", "you",
    "should", "whats", "s",
}


def _sources() -> list[dict]:
    """Every persona/skill markdown, as {name, kind, path}."""
    out = []
    for md in sorted(_LIB.glob("agents/*.md")):
        out.append({"name": md.stem, "kind": "agent", "path": md})
    for md in sorted(_LIB.glob("skills/*/SKILL.md")):
        out.append({"name": md.parent.name, "kind": "skill", "path": md})
    return out


def _best_match(query: str) -> dict | None:
    q = set(re.findall(r"[a-z0-9]+", query.lower())) - _STOP
    if not q:
        return None
    ql = query.lower()
    best, best_score = None, 0
    for s in _sources():
        try:
            head = s["path"].read_text(encoding="utf-8", errors="replace")[:1500].lower()
        except Exception:
            head = ""
        hay = s["name"].replace("-", " ").lower() + " " + head
        toks = set(re.findall(r"[a-z0-9]+", hay))
        score = len(q & toks)
        if s["name"].replace("-", " ").lower() in ql:
            score += 5
        if score > best_score:
            best, best_score = s, score
    return best or (_sources()[0] if _sources() else None)


_SYSTEM = (
    "You are the Crypto Trading Desk — a coordinated crypto/DeFi intelligence team. The "
    "expert agent/skill definition below is your authoritative playbook; follow its role, "
    "methods, and cautions. Answer the user's crypto question concretely with analysis, "
    "indicators, math, and code. You do NOT have live market data in this context, so when "
    "a number would require it, say so and show the exact method/tool to fetch it rather "
    "than inventing a figure. You are NOT a licensed financial advisor: never give "
    "personalized buy/sell/hold advice on a specific asset.\n\n"
    "=== {kind}: {name} ===\n{body}\n=== END ==="
)


def available() -> bool:
    return _LIB.is_dir() and bool(_sources())


def run(task: str, progress=None) -> dict:
    def note(msg: str) -> None:
        if progress:
            try:
                progress(msg)
            except Exception:
                pass

    if not available():
        return {"ok": False, "error": "crypto_desk_lib is missing — re-vendor the agents/skills."}
    src = _best_match(task)
    if not src:
        return {"ok": False, "error": "no crypto agent/skill matched that."}
    note(f"Consulting {src['kind']}: {src['name']}")
    body = src["path"].read_text(encoding="utf-8", errors="replace")[:12000]
    system = _SYSTEM.format(kind=src["kind"], name=src["name"], body=body)
    try:
        msg = ai_client.client().messages.create(
            model=ai_client.TEXT_MODEL, max_tokens=1500, system=system,
            messages=[{"role": "user", "content": task}],
        )
        answer = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
        return {"ok": True, "answer": f"[{src['name']}]\n\n{answer}"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


PLUGIN = {
    "name": "Crypto Trading Desk",
    "command": "crypto",
    "description": "7 crypto agent personas + skills from crypto-claude-desk (TA, risk, portfolio, sentiment, on-chain). Analysis only.",
    "run": run,
}


if __name__ == "__main__":
    import json
    import sys

    t = " ".join(sys.argv[1:]) or "Explain how to read RSI divergence for a swing trade."
    print(json.dumps(run(t, progress=lambda m: print("...", m)), indent=2))
