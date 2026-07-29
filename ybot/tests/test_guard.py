"""The guard is the only thing between the model and the machine.

Two kinds of test here. The first checks the policy decides correctly. The
second checks the policy is actually *consulted* — a correct policy that some
new code path forgets to call protects nothing, and that is a far easier
mistake to make than getting a regex wrong.
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ybot.guard import (  # noqa: E402
    Decision,
    evaluate,
    gate_command,
)


# --- policy ----------------------------------------------------------------

@pytest.mark.parametrize("text", [
    "4111 1111 1111 1111",
    "4111-1111-1111-1111",
    "my cvv is 123",
    "Place Order",
    "Buy now",
    "confirm purchase",
    "billing address",
])
def test_payment_text_is_hard_blocked_even_when_independent(text):
    d = evaluate("type", {"text": text}, independent=True)
    assert not d.allow, f"{text!r} must never execute"


def test_payment_element_name_is_blocked_on_click():
    """The block must cover clicking a Checkout button, not just typing a card."""
    d = evaluate("ui_click", {"element_name": "Checkout"}, independent=True)
    assert not d.allow


def test_ordinary_click_runs_unattended_in_independent_mode():
    d = evaluate("left_click", {"coordinate": [10, 10]}, independent=True)
    assert d.allow and not d.needs_approval


def test_assisted_mode_confirms_everything():
    d = evaluate("left_click", {"coordinate": [10, 10]}, independent=False)
    assert d.allow and d.needs_approval


def test_terminal_input_asks_first(monkeypatch):
    monkeypatch.setattr("ybot.guard.active_window_title", lambda: "Windows PowerShell")
    d = evaluate("type", {"text": "dir"}, independent=True)
    assert d.allow and d.needs_approval


def test_non_terminal_window_does_not_ask(monkeypatch):
    monkeypatch.setattr("ybot.guard.active_window_title", lambda: "Untitled - Notepad")
    d = evaluate("type", {"text": "hello"}, independent=True)
    assert d.allow and not d.needs_approval


def test_foreground_window_never_raises_off_windows():
    """Called on every action; must degrade, not explode, when the API is absent."""
    from ybot.guard import foreground_window

    hwnd, title = foreground_window()
    assert isinstance(hwnd, int) and isinstance(title, str)


@pytest.mark.parametrize("cmd", [
    "rm -rf /",
    "git push --force origin main",
    "git reset --hard",
    "drop table users",
    "shutdown /r",
    "ufw enable",
    "cat ~/.ssh/id_rsa",
    "export API_TOKEN=abc",
])
def test_dangerous_commands_require_approval(cmd):
    d = gate_command(cmd, independent=True)
    assert d.needs_approval, f"{cmd!r} must not run unattended"


def test_ordinary_command_runs_unattended():
    assert not gate_command("ls -la", independent=True).needs_approval


# --- the invariant: nothing acts without asking the guard -------------------

ACTING_CALLS = {"execute", "click", "click_input"}


def _calls_in(fn: ast.FunctionDef) -> set[str]:
    names = set()
    for node in ast.walk(fn):
        if isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Attribute):
                names.add(f.attr)
            elif isinstance(f, ast.Name):
                names.add(f.id)
    return names


def test_every_acting_function_consults_the_guard():
    """Any function that drives the mouse/keyboard must also call evaluate().

    This is the test that catches the dangerous class of change: someone adds a
    new tool that executes input and wires it straight to actions.execute. The
    policy would still be correct, and the machine would still be unprotected.
    """
    tree = ast.parse((ROOT / "ybot" / "agent.py").read_text(encoding="utf-8"))
    offenders = []
    for fn in [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]:
        calls = _calls_in(fn)
        if calls & ACTING_CALLS and "evaluate" not in calls:
            offenders.append(fn.name)
    assert not offenders, (
        f"these functions perform input without consulting guard.evaluate(): {offenders}"
    )


def test_the_invariant_test_can_actually_fail():
    """A guard test that cannot fail is decoration. Prove this one bites."""
    tree = ast.parse(
        "def rogue(self):\n"
        "    actions.execute('type', {'text': 'x'}, self.screen.metrics())\n"
    )
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef))
    calls = _calls_in(fn)
    assert calls & ACTING_CALLS and "evaluate" not in calls
