"""Entry point for the Solana meme-coin bot.

Paper by default (safe). Double-click run-memebot.bat to start — no command-line
knowledge needed. Ctrl+C stops cleanly; state persists after every cycle.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

from .config import load_config
from .engine import Engine


def main() -> None:
    cfg = load_config()
    hunt = ",".join(b for b, on in
                    [("established", cfg.hunt_established), ("fresh", cfg.hunt_fresh)] if on)
    banner = (f"[{cfg.mode.upper()}] Solana meme bot | bankroll ${cfg.risk.bankroll:.0f} "
              f"| hunt: {hunt} | max {cfg.risk.max_positions} positions")
    print("=" * len(banner))
    print(banner)
    print("=" * len(banner))
    if cfg.mode == "paper":
        print("PAPER MODE — simulated fills on REAL live prices. No money at risk.")
        print("Meme coins are extremely high risk; this proves the strategy safely first.\n")

    engine = Engine(cfg)
    try:
        while True:
            equity, halted, scanned = engine.step()
            held = ", ".join(
                f"{p.symbol}(${p.tokens * p.entry:.2f})"
                for p in engine.pf.positions.values()) or "none"
            ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
            flag = "  [HALTED: daily loss cap]" if halted else ""
            print(f"{ts}  scanned {scanned:>3}  equity=${equity:,.2f}  "
                  f"cash=${engine.pf.cash:,.2f}  realized=${engine.pf.realized:+.2f}  "
                  f"held=[{held}]{flag}")
            time.sleep(cfg.loop_seconds)
    except KeyboardInterrupt:
        print(f"\nstopped. state saved to {cfg.state_dir}")


if __name__ == "__main__":
    main()
