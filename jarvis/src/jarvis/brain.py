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

from .config import FREE_PROVIDERS, Settings
from .llm_ollama import stream_chat
from .llm_openai_compat import stream_chat as stream_chat_openai
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
        # No Anthropic client is created on a free provider — those paths never
        # touch the paid API (and need no key).
        self.client = None if settings.uses_free_llm else Anthropic(api_key=settings.anthropic_api_key)
        self._history: list[dict[str, Any]] = []

        # Runtime model override set by the HUD picker (None = follow settings).
        # Keys: {"provider": "anthropic"|"ollama"|"cerebras", "model": str}; the
        # free providers also carry "host"/"base_url" and "api_key" so local,
        # cloud, and Cerebras models each route right.
        self._override: dict[str, Any] | None = None

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
        loop = self._free_reply if self._use_free_now else self._run_loop
        try:
            for sentence in loop():
                spoken.append(sentence)
                yield sentence
        except APIStatusError as exc:
            yield self._explain_api_error(exc)
            return
        except APIError as exc:
            log.exception("Anthropic API error")
            yield f"I couldn't reach my brain just then. {exc.__class__.__name__}."
            return
        except Exception as exc:  # noqa: BLE001 - local (Ollama) transport path
            log.exception("Brain loop error")
            if self._use_free_now:
                # Never silently fall back to the paid provider — say what's wrong.
                if self._provider_now == "cerebras":
                    _model, _endpoint, _ = self._active_cerebras()
                    yield (
                        f"I couldn't reach Cerebras at {_endpoint}. "
                        "Check the key is valid, or that the free daily limit "
                        "isn't spent."
                    )
                    return
                _model, _host, _ = self._active_ollama()
                yield (
                    f"I couldn't reach the Ollama model at {_host}. "
                    "Make sure Ollama is running (or the cloud key is valid)."
                )
            else:
                yield f"Something went wrong just then: {exc.__class__.__name__}."
            return

        if spoken:
            self.memory.log_turn(self.session_id, "assistant", " ".join(spoken))

    def reset(self) -> None:
        """Clear working context. Durable memory is untouched."""
        self._history.clear()

    @property
    def turn_count(self) -> int:
        return len(self._history)

    # --------------------------------------------------------- model switch

    def set_model(self, provider: str, model: str, *, host: str = "", api_key: str = "") -> dict[str, str]:
        """Switch the active model at runtime (driven by the HUD picker).

        Anthropic needs a client; if JARVIS booted in Ollama mode there isn't
        one yet, so create it lazily (and refuse if no key is configured).
        """
        provider = provider.lower().strip()
        if provider == "anthropic":
            if self.client is None:
                if not self.settings.anthropic_api_key:
                    raise ValueError("No Anthropic API key is configured.")
                self.client = Anthropic(api_key=self.settings.anthropic_api_key)
            self._override = {"provider": "anthropic", "model": model}
        elif provider == "ollama":
            self._override = {
                "provider": "ollama",
                "model": model,
                "host": host or self.settings.ollama_host,
                "api_key": api_key,
            }
        elif provider == "cerebras":
            key = api_key or self.settings.cerebras_api_key
            if not key:
                raise ValueError("No Cerebras API key is configured.")
            self._override = {
                "provider": "cerebras",
                "model": model,
                "base_url": host or self.settings.cerebras_base_url,
                "api_key": key,
            }
        else:
            raise ValueError(f"Unknown provider {provider!r}.")
        log.info("Model switched -> %s / %s", provider, model)
        return self.current_model()

    def current_model(self) -> dict[str, str]:
        """The provider+model in effect right now (override or settings default)."""
        if self._override:
            return {"provider": self._override["provider"], "model": self._override["model"]}
        if self.settings.use_ollama:
            return {"provider": "ollama", "model": self.settings.ollama_model}
        if self.settings.use_cerebras:
            return {"provider": "cerebras", "model": self.settings.cerebras_model}
        return {"provider": "anthropic", "model": self.settings.model}

    @property
    def _provider_now(self) -> str:
        """The provider actually in effect (override wins over settings)."""
        if self._override:
            return self._override["provider"]
        return self.settings.llm_provider

    @property
    def _use_free_now(self) -> bool:
        """True when the active provider streams plain text with no tools."""
        return self._provider_now in FREE_PROVIDERS

    def _active_ollama(self) -> tuple[str, str, str]:
        """(model, host, api_key) for the current Ollama selection."""
        if self._override and self._override["provider"] == "ollama":
            o = self._override
            return o["model"], o["host"], o["api_key"]
        return self.settings.ollama_model, self.settings.ollama_host, self.settings.ollama_api_key

    def _active_cerebras(self) -> tuple[str, str, str]:
        """(model, base_url, api_key) for the current Cerebras selection."""
        if self._override and self._override["provider"] == "cerebras":
            o = self._override
            return o["model"], o["base_url"], o["api_key"]
        return (
            self.settings.cerebras_model,
            self.settings.cerebras_base_url,
            self.settings.cerebras_api_key,
        )

    # --------------------------------------------------------------- internals

    def _run_loop(self) -> Iterator[str]:
        """Alternate between model calls and tool execution until it settles."""
        for round_number in range(MAX_TOOL_ROUNDS):
            assistant_blocks: list[dict[str, Any]] = []
            buffer = ""

            model = (
                self._override["model"]
                if self._override and self._override["provider"] == "anthropic"
                else self.settings.model
            )
            with self.client.messages.stream(
                model=model,
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

    # ---- free / local path (Ollama) ---------------------------------------
    # A plain streaming chat with no tools or hosted web search — small/local
    # models are unreliable at tool use, so the free path is honest chat only.

    def _free_reply(self) -> Iterator[str]:
        system_text = self._system_text()
        messages = self._ollama_messages()
        # Both clients take (endpoint, model, system, messages, api_key=, max_tokens=),
        # so the only thing that varies is which one and where it points.
        if self._provider_now == "cerebras":
            model, endpoint, api_key = self._active_cerebras()
            client = stream_chat_openai
        else:
            model, endpoint, api_key = self._active_ollama()
            client = stream_chat
        buffer = ""
        parts_out: list[str] = []
        for chunk in client(
            endpoint,
            model,
            system_text,
            messages,
            api_key=api_key,
            max_tokens=self.settings.max_tokens,
        ):
            buffer += chunk
            pieces = _SENTENCE_END.split(buffer)
            if len(pieces) > 1:
                for complete in pieces[:-1]:
                    if complete.strip():
                        parts_out.append(complete.strip())
                        yield complete.strip()
                buffer = pieces[-1]
        if buffer.strip():
            parts_out.append(buffer.strip())
            yield buffer.strip()

        # Keep conversational context for the next turn. History stays plain
        # text in ollama mode (no tool blocks), which is exactly what the API
        # here expects.
        if parts_out:
            self._history.append({"role": "assistant", "content": " ".join(parts_out)})
            self._trim_history()

    def _system_text(self) -> str:
        """Flatten the block-structured system prompt into plain text for Ollama."""
        return "\n\n".join(
            b.get("text", "")
            for b in self._system_prompt()
            if isinstance(b, dict) and b.get("text")
        )

    def _ollama_messages(self) -> list[dict[str, str]]:
        """History as OpenAI-style {role, content} string messages."""
        out: list[dict[str, str]] = []
        for message in self._history:
            content = message.get("content")
            if isinstance(content, list):
                text = " ".join(
                    b.get("text", "")
                    for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                )
            else:
                text = str(content)
            out.append({"role": message["role"], "content": text})
        return out

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
