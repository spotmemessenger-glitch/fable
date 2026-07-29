"""Translate computer-use tool actions into real Windows mouse/keyboard events.

Speed note: pyautogui sleeps `PAUSE` seconds after EVERY call, and its default of
0.1 s is why the hands felt slow — a click is moveTo+click (0.2 s of pure sleep)
and a Ctrl+S is four calls (0.4 s). None of that is work. We drop it to 20 ms,
which is still ample for Windows to deliver the input, and the operator captures
the screen afterwards anyway (~105 ms) which acts as a natural settle. If an app
ever misses input, raise OPERATOR_ACTION_PAUSE rather than putting 0.1 back.
"""
from __future__ import annotations

import time

import pyautogui
import pyperclip

from .config import SETTINGS
from .perf import span
from .screen import Frame

pyautogui.PAUSE = SETTINGS.action_pause

_BUTTON = {"left_click": "left", "right_click": "right", "middle_click": "middle"}

# Map xdotool-style key names (what the model emits) to pyautogui names.
_KEYMAP = {
    "return": "enter",
    "esc": "escape",
    "control": "ctrl",
    "cmd": "win",
    "super": "win",
    "page_down": "pagedown",
    "page_up": "pageup",
    "next": "pagedown",
    "prior": "pageup",
}


def execute(action: str, params: dict, frame: Frame) -> None:
    """Perform a single action. Coordinates arrive in sent-image space and are scaled."""
    with span(f"action.{action}"):
        _execute(action, params, frame)


def _execute(action: str, params: dict, frame: Frame) -> None:
    coord = params.get("coordinate")

    def at(c):
        return frame.to_native(c[0], c[1])

    if action == "mouse_move":
        pyautogui.moveTo(*at(coord))
    elif action in _BUTTON:
        if coord:
            pyautogui.moveTo(*at(coord))
        pyautogui.click(button=_BUTTON[action])
    elif action == "double_click":
        if coord:
            pyautogui.moveTo(*at(coord))
        pyautogui.doubleClick()
    elif action == "triple_click":
        if coord:
            pyautogui.moveTo(*at(coord))
        pyautogui.click(clicks=3, interval=0.05)
    elif action == "left_click_drag":
        start = params.get("start_coordinate")
        if start:
            pyautogui.moveTo(*at(start))
        pyautogui.dragTo(*at(coord), duration=0.3, button="left")
    elif action == "left_mouse_down":
        pyautogui.mouseDown(*(at(coord) if coord else ()), button="left")
    elif action == "left_mouse_up":
        pyautogui.mouseUp(*(at(coord) if coord else ()), button="left")
    elif action == "type":
        _type_text(str(params.get("text", "")))
    elif action == "key":
        _press_combo(str(params.get("text", "")))
    elif action == "hold_key":
        _hold_key(str(params.get("text", "")), float(params.get("duration", 1)))
    elif action == "scroll":
        _scroll(at(coord) if coord else None, params)
    elif action == "wait":
        time.sleep(min(float(params.get("duration", 1)), 5))
    else:
        raise ValueError(f"Unsupported action: {action}")


def _scroll(pos, params: dict) -> None:
    if pos:
        pyautogui.moveTo(*pos)
    amount = int(params.get("scroll_amount", 3))
    direction = params.get("scroll_direction", "down")
    if direction in ("up", "down"):
        pyautogui.scroll(amount * (1 if direction == "up" else -1) * 100)
    else:
        pyautogui.hscroll(amount * (1 if direction == "right" else -1) * 100)


def _type_text(text: str) -> None:
    # Paste via clipboard for long/unicode text; type short strings directly.
    if len(text) > 20:
        prev = None
        try:
            prev = pyperclip.paste()
        except Exception:
            pass
        pyperclip.copy(text)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(0.05)
        if prev is not None:
            try:
                pyperclip.copy(prev)
            except Exception:
                pass
    else:
        pyautogui.typewrite(text, interval=0.01)


def _norm_keys(combo: str) -> list[str]:
    parts = [p.strip().lower() for p in combo.replace("-", "+").split("+") if p.strip()]
    return [_KEYMAP.get(p, p) for p in parts]


def _press_combo(combo: str) -> None:
    keys = _norm_keys(combo)
    if keys:
        pyautogui.hotkey(*keys)


def _hold_key(combo: str, duration: float) -> None:
    keys = _norm_keys(combo)
    for k in keys:
        pyautogui.keyDown(k)
    time.sleep(min(duration, 5))
    for k in reversed(keys):
        pyautogui.keyUp(k)
