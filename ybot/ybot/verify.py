"""Did the action do what it was supposed to do?

WHY THIS EXISTS. Until now the operator verified a step by asking `Screen.wait_change`
whether ANY pixel moved. That is a real check — it catches a click that lands on
nothing — but it cannot tell success from the wrong thing happening. A click that
opens the wrong menu changes pixels. A mistyped filename changes pixels. An error
dialog changes pixels. All three were logged as `✓`. A blinking text cursor changes
pixels too, so a step that accomplished nothing could still be reported as done.

So a step may now declare what it EXPECTS, and this module checks that instead. The
accessibility tree already carries the evidence — element names, control types, the
foreground window title — and reading it costs about 336 tokens against roughly 1,230
for a screenshot, so the precise check is also the cheap one.

DELIBERATELY PURE. Nothing here imports pywinauto, mss or ctypes, and nothing here
touches a clock. It takes two snapshots as plain data and returns a verdict, which is
why it can be tested on any machine — see tests/test_verify.py. Capturing snapshots
is uia.py's job; polling until the deadline is agent.py's.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# Expectation kinds a step may declare. Kept small on purpose: every one of these is
# answerable from the accessibility tree alone, with no model call and no screenshot.
KINDS = ("appears", "disappears", "title", "changed")


@dataclass(frozen=True)
class Snapshot:
    """What the screen looked like at one instant, as data.

    `elements` is (name, control_type) pairs — the same interactive elements
    `UIA.inspect()` surfaces. Tuples rather than Element objects so this module owes
    nothing to uia.py, and a test can build one in a line.
    """

    title: str = ""
    elements: tuple[tuple[str, str], ...] = ()
    pixels_changed: bool = False

    def names(self) -> list[str]:
        return [n for n, _ in self.elements]


@dataclass
class Outcome:
    ok: bool
    detail: str
    # True when the expectation was ALREADY satisfied before the action ran. The step
    # still passes — "the title is still Notepad" is a legitimate thing to want — but
    # it is not evidence the action did anything, and the model is told so rather than
    # being allowed to read it as proof.
    proved_nothing: bool = False


@dataclass
class Expectation:
    kind: str
    value: str = ""
    raw: str = ""
    error: str = field(default="")

    @property
    def valid(self) -> bool:
        return not self.error


def parse(spec: str | None) -> Expectation:
    """`"appears:Save As"` -> Expectation(kind='appears', value='Save As').

    A malformed spec is NOT silently downgraded to "any change". Falling back would
    reintroduce exactly the weak check this module replaces, and would do it invisibly
    — the step would report success on a typo in its own expectation.
    """
    if spec is None or not str(spec).strip():
        return Expectation("changed", raw="")
    raw = str(spec).strip()
    kind, _, value = raw.partition(":")
    kind = kind.strip().lower()
    value = value.strip()
    if kind not in KINDS:
        return Expectation(
            "changed", raw=raw,
            error=f"unknown expectation {kind!r}; use one of {', '.join(KINDS)}",
        )
    if kind in ("appears", "disappears", "title") and not value:
        return Expectation(kind, raw=raw, error=f"{kind!r} needs a value, e.g. {kind}:Save")
    return Expectation(kind, value, raw=raw)


def _matches(snap: Snapshot, needle: str) -> list[str]:
    """Element names containing `needle`, case-insensitively.

    Substring and case-insensitive because the model is quoting a label it read, and
    UI labels carry accelerators, ellipses and padding — demanding an exact match would
    fail on "&Save" or "Save As..." and teach the model to stop declaring expectations.
    """
    low = needle.lower()
    return [n for n in snap.names() if low in n.lower()]


def _visible(snap: Snapshot, limit: int = 12) -> str:
    """What IS on screen, for the failure message.

    The recovery step is only as good as this string: "expected X, did not find it" is
    a dead end, while naming the real buttons lets the next attempt pick one.
    """
    names = [n for n in snap.names() if n]
    if not names:
        return "the window exposes no named elements"
    shown = ", ".join(repr(n) for n in names[:limit])
    more = f" (+{len(names) - limit} more)" if len(names) > limit else ""
    return f"the window shows: {shown}{more}"


def evaluate(expect: Expectation, before: Snapshot, after: Snapshot) -> Outcome:
    """Verdict on one step. Never raises — a verifier that throws kills the run."""
    if not expect.valid:
        return Outcome(False, f"expectation not understood: {expect.error}")

    if expect.kind == "changed":
        if after.pixels_changed:
            return Outcome(True, "screen changed")
        return Outcome(
            False,
            "screen unchanged — nothing moved. The click may have missed, or the "
            "application ignored it. Do not simply repeat it; call ui_inspect to find "
            "the real target.",
        )

    if expect.kind == "appears":
        hits = _matches(after, expect.value)
        if not hits:
            return Outcome(
                False,
                f"expected an element matching {expect.value!r} to appear, but "
                f"{_visible(after)}",
            )
        already = bool(_matches(before, expect.value))
        return Outcome(
            True,
            f"{hits[0]!r} is present"
            + (
                " — but it was ALREADY there before this step, so this does not prove "
                "the action did anything. If you needed proof, expect something that "
                "only appears on success."
                if already else ""
            ),
            proved_nothing=already,
        )

    if expect.kind == "disappears":
        hits = _matches(after, expect.value)
        if hits:
            return Outcome(
                False,
                f"expected {expect.value!r} to be gone, but {hits[0]!r} is still there",
            )
        was_there = bool(_matches(before, expect.value))
        return Outcome(
            True,
            f"nothing matching {expect.value!r} remains"
            + (
                " — but it was not there BEFORE this step either, so this proves "
                "nothing about the action."
                if not was_there else ""
            ),
            proved_nothing=not was_there,
        )

    # title
    hit = expect.value.lower() in (after.title or "").lower()
    if not hit:
        return Outcome(
            False,
            f"expected the foreground window title to contain {expect.value!r}, "
            f"but it is {after.title!r}",
        )
    already = expect.value.lower() in (before.title or "").lower()
    return Outcome(
        True,
        f"foreground window is {after.title!r}"
        + (
            " — unchanged from before this step, so it does not prove the action "
            "did anything."
            if already else ""
        ),
        proved_nothing=already,
    )
