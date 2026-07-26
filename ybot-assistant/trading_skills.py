"""Ybot's trading-skills brain: the 67 trading / DeFi / quant Agent Skills from
agiprolabs/claude-trading-skills, made usable by Ybot.

Ybot is a standalone Python app with no Claude-plugin skill loader, so it can't
"install" these the way Claude Code does. Instead this wraps them the same way
cli_hub.py / graphify_client.py wrap external tools: the skill files are vendored
into trading_skills_lib/, and a task loads the single most-relevant SKILL.md as
authoritative expert context, then answers through Ybot's brain (free Gemini route
via ai_client — pure reasoning, no desktop control, no Anthropic credit).
"""
from __future__ import annotations

import re
from pathlib import Path

import ai_client

_LIB = Path(__file__).resolve().parent / "trading_skills_lib"

# Words too common to help match a query to a skill.
_STOP = {
    "the", "a", "an", "of", "for", "and", "to", "in", "on", "with", "my", "me",
    "how", "do", "i", "is", "are", "use", "using", "get", "what", "can", "you",
}


def available() -> bool:
    return _LIB.is_dir() and any(_LIB.glob("*/SKILL.md"))


def _meta(skill_md: Path) -> tuple[str, str]:
    """(name, description) parsed from a SKILL.md YAML frontmatter block."""
    name, desc = skill_md.parent.name, ""
    try:
        text = skill_md.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return name, desc
    m = re.search(r"^---\s*(.*?)\s*---", text, re.DOTALL)
    fm = m.group(1) if m else ""
    n = re.search(r"^name:\s*(.+)$", fm, re.MULTILINE)
    d = re.search(r"^description:\s*(.+)$", fm, re.MULTILINE)
    if n:
        name = n.group(1).strip()
    if d:
        desc = d.group(1).strip()
    return name, desc


def list_skills() -> list[dict]:
    return [
        {"name": (nd := _meta(md))[0], "description": nd[1], "path": str(md)}
        for md in sorted(_LIB.glob("*/SKILL.md"))
    ]


def _best_match(query: str) -> dict | None:
    """Pick the single most relevant skill by keyword overlap on name+description,
    with a strong boost when the skill's name is mentioned directly."""
    q = set(re.findall(r"[a-z0-9]+", query.lower())) - _STOP
    if not q:
        return None
    ql = query.lower()
    best, best_score = None, 0
    for s in list_skills():
        toks = set(re.findall(r"[a-z0-9]+", (s["name"] + " " + s["description"]).lower()))
        score = len(q & toks)
        if s["name"].lower().replace("-", " ") in ql:
            score += 5
        if score > best_score:
            best, best_score = s, score
    return best if best_score > 0 else None


_SYSTEM = (
    "You are a professional quantitative trading and DeFi engineer. The expert Agent "
    "Skill below is your authoritative reference — follow its frameworks, formulas, and "
    "cautions precisely and answer the user's task concretely (math, code, and steps). "
    "You are NOT a licensed financial advisor: give analysis and tooling, never "
    "personalized buy/sell/hold advice on a specific asset.\n\n"
    "=== SKILL: {name} ===\n{body}\n=== END SKILL ==="
)


def run(task: str, progress=None) -> dict:
    """Answer a trading task using the most relevant vendored skill as context.
    Returns {ok, skill, answer} or {ok: False, error}."""
    def note(msg: str) -> None:
        if progress:
            try:
                progress(msg)
            except Exception:
                pass

    if not available():
        return {"ok": False, "error": "trading_skills_lib is missing — re-vendor the skills."}
    skill = _best_match(task)
    if not skill:
        names = ", ".join(s["name"] for s in list_skills()[:12])
        return {"ok": False, "error": f"couldn't match a skill. Name one, e.g.: {names}, …"}
    note(f"Using skill: {skill['name']}")
    body = Path(skill["path"]).read_text(encoding="utf-8", errors="replace")
    system = _SYSTEM.format(name=skill["name"], body=body[:12000])
    try:
        msg = ai_client.client().messages.create(
            model=ai_client.TEXT_MODEL, max_tokens=1500, system=system,
            messages=[{"role": "user", "content": task}],
        )
        answer = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
        return {"ok": True, "skill": skill["name"], "answer": answer}
    except Exception as e:
        return {"ok": False, "skill": skill["name"], "error": f"{type(e).__name__}: {e}"}


if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "list":
        for s in list_skills():
            print(f"{s['name']}: {s['description']}")
    else:
        t = " ".join(sys.argv[1:]) or "Size a position with the Kelly criterion: 55% win rate, 1.5:1 payoff."
        print(json.dumps(run(t, progress=lambda m: print("...", m)), indent=2))
