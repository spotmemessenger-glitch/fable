---
name: action-verify-loop
description: Confirm that a GUI action actually took effect before moving on, and recover when it did not. Use when building or debugging a computer-use agent loop that clicks and assumes success, silently drops input, loops on a stuck screen, or reports a task complete that never happened.
allowed-tools: [Read, Grep, Glob, Edit, Write, Bash]
---

# Action verification loop

The default failure of a GUI agent is not clicking the wrong thing — it is
clicking the right thing, having nothing happen, and never noticing. Input to
elevated windows is dropped silently. A click 3px outside a button hits the
container. A menu closes before the item registers. In every case the API call
succeeds and the agent proceeds on a false premise, then compounds it.

**Rule: an action is not done until its effect is observed.**

## The loop

```
act → wait for change (bounded) → observe → classify → proceed | retry | escalate
```

Never `act → act`. Never `act → sleep → assume`.

## Waiting: poll, don't sleep

A fixed `sleep(1.5)` costs the full 1.5s on a fast app and is still too short
for a slow one. Poll for the transition with a timeout — ybot's
`screen.wait_for_change(timeout=1.2)` returns `None` when nothing moved.

Report that outcome to the model in its own words. ybot surfaces:

> `Screen unchanged after {what} — nothing on screen moved for 1.2s.`

That sentence is the entire mechanism. It converts a silent failure into an
observation the model can reason about, which is what stops the compounding.

## Classify the outcome — three cases, not two

| Observation | Meaning | Response |
|---|---|---|
| Expected state present | Success | Proceed |
| Screen changed, unexpected state | Action worked, wrong target, or a dialog appeared | Re-perceive fully, replan — do **not** retry the same action |
| Nothing changed | Input dropped, wrong coordinate, or app busy | Retry once by a *different* route, then escalate |

The middle row matters most: an unexpected modal, permission prompt, or
autocomplete popup is a changed screen, and blindly retrying the original click
now hits the dialog instead.

## Retry by a different route, never the same one

Repeating an identical failed click is the single most common agent death loop.
If it failed once, the coordinate or the target is wrong, and the second attempt
has the same information. Escalate the *method* instead:

1. Pixel click failed → re-inspect the accessibility tree, click by reference.
2. UIA click failed → the element may be stale; re-enumerate, then retry.
3. Both failed → check for an elevated foreground window (input is silently
   dropped when the agent is not elevated).
4. Still failing → stop and ask the user. Two failed routes is enough evidence.

Cap retries per step (2 is plenty) and cap total steps per task. An agent that
cannot make progress must halt loudly, not spin.

## Verify what you claim

Before reporting a task complete, confirm the *end state*, not the last action.
"I clicked Save" is not "the file is saved" — check the title bar lost its
dirty marker, the dialog closed, the row appeared. This is the one place a
screenshot is worth its 1,230 tokens: visual confirmation of a terminal claim.

## Idempotence before retry

Retrying is only safe if the action is idempotent. Re-clicking Send, Submit,
Pay, or Delete may fire twice — the first may have worked and the change simply
not rendered yet. For non-idempotent actions: extend the wait, verify harder,
and ask rather than retry. `guard.evaluate()` hard-blocks the payment class
outright; anything destructive deserves the same caution.

## Anti-patterns

- `click(); sleep(2); click_next()` — the canonical broken loop.
- Retrying the identical coordinate after a failure.
- Treating "no exception" as "it worked" — pyautogui raises nothing when input
  is dropped.
- Unbounded retries, or a step budget with no ceiling.
- Reporting success from the action log rather than from observed state.
