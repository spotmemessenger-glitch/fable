"""Entry point: `python run.py` (or `python -m operator_agent.main`)."""
from __future__ import annotations

from . import charts, crash_reporter
from .agent import Operator
from .config import SETTINGS
from .screen import set_dpi_awareness


def console_approver(reason: str) -> bool:
    print(f"\n[APPROVAL NEEDED] {reason}")
    return input("Allow? [y/N] ").strip().lower() in ("y", "yes")


def main() -> None:
    crash_reporter.install()  # every uncaught exception -> crashes/ + auto-triage
    set_dpi_awareness()  # MUST run before pyautogui / mss initialize
    SETTINGS.validate()

    print("=" * 64)
    print(" Ybot — Phase 1")
    _active_model = SETTINGS.ollama_model if SETTINGS.use_ollama else SETTINGS.model
    _mode_tag = "free vision" if SETTINGS.use_ollama else "computer-use"
    print(f" Model: {_active_model} ({_mode_tag})   Kill switch: {SETTINGS.kill_hotkey}")
    print(" Failsafe: slam the mouse into any screen corner to abort.")
    print("=" * 64)

    mode = input("Mode — [a]ssisted (confirm each action) or [i]ndependent? [a/i] ").strip().lower()
    independent = mode.startswith("i")
    if independent:
        print(
            "INDEPENDENT MODE: safe GUI actions run automatically. Purchases are blocked; "
            "terminal input still asks first."
        )

    goal = input("\nWhat should I do?\n> ").strip()
    if not goal:
        print("No goal given. Exiting.")
        return

    # Fast-path: a plain "chart BTC" / "show me the live SOL chart" opens a live
    # TradingView chart in the browser without spinning up the vision loop.
    chart_symbol = charts.parse_chart_goal(goal)
    if chart_symbol is not None:
        url = charts.open_chart(chart_symbol)
        print(f"\nOpening live chart for {chart_symbol} → {url}")
        return

    if SETTINGS.use_ollama:
        from .ollama_operator import OllamaOperator

        op = OllamaOperator(independent=independent, approver=console_approver)
    else:
        op = Operator(independent=independent, approver=console_approver)
    if not op.kill.registered:
        print(
            f"(Note: global hotkey '{SETTINGS.kill_hotkey}' could not register — run as "
            "admin for it. The mouse-corner failsafe still works.)"
        )
    try:
        result = op.run(goal)
        print(f"\n=== RESULT ===\n{result}")
    except KeyboardInterrupt:
        print("\n[stopped by kill switch]")


if __name__ == "__main__":
    main()
