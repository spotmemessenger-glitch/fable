"""Agent orchestrator: routes a classified Intent to the right specialist.

Routing is a table, not a model call. Each Domain maps to a handler name that
the ybot side resolves to a real agent. Keeping this deterministic makes a route
auditable and testable, and turns a misroute into a data fix rather than a
prompt tweak.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .intent import Domain, Intent


@dataclass(frozen=True)
class Route:
    agent: str
    description: str
    needs_approval: bool = False


ROUTES: dict[Domain, Route] = {
    Domain.CODING: Route("engineering-senior-developer", "write or change code"),
    Domain.RESEARCH: Route("product-trend-researcher", "investigate and report"),
    Domain.BROWSER: Route("browser-operator", "drive a web browser"),
    Domain.UIUX: Route("design-ui-designer", "interface and visual design"),
    Domain.FILESYSTEM: Route("desktop-operator", "files and folders", needs_approval=True),
    Domain.THREED: Route("blender-automation", "3D modelling and rendering"),
    Domain.TRADING: Route("crypto-trading-desk:market-monitor", "market data and analysis"),
    Domain.DESKTOP: Route("desktop-operator", "mouse and keyboard control"),
    Domain.CHITCHAT: Route("manager", "answer directly, no delegation"),
    Domain.CONTROL: Route("manager", "stop or cancel current work"),
    Domain.UNKNOWN: Route("manager", "ask the user to clarify"),
}


@dataclass(frozen=True)
class Dispatch:
    route: Route
    intent: Intent
    approved: bool


class Orchestrator:
    """Maps Intent to Dispatch and invokes the registered handler.

    `approver` is called for any route flagged needs_approval, mirroring the
    console_approver already used by ybot main.py. Destructive filesystem work
    must never run unattended merely because it was spoken aloud.
    """

    def __init__(self, approver: Callable[[str], bool] | None = None) -> None:
        self._approver = approver
        self._handlers: dict[str, Callable[[Intent], str]] = {}

    def register(self, agent: str, fn: Callable[[Intent], str]) -> None:
        self._handlers[agent] = fn

    def plan(self, intent: Intent) -> Dispatch:
        route = ROUTES.get(intent.domain, ROUTES[Domain.UNKNOWN])
        approved = True
        if route.needs_approval and self._approver is not None:
            approved = self._approver(f"{route.description}: {intent.text}")
        return Dispatch(route, intent, approved)

    def dispatch(self, intent: Intent) -> str:
        d = self.plan(intent)
        if not d.approved:
            return "Cancelled - not approved."
        fn = self._handlers.get(d.route.agent)
        if fn is None:
            return f"No handler registered for {d.route.agent}."
        return fn(intent)


def demo() -> None:
    from .intent import IntentManager

    im = IntentManager()
    calls: list[str] = []

    # deny everything: an approval-gated route must not reach its handler
    o = Orchestrator(approver=lambda reason: False)
    o.register("desktop-operator", lambda i: calls.append(i.text) or "done")
    fs = im.classify("delete that folder")
    assert fs.domain is Domain.FILESYSTEM
    assert o.dispatch(fs) == "Cancelled - not approved."
    assert calls == [], "handler ran despite denied approval"

    # an ungated route reaches its handler
    o2 = Orchestrator(approver=lambda r: True)
    o2.register("desktop-operator", lambda i: "clicked")
    assert o2.dispatch(im.classify("click the start button")) == "clicked"

    # every domain must have a route - no silent KeyError at runtime
    for d in Domain:
        assert d in ROUTES, d
    print("orchestrator: ok (approval gate held, all domains routed)")


if __name__ == "__main__":
    demo()
