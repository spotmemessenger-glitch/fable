"""The desk you can talk to. A small REPL over Helm.

    python -m desk                 interactive
    python -m desk look BTC/USDT   one command and exit
    python -m desk scan
    python -m desk memes
    python -m desk book
    python -m desk status
    python -m desk run             paper loop (Ctrl-C to stop)

Nothing here can arm live trading; that is the three env switches in config.py.
`run` executes against the book, but the book is paper unless the desk is armed.
"""
from __future__ import annotations

import sys
import time

from .config import settings
from .helm import Helm


def _fmt_reading(name: str, r: dict) -> str:
    tag = {"long": "▲", "short": "▼", "flat": "•"}.get(r["stance"], "•")
    state = "" if r["state"] == "ok" else f" ({r['state']})"
    fact = r["facts"][0] if r["facts"] else ""
    return f"  {tag} {name:<9} {r['signal']:+.2f}{state}  {fact}"


def _print_report(rep: dict) -> None:
    print(f"\n═══ {rep['symbol']}  [{rep['mode'].upper()}]  "
          f"consensus {rep['consensus']:+.2f} ═══")
    for name, r in rep["readings"].items():
        if r["state"] in ("ok", "thin"):
            print(_fmt_reading(name, r))
    verdict = "APPROVED" if rep["approved"] else "NO TRADE"
    print(f"  SENTINEL  {verdict}: {'; '.join(rep['ruling']) or '—'}")
    if rep["action"] != "watch":
        print(f"  ACTION    {rep['action']}")
    print(f"\n  HELM ▸ {rep['narration']}")
    if rep.get("voice"):
        print(f"  (voice: {rep['voice']})")


def _print_book(b: dict) -> None:
    print(f"\n─── THE BOOK [{b['mode'].upper()}] ───")
    print(f"  cash ${b['cash']:,.2f}   equity ${b['equity']:,.2f}   "
          f"realised ${b['realised']:+,.2f}   unrealised ${b['unrealised']:+,.2f}")
    if not b["positions"]:
        print("  (no open positions)")
    for p in b["positions"]:
        mark = f"{p['price']:.4g}" if p["price"] else "?"
        print(f"  {p['symbol']:<10} {p['qty']:.6g} @ {p['entry']:.4g} → {mark}  "
              f"{p['pnl_pct']:+.2f}% (${p['pnl']:+,.2f})  [{p['wing']}]")


def _print_memes(rows: list) -> None:
    print(f"\n─── MEME SCAN ({len(rows)} candidates) ───")
    if not rows:
        print("  nothing boosted on Solana right now, or the feed is down")
    for row in rows:
        mark = "✅" if row["verdict"] == "GO" else "🚫"
        print(f"  {mark} {row['verdict']:<4} {row['symbol'] or row['mint'][:8]}")
        print(f"     {row['narration']}")
        trade = row.get("trade")
        if trade and trade.get("executed"):
            print(f"     ▸ SWAPPED ${trade['in_usdc']:,.2f} USDC — sig {trade['signature'][:16]}…")
        elif trade:
            print(f"     ▸ not executed: {trade['reason']}")


def _print_wallet(w: dict) -> None:
    print("\n─── SOLANA WALLET ───")
    print(f"  address  {w['address'] or '(none set)'}")
    print(f"  rpc      {w['rpc']}")
    print(f"  armed    {'YES — live swaps enabled' if w['armed'] else 'no (read-only / analysis)'}")
    sol = f"{w['sol']:.4f}" if w['sol'] is not None else "? (rpc unreachable)"
    usdc = f"{w['usdc']:,.2f}" if w['usdc'] is not None else "? (rpc unreachable)"
    print(f"  SOL      {sol}")
    print(f"  USDC     {usdc}")


def _status() -> None:
    lim = settings.limits
    print("\n─── DESK STATUS ───")
    print(f"  mode         {settings.mode.upper()}")
    print(f"  exchange     {settings.exchange_id}")
    print(f"  symbols      {', '.join(settings.symbols)}")
    print(f"  timeframe    {settings.timeframe}")
    print(f"  llm          {settings.llm_provider}")
    print(f"  voice        {'on' if settings.voice_enabled else 'off'}")
    print(f"  live switches: DESK_MODE=live={'✓' if _env('DESK_MODE') == 'live' else '✗'}  "
          f"DESK_API_KEY={'✓' if _env('DESK_API_KEY') else '✗'}  "
          f"DESK_API_SECRET={'✓' if _env('DESK_API_SECRET') else '✗'}  "
          f"DESK_LIVE_ARM={'✓' if _env('DESK_LIVE_ARM') == 'I_UNDERSTAND_THE_RISK' else '✗'}")
    print(f"  caps: position {lim.max_position_pct*100:.0f}%  exposure "
          f"{lim.max_total_exposure_pct*100:.0f}%  daily-loss halt "
          f"{lim.daily_loss_limit_pct*100:.0f}%")
    print(f"  solana swaps: {'ARMED' if settings.solana_armed else 'analysis only'}  "
          f"(DESK_SOLANA_KEY={'✓' if _env('DESK_SOLANA_KEY') else '✗'}  "
          f"DESK_SOLANA_ARM={'✓' if _env('DESK_SOLANA_ARM') == 'I_UNDERSTAND_THE_RISK' else '✗'})")


def _env(name: str) -> str:
    import os
    return os.environ.get(name, "")


HELP = """commands:
  look <SYMBOL>   full desk read on one symbol (e.g. look BTC/USDT or look SOL)
  scan            read every configured symbol
  memes [--live]  hunt Solana memecoins; --live buys GO candidates if armed
  wallet          Solana wallet: address, arm state, live SOL/USDC balances
  book            show cash, equity, and open positions
  status          mode, live-arm switches, and risk caps
  run [--dry]     paper loop over all symbols; --dry = analyse, don't trade
  help | quit"""


def _norm(symbol: str) -> str:
    symbol = symbol.upper()
    return symbol if "/" in symbol else f"{symbol}/USDT"


def _run_loop(desk: Helm, execute: bool) -> None:
    tag = "PAPER TRADING" if execute else "DRY (analysis only)"
    print(f"\n▶ run — {tag}, {settings.refresh_seconds}s cadence, Ctrl-C to stop")
    try:
        while True:
            for rep in desk.scan(execute=execute):
                _print_report(rep)
            time.sleep(settings.refresh_seconds)
    except KeyboardInterrupt:
        print("\n■ stopped.")


def _dispatch(desk: Helm, parts: list[str]) -> bool:
    """Run one command. Returns False to exit the REPL."""
    cmd = parts[0].lower()
    if cmd in ("quit", "exit", "q"):
        return False
    if cmd in ("help", "?"):
        print(HELP)
    elif cmd == "look" and len(parts) > 1:
        _print_report(desk.look(_norm(parts[1])))
    elif cmd == "scan":
        for rep in desk.scan(execute=False):
            _print_report(rep)
    elif cmd == "memes":
        _print_memes(desk.scan_memes(execute="--live" in parts))
    elif cmd == "wallet":
        _print_wallet(desk.wallet_status())
    elif cmd == "book":
        _print_book(desk.book())
    elif cmd == "status":
        _status()
    elif cmd == "run":
        _run_loop(desk, execute="--dry" not in parts)
    else:
        print("? try 'help'")
    return True


def main(argv: list[str] | None = None) -> None:
    # Windows consoles default to cp1252 and choke on the box-drawing glyphs.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    argv = list(sys.argv[1:] if argv is None else argv)
    print(f"THE DESK — 15 seats, crypto-native. mode: {settings.mode.upper()}")
    if settings.mode == "paper":
        print("paper by default. `status` shows what live arming would take.")
    desk = Helm(settings)

    if argv:                      # one-shot
        _dispatch(desk, argv)
        return

    print("type 'help' for commands.")
    while True:
        try:
            raw = input("\ndesk ▸ ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not raw:
            continue
        if not _dispatch(desk, raw.split()):
            break
