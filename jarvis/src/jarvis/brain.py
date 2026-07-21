"""The reasoning loop: Claude, plus tools, plus memory.

Responses stream back sentence by sentence so speech can start before the model
has finished thinking. Tool calls run inside the loop, gated by the permission
tier declared on each tool.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Callable, Iterator

from anthropic import Anthropic, APIError, APIStatusError

from .config import Settings
from .memory import Memory
from .persona import build_system_prompt
from .tools.registry import Registry, Risk, Tool

log = logging.getLogger(__name__)

# Sentence boundary for chunking speech. Requires whitespace after the
# terminator so "3.5" and "e.g." don't split mid-thought.
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")

# A tool loop that never terminates is the classic way an agent burns money.
MAX_TOOL_ROUNDS = 12

# Anthropic's hosted web-search tool: runs entirely server-side (search,
# fetch, and synthesis all happen inside one API call — no client round-trip,
# so it needs no entry in the local tool registry and no permission gate; it's
# read-only and can't be pointed at anything destructive). max_uses caps how
# many searches a single turn can spend, so one question can't spiral into a
# runaway sequence of paid searches.
WEB_SEARCH_TOOLS: list[dict[str, Any]] = [
    {"type": "web_search_20260209", "name": "web_search", "max_uses": 3},
]

Approver = Callable[[Tool, dict[str, Any]], bool]


def _always_allow(tool: Tool, arguments: dict[str, Any]) -> bool:
    return True


class Brain:
    """Holds conversation state and turns user input into spoken replies."""

    def __init__(
        self,
        settings: Settings,
        memory: Memory,
        registry: Registry,
        session_id: str,
        *,
        owner: str = "the owner",
        approver: Approver | None = None,
    ) -> None:
        self.settings = settings
        self.memory = memory
        self.registry = registry
        self.session_id = session_id
        self.owner = owner
        self.approver = approver or _always_allow
        self.client = Anthropic(api_key=settings.anthropic_api_key)
        self._history: list[dict[str, Any]] = []

        # Optional observer, called as on_tool(name, arguments, phase, approved)
        # with phase "start" or "end". The HUD uses this to light up the agent
        # that is working; failures in the observer must never break the loop.
        self.on_tool: Callable[[str, dict[str, Any], str, bool], None] | None = None

    # ------------------------------------------------------------------ api

    def respond(self, user_text: str) -> Iterator[str]:
        """Handle one user turn, yielding complete sentences as they arrive."""
        user_text = user_text.strip()
        if not user_text:
            return

        self.memory.log_turn(self.session_id, "user", user_text)
        self._history.append({"role": "user", "content": user_text})
        self._trim_history()

        spoken: list[str] = []
        try:
            for sentence in self._run_loop():
                spoken.append(sentence)
                yield sentence
        except APIStatusError as exc:
            yield self._explain_api_error(exc)
            return
        except APIError as exc:
            log.exception("Anthropic API error")
            yield f"I couldn't reach my brain just then. {exc.__class__.__name__}."
            return

        if spoken:
            self.memory.log_turn(self.session_id, "assistant", " ".join(spoken))

    def reset(self) -> None:
        """Clear working context. Durable memory is untouched."""
        self._history.clear()

    @property
    def turn_count(self) -> int:
        return len(self._history)

    # --------------------------------------------------------------- internals

    def _run_loop(self) -> Iterator[str]:
        """Alternate between model calls and tool execution until it settles."""
        for round_number in range(MAX_TOOL_ROUNDS):
            assistant_blocks: list[dict[str, Any]] = []
            buffer = ""

            with self.client.messages.stream(
                model=self.settings.model,
                max_tokens=self.settings.max_tokens,
                system=self._system_prompt(),
                tools=self.registry.specs() + WEB_SEARCH_TOOLS,
                messages=self._history,
            ) as stream:
                for event in stream.text_stream:
                    buffer += event
                    # Emit whole sentences so speech sounds natural rather than
                    # arriving in token-sized fragments.
                    parts = _SENTENCE_END.split(buffer)
                    if len(parts) > 1:
                        for complete in parts[:-1]:
                            if complete.strip():
                                yield complete.strip()
                        buffer = parts[-1]
                final = stream.get_final_message()

            if buffer.strip():
                yield buffer.strip()

            for block in final.content:
                assistant_blocks.append(block.model_dump(exclude_none=True))
            self._history.append({"role": "assistant", "content": assistant_blocks})

            tool_uses = [b for b in final.content if b.type == "tool_use"]
            if final.stop_reason != "tool_use" or not tool_uses:
                return

            results = [self._execute(use) for use in tool_uses]
            self._history.append({"role": "user", "content": results})
            self._trim_history()

        yield (
            "I've gone round in circles on that one and stopped myself. "
            "Try asking me a smaller piece of it."
        )

    def _execute(self, use: Any) -> dict[str, Any]:
        """Run one tool call, enforcing its permission tier."""
        name = use.name
        arguments = dict(use.input or {})
        tool = self.registry.get(name)
        self._notify(name, arguments, "start", True)

        if tool is None:
            output, approved = f"Error: no tool named {name!r}.", False
        elif tool.risk is Risk.BLOCKED:
            output, approved = f"Error: {name!r} is blocked.", False
        elif tool.risk is Risk.CONFIRM and not self.approver(tool, arguments):
            output = (
                "The owner declined this action. Do not retry it or attempt the "
                "same thing another way. Tell them it was not done."
            )
            approved = False
        else:
            output, approved = self.registry.run(name, arguments), True

        self.memory.log_action(self.session_id, name, arguments, output, approved)
        self._notify(name, arguments, "end", approved)

        return {
            "type": "tool_result",
            "tool_use_id": use.id,
            "content": output[:12000],
            **({"is_error": True} if output.startswith("Error:") else {}),
        }

    def _notify(self, name: str, arguments: dict[str, Any], phase: str, ok: bool) -> None:
        if self.on_tool is None:
            return
        try:
            self.on_tool(name, arguments, phase, ok)
        except Exception:  # noqa: BLE001 - observers must never break the loop
            log.exception("on_tool observer failed")

    def _system_prompt(self) -> list[dict[str, Any]]:
        return build_system_prompt(
            assistant_name=self.settings.assistant_name,
            owner=self.owner,
            facts=self.memory.active_facts(),
            cwd=str(self.settings.workspace_root),
        )

    def _trim_history(self) -> None:
        """Keep history bounded while staying valid for the API.

        The API requires the first message to have the "user" role, and a
        tool_result block must follow the tool_use that produced it. A naive
        slice breaks both invariants — that is exactly the bug that made the
        previous version start failing after about ten exchanges. So: trim to
        size, then walk forward until the head is a real user message.
        """
        limit = max(2, self.settings.max_history_pairs * 2)
        while len(self._history) > limit:
            self._history.pop(0)

        while self._history and not self._is_valid_head(self._history[0]):
            self._history.pop(0)

    @staticmethod
    def _is_valid_head(message: dict[str, Any]) -> bool:
        if message.get("role") != "user":
            return False
        content = message.get("content")
        if isinstance(content, list):
            # A tool_result cannot lead: its matching tool_use is already gone.
            return not any(
                isinstance(b, dict) and b.get("type") == "tool_result" for b in content
            )
        return True

    def _explain_api_error(self, exc: APIStatusError) -> str:
        status = getattr(exc, "status_code", None)
        if status == 429:
            return "I'm being rate limited right now. Give me a moment and ask again."
        if status == 401:
            return "My API key was rejected. Check ANTHROPIC_API_KEY in the .env file."
        if status == 400 and "credit" in str(exc).lower():
            return "The Anthropic account is out of credit."
        if status and status >= 500:
            return "Anthropic's API is having trouble. Not something on our end."
        log.exception("Unhandled API status error")
        return f"Something went wrong talking to my brain: {status}."
