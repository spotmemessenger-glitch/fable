"""Proves a step can tell success from "something moved".

THE GAP THIS PINS. `Screen.wait_change` hashes the frame, so it answers "did ANY pixel
change" — not "did the EXPECTED change happen". A click that opens the wrong menu, a
mistyped filename and an error dialog all move pixels, and all three were logged as ✓.
A blinking cursor moves pixels too, so a step that achieved nothing could report done.

Everything here runs on any machine: verify.py imports no pywinauto, no mss, no ctypes
and reads no clock. That is the point of keeping it pure — ybot only runs on Windows,
so a check that needed a real window could never be tested where the code is written.

    python3 tests/test_verify.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ybot.verify import Snapshot, evaluate, parse   # noqa: E402

results: dict[str, bool] = {}
names: list[str] = []


def check(name: str, passed: bool) -> None:
    names.append(name)
    results[name] = passed is True


def snap(title: str = "", *labels: str, pixels: bool = False) -> Snapshot:
    return Snapshot(title=title,
                    elements=tuple((n, "Button") for n in labels),
                    pixels_changed=pixels)


def verdict(spec, before, after):
    return evaluate(parse(spec), before, after)


# ---- the weak default still behaves exactly as it did -------------------------------

check("no expectation given falls back to 'any pixel moved'",
      parse(None).kind == "changed" and parse("").kind == "changed")

check("'changed' passes when the screen moved",
      verdict(None, snap(), snap(pixels=True)).ok)

check("'changed' fails when nothing moved",
      not verdict(None, snap(), snap(pixels=False)).ok)

check("...and still says to run ui_inspect rather than repeat the click",
      "ui_inspect" in verdict(None, snap(), snap()).detail)

# ---- THE POINT: pixels moving is not the same as the right thing happening ----------

_before = snap("Notepad", "File", "Edit")
_wrong = snap("Notepad", "File", "Edit", "Recent Documents", pixels=True)

check("THE GAP: the WRONG menu opening moves pixels, so 'changed' calls it success",
      verdict(None, _before, _wrong).ok)

check("...but a declared expectation catches it",
      not verdict("appears:Save As", _before, _wrong).ok)

check("...and the failure names what IS on screen, so recovery has somewhere to go",
      "Recent Documents" in verdict("appears:Save As", _before, _wrong).detail)

check("the expected dialog appearing passes",
      verdict("appears:Save As", _before,
              snap("Notepad", "Save As", "Cancel", pixels=True)).ok)

# ---- an expectation that was already true proves nothing ----------------------------

_already = snap("Notepad", "Save", "Cancel")
_still = snap("Notepad", "Save", "Cancel", pixels=True)

check("an expectation that already held still PASSES (staying put can be the goal)",
      verdict("appears:Save", _already, _still).ok)

check("...but is flagged as proving nothing about the action",
      verdict("appears:Save", _already, _still).proved_nothing)

check("...and says so in words the model reads",
      "ALREADY" in verdict("appears:Save", _already, _still).detail)

check("an expectation that was FALSE before and true after is not flagged",
      not verdict("appears:Save As", _before,
                  snap("Notepad", "Save As", pixels=True)).proved_nothing)

# ---- disappears: for closing dialogs ------------------------------------------------

check("'disappears' passes once the element is gone",
      verdict("disappears:Cancel", snap("x", "Save", "Cancel"), snap("x", "Save")).ok)

check("'disappears' fails while it is still there",
      not verdict("disappears:Cancel", snap("x", "Cancel"), snap("x", "Cancel")).ok)

check("...and names the survivor",
      "Cancel" in verdict("disappears:Cancel", snap("x", "Cancel"), snap("x", "Cancel")).detail)

check("'disappears' for something never present is flagged as proving nothing",
      verdict("disappears:Ghost", snap("x", "Save"), snap("x", "Save")).proved_nothing)

# ---- title -------------------------------------------------------------------------

check("'title' passes on a substring match",
      verdict("title:Notepad", snap("Explorer"), snap("notes.txt - Notepad")).ok)

check("'title' fails and reports the real title",
      "Explorer" in verdict("title:Notepad", snap("x"), snap("Explorer")).detail)

check("an unchanged title is flagged as proving nothing",
      verdict("title:Notepad", snap("Notepad"), snap("Notepad")).proved_nothing)

# ---- labels are quoted from a screen, so matching has to be forgiving ---------------

check("matching is case-insensitive",
      verdict("appears:save as", snap(), snap("x", "Save As", pixels=True)).ok)

check("matching is substring, so accelerators and ellipses do not break it",
      verdict("appears:Save", snap(), snap("x", "&Save As...", pixels=True)).ok)

# ---- a typo in the expectation must not silently become the weak check --------------

check("an unknown kind is REFUSED, not quietly downgraded to 'changed'",
      not verdict("appearz:Save", snap(), snap(pixels=True)).ok)

check("...and the message says which kinds exist",
      "appears" in verdict("appearz:Save", snap(), snap(pixels=True)).detail)

check("a kind with no value is refused",
      not verdict("appears:", snap(), snap(pixels=True)).ok)

check("a refused expectation cannot pass just because pixels moved",
      not verdict("appearz:Save", snap(), snap(pixels=True)).ok)

# ---- robustness: a verifier that raises would kill the whole run --------------------

check("an empty window is handled, not crashed on",
      not verdict("appears:Save", Snapshot(), Snapshot()).ok)

check("...and says the window exposes nothing rather than showing an empty list",
      "no named elements" in verdict("appears:Save", Snapshot(), Snapshot()).detail)

check("unnamed elements do not blow up the summary",
      not verdict("appears:Save", snap(), snap("t", "", "")).ok)

print("\n========================================")
print("  verify — did the EXPECTED thing happen")
print("========================================")
for n in names:
    print(f"  {'PASS' if results[n] else 'FAIL'}  {n}")
passed = sum(1 for n in names if results[n])
print("========================================")
print(f"  {passed}/{len(names)} passed")
print("========================================\n")
sys.exit(0 if passed == len(names) else 1)
