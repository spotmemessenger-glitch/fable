"""JS <-> Python bridge: drives the Ybot operator, window controls, voice, approvals.

Exposed to the web UI as `window.pywebview.api.*`. Long-running work runs on a
background thread; progress is pushed back to the UI via `window.evaluate_js`.
"""
from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
import os
import re
import sys
import threading
import time
import traceback
from pathlib import Path

import webview

# --- natural-language command routing ------------------------------------------------
# Lets plain-English requests reach the right skill without memorising exact prefixes
# ("3d:", "likeness:", "photoreal:"). Deliberately regex/keyword-based, not an LLM call —
# every message would otherwise pay extra latency+cost just to classify intent. Patterns
# are multi-word and specific on purpose, to avoid hijacking ordinary operator commands
# that happen to mention "model" or "3d" in an unrelated sense.
_RE_3D_VIEW = re.compile(r"\b(show|see|view|check|how'?s|how is)\b.{0,20}\b(3d|model|progress)\b", re.I)
_RE_PHOTOREAL = re.compile(
    r"\b(look(s)? like me|my (photo|picture|face|selfie)|this photo|"
    r"3d (scan|model) of me|exactly like me|photoreal)\b", re.I,
)
_RE_LIKENESS = re.compile(
    r"\b(3d (model|character|avatar) of (him|her|the person|this (guy|man|woman|photo))|"
    r"turn (this|him|her) into (a )?3d|likeness)\b", re.I,
)
_RE_3D_BUILD = re.compile(
    r"\b(make|build|create|generate|model|design)\b.{0,25}\b(3d model|in 3d|as a 3d|3d version|3d object)\b|"
    r"\b3d model of\b", re.I,
)
_RE_JAVA = re.compile(
    r"\b(write|make|build|create|generate|code)\b.{0,30}\bjava\b|"
    r"\bjava (program|code|class|application|app)\b", re.I,
)
_RE_REMEMBER = re.compile(r"^\s*remember (that |this[:,]? )?", re.I)
_RE_RECALL = re.compile(
    r"^\s*(do you remember|what do you remember|recall|what did i (tell|say)|"
    r"have i told you)\b", re.I,
)
_RE_HELP = re.compile(
    r"^\s*(help|what can you do|what are your (commands|skills|capabilities)|"
    r"list (your )?(commands|skills)|what commands)\s*[?.!]*\s*$", re.I,
)
_RE_DESIGN = re.compile(
    r"\b(design|mock(\s|-)?up)\b.{0,30}\b(app|website|site|screen|page|ui|ux|"
    r"interface|dashboard|landing page)\b|"
    r"\b(app|website|site|screen|page|ui|ux)\b.{0,20}\bdesign\b", re.I,
)

_CAPABILITIES_TEXT = (
    "Here's what I can do, boss:\n"
    "• Type any task and I'll take over the mouse/keyboard to do it (files, browsers, apps).\n"
    "• \"3d: <description>\" or just describe an object — I'll model it in Blender headless.\n"
    "• Attach a photo and say \"photoreal:\" (or \"make a 3d model of me\") — a real neural "
    "3D reconstruction of the photo, not a sketch.\n"
    "• Attach a photo and say \"likeness:\" — a stylized 3D character built in Blender from it.\n"
    "• \"java: <task>\" or \"write java code for…\" — I write it, compile it with javac, "
    "run it, and fix any errors before calling it done.\n"
    "• \"remember that…\" — I'll keep it permanently, across restarts. \"recall …\" or "
    "\"what do you remember about…\" to search it back.\n"
    "• \"cli: search|install|launch <name>\" — control other software (GIMP, "
    "LibreOffice, OBS, 100+ others) via a generated CLI instead of clicking through it.\n"
    "• \"shell: <task>\" or \"terminal: <task>\" — I'll drive real PowerShell/cmd/git/VS "
    "Code directly, one careful step at a time, with a hard safety block on destructive commands.\n"
    "• \"design: <brief>\" — a real, openable HTML/CSS app mockup from a senior UI/UX + "
    "frontend engineer (Figma/Canva/Stitch aren't something I can drive — this is the "
    "honest, actually-working equivalent, and it opens straight in your browser).\n"
    "• \"trade: <question>\" — trading, DeFi, and quant finance answers backed by 67 "
    "expert skills (Kelly sizing, risk management, backtesting, on-chain analysis, "
    "options pricing, tax, and more). Analysis and code, never buy/sell advice.\n"
    "• \"crypto: <question>\" — the Crypto Trading Desk plugin (7 expert agent personas: "
    "technical analysis, risk, portfolio, sentiment, on-chain). \"plugins\" lists what's "
    "installed; drop a .py into plugins/ to add your own.\n"
    "• \"3dview\" or \"show me the model\" — opens a live Blender window that auto-updates.\n"
    "• Click the mic to dictate, or the 👂 to arm \"hey bot\" hands-free voice.\n"
    "• I speak my replies out loud — click 🔊 to mute."
)


def _route_natural_language(text: str, has_images: bool) -> str | None:
    """Rewrite plain-English 3D/Java/help requests into the canonical prefixed command
    the rest of command() already understands. Returns None to fall through unchanged."""
    if _RE_HELP.search(text):
        return "help"
    if _RE_RECALL.search(text):
        return f"recall: {text}"
    if _RE_REMEMBER.match(text):
        return f"remember: {_RE_REMEMBER.sub('', text)}"
    if _RE_3D_VIEW.search(text):
        return "3dview"
    if has_images and _RE_PHOTOREAL.search(text):
        return f"photoreal: {text}"
    if has_images and _RE_LIKENESS.search(text):
        return f"likeness: {text}"
    if _RE_JAVA.search(text):
        return f"java: {text}"
    if _RE_3D_BUILD.search(text):
        return f"3d: {text}"
    if _RE_DESIGN.search(text):
        return f"design: {text}"
    return None

# Diagnostic log — every lifecycle event with a timestamp, so we can see exactly what
# fires (and in what order) when a task is spoken/started/stopped.
_LOG = Path(__file__).resolve().parent / "ybot.log"


def _log(event: str) -> None:
    try:
        with _LOG.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {event}\n")
    except Exception:
        pass

# Reuse the already-built Ybot operator (hands/eyes) from the sibling project.
_YBOT = Path(__file__).resolve().parent.parent / "ybot"
if str(_YBOT) not in sys.path:
    sys.path.insert(0, str(_YBOT))

_HWND_TOPMOST = wintypes.HWND(-1)
_HWND_NOTOPMOST = wintypes.HWND(-2)
_SWP_NOMOVE = 0x0002
_SWP_NOSIZE = 0x0001
_SWP_NOZORDER = 0x0004
_SWP_NOACTIVATE = 0x0010
_GA_ROOT = 2
_HWND_TOP = wintypes.HWND(0)

# Bind the Win32 calls with correct pointer-width types. Without argtypes, ctypes
# treats HWNDs as 32-bit ints and silently truncates them on 64-bit Windows, so
# SetWindowPos hits the wrong (or no) window and always-on-top appears to do nothing.
_user32 = ctypes.windll.user32
_user32.FindWindowW.restype = wintypes.HWND
_user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
_user32.GetAncestor.restype = wintypes.HWND
_user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
_user32.SetWindowPos.restype = wintypes.BOOL
_user32.SetWindowPos.argtypes = [
    wintypes.HWND, wintypes.HWND,
    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wintypes.UINT,
]
_user32.GetWindowRect.restype = wintypes.BOOL
_user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
_user32.ShowWindow.restype = wintypes.BOOL
_user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]

_SW_MINIMIZE = 6
_SW_RESTORE = 9


class Bridge:
    def __init__(self) -> None:
        self._window = None
        self._busy = False
        self._mode = "bypass"  # "bypass" (autonomous) | "ask" (permission required)
        self._approval = threading.Event()
        self._approval_result = False
        self._attachments: list[str] = []
        self._stop = threading.Event()  # set -> the running operator aborts
        self._hwnd_val = None           # cached top-level window handle (captured on show)

    def set_window(self, window) -> None:
        self._window = window

    def capture_hwnd(self) -> None:
        """Cache the real top-level HWND once the window is on screen."""
        self._hwnd_val = self._resolve_hwnd()

    # --- UI updates --------------------------------------------------------------------
    def _js(self, code: str) -> None:
        if self._window is None:
            return
        try:
            self._window.evaluate_js(code)
        except Exception:
            pass

    def _emit(self, kind: str, text: str) -> None:
        safe = (text or "").replace("\\", "\\\\").replace("`", "\\`").replace("$", "\\$")
        self._js(f"window.ybot.on({kind!r}, `{safe}`)")

    def _say(self, text: str) -> None:
        """Show a line AND speak it aloud."""
        safe = (text or "").replace("\\", "\\\\").replace("`", "\\`").replace("$", "\\$")
        self._js(f"window.ybot.say(`{safe}`)")

    # --- window controls ---------------------------------------------------------------
    def minimize(self) -> None:
        try:
            self._window.minimize()
        except Exception:
            pass

    def _handle_to_int(self, handle) -> int:
        # pythonnet IntPtr -> python int (ToInt64 is the reliable path; int() varies by version).
        for attr in ("ToInt64", "ToInt32"):
            fn = getattr(handle, attr, None)
            if fn is not None:
                try:
                    return int(fn())
                except Exception:
                    pass
        return int(handle)

    def _resolve_hwnd(self):
        # 1) live native handle (correct even for frameless windows / after relaunches)
        try:
            native = getattr(self._window, "native", None)
            handle = getattr(native, "Handle", None)
            if handle is not None:
                hwnd = wintypes.HWND(self._handle_to_int(handle))
                root = _user32.GetAncestor(hwnd, _GA_ROOT)  # child control -> top-level window
                if root:
                    return root
                if hwnd:
                    return hwnd
        except Exception:
            pass
        # 2) find a VISIBLE top-level window titled "Ybot" (skips stale/hidden ones)
        try:
            found = {"h": None}
            @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
            def _cb(h, _lp):
                if not _user32.IsWindowVisible(h):
                    return True
                n = _user32.GetWindowTextLengthW(h)
                buf = ctypes.create_unicode_buffer(n + 1)
                _user32.GetWindowTextW(h, buf, n + 1)
                if buf.value == "Ybot":
                    found["h"] = h
                    return False
                return True
            _user32.EnumWindows(_cb, 0)
            if found["h"]:
                return found["h"]
        except Exception:
            pass
        # 3) last resort: first match by title
        hwnd = _user32.FindWindowW(None, "Ybot")
        return hwnd if hwnd else None

    def _hwnd(self):
        return self._hwnd_val or self._resolve_hwnd()

    def set_on_top(self, on: bool) -> bool:
        applied = False
        try:
            hwnd = self._hwnd()
            if hwnd:
                applied = bool(_user32.SetWindowPos(
                    hwnd,
                    _HWND_TOPMOST if on else _HWND_NOTOPMOST,
                    0, 0, 0, 0,
                    _SWP_NOMOVE | _SWP_NOSIZE | _SWP_NOACTIVATE,
                ))
        except Exception:
            pass
        try:
            self._window.on_top = bool(on)  # keep pywebview's own state in sync
        except Exception:
            pass
        self._emit("status", f"always-on-top {'ON' if on else 'OFF'}"
                             + ("" if applied else " (win32 call failed)"))
        return bool(on)

    def close(self) -> None:
        # While a task runs the operator is driving the real mouse; ignore close clicks so
        # it can't shut its own window. The user stops the task (⏹ / Ctrl+Alt+Q) first.
        if self._busy:
            self._emit("status", "stop the task first (⏹ or Ctrl+Alt+Q), then close")
            return
        if self._window is not None:
            self._window.destroy()

    def _show(self, cmd: int) -> None:
        try:
            hwnd = self._hwnd()
            if hwnd:
                _user32.ShowWindow(hwnd, cmd)
        except Exception:
            pass

    def _repaint(self) -> None:
        """Force WebView2 to rebuild its render surface after a restore so it doesn't
        come back black. Nudging the window 1px larger and back triggers a WM_SIZE, which
        makes the WebView2 controller resize + repaint. NOMOVE|NOZORDER keeps the position
        and always-on-top z-order untouched. (The CalculateNativeWinOcclusion switch in
        run.py is the primary fix; this recovers the surface instantly on the auto-restore.)"""
        try:
            hwnd = self._hwnd()
            if not hwnd:
                return
            rect = wintypes.RECT()
            if not _user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                return
            w = rect.right - rect.left
            h = rect.bottom - rect.top
            flags = _SWP_NOMOVE | _SWP_NOZORDER | _SWP_NOACTIVATE
            _user32.SetWindowPos(hwnd, _HWND_TOP, 0, 0, w + 1, h + 1, flags)
            _user32.SetWindowPos(hwnd, _HWND_TOP, 0, 0, w, h, flags)
        except Exception:
            pass

    # --- dragging (frameless window is moved by its titlebar) ---------------------------
    def get_position(self) -> dict:
        try:
            hwnd = self._hwnd()
            if hwnd:
                rect = wintypes.RECT()
                if _user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                    return {"x": int(rect.left), "y": int(rect.top)}
        except Exception:
            pass
        return {"x": 0, "y": 0}

    def move_to(self, x: int, y: int) -> bool:
        # NOZORDER keeps the current z-order, so dragging never drops always-on-top.
        try:
            hwnd = self._hwnd()
            if hwnd and _user32.SetWindowPos(
                hwnd, _HWND_TOP, int(x), int(y), 0, 0,
                _SWP_NOSIZE | _SWP_NOZORDER | _SWP_NOACTIVATE,
            ):
                return True
        except Exception:
            pass
        try:
            self._window.move(int(x), int(y))  # backend fallback
            return True
        except Exception:
            return False

    # --- command -----------------------------------------------------------------------
    def command(self, text: str, mode: str = "bypass", speed: str = "fast") -> str:
        text = (text or "").strip()
        if not text:
            return "empty"
        if self._busy:
            return "busy"
        # Natural-language routing: rewrite plain English into the canonical prefixed
        # command before anything else looks at `text`, so "make me a 3d model of a gear"
        # or "can you make it look like me" work without memorising exact prefixes.
        has_images = bool(self._attachments)
        already_explicit = text.lower().startswith(
            ("3d:", "blender:", "likeness:", "photoreal:", "java:", "remember:", "recall:", "cli:", "graph:", "docs:", "shell:", "terminal:", "design:", "trade:", "trading:")
        ) or text.lower().replace(" ", "") in (
            "3dview", "3dwatch", "3dprogress", "likeness", "photoreal", "help", "recall",
        )
        # Plugins: plugins/*.py each claim a "<command>:" prefix (see plugins_loader).
        # Handle them here — before natural-language routing — so a plugin command is
        # never rewritten, plus the "plugins" command that lists what's installed.
        _tl = text.lower()
        if _tl.replace(" ", "") in ("plugins", "plugin", "listplugins"):
            try:
                import plugins_loader
                self._say(plugins_loader.summary())
            except Exception as e:
                self._emit("error", f"couldn't list plugins: {type(e).__name__}: {e}")
            return "started"
        try:
            import plugins_loader
            _plugin = next((p for p in plugins_loader.discover()
                            if _tl.startswith(p["command"].lower() + ":")), None)
        except Exception:
            _plugin = None
        if _plugin:
            ptask = text.split(":", 1)[1].strip()
            if not ptask:
                return "empty"
            self._busy = True
            self._stop.clear()
            threading.Thread(target=self._run_plugin, args=(_plugin, ptask), daemon=True).start()
            return "started"
        if not already_explicit:
            rewritten = _route_natural_language(text, has_images)
            if rewritten:
                text = rewritten
        if text.lower() == "help":
            self._say(_CAPABILITIES_TEXT)
            return "started"
        # Live 3D progress viewer: opens a GUI Blender that auto-reloads the likeness
        # model as build rounds update it ("teach ybot" — the same viewer used for the
        # overnight likeness build).
        low = text.lower()
        if low.replace(" ", "") in ("3dview", "3dwatch", "3dprogress"):
            try:
                import subprocess
                subprocess.Popen([
                    r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe",
                    "--python",
                    str(Path(__file__).resolve().parent / "creations" / "likeness" / "watch.py"),
                ])
                self._emit("done", "Live 3D viewer opened — Blender will auto-reload as the model updates.")
            except Exception as e:
                self._emit("error", f"couldn't open the viewer: {e}")
            return "started"
        # 3D route: "3d: <description>" (or "blender: …") builds a mesh in Blender headless
        # instead of driving the desktop with the operator's arms/eyes.
        if low.startswith("3d:") or low.startswith("blender:"):
            desc = text.split(":", 1)[1].strip()
            if not desc:
                return "empty"
            self._busy = True
            self._stop.clear()
            threading.Thread(target=self._run_blender, args=(desc,), daemon=True).start()
            return "started"
        # Likeness route: "likeness: <description>" turns attached reference photo(s) into
        # an iteratively-refined 3D character in Blender (render -> critique -> patch loop).
        if low.startswith("likeness:") or low.replace(" ", "") == "likeness":
            images = [p for p in self._attachments if Path(p).suffix.lower() in
                      (".png", ".jpg", ".jpeg", ".webp")]
            if not images:
                return "no_reference_images"
            desc = text.split(":", 1)[1].strip() if ":" in text else ""
            self._attachments = []
            self._busy = True
            self._stop.clear()
            threading.Thread(target=self._run_likeness, args=(images, desc), daemon=True).start()
            return "started"
        # Photoreal route: "photoreal:" turns an attached reference photo into an ACTUAL
        # neural 3D reconstruction (TripoSR, local GPU) — far more accurate than the
        # procedural "likeness:" route, best for "make it look like me" requests.
        if low.startswith("photoreal:") or low.replace(" ", "") == "photoreal":
            images = [p for p in self._attachments if Path(p).suffix.lower() in
                      (".png", ".jpg", ".jpeg", ".webp")]
            if not images:
                return "no_reference_images"
            desc = text.split(":", 1)[1].strip() if ":" in text else ""
            self._attachments = []
            self._busy = True
            self._stop.clear()
            threading.Thread(target=self._run_photoreal, args=(images[0], desc), daemon=True).start()
            return "started"
        # Java route: "java: <task>" writes REAL Java — compiles with javac, runs it,
        # and auto-fixes compile/runtime errors. Runs on the free Gemini route (pure
        # code generation, no desktop control), so it doesn't touch Anthropic credit.
        if low.startswith("java:"):
            task = text.split(":", 1)[1].strip()
            if not task:
                return "empty"
            self._busy = True
            self._stop.clear()
            threading.Thread(target=self._run_java, args=(task,), daemon=True).start()
            return "started"
        # Memory routes: "remember: <fact>" stores it permanently (supermemory.ai,
        # free cloud tier — Ybot has no persistence across restarts otherwise);
        # "recall: <question>" searches everything Ybot has been told.
        if low.startswith("remember:"):
            fact = text.split(":", 1)[1].strip()
            if not fact:
                return "empty"
            self._busy = True
            self._stop.clear()
            threading.Thread(target=self._run_remember, args=(fact,), daemon=True).start()
            return "started"
        if low.startswith("recall:") or low.replace(" ", "") == "recall":
            query = text.split(":", 1)[1].strip() if ":" in text else ""
            if not query:
                return "empty"
            self._busy = True
            self._stop.clear()
            threading.Thread(target=self._run_recall, args=(query,), daemon=True).start()
            return "started"
        # CLI route: "cli: search|install|launch <name>" — controls other software
        # (GIMP, LibreOffice, Blender, OBS, 100+ others) via CLI-Anything's generated
        # agent-native CLIs instead of clicking through a GUI.
        if low.startswith("cli:"):
            args_text = text.split(":", 1)[1].strip()
            if not args_text:
                return "empty"
            self._busy = True
            self._stop.clear()
            threading.Thread(target=self._run_cli, args=(args_text,), daemon=True).start()
            return "started"
        # Graph route: "graph: path A B" or "graph: explain X" — queries a codebase
        # knowledge graph already built by graphify (e.g. via Claude Code's /graphify .).
        # Building the graph is agent-orchestrated, not something Ybot does itself.
        if low.startswith("graph:"):
            args_text = text.split(":", 1)[1].strip()
            if not args_text:
                return "empty"
            self._busy = True
            self._stop.clear()
            threading.Thread(target=self._run_graph, args=(args_text,), daemon=True).start()
            return "started"
        # Docs route: "docs: <task>" writes a real PDF/DOCX/PPTX/XLSX file — the brain
        # plans structured content, doc_tools.py builds the actual file deterministically
        # via pypdf/python-docx/python-pptx/openpyxl. Free Gemini route, no desktop control.
        if low.startswith("docs:"):
            task = text.split(":", 1)[1].strip()
            if not task:
                return "empty"
            self._busy = True
            self._stop.clear()
            threading.Thread(target=self._run_docs, args=(task,), daemon=True).start()
            return "started"
        # Shell route: "shell: <task>" — a senior-engineer PowerShell/cmd/git/VS Code
        # loop, real subprocess execution (not typing into a GUI terminal), with a hard
        # safety denylist checked before every command regardless of what the brain proposes.
        if low.startswith("shell:") or low.startswith("terminal:"):
            task = text.split(":", 1)[1].strip()
            if not task:
                return "empty"
            self._busy = True
            self._stop.clear()
            threading.Thread(target=self._run_shell, args=(task,), daemon=True).start()
            return "started"
        # Design route: "design: <brief>" — a real, openable production-quality HTML/CSS
        # app mockup (Figma/Canva/Stitch are MCP tools only Claude Code can drive; Ybot
        # isn't an MCP client, so this is the honest, actually-buildable equivalent).
        if low.startswith("design:"):
            task = text.split(":", 1)[1].strip()
            if not task:
                return "empty"
            self._busy = True
            self._stop.clear()
            threading.Thread(target=self._run_design, args=(task,), daemon=True).start()
            return "started"
        # Trading route: "trade: <task>" answers a trading/DeFi/quant question using the
        # single most-relevant of the 67 vendored agiprolabs trading Agent Skills as
        # authoritative context. Free Gemini route (ai_client) — no desktop control, no
        # Anthropic credit. Analysis/code only; never personalized buy/sell advice.
        if low.startswith("trade:") or low.startswith("trading:"):
            task = text.split(":", 1)[1].strip()
            if not task:
                return "empty"
            self._busy = True
            self._stop.clear()
            threading.Thread(target=self._run_trade, args=(task,), daemon=True).start()
            return "started"
        if self._attachments:
            files = "\n".join(f"- {p}" for p in self._attachments)
            text = (
                "The user attached these files; open or use them as needed:\n"
                f"{files}\n\nTask: {text}"
            )
            self._attachments = []
        self._mode = mode if mode in ("bypass", "ask") else "bypass"
        self._busy = True
        self._stop.clear()
        independent = self._mode == "bypass"
        _log(f"command START mode={self._mode} speed={speed} text={text[:60]!r}")
        threading.Thread(target=self._run, args=(text, independent, speed), daemon=True).start()
        return "started"

    def _run(self, goal: str, independent: bool, speed: str = "fast") -> None:
        # Get out of the operator's way: a floating, always-on-top window would otherwise be
        # clicked (or closed) by the operator driving the real mouse. Only auto-minimise in
        # autonomous mode; in "ask" mode the window must stay visible to show approval popups.
        if independent:
            # Announce out loud, give the user a moment to hear it, THEN tuck away.
            self._say("On it, boss. I'll minimise while I work on your task, and pop back "
                      "the moment it's done.")
            time.sleep(3.2)
            self._show(_SW_MINIMIZE)
        else:
            self._emit("status", "working on it… (I'll ask before each action)")
        try:
            from ybot.config import SETTINGS

            # Free path: when OPERATOR_PROVIDER=ollama, drive the desktop with the
            # local/cloud VISION operator — no Anthropic, no computer-use credit.
            if SETTINGS.use_ollama:
                from ybot.ollama_operator import OllamaOperator

                op = OllamaOperator(
                    independent=independent,
                    approver=self._approve,
                    should_stop=self._stop.is_set,
                )  # model defaults to SETTINGS.ollama_model (e.g. gemma4:31b)
            else:
                from ybot.agent import Operator

                model = {
                    "smart": SETTINGS.smart_model,
                    "fable": SETTINGS.fable_model,
                }.get(speed, SETTINGS.fast_model)
                op = Operator(
                    independent=independent,
                    approver=self._approve,
                    should_stop=self._stop.is_set,
                    model=model,
                )
            result = op.run(goal)
            _log(f"operator RESULT {result[:80]!r}")
            self._emit("done", result)
        except Exception as e:
            _log(f"operator EXCEPTION {type(e).__name__}: {e}")
            self._emit("error", f"{type(e).__name__}: {e}")
        finally:
            self._busy = False
            if independent:
                self._show(_SW_RESTORE)
                time.sleep(0.15)   # let the restore settle before nudging a repaint
                self._repaint()    # rebuild the WebView2 surface so it isn't black
            _log("run FINISHED (busy cleared, window restored)")

    def _run_blender(self, description: str) -> None:
        """3D route: Claude writes a Blender bpy script, Blender builds + exports it headless.
        No minimise/operator — this never touches the mouse, so Ybot stays put."""
        try:
            self._say("On it, boss — building your 3D model in Blender. Give me a moment.")
            self._emit("status", f"Modelling “{description}” in Blender (headless)… ~30–60s")
            import blender  # local import so a Blender/anthropic hiccup can't break startup
            res = blender.create(description)
            if res.get("ok") and res.get("out"):
                out = Path(res["out"])
                try:
                    os.startfile(str(out.parent))  # pop open the creations/ folder
                except Exception:
                    pass
                # show the result in Blender on screen ("progress you can see")
                if res.get("blend"):
                    try:
                        import subprocess
                        subprocess.Popen([
                            r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe",
                            res["blend"],
                        ])
                    except Exception:
                        pass
                self._emit("done", f"Built it — {out.name} (plus an editable .blend) in creations/. Opened the folder and the model in Blender.")
            else:
                tail = (res.get("log") or "").strip()[-300:]
                self._emit("error", "Blender couldn't build that. " + tail)
        except Exception as e:
            _log(f"blender EXCEPTION {type(e).__name__}: {e}")
            self._emit("error", f"3D build failed: {type(e).__name__}: {e}")
        finally:
            self._busy = False
            _log("blender run FINISHED (busy cleared)")

    def _run_likeness(self, images: list, description: str) -> None:
        """Reference photo(s) -> iteratively-refined 3D character. Brain=Claude vision,
        hands=headless Blender, eyes=the renders each round compares against the photos."""
        try:
            self._say("On it, boss — studying the reference photos and sculpting a 3D "
                       "likeness in Blender. I'll keep the model open so you can watch it "
                       "improve each round. This takes a few minutes.")
            self._emit("status", f"Building a 3D likeness from {len(images)} reference photo(s)…")
            import likeness  # local import so a hiccup here can't break Ybot startup

            def progress(msg: str) -> None:
                self._emit("status", msg)

            res = likeness.build_from_images(images, description=description, progress=progress)
            if res.get("ok"):
                job = Path(res["job_dir"])
                try:
                    os.startfile(str(job))
                except Exception:
                    pass
                score = res.get("score", 0)
                self._emit(
                    "done",
                    f"Likeness built — {res['rounds_run']} refinement round(s), "
                    f"critic score {score:.1f}/10. Model + renders are open in "
                    f"{job.name}/, and Blender is showing the live result.",
                )
            else:
                err = (res.get("error") or "; ".join(res.get("errors", [])))[:300]
                self._emit("error", f"Couldn't finish the likeness build: {err}")
        except Exception as e:
            _log(f"likeness EXCEPTION {type(e).__name__}: {e}")
            self._emit("error", f"Likeness build failed: {type(e).__name__}: {e}")
        finally:
            self._busy = False
            _log("likeness run FINISHED (busy cleared)")

    def _run_photoreal(self, image_path: str, description: str) -> None:
        """A real reference photo -> an actual neural 3D reconstruction (TripoSR, local
        GPU) — no cloud, no credits. Far more accurate than the procedural likeness route
        for "make it look like me" requests; see photoreal.py's docstring for the one
        known limitation (Blender re-render washes out large flat garment colors — the
        native turntable video/frames TripoSR itself produces don't have that problem)."""
        try:
            self._say("On it, boss — running an actual 3D reconstruction of your photo "
                       "on the GPU. This is the real neural model, not a sketch — give it "
                       "a minute or two.")
            self._emit("status", "Running the photoreal 3D reconstruction…")
            import photoreal  # local import so a hiccup here can't break Ybot startup

            if not photoreal.available():
                self._emit("error", "TripoSR isn't set up on this machine (photoreal.available() is False).")
                return

            def progress(msg: str) -> None:
                self._emit("status", msg)

            res = photoreal.create_from_photo(image_path, description=description, progress=progress)
            if res.get("ok"):
                job = Path(res["job_dir"])
                try:
                    os.startfile(str(job))
                except Exception:
                    pass
                if res.get("model_blend"):
                    try:
                        import subprocess
                        subprocess.Popen([photoreal._blender_exe(), res["model_blend"]])
                    except Exception:
                        pass
                self._emit(
                    "done",
                    f"Photoreal 3D model built — real neural reconstruction, not a sketch. "
                    f"Opened {job.name}/ with the turntable video/frames (best quality — "
                    f"look at those first) plus model.blend in Blender.",
                )
            else:
                err = "; ".join(res.get("errors", []))[:300]
                self._emit("error", f"Couldn't finish the photoreal build: {err}")
        except Exception as e:
            _log(f"photoreal EXCEPTION {type(e).__name__}: {e}")
            self._emit("error", f"Photoreal build failed: {type(e).__name__}: {e}")
        finally:
            self._busy = False
            _log("photoreal run FINISHED (busy cleared)")

    def _run_java(self, task: str) -> None:
        """A plain-English task -> real, compiled, run-verified Java. Writes actual
        .java files, compiles with javac, runs the result, and auto-fixes compile/
        runtime errors (up to java_coder.MAX_FIX_ROUNDS retries). Runs on the free
        Gemini route via ai_client — pure code generation, no desktop control, so it
        never touches Anthropic credit."""
        try:
            self._say("On it, boss — writing Java for that. I'll compile and run it "
                       "to make sure it actually works before calling it done.")
            self._emit("status", "Writing Java…")
            import java_coder  # local import so a hiccup here can't break Ybot startup

            if not java_coder.available():
                self._emit("error", "No JDK found on this machine — can't compile Java here.")
                return

            def progress(msg: str) -> None:
                self._emit("status", msg)

            res = java_coder.write_java(task, progress=progress)
            if res.get("ok"):
                job = Path(res["job_dir"])
                try:
                    os.startfile(str(job))
                except Exception:
                    pass
                files = ", ".join(res.get("files", []))
                run_out = (res.get("output") or "").strip()
                tail = f" Output:\n{run_out[:400]}" if res.get("stage") == "run" and run_out else ""
                self._emit(
                    "done",
                    f"Java's written, compiled, and ran clean — {files}. "
                    f"{res.get('notes', '')}{tail} Opened {job.name}/.",
                )
            else:
                err = "; ".join(res.get("errors", []))[:400]
                self._emit("error", f"Couldn't get the Java working: {err}")
        except Exception as e:
            _log(f"java EXCEPTION {type(e).__name__}: {e}")
            self._emit("error", f"Java build failed: {type(e).__name__}: {e}")
        finally:
            self._busy = False
            _log("java run FINISHED (busy cleared)")

    def _run_remember(self, fact: str) -> None:
        """Store a fact permanently via supermemory (free cloud tier) — Ybot's only
        persistence across restarts; everything else resets on relaunch."""
        try:
            import memory  # local import so a hiccup here can't break Ybot startup

            if not memory.available():
                self._say("I can't remember that yet, boss — supermemory isn't set up "
                           "(no SUPERMEMORY_API_KEY). Get a free key at "
                           "console.supermemory.ai and I'll wire it in.")
                return
            res = memory.remember(fact, permanent=True)
            if res.get("ok"):
                self._emit("done", f"Got it, I'll remember that: \"{fact}\"")
            else:
                self._emit("error", f"Couldn't save that: {res.get('error')}")
        except Exception as e:
            _log(f"remember EXCEPTION {type(e).__name__}: {e}")
            self._emit("error", f"Couldn't save that: {type(e).__name__}: {e}")
        finally:
            self._busy = False
            _log("remember run FINISHED (busy cleared)")

    def _run_recall(self, query: str) -> None:
        """Search everything Ybot has been told to remember (supermemory, free cloud tier)."""
        try:
            import memory  # local import so a hiccup here can't break Ybot startup

            if not memory.available():
                self._say("I don't have memory set up yet, boss — no SUPERMEMORY_API_KEY.")
                return
            res = memory.recall(query)
            if not res.get("ok"):
                self._emit("error", f"Couldn't search my memory: {res.get('error')}")
                return
            results = res.get("results", [])
            if not results:
                self._say(f"I don't remember anything about \"{query}\".")
            else:
                lines = "\n".join(f"- {r.get('memory', r.get('chunk', ''))}" for r in results[:5])
                self._say(f"Here's what I remember about \"{query}\":\n{lines}")
        except Exception as e:
            _log(f"recall EXCEPTION {type(e).__name__}: {e}")
            self._emit("error", f"Couldn't search my memory: {type(e).__name__}: {e}")
        finally:
            self._busy = False
            _log("recall run FINISHED (busy cleared)")

    def _run_cli(self, args_text: str) -> None:
        """"cli: search|install|launch <name>" — control other software via
        CLI-Anything's generated agent-native CLIs instead of GUI clicking."""
        try:
            import cli_hub  # local import so a hiccup here can't break Ybot startup

            if not cli_hub.available():
                self._emit("error", "cli-hub isn't installed (pip install cli-anything-hub).")
                return
            parts = args_text.split(None, 1)
            verb = parts[0].lower() if parts else ""
            rest = parts[1].strip() if len(parts) > 1 else ""
            self._emit("status", f"cli-hub {verb} {rest}…")
            if verb == "search":
                res = cli_hub.search(rest)
            elif verb == "install":
                res = cli_hub.install(rest)
            elif verb == "launch":
                res = cli_hub.launch(rest)
            else:
                res = cli_hub.run(args_text.split())
            out = (res.get("output") or "").strip()
            if res.get("ok"):
                self._emit("done", out[:800] or "Done.")
            else:
                self._emit("error", out[:500] or "cli-hub command failed.")
        except Exception as e:
            _log(f"cli EXCEPTION {type(e).__name__}: {e}")
            self._emit("error", f"CLI command failed: {type(e).__name__}: {e}")
        finally:
            self._busy = False
            _log("cli run FINISHED (busy cleared)")

    def _run_graph(self, args_text: str) -> None:
        """"graph: path A B" or "graph: explain X" — queries an existing graphify
        knowledge graph (graphify-out/graph.json). Building that graph is an
        agent-orchestrated process (Claude Code's /graphify .), not something this
        wrapper does — it only queries a graph that already exists."""
        try:
            import graphify_client  # local import so a hiccup here can't break startup

            if not graphify_client.available():
                self._emit("error", "graphify isn't installed (uv tool install graphifyy).")
                return
            parts = args_text.split(None, 2)
            verb = parts[0].lower() if parts else ""
            self._emit("status", f"graphify {args_text}…")
            if verb == "path" and len(parts) >= 3:
                res = graphify_client.path(parts[1], parts[2])
            elif verb == "explain" and len(parts) >= 2:
                res = graphify_client.explain(" ".join(parts[1:]))
            else:
                res = {"ok": False, "output": "usage: \"graph: path <A> <B>\" or \"graph: explain <node>\""}
            out = (res.get("output") or "").strip()
            if res.get("ok"):
                self._emit("done", out[:800] or "Done.")
            else:
                self._emit("error", out[:500] or "graphify command failed — is graphify-out/graph.json built yet?")
        except Exception as e:
            _log(f"graph EXCEPTION {type(e).__name__}: {e}")
            self._emit("error", f"Graph query failed: {type(e).__name__}: {e}")
        finally:
            self._busy = False
            _log("graph run FINISHED (busy cleared)")

    def _run_docs(self, task: str) -> None:
        """"docs: <task>" — a real, openable PDF/DOCX/PPTX/XLSX file. The brain plans
        structured content, doc_tools.py builds the actual file deterministically."""
        try:
            self._say("On it, boss — putting that document together.")
            self._emit("status", "Writing the document…")
            import doc_tools  # local import so a hiccup here can't break Ybot startup

            def progress(msg: str) -> None:
                self._emit("status", msg)

            res = doc_tools.create_document(task, progress=progress)
            if res.get("ok"):
                job = Path(res["job_dir"])
                try:
                    os.startfile(str(job))
                except Exception:
                    pass
                self._emit("done", f"Done — {res['title']} (.{res['format']}). Opened {job.name}/.")
            else:
                err = "; ".join(res.get("errors", []))[:400]
                self._emit("error", f"Couldn't finish the document: {err}")
        except Exception as e:
            _log(f"docs EXCEPTION {type(e).__name__}: {e}")
            self._emit("error", f"Document build failed: {type(e).__name__}: {e}")
        finally:
            self._busy = False
            _log("docs run FINISHED (busy cleared)")

    def _run_shell(self, task: str) -> None:
        """"shell: <task>" — a senior Windows engineer driving PowerShell/cmd/git/VS
        Code directly via subprocess (real commands, not typing into a GUI terminal).
        A hard denylist blocks genuinely destructive patterns before they run, checked
        independently of what the brain proposes each step."""
        try:
            self._say("On it, boss — I'll work through this in PowerShell, one step "
                       "at a time, checking as I go.")
            self._emit("status", "Starting…")
            import shell_expert  # local import so a hiccup here can't break Ybot startup

            def progress(msg: str) -> None:
                self._emit("status", msg)

            res = shell_expert.run_shell_task(task, progress=progress)
            if res.get("ok"):
                job = Path(res["job_dir"])
                n = len(res.get("steps", []))
                self._emit("done", f"{res.get('summary', 'Done.')} ({n} step(s) — full transcript in {job.name}/)")
            else:
                err = "; ".join(res.get("errors", []))[:400]
                self._emit("error", f"Didn't finish: {err}")
        except Exception as e:
            _log(f"shell EXCEPTION {type(e).__name__}: {e}")
            self._emit("error", f"Shell task failed: {type(e).__name__}: {e}")
        finally:
            self._busy = False
            _log("shell run FINISHED (busy cleared)")

    def _run_design(self, task: str) -> None:
        """"design: <brief>" — a real, openable production-quality HTML/CSS app mockup
        (senior UI/UX + frontend engineer system prompt). Figma/Canva/Stitch aren't
        driveable from here (MCP-only tools; Ybot isn't an MCP client) — this is the
        honest, actually-working equivalent: a real file you can open right now."""
        try:
            self._say("On it, boss — designing that now.")
            self._emit("status", "Designing…")
            import design_expert  # local import so a hiccup here can't break Ybot startup

            def progress(msg: str) -> None:
                self._emit("status", msg)

            res = design_expert.create_design(task, progress=progress)
            if res.get("ok"):
                out = Path(res["file"])
                try:
                    os.startfile(str(out))  # opens in the default browser
                except Exception:
                    pass
                self._emit("done", f"Design's ready — opened {out.name} in your browser.")
            else:
                err = "; ".join(res.get("errors", []))[:400]
                self._emit("error", f"Couldn't finish the design: {err}")
        except Exception as e:
            _log(f"design EXCEPTION {type(e).__name__}: {e}")
            self._emit("error", f"Design build failed: {type(e).__name__}: {e}")
        finally:
            self._busy = False
            _log("design run FINISHED (busy cleared)")

    def _run_trade(self, task: str) -> None:
        """"trade: <task>" — answers a trading/DeFi/quant question using the most
        relevant of the 67 vendored agiprolabs trading Agent Skills as expert context.
        Free Gemini route via ai_client (no desktop control, no Anthropic credit).
        Analysis, math, and code only — never personalized buy/sell/hold advice."""
        try:
            self._say("On it, boss — pulling up the right trading skill for that.")
            self._emit("status", "Matching a trading skill…")
            import trading_skills  # local import so a hiccup here can't break Ybot startup

            if not trading_skills.available():
                self._emit("error", "Trading skills aren't vendored (trading_skills_lib is missing).")
                return

            def progress(msg: str) -> None:
                self._emit("status", msg)

            res = trading_skills.run(task, progress=progress)
            if res.get("ok"):
                self._say(f"Using my {res['skill']} skill:\n\n{res['answer']}")
            else:
                self._emit("error", res.get("error", "Couldn't answer that trading task."))
        except Exception as e:
            _log(f"trade EXCEPTION {type(e).__name__}: {e}")
            self._emit("error", f"Trading task failed: {type(e).__name__}: {e}")
        finally:
            self._busy = False
            _log("trade run FINISHED (busy cleared)")

    def _run_plugin(self, plugin: dict, task: str) -> None:
        """Run a user-installed plugin (plugins/*.py) — its run(task, progress) returns
        {ok, answer} or {ok: False, error}. Plugins are sandboxed only by convention; a
        crash here is caught and reported, never allowed to wedge Ybot."""
        name = plugin.get("name", plugin.get("command", "plugin"))
        try:
            self._say(f"On it, boss — using the {name} plugin.")
            self._emit("status", f"{name}…")

            def progress(msg: str) -> None:
                self._emit("status", msg)

            res = plugin["run"](task, progress=progress)
            if isinstance(res, dict) and res.get("ok"):
                self._say(res.get("answer") or "Done.")
            else:
                err = (res or {}).get("error", "plugin returned no result") if isinstance(res, dict) else "plugin returned no result"
                self._emit("error", f"{name}: {err}")
        except Exception as e:
            _log(f"plugin EXCEPTION {type(e).__name__}: {e}")
            self._emit("error", f"Plugin '{name}' failed: {type(e).__name__}: {e}")
        finally:
            self._busy = False
            _log(f"plugin '{name}' run FINISHED (busy cleared)")

    def stop(self) -> bool:
        """Ask the running operator to abort at its next checkpoint."""
        _log("stop() CALLED\n" + "".join(traceback.format_stack()[-4:-1]))
        if not self._busy:
            return False
        self._stop.set()
        # If it's blocked waiting for an approval, release that wait as a denial.
        self._approval_result = False
        self._approval.set()
        self._emit("status", "stopping… (finishing the current step, then aborting)")
        return True

    def reset(self) -> bool:
        """Hard reset used by the Refresh button: signal any running task to abort AND
        immediately free the UI, so a wedged/slow task can never leave it stuck on 'busy'.
        The old worker (if any) winds down at its next checkpoint; the stop flag guarantees
        it won't keep acting once a new task starts."""
        _log("reset() CALLED\n" + "".join(traceback.format_stack()[-4:-1]))
        self._stop.set()
        self._approval_result = False
        self._approval.set()
        self._busy = False
        return True

    # --- approvals (called by the operator worker thread) ------------------------------
    def _approve(self, reason: str) -> bool:
        # Autonomous mode runs hands-free. The operator's own guard STILL hard-blocks
        # purchases regardless of mode, so "bypass" never authorizes a payment.
        if self._mode == "bypass":
            return True
        # Ask mode: pop an in-window Allow/Deny dialog and block until answered.
        self._approval.clear()
        self._approval_result = False
        safe = (reason or "").replace("\\", "\\\\").replace("`", "\\`").replace("$", "\\$")
        self._js(f"window.ybot.askApproval(`{safe}`)")
        if not self._approval.wait(timeout=120):
            return False  # no answer within 2 min -> deny
        return self._approval_result

    def resolve_approval(self, allow: bool) -> None:
        self._approval_result = bool(allow)
        self._approval.set()

    # --- attachments & connectors ------------------------------------------------------
    def attach_files(self) -> list:
        try:
            paths = self._window.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=True)
            self._attachments = list(paths) if paths else []
            return self._attachments
        except Exception as e:
            self._emit("error", f"attach failed: {e}")
            return []

    def remove_attachment(self, index: int) -> list:
        try:
            i = int(index)
            if 0 <= i < len(self._attachments):
                self._attachments.pop(i)
        except Exception:
            pass
        return list(self._attachments)

    def clear_attachments(self) -> list:
        self._attachments = []
        return []

    def copy_text(self, text: str) -> bool:
        """Copy a message to the Windows clipboard (reliable inside WebView2)."""
        try:
            import pyperclip

            pyperclip.copy(text or "")
            return True
        except Exception as e:
            self._emit("error", f"copy failed: {type(e).__name__}: {e}")
            return False

    def paste_text(self) -> str:
        """Return the OS clipboard text. WebView2's own Ctrl+V is unreliable inside a
        frameless pywebview window, so the UI routes paste through here (pyperclip) and
        inserts the result into the composer itself — a paste path that always works."""
        try:
            import pyperclip

            return pyperclip.paste() or ""
        except Exception as e:
            self._emit("error", f"paste failed: {type(e).__name__}: {e}")
            return ""

    def connectors(self) -> str:
        base = "Connected: Claude Opus 4.8 (brain) + ElevenLabs (voice).\n\n"
        try:
            import plugins_loader
            return base + plugins_loader.summary() + (
                "\n\nAdd a plugin: drop a <name>.py (with a PLUGIN dict) into "
                "ybot-assistant/plugins/ — I pick it up automatically."
            )
        except Exception:
            return base + "Plugins: (none loaded)."

    # --- voice (ElevenLabs) ------------------------------------------------------------
    def tts(self, text: str) -> str:
        try:
            from voice import tts as _tts

            audio = _tts(text or "")
            return base64.b64encode(audio).decode() if audio else ""
        except Exception as e:
            self._emit("status", f"(voice off: {type(e).__name__})")
            return ""

    def stt(self, b64: str, mime: str = "audio/webm") -> str:
        try:
            from voice import stt as _stt

            audio = base64.b64decode(b64 or "")
            text = _stt(audio, mime=mime)
            _log(f"stt audio={len(audio)}B mime={mime} -> {text[:80]!r}")
            return text
        except Exception as e:
            _log(f"stt EXCEPTION {type(e).__name__}: {e}")
            self._emit("error", f"transcribe failed: {type(e).__name__}: {e}")
            return ""
