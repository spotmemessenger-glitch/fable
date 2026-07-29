"""ybot's capabilities, exposed to a voice model as callable functions.

The split your architecture asks for: the voice model reasons and talks, ybot
owns the machine. The model never sees a screenshot or a coordinate — it asks
for an outcome ("open notepad and write the address") and the desktop Operator,
which already knows how to perceive, guard, verify, and retry, does the work.

Every tool here goes through the existing Operator, so `guard.evaluate()` still
gates every action. A voice interface must not become a second, unguarded path
to the mouse.

Long tasks return immediately with a handle rather than blocking the
conversation — a voice assistant that goes silent for ninety seconds while it
works is broken, however good the result is.
"""
from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from typing import Callable

from .openai_realtime import Tool


@dataclass
class Task:
    """A unit of desktop work running behind the conversation."""

    id: str
    goal: str
    state: str = "running"       # running | done | failed | cancelled
    result: str = ""
    _thread: threading.Thread | None = None

    def summary(self) -> str:
        if self.state == "running":
            return f"still working on: {self.goal}"
        return f"{self.state}: {self.result or self.goal}"


@dataclass
class TaskRunner:
    """Runs desktop goals in the background so speech never blocks on them.

    run_goal: usually `Operator(...).run` — takes a goal string, returns a
        summary. Injected rather than imported so this is testable without
        pywinauto, mss, or a screen.
    """

    run_goal: Callable[[str], str]
    tasks: dict[str, Task] = field(default_factory=dict)
    on_finish: Callable[[Task], None] = lambda _t: None

    def start(self, goal: str) -> Task:
        task = Task(id=uuid.uuid4().hex[:8], goal=goal)
        self.tasks[task.id] = task

        def work() -> None:
            try:
                task.result = self.run_goal(goal)
                task.state = "done"
            except Exception as exc:
                task.result = str(exc)
                task.state = "failed"
            finally:
                self.on_finish(task)

        task._thread = threading.Thread(target=work, daemon=True, name=f"ybot-task-{task.id}")
        task._thread.start()
        return task

    def status(self, task_id: str | None = None) -> str:
        if task_id:
            task = self.tasks.get(task_id)
            return task.summary() if task else f"no task {task_id}"
        if not self.tasks:
            return "nothing running"
        return "; ".join(t.summary() for t in self.tasks.values())

    @property
    def running(self) -> list[Task]:
        return [t for t in self.tasks.values() if t.state == "running"]


def build_tools(runner: TaskRunner, recall: Callable[[str], str] | None = None) -> dict[str, Tool]:
    """The function set handed to the voice model."""

    def do_on_computer(args: dict) -> str:
        goal = (args.get("goal") or "").strip()
        if not goal:
            return "No goal given."
        task = runner.start(goal)
        # Returns immediately: the model says "on it" and keeps talking.
        return (
            f"Started task {task.id}: {goal}. It is running in the background — "
            "tell the user you have started, do not claim it is finished. "
            "Use check_task to see how it went."
        )

    def check_task(args: dict) -> str:
        return runner.status(args.get("task_id"))

    tools = {
        "do_on_computer": Tool(
            name="do_on_computer",
            description=(
                "Do something on the user's Windows desktop or in their browser — open "
                "or control an app, write or edit a file, search the web, fill a form. "
                "Describe the OUTCOME you want in plain language; the desktop operator "
                "handles perception, clicking and typing. Returns immediately with a "
                "task id because the work runs in the background."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "goal": {
                        "type": "string",
                        "description": "What should end up being true, e.g. 'open Notepad "
                                       "and write today's shopping list, save to Desktop'",
                    }
                },
                "required": ["goal"],
            },
            run=do_on_computer,
        ),
        "check_task": Tool(
            name="check_task",
            description=(
                "Check on background desktop work. Call this when the user asks whether "
                "something finished, or before claiming a task is done."
            ),
            parameters={
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": [],
            },
            run=check_task,
        ),
    }

    if recall is not None:
        tools["recall"] = Tool(
            name="recall",
            description=(
                "Look up what is already known about the user, this project, or earlier "
                "conversations. Call this BEFORE asking the user for something they may "
                "have already told you."
            ),
            parameters={
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
            run=lambda args: recall(args.get("query", "")),
        )

    return tools


VOICE_INSTRUCTIONS = (
    "You are Ybot, a voice assistant with real control of the user's Windows computer.\n\n"
    "SPEAK LIKE A PERSON. Short sentences. Contractions. No bullet points, no markdown, "
    "no headings — everything you say is spoken aloud. Answer simple questions in one or "
    "two sentences and stop; expand only when asked.\n\n"
    "DOING THINGS: use do_on_computer for anything involving the desktop, browser, or "
    "files. It returns a task id immediately and the work continues in the background. "
    "Say that you have started — never say it is finished until check_task confirms it. "
    "Keep talking to the user while work runs; do not go silent.\n\n"
    "MEMORY: call recall before asking the user for something they may already have told "
    "you. Do not make them repeat themselves.\n\n"
    "BEING INTERRUPTED is normal and fine. Stop immediately, listen, and carry on from "
    "what they actually heard — not from what you had planned to say.\n\n"
    "Never attempt payments, purchases or checkouts. If a task needs one, say so and stop."
)
