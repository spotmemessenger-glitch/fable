"""Windows UI Automation: enumerate interactive elements and click them by reference.

Coordinates returned here are native screen pixels (the same space pyautogui uses,
because DPI awareness is set at startup). The agent converts them to sent-image space
only for display; clicking is done by reference, so the model never needs coordinates.
"""
from __future__ import annotations

import ctypes
from dataclasses import dataclass

from pywinauto import Desktop

# Control types worth surfacing to the model as clickable targets.
INTERACTIVE = {
    "Button",
    "MenuItem",
    "ComboBox",
    "Edit",
    "CheckBox",
    "RadioButton",
    "ListItem",
    "TabItem",
    "Hyperlink",
    "TreeItem",
    "SplitButton",
}


@dataclass
class Element:
    ref: int
    name: str
    control_type: str
    cx: int  # center X, native pixels
    cy: int  # center Y, native pixels


class UIA:
    """Reads the foreground window's accessibility tree and clicks elements by ref."""

    def __init__(self, max_elements: int = 80):
        self.max_elements = max_elements
        self._desktop = Desktop(backend="uia")
        self._elements: list[Element] = []
        self._wrappers: list = []

    def _foreground(self):
        hwnd = ctypes.windll.user32.GetForegroundWindow()
        return self._desktop.window(handle=hwnd)

    def inspect(self) -> list[Element]:
        """Return the visible interactive elements of the current foreground window."""
        self._elements = []
        self._wrappers = []
        try:
            descendants = self._foreground().descendants()
        except Exception:
            return self._elements

        ref = 0
        for d in descendants:
            try:
                ct = d.element_info.control_type
                if ct not in INTERACTIVE or not d.is_visible():
                    continue
                r = d.rectangle()
                if r.right <= r.left or r.bottom <= r.top:
                    continue
                name = (d.window_text() or "").strip()[:60]
                self._elements.append(
                    Element(ref, name, ct, (r.left + r.right) // 2, (r.top + r.bottom) // 2)
                )
                self._wrappers.append(d)
                ref += 1
                if ref >= self.max_elements:
                    break
            except Exception:
                continue
        return self._elements

    def element(self, ref: int) -> Element:
        if not 0 <= ref < len(self._elements):
            raise IndexError(f"No element ref {ref}; run ui_inspect first.")
        return self._elements[ref]

    def click(self, ref: int) -> None:
        if not 0 <= ref < len(self._wrappers):
            raise IndexError(f"No element ref {ref}; run ui_inspect first.")
        self._wrappers[ref].click_input()
