"""Ybot's UI/UX design skill: a senior product designer + frontend engineer who builds
real, openable app designs — not Figma/Canva/Stitch files (those are MCP tools only
Claude Code has access to; Ybot is a separate Python process, not an MCP client, so it
literally cannot drive them). The honest equivalent: production-quality, self-contained
HTML/CSS/Tailwind mockups the user can open in any browser immediately, following real
UI/UX principles (visual hierarchy, an 8pt spacing grid, WCAG AA contrast, mobile-first
responsive layout, a coherent type/color system) — not placeholder wireframes.
"""
from __future__ import annotations

import re
import time
from pathlib import Path

import ai_client

_ROOT = Path(__file__).resolve().parent
_JOBS = _ROOT / "creations" / "designs"


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:40] or "design"


_SYSTEM = (
    "You are a senior product designer AND senior frontend engineer — the rare "
    "combination that ships polished, production-quality UI, not wireframes. Given a "
    "design brief, output ONE complete, self-contained HTML file (Tailwind via the CDN "
    "script tag for styling — no build step, opens directly in any browser).\n\n"
    "Design discipline (non-negotiable):\n"
    "- Real visual hierarchy: one clear focal point per screen, deliberate type scale "
    "(not just font-size guessing), generous whitespace on an 8px grid.\n"
    "- A coherent color system: one primary, one accent, neutral greys — never more "
    "than 2-3 hues total. WCAG AA contrast on all text (4.5:1 body, 3:1 large text).\n"
    "- Mobile-first responsive: design the small screen first, then widen with "
    "Tailwind's sm:/md:/lg: prefixes — never a desktop layout that just squishes.\n"
    "- Real interactive states: hover/focus/active/disabled on every clickable element, "
    "visible focus rings for keyboard nav (never remove outline without replacing it).\n"
    "- Realistic content — real-sounding copy, not 'Lorem ipsum' or '[placeholder]'. "
    "Use actual icon glyphs (inline SVG or unicode) — never broken image placeholders.\n"
    "- Semantic HTML5 (nav/main/section/article/button — not div soup).\n\n"
    "Output ONLY the raw HTML file content. No markdown fences, no prose, no "
    "explanation before or after."
)


def create_design(task: str, progress=None) -> dict:
    """Plain-English UI/UX brief -> a real, openable, production-quality HTML mockup."""
    def note(msg: str) -> None:
        if progress:
            try:
                progress(msg)
            except Exception:
                pass

    note("Designing...")
    msg = ai_client.client().messages.create(
        model=ai_client.TEXT_MODEL, max_tokens=8192, system=_SYSTEM,
        messages=[{"role": "user", "content": f"Design brief: {task}\n\nBuild it now."}],
    )
    html = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
    html = re.sub(r"^```(?:html)?\n?", "", html)
    html = re.sub(r"\n?```$", "", html).strip()

    if "<html" not in html.lower():
        return {"ok": False, "errors": ["the brain didn't return a full HTML document"]}

    _JOBS.mkdir(parents=True, exist_ok=True)
    job = _JOBS / f"{_slug(task)}-{time.strftime('%Y%m%d-%H%M%S')}"
    job.mkdir(parents=True, exist_ok=True)
    out_path = job / "design.html"
    out_path.write_text(html, encoding="utf-8")

    return {"ok": True, "job_dir": str(job), "file": str(out_path), "errors": []}


if __name__ == "__main__":
    import json
    import sys

    task = " ".join(sys.argv[1:]) or "a clean fitness-tracking app home screen"
    print(json.dumps(create_design(task, progress=print), indent=2))
