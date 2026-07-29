---
name: desktop-automation
description: Drive a real Windows desktop through screenshots, the accessibility tree, and synthetic mouse/keyboard input. Use when working on ybot or any computer-use agent — the operator loop, perception, coordinate spaces, DPI, pyautogui/pywinauto/mss behaviour, or the permission guard and kill switch. Also use when an agent clicks the wrong place, misses input, or burns tokens on screenshots.
allowed-tools: [Read, Grep, Glob, Edit, Write, Bash]
---

# Desktop automation (ybot operator)

Reference implementation: `ybot/ybot/` — `agent.py` (loop), `screen.py` (eyes),
`uia.py` (accessibility tree), `actions.py` (hands), `guard.py` (policy),
`killswitch.py`. Read the relevant module before changing behaviour; the
non-obvious decisions below are already encoded there with reasons.

## Perception: cheapest source that answers the question

Never reach for pixels first. Ranked by cost:

| Source | Cost | Use for |
|---|---|---|
| `ui_inspect` (UIA tree) | ~336 tokens | Buttons, menus, fields, list items — anything with a control type |
| Screenshot | ~1,230 tokens + latency | Images, canvas, charts, video, PDFs, 3D/game content, windows exposing no elements, final visual confirmation |

A UIA hit is also *exact* — `ui_click(ref)` lands dead-centre with no coordinate
maths and no scaling bug. Pixels are a guess. Dropdowns and menus in particular
should never be clicked by coordinate.

`screen.capture(only_if_changed=True)` returns `None` when the frame is
pixel-identical to the last one sent, skipping the PNG encode — the expensive
half. `metrics()` gives dimensions for coordinate maths without grabbing at all.

## Two coordinate spaces — keep them straight

- **Native screen pixels** — what pyautogui and pywinauto use.
- **Sent-image space** — the downscaled PNG the model saw and emits coordinates in.

Model coordinates are *always* sent-image space and must be scaled before use
(`actions.execute` does this). Displaying UIA coordinates back to the model
requires the reverse conversion. Mixing them produces clicks that are
consistently offset by the scale factor — the signature symptom.

## DPI: call it first or everything is wrong

`screen.set_dpi_awareness()` must run **before** pyautogui or mss initialise.
Without it, on any display scale other than 100%, screenshot pixels and click
coordinates disagree and every click lands off-target. Symptom: clicks are
offset proportionally to the scale (125% → ~20% short).

## Input synthesis

`pyautogui.PAUSE` sleeps after *every* call and defaults to 0.1s — a click is
`moveTo`+`click` (0.2s of pure sleep), Ctrl+S is four calls (0.4s). ybot sets it
to 20ms; the ~105ms screen capture that follows acts as a natural settle. If an
app genuinely misses input, raise `OPERATOR_ACTION_PAUSE` — do not restore 0.1
globally.

The model emits xdotool-style key names (`return`, `esc`, `control`, `super`);
`actions._KEYMAP` translates them to pyautogui names. Extend that map rather
than teaching the model a different vocabulary.

Prefer clipboard paste (`pyperclip`) over per-character typing for anything long:
one action instead of N, and immune to keyboard-layout surprises.

## Safety is not optional

Three independent layers, all in the loop before an action executes:

1. **Kill switch** — global hotkey (`Ctrl+Alt+Q`), needs Administrator to register.
2. **pyautogui failsafe** — mouse into any screen corner aborts. Leave it enabled.
3. **`guard.evaluate()`** — hard-blocks purchase/payment patterns even in
   independent mode, and gates typing into terminal windows for approval.

When adding a capability, ask what it lets the agent do that `guard` cannot see.
A new action that bypasses `guard.evaluate()` is a bug, not a feature. Assisted
mode (confirm every action) is the default for anything new.

## Elevated windows

A non-elevated process cannot send input to an elevated window — input is
silently dropped, with no error. The screen simply does not change. If actions
appear to succeed but nothing moves and the foreground window is elevated, that
is the cause; the process must run as Administrator.

## Anti-patterns

- Screenshotting every step "to be safe" — 4x the tokens for the same decision.
- Clicking a menu item by coordinate when UIA exposes it by reference.
- `time.sleep()` to wait for an app — poll for the state you need instead
  (`screen.wait_for_change`), so a fast app doesn't cost the full timeout.
- Declaring a task done without confirming the end state. See `action-verify-loop`.
