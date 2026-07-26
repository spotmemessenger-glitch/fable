"""Entrypoint.

Paper (default):   python run.py
Live micro:        set BOT_MODE, BOT_API_KEY, BOT_API_SECRET, BOT_LIVE_ARM first.

Ctrl+C stops cleanly; all state is already persisted after each step.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

from bot.config import load_config
from bot.engine import Engine


def main() -> None:
    cfg = load_config()
    engine = Engine(cfg)

    banner = (f"[{cfg.mode.upper()}] {cfg.exchange_id} | "
              f"symbols={','.join(cfg.symbols)} | tf={cfg.timeframe} | "
              f"start=${cfg.starting_cash:.2f}")
    print("=" * len(banner)); print(banner); print("=" * len(banner))
    if cfg.mode == "live":
        print("!! LIVE MODE — real orders will be placed. Ctrl+C within 5s to abort.")
        time.sleep(5)

    try:
        while True:
            equity, halted = engine.step()
            pos = ", ".join(f"{s}:{p.qty:.4f}@{p.avg_price:.2f}"
                            for s, p in engine.pf.positions.items()) or "none"
            flag = "  [HALTED: daily loss limit]" if halted else ""
            ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
            print(f"{ts}  equity=${equity:.2f}  cash=${engine.pf.cash:.2f}  "
                  f"realizedPnL=${engine.pf.realized_pnl:+.2f}  pos=[{pos}]{flag}")
            time.sleep(cfg.loop_seconds)
    except KeyboardInterrupt:
        print(f"\nstopped. state saved to {cfg.state_dir}")


if __name__ == "__main__":
    main()
