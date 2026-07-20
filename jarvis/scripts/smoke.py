"""End-to-end smoke test against the live Anthropic API.

Runs a short scripted conversation to prove the whole core works: streaming,
tool calls, memory writes that persist, and the permission gate. Auto-denies
confirm-tier actions so nothing is actually executed.

Run:  python scripts/smoke.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from jarvis.config import settings
from jarvis.app import Session


def main() -> int:
    session = Session(settings, owner="Yuv")
    # Deny every confirm-tier action so the smoke test cannot change anything.
    session.brain.approver = lambda tool, args: (
        print(f"    [gate] would ask to approve: {tool.describe_call(args)} -> DENIED"),
        False,
    )[1]

    script = [
        "Remember that I prefer to be called Yuv and I'm building a voice assistant.",
        "What tools do you have available right now?",
        "What do you remember about me?",
        "Try to write a file called test.txt with the word hello in it.",
    ]

    for turn in script:
        print(f"\n  you > {turn}")
        print("  jarvis >")
        got = False
        for sentence in session.brain.respond(turn):
            print(f"    {sentence}")
            got = True
        if not got:
            print("    (no text output)")

    print("\n  --- memory after conversation ---")
    for f in session.memory.active_facts():
        print(f"    {f.render()}")

    print("\n  --- action audit ---")
    for a in session.memory.recent_actions(10):
        flag = "approved" if a["approved"] else "DENIED"
        print(f"    [{flag}] {a['tool']}")

    session.close()
    print("\n  Smoke test complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
