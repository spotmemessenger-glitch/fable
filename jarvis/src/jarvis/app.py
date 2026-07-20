"""Application wiring: assemble the pieces and run a session.

Two front ends share one core: a text REPL (works everywhere, needs no
microphone) and a voice loop (wake word, listen, think, speak). Both go through
the same Brain, Memory, and permission gate.
"""

from __future__ import annotations

import logging
import sys
import uuid
from pathlib import Path

from .brain import Brain
from .config import Settings, settings
from .memory import Memory
from .tools import builtin
from .tools.registry import Risk, Tool, registry

log = logging.getLogger(__name__)


def _setup_logging(log_path: Path) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=[logging.FileHandler(log_path, encoding="utf-8")],
    )


class Session:
    """One run of the assistant. Owns the objects and the approval policy."""

    def __init__(self, cfg: Settings, owner: str = "the owner") -> None:
        self.cfg = cfg
        self.owner = owner
        self.session_id = uuid.uuid4().hex[:12]
        self.memory = Memory(cfg.db_path)
        builtin.bind(self.memory, cfg.workspace_root)
        self.brain = Brain(
            cfg,
            self.memory,
            registry,
            self.session_id,
            owner=owner,
            approver=self._approve,
        )
        self._auto_approve = False

    def close(self) -> None:
        self.memory.close()

    # The approval gate. CONFIRM-tier tools call this before running. In text
    # mode the owner types y/n; the voice loop overrides this with a spoken gate.
    def _approve(self, tool: Tool, arguments: dict) -> bool:
        if self._auto_approve:
            return True
        print(f"\n  [approval needed] {tool.describe_call(arguments)}")
        answer = input("  Allow this? [y/N] ").strip().lower()
        return answer in {"y", "yes"}

    def set_auto_approve(self, value: bool) -> None:
        """Danger switch. Only for trusted, unattended runs."""
        self._auto_approve = value


def _print_banner(session: Session, cfg: Settings) -> None:
    stats = session.memory.stats()
    voice = "on" if cfg.has_voice_output else "off (text only)"
    print(f"\n  {cfg.assistant_name} is awake.")
    print(f"  model: {cfg.model}   voice: {voice}   tools: {len(registry)}")
    print(f"  memory: {stats['facts']} facts, {stats['episodes']} turns logged")
    print(f"  session: {session.session_id}")
    print("  Type your message, or /help for commands.\n")


HELP = """\
  Commands:
    /help              show this
    /facts             list what I remember about you
    /actions           what I've done recently
    /reset             clear the current conversation (memory is kept)
    /auto on|off       toggle auto-approval of confirm-tier actions (careful)
    /quit              exit
"""


def run_text(owner: str = "the owner") -> int:
    """Text REPL. The default because it needs no microphone."""
    _setup_logging(settings.log_path)
    session = Session(settings, owner=owner)
    _print_banner(session, settings)

    try:
        while True:
            try:
                text = input("  you > ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                break

            if not text:
                continue
            if text.startswith("/"):
                if _handle_command(text, session):
                    break
                continue

            print(f"  {settings.assistant_name.lower()} >")
            spoke = False
            for sentence in session.brain.respond(text):
                print(f"    {sentence}")
                spoke = True
            if not spoke:
                print("    ...")
    finally:
        session.close()
    print(f"  {settings.assistant_name} sleeping. Bye.")
    return 0


def _handle_command(text: str, session: Session) -> bool:
    """Return True to exit the loop."""
    parts = text.split()
    cmd = parts[0].lower()

    if cmd in {"/quit", "/exit", "/q"}:
        return True
    if cmd == "/help":
        print(HELP)
    elif cmd == "/facts":
        facts = session.memory.active_facts()
        if not facts:
            print("  I don't know anything about you yet.")
        else:
            for f in facts:
                print(f"    {f.render()}")
    elif cmd == "/actions":
        for a in session.memory.recent_actions(20):
            flag = "" if a["approved"] else " (denied)"
            print(f"    [{a['when']}] {a['tool']}{flag}")
    elif cmd == "/reset":
        session.brain.reset()
        print("  Conversation cleared.")
    elif cmd == "/auto":
        want = len(parts) > 1 and parts[1].lower() == "on"
        session.set_auto_approve(want)
        print(f"  Auto-approve {'ON — be careful.' if want else 'off.'}")
    else:
        print(f"  Unknown command {cmd!r}. /help for the list.")
    return False


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    owner = "the owner"
    if "--owner" in argv:
        i = argv.index("--owner")
        if i + 1 < len(argv):
            owner = argv[i + 1]

    if "--voice" in argv:
        from .voice_loop import run_voice

        return run_voice(owner=owner)
    return run_text(owner=owner)


if __name__ == "__main__":
    raise SystemExit(main())
