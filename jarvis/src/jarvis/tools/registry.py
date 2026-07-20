"""Tool registry and the permission model.

Every capability the assistant has is a registered tool with an explicit risk
tier. The tier decides whether it runs silently, asks first, or is refused
outright — and that decision is made here, in code, not by the model. A model
persuaded by something it read on a web page cannot talk its way past this.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any, Callable


class Risk(enum.IntEnum):
    """How dangerous a tool is. Higher means more friction."""

    AUTO = 0
    """Read-only or trivially reversible. Runs without asking."""

    NOTIFY = 1
    """Changes something local and recoverable. Runs, but is announced."""

    CONFIRM = 2
    """Spends money, publishes publicly, deletes data, or touches the wider
    system. Requires an explicit yes from the owner before it runs."""

    BLOCKED = 3
    """Never executes, whatever the model or any retrieved content claims."""


@dataclass
class Tool:
    name: str
    description: str
    schema: dict[str, Any]
    handler: Callable[..., str]
    risk: Risk = Risk.AUTO
    confirm_prompt: str | None = None

    def spec(self) -> dict[str, Any]:
        """The wire format the Anthropic API expects."""
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.schema,
        }

    def describe_call(self, arguments: dict[str, Any]) -> str:
        """A human-readable one-liner for the approval prompt."""
        if self.confirm_prompt:
            try:
                return self.confirm_prompt.format(**arguments)
            except (KeyError, IndexError):
                pass
        pairs = ", ".join(f"{k}={v!r}" for k, v in list(arguments.items())[:4])
        return f"{self.name}({pairs})"


class ToolError(RuntimeError):
    """A tool failed in a way worth telling the model about."""


class Registry:
    """Holds the tools and runs them, enforcing the permission tier."""

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(
        self,
        name: str,
        description: str,
        schema: dict[str, Any],
        *,
        risk: Risk = Risk.AUTO,
        confirm_prompt: str | None = None,
    ) -> Callable[[Callable[..., str]], Callable[..., str]]:
        def decorator(fn: Callable[..., str]) -> Callable[..., str]:
            if name in self._tools:
                raise ValueError(f"tool {name!r} is already registered")
            self._tools[name] = Tool(
                name=name,
                description=description,
                schema=schema,
                handler=fn,
                risk=risk,
                confirm_prompt=confirm_prompt,
            )
            return fn

        return decorator

    def add(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def specs(self) -> list[dict[str, Any]]:
        return [t.spec() for t in self._tools.values() if t.risk is not Risk.BLOCKED]

    def names(self) -> list[str]:
        return sorted(self._tools)

    def __len__(self) -> int:
        return len(self._tools)

    def run(self, name: str, arguments: dict[str, Any]) -> str:
        """Execute a tool. Permission checks happen in the caller (brain.py),
        which owns the conversation with the user; this just runs it."""
        tool = self._tools.get(name)
        if tool is None:
            return f"Error: no tool named {name!r}. Available: {', '.join(self.names())}"
        if tool.risk is Risk.BLOCKED:
            return f"Error: {name!r} is blocked and cannot be run."
        try:
            result = tool.handler(**arguments)
        except TypeError as exc:
            return f"Error: bad arguments for {name!r}: {exc}"
        except ToolError as exc:
            return f"Error: {exc}"
        except Exception as exc:  # noqa: BLE001 - surface everything to the model
            return f"Error: {name!r} failed: {type(exc).__name__}: {exc}"
        if result is None:
            return "Done."
        return str(result)


registry = Registry()
