"""Global kill switch: a hotkey plus the mouse-corner failsafe that halt the loop."""
from __future__ import annotations

import threading

import pyautogui


class KillSwitch:
    def __init__(self, hotkey: str = "ctrl+alt+q"):
        self.hotkey = hotkey
        self._event = threading.Event()
        self.registered = False
        pyautogui.FAILSAFE = True  # slam the mouse into a screen corner to abort
        pyautogui.PAUSE = 0.1

    def arm(self) -> None:
        try:
            import keyboard

            keyboard.add_hotkey(self.hotkey, self._event.set)
            self.registered = True
        except Exception:
            # The `keyboard` library may need admin rights; the corner failsafe still works.
            self.registered = False

    @property
    def triggered(self) -> bool:
        return self._event.is_set()

    def check(self) -> None:
        if self._event.is_set():
            raise KeyboardInterrupt("Kill switch activated")
