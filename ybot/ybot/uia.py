"""Windows UI Automation: enumerate interactive elements and click them by reference.

Coordinates returned here are native screen pixels (the same space pyautogui uses,
because DPI awareness is set at startup). The agent converts them to sent-image space
only for display; clicking is done by reference, so the model never needs coordinates.
"""
from __future__ import annotations

import ctypes
from dataclasses import dataclass

from pywinauto import Desktop
from pywinauto.controls.uiawrapper import UIAWrapper

from .perf import count, span

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
        self._infos: list = []  # UIAElementInfo per element; wrapped only on click

    def _foreground(self):
        hwnd = ctypes.windll.user32.GetForegroundWindow()
        return self._desktop.window(handle=hwnd)

    def inspect(self) -> list[Element]:
        """Return the visible interactive elements of the current foreground window.

        Filtering happens on raw `UIAElementInfo` objects rather than on pywinauto
        wrappers. `window.descendants()` constructs a full wrapper per node — for a
        browser or IDE that is thousands of objects, nearly all of them discarded
        one line later by the INTERACTIVE check. `element_info.descendants()` walks
        the same tree returning lightweight info objects, and a wrapper is built
        lazily in `click()` for the single element actually clicked.

        Falls back to the wrapper walk if the fast path is unavailable, so a
        pywinauto version without the element_info API still works.
        """
        self._elements = []
        self._infos = []
        with span("uia.inspect"):
            try:
                window = self._foreground()
            except Exception:
                return self._elements

            with span("uia.inspect.descendants"):
                try:
                    nodes = window.element_info.descendants()
                    fast = True
                except Exception:
                    try:
                        nodes = window.descendants()
                    except Exception:
                        return self._elements
                    fast = False
            count("uia.inspect.nodes_walked", len(nodes))
            count("uia.inspect.fast_path" if fast else "uia.inspect.slow_path")

            with span("uia.inspect.filter"):
                for node in nodes:
                    info = node if fast else node.element_info
                    try:
                        if info.control_type not in INTERACTIVE or not info.visible:
                            continue
                        r = info.rectangle
                        if r.right <= r.left or r.bottom <= r.top:
                            continue
                        name = (info.name or "").strip()[:60]
                        self._elements.append(
                            Element(
                                len(self._elements), name, info.control_type,
                                (r.left + r.right) // 2, (r.top + r.bottom) // 2,
                            )
                        )
                        self._infos.append(info)
                        if len(self._elements) >= self.max_elements:
                            break
                    except Exception:
                        continue
            count("uia.inspect.elements_returned", len(self._elements))
            return self._elements

    def element(self, ref: int) -> Element:
        if not 0 <= ref < len(self._elements):
            raise IndexError(f"No element ref {ref}; run ui_inspect first.")
        return self._elements[ref]

    def click(self, ref: int) -> None:
        """Click one element. The wrapper is built here — for one node, not thousands."""
        if not 0 <= ref < len(self._infos):
            raise IndexError(f"No element ref {ref}; run ui_inspect first.")
        with span("uia.click"):
            info = self._infos[ref]
            wrapper = info if hasattr(info, "click_input") else UIAWrapper(info)
            wrapper.click_input()
