"""Permission policy: hard-block purchases, gate risky actions for approval."""
from __future__ import annotations

import ctypes
import re
from dataclasses import dataclass

# Hard block — never executed, even in independent mode.
PURCHASE_PATTERNS = re.compile(
    r"(card\s*number|\bcvv\b|\bcvc\b|checkout|place\s+order|buy\s+now|pay\s+now|"
    r"confirm\s+purchase|billing\s+address|routing\s+number|\biban\b|"
    r"\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})",
    re.IGNORECASE,
)

# Typing into one of these windows requires explicit approval.
TERMINAL_TITLES = (
    "command prompt",
    "powershell",
    "cmd.exe",
    "terminal",
    "wsl",
)


@dataclass
class Decision:
    allow: bool
    needs_approval: bool
    reason: str = ""


def foreground_window() -> tuple[int, str]:
    """(hwnd, title) of the foreground window; (0, "") if it cannot be read.

    The handle matters as much as the title: two dialogs can share a title, and
    a title can change while focus does not. Callers comparing "did focus move?"
    need both.
    """
    try:
        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        length = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        return int(hwnd), buf.value
    except Exception:
        return 0, ""


def active_window_title() -> str:
    return foreground_window()[1]


def evaluate(action: str, params: dict, independent: bool) -> Decision:
    """Return a Decision for a single computer-use action about to run."""
    text = str(params.get("text", ""))
    # For ui_click the target label is the element's name, not typed text.
    target = text if action == "type" else str(params.get("element_name", ""))

    # 1) Hard block: typed text OR a clicked element that resembles payment / checkout.
    if action in ("type", "ui_click") and PURCHASE_PATTERNS.search(target):
        return Decision(
            allow=False,
            needs_approval=False,
            reason="Blocked: resembles payment / purchase. Purchases are never permitted.",
        )

    # 2) Typing/keys into a terminal window — always ask first ('cmd after permission').
    if action in ("type", "key"):
        title = active_window_title()
        if any(t in title.lower() for t in TERMINAL_TITLES):
            return Decision(True, True, f"Sending input to a terminal window: '{title}'")

    # 3) Assisted mode confirms every action.
    if not independent:
        return Decision(True, True, "Assisted mode: confirm each action.")

    # 4) Independent mode: safe GUI actions run automatically.
    return Decision(True, False, "")


# ---------------------------------------------------------------------------
# Server / deploy mode — gating for shell commands (local or over SSH).
# Deterministic patterns, never model judgment, so they can't be argued away.
# ---------------------------------------------------------------------------

DESTRUCTIVE_COMMAND = re.compile(
    r"(\brm\s+-[a-z]*[rf]|\brmdir\s+/s|\bdel\s+/[a-z]*[sq]|remove-item[^\n]*-recurse|"
    r"\bformat\b|\bmkfs|\bdd\s+if=|>\s*/dev/sd|git\s+push\s+.*--force|git\s+reset\s+--hard|"
    r"\bdrop\s+(table|database)\b|\btruncate\s+table\b|shutdown|reboot|halt|"
    r"\bdiskpart\b|clear-disk|reg\s+delete|rd\s+/s|:\s*>\s*/|chmod\s+-R\s+777\s+/)",
    re.IGNORECASE,
)

# Firewall / SSH changes that can sever the connection. The persona is taught to
# allow SSH before enabling ufw; this is the human-eyeball safety net.
LOCKOUT_COMMAND = re.compile(
    r"(ufw\s+enable|ufw\s+default\s+deny|ufw\s+reset|iptables\s+-P\s+INPUT\s+DROP|"
    r"iptables\s+-F|nft\s+flush|/etc/ssh/sshd_config|systemctl\s+(stop|disable)\s+ssh|"
    r"service\s+ssh\s+stop|passwd\s+-l\b)",
    re.IGNORECASE,
)

SECRETS_COMMAND = re.compile(
    r"(\.env\b|id_rsa|id_ed25519|\.ssh/|\.pem\b|"
    r"\bexport\s+[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)|"
    r"aws_secret|private_key)",
    re.IGNORECASE,
)


def gate_command(command: str, independent: bool, remote: bool = False) -> Decision:
    """Verdict for a shell command the deploy brain wants to run (local or remote)."""
    where = "remote server" if remote else "your PC"
    if DESTRUCTIVE_COMMAND.search(command):
        return Decision(True, True, f"Destructive command on the {where} — approve to run.")
    if LOCKOUT_COMMAND.search(command):
        return Decision(True, True, f"Firewall/SSH change on the {where} that could lock you out — approve.")
    if SECRETS_COMMAND.search(command):
        return Decision(True, True, f"Touches credentials on the {where} — approve to run.")
    # Ordinary command: auto in independent mode, confirmed in assisted mode.
    return Decision(True, not independent, "" if independent else "Assisted mode: confirm each command.")
