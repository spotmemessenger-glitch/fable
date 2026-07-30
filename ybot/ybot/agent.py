"""The operator loop: screenshot -> Claude decides an action -> guard -> execute -> repeat.

The model gets three tools: the pixel-based `computer` tool, plus two accessibility-tree
tools — `ui_inspect` (list interactive elements of the foreground window) and `ui_click`
(click one by ref). Element-level clicking is far more reliable for dropdowns and menus.
"""
from __future__ import annotations

import base64
import getpass
import os
import time
from typing import Callable

from anthropic import Anthropic

from . import actions
from .config import SETTINGS, computer_tool_for, other_tool_version
from .guard import evaluate
from .killswitch import KillSwitch
from .screen import Frame, Screen
from .uia import UIA

SYSTEM_PROMPT = (
    "You are a desktop operator controlling a real Windows computer. Work toward the user's "
    "goal one action at a time.\n\n"
    "PERCEPTION — read before you look. A screenshot costs about 1,230 tokens and a slow "
    "round trip; the accessibility tree costs about 336 and is exact rather than guessed. "
    "So DEFAULT to ui_inspect: it lists the foreground window's real buttons, menu items, "
    "fields and list items, and ui_click(ref) hits them dead-centre with no coordinates "
    "involved. Take a screenshot when you genuinely need to SEE something the tree cannot "
    "tell you: images, canvas or drawing surfaces, charts, video, PDFs, game or 3D content, "
    "a window that exposes no elements, or when you must confirm a visual end state. If a "
    "target is small or text is hard to read, use the zoom action.\n"
    "When an action changes nothing on screen you will be told 'screen unchanged' instead of "
    "being sent an identical picture — treat that as real evidence that your click missed or "
    "the app ignored it, and try a different approach rather than repeating yourself.\n\n"
    "Never attempt payments, purchases, checkouts, or any financial transaction.\n\n"
    "FINISHING: Only declare the task complete after you have taken a screenshot and can SEE "
    "that the end state is correct. NEVER reply that the work is done without visually "
    "verifying it — if you have not confirmed the result on screen, keep working. When (and "
    "only when) you have verified success, stop calling tools and reply with a short summary.\n\n"
    "PLAN AND BATCH (the speed doctrine, still secondary to correctness): you are the "
    "PLANNER; batch_actions is your fast executor. Default flow: ui_inspect → plan the next "
    "3-15 mechanical steps → ONE batch_actions call (each step with a short note) → read its "
    "log + final screenshot → think again. The executor waits for the screen to change after "
    "each step and STOPS EARLY if a click misses, so batches are safe: you find out exactly "
    "which step failed. Think step-by-step only at real decision points — a new window you "
    "have not seen, a result you could not predict, or recovering from a miss. Typing a "
    "known text, walking a menu path, or filling a form is ALWAYS one batch, never many "
    "single calls. Still verify the end state visually before declaring the task done."
)

UI_INSPECT_TOOL = {
    "name": "ui_inspect",
    "description": (
        "List the interactive UI elements (buttons, menu items, dropdowns, text fields, list "
        "items, tabs, checkboxes, links) of the CURRENT foreground window, from the Windows "
        "accessibility tree. Returns each element's ref id, control type, name, and on-screen "
        "center as TEXT — no screenshot, so it is roughly 4x cheaper and faster than looking. "
        "PREFER THIS over a screenshot for anything with normal window controls; then click "
        "with ui_click(ref)."
    ),
    "input_schema": {"type": "object", "properties": {}, "required": []},
}

UI_CLICK_TOOL = {
    "name": "ui_click",
    "description": (
        "Click an interactive element by its ref id from the most recent ui_inspect result. "
        "Reliable for dropdowns, menu items, and buttons — it targets the element itself, so "
        "no coordinates can be misjudged. Returns the resulting screenshot if the screen "
        "changed, or a note saying it did not."
    ),
    "input_schema": {
        "type": "object",
        "properties": {"ref": {"type": "integer", "description": "ref id from the latest ui_inspect"}},
        "required": ["ref"],
    },
}

BATCH_TOOL = {
    "name": "batch_actions",
    "description": (
        "Execute a PLANNED sequence of up to 20 actions in one call — think once, act many. "
        "Use after ui_inspect whenever the next several steps are mechanical (open menu → "
        "click item → type text → press enter). Each UI-changing step waits for the screen "
        "to actually change before the next one runs; if a click changes nothing, the batch "
        "STOPS EARLY and tells you which step missed. Returns a step-by-step log plus one "
        "final screenshot. This is roughly N times faster than N separate tool calls."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "description": ("ui_click | left_click | double_click | right_click | "
                                            "type | key | scroll | mouse_move | wait_change"),
                        },
                        "ref": {"type": "integer", "description": "for ui_click: ref from the latest ui_inspect"},
                        "coordinate": {"type": "array", "items": {"type": "number"}},
                        "text": {"type": "string", "description": "text to type, or key combo like ctrl+s"},
                        "scroll_direction": {"type": "string"},
                        "scroll_amount": {"type": "integer"},
                        "duration": {"type": "number", "description": "for wait_change: max seconds to wait"},
                        "note": {"type": "string", "description": "what this step should accomplish"},
                    },
                    "required": ["action"],
                },
            },
        },
        "required": ["steps"],
    },
}

# Batch steps that change the UI and therefore get a settle-wait after them.
_UI_CHANGING = {"ui_click", "left_click", "double_click", "right_click", "type", "key", "scroll"}


def _env_hint() -> str:
    """Concrete machine facts so the model never guesses paths — the #1 cause of save loops."""
    home = os.path.expanduser("~")
    desktop = os.path.join(home, "Desktop")
    documents = os.path.join(home, "Documents")
    downloads = os.path.join(home, "Downloads")
    return (
        f"\n\nENVIRONMENT: Windows. User: {getpass.getuser()}. "
        f"Home: {home} | Desktop: {desktop} | Documents: {documents} | Downloads: {downloads}.\n"
        "SAVING FILES — do this the reliable way: press Ctrl+S, then in the Save dialog click the "
        "'File name' box, type the COMPLETE path including folder and extension "
        f"(e.g. {os.path.join(desktop, 'notes.txt')}), and press Enter. Do NOT navigate folders "
        "click-by-click and do NOT guess the path — typing the full path in the filename box is "
        "far more reliable and avoids getting stuck in the file browser."
    )


def _img_block(png: bytes) -> dict:
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": base64.standard_b64encode(png).decode(),
        },
    }


def _tool_result(tool_use_id: str, png: bytes | None, text: str | None = None) -> dict:
    content: list[dict] = []
    if text:
        content.append({"type": "text", "text": text})
    if png is not None:
        content.append(_img_block(png))
    return {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}


def _to_sent(frame: Frame, x: int, y: int) -> tuple[int, int]:
    """Native screen pixels -> sent-image space (what the model sees in the screenshot)."""
    return (
        int(x * frame.sent_w / frame.native_w),
        int(y * frame.sent_h / frame.native_h),
    )


class Operator:
    def __init__(
        self,
        independent: bool,
        approver: Callable[[str], bool],
        should_stop: Callable[[], bool] | None = None,
        model: str | None = None,
    ):
        self.independent = independent
        self.approver = approver
        self.should_stop = should_stop or (lambda: False)
        self.model = model or SETTINGS.model
        # The computer-use tool version this model actually accepts. Wrong
        # version = every step 400s, so it is derived per model, not global.
        self.tool_type, self.beta_flag = computer_tool_for(self.model)
        self.system = SYSTEM_PROMPT + _env_hint()
        client_kw = {"api_key": SETTINGS.api_key}
        if SETTINGS.anthropic_base_url:          # e.g. ZenMux gateway
            client_kw["base_url"] = SETTINGS.anthropic_base_url
        self.client = Anthropic(**client_kw)
        self.screen = Screen(SETTINGS.target_width)
        self.uia = UIA()
        self.kill = KillSwitch(SETTINGS.kill_hotkey)
        self.kill.arm()

    def _tools(self) -> list[dict]:
        sw, sh = self.screen.sent_size()
        computer = {
            "type": self.tool_type,
            "name": "computer",
            "display_width_px": sw,
            "display_height_px": sh,
            "enable_zoom": True,
        }
        # cache_control on the last tool caches the whole tools+system prefix, so every
        # step after the first skips re-processing it (lower latency and cost per step).
        batch = dict(BATCH_TOOL, cache_control={"type": "ephemeral"})
        return [computer, UI_INSPECT_TOOL, UI_CLICK_TOOL, batch]

    def _create(self, messages: list[dict]):
        """One model call, with a self-correcting retry on tool-version rejection.

        computer_tool_for() knows the pairings that exist today; a model released
        after this code was written can still be refused. Rather than dying on
        every step — which is what a hardcoded version did — flip to the other
        version once, keep it for the rest of the run, and say so.
        """
        try:
            return self.client.beta.messages.create(
                model=self.model,
                max_tokens=SETTINGS.max_tokens,
                system=self.system,
                tools=self._tools(),
                betas=[self.beta_flag],
                messages=messages,
                timeout=120,  # never let one step hang the whole assistant
            )
        except Exception as exc:
            if "does not support tool types" not in str(exc):
                raise
            self.tool_type, self.beta_flag = other_tool_version(self.tool_type)
            print(
                f"[operator] {self.model} rejected that computer-use version; "
                f"retrying with {self.tool_type}"
            )
            return self.client.beta.messages.create(
                model=self.model,
                max_tokens=SETTINGS.max_tokens,
                system=self.system,
                tools=self._tools(),
                betas=[self.beta_flag],
                messages=messages,
                timeout=120,
            )

    def run(self, goal: str) -> str:
        messages: list[dict] = [{"role": "user", "content": goal}]
        for _ in range(SETTINGS.max_steps):
            self.kill.check()
            if self.should_stop():
                return "(stopped by user)"
            resp = self._create(messages)
            messages.append(
                {"role": "assistant", "content": [b.model_dump() for b in resp.content]}
            )
            for b in resp.content:
                if b.type == "text" and b.text.strip():
                    # Diagnostic only — the model's text often contains ✓/emoji/dashes,
                    # and under a cp1252 stdout a raw print() would raise UnicodeEncodeError
                    # and abort the whole run. Never let a debug line kill the operator loop.
                    try:
                        print(f"\n[operator] {b.text.strip()}")
                    except Exception:
                        pass

            tool_uses = [b for b in resp.content if b.type == "tool_use"]
            if resp.stop_reason != "tool_use" or not tool_uses:
                return " ".join(b.text for b in resp.content if b.type == "text").strip() or "(done)"

            if self.should_stop():
                return "(stopped by user)"
            results = [self._handle_tool(tu) for tu in tool_uses]
            messages.append({"role": "user", "content": results})
            self._prune_images(messages)
        return "(stopped: reached max steps)"

    def _handle_tool(self, tu) -> dict:
        if tu.name == "ui_inspect":
            return self._ui_inspect(tu.id)
        if tu.name == "ui_click":
            return self._ui_click(tu.id, tu.input or {})
        if tu.name == "batch_actions":
            return self._batch(tu.id, tu.input or {})
        return self._computer(tu.id, tu.input or {})

    # --- computer (pixel) tool ---------------------------------------------------------
    def _computer(self, tool_use_id: str, params: dict) -> dict:
        action = params.get("action", "")
        # An explicit look always gets real pixels, even if nothing moved.
        if action in ("screenshot", "cursor_position", "zoom"):
            self.screen._last_digest = None
            return _tool_result(tool_use_id, self.screen.capture().png)

        decision = evaluate(action, params, self.independent)
        if not decision.allow:
            return _tool_result(tool_use_id, None, f"REFUSED by policy: {decision.reason}")
        if decision.needs_approval and not self.approver(f"{action} {params} — {decision.reason}"):
            return _tool_result(tool_use_id, None, "User declined this action.")

        self.kill.check()
        # Only the dimensions matter for scaling coordinates — grabbing a frame
        # here encoded a 252 KB PNG that was discarded on every single action.
        try:
            actions.execute(action, params, self.screen.metrics())
        except Exception as e:  # keep the loop alive; report the failure to the model
            return _tool_result(tool_use_id, None, f"Action error: {e}")
        return self._after(tool_use_id, action)

    def _after(self, tool_use_id: str, what: str) -> dict:
        """Result of an action: pixels as soon as the screen changes (event-ish)."""
        frame = self.screen.wait_change(timeout=1.2)
        if frame is None:
            return _tool_result(
                tool_use_id, None,
                f"Screen unchanged after {what} — nothing on screen moved for 1.2s. The "
                "click may have missed, or the application ignored it. Do not simply "
                "repeat it; call ui_inspect to find the real target.",
            )
        return _tool_result(tool_use_id, frame.png)

    # --- batch executor: think once, act many -----------------------------------------
    def _batch(self, tool_use_id: str, params: dict) -> dict:
        steps = (params.get("steps") or [])[:20]
        if not steps:
            return _tool_result(tool_use_id, None, "batch_actions: no steps given.")

        # Pre-flight: policy-check EVERY step before executing ANY (no half-run batches
        # on a refusal), and gather everything needing approval into ONE ask.
        needs_ok: list[str] = []
        for i, st in enumerate(steps, 1):
            act = str(st.get("action", ""))
            if act == "ui_click":
                try:
                    el = self.uia.element(int(st.get("ref", -1)))
                    decision = evaluate("ui_click", {"element_name": el.name}, self.independent)
                except Exception as e:
                    return _tool_result(tool_use_id, None,
                                        f"batch aborted before start: step {i} invalid ({e}). "
                                        "Run ui_inspect and rebuild the batch.")
            elif act == "wait_change":
                continue
            else:
                decision = evaluate(act, st, self.independent)
            if not decision.allow:
                return _tool_result(tool_use_id, None,
                                    f"batch REFUSED by policy at step {i}: {decision.reason}. "
                                    "Nothing was executed.")
            if decision.needs_approval:
                needs_ok.append(f"step {i}: {act} {st.get('note') or ''}".strip())
        if needs_ok and not self.approver("batch of " + str(len(steps)) + " steps — approval needed for: "
                                          + "; ".join(needs_ok)):
            return _tool_result(tool_use_id, None, "User declined the batch. Nothing was executed.")

        log: list[str] = []
        for i, st in enumerate(steps, 1):
            self.kill.check()
            act = str(st.get("action", ""))
            note = st.get("note") or ""
            t0 = time.perf_counter()
            try:
                if act == "ui_click":
                    self.uia.click(int(st["ref"]))
                elif act == "wait_change":
                    self.screen.wait_change(timeout=min(float(st.get("duration", 2.0)), 8.0))
                else:
                    actions.execute(act, st, self.screen.metrics())
            except Exception as e:
                log.append(f"{i} ✗ {act} {note} — ERROR: {e}")
                return self._batch_done(tool_use_id, log,
                                        f"stopped at step {i}/{len(steps)} (error). ")
            if act in _UI_CHANGING:
                changed = self.screen.wait_change(timeout=0.9)
                ms = int((time.perf_counter() - t0) * 1000)
                if changed is None and act in ("ui_click", "left_click", "double_click", "right_click"):
                    log.append(f"{i} ✗ {act} {note} — screen did NOT change ({ms}ms)")
                    return self._batch_done(tool_use_id, log,
                                            f"stopped at step {i}/{len(steps)}: that click "
                                            "changed nothing (likely missed). ")
                log.append(f"{i} ✓ {act} {note} ({ms}ms)")
            else:
                log.append(f"{i} ✓ {act} {note}")
        return self._batch_done(tool_use_id, log, "all steps completed. ")

    def _batch_done(self, tool_use_id: str, log: list[str], headline: str) -> dict:
        self.screen._last_digest = None                  # final frame always sends
        frame = self.screen.capture()
        return _tool_result(tool_use_id, frame.png,
                            "batch_actions: " + headline + "\n" + "\n".join(log))

    # --- accessibility-tree tools ------------------------------------------------------
    def _ui_inspect(self, tool_use_id: str) -> dict:
        # Text only. This is the fast path — attaching a screenshot here made the
        # cheap route cost the same as the expensive one (~336 tokens vs ~1,230).
        frame = self.screen.metrics()
        elements = self.uia.inspect()
        lines = [
            f"{e.ref}: [{e.control_type}] {e.name!r} @{_to_sent(frame, e.cx, e.cy)}"
            for e in elements
        ]
        if not elements:
            return _tool_result(
                tool_use_id, None,
                "This window exposes no interactive elements to the accessibility tree "
                "(common for canvas, game, or custom-drawn UIs). Take a screenshot and "
                "work from pixels instead.",
            )
        text = (
            "Interactive elements of the foreground window "
            "(ref: [type] name @sent-image-coords). Click one with ui_click(ref).\n"
            + "\n".join(lines)
        )
        return _tool_result(tool_use_id, None, text)

    def _ui_click(self, tool_use_id: str, params: dict) -> dict:
        try:
            ref = int(params.get("ref"))
            el = self.uia.element(ref)
        except Exception as e:
            return _tool_result(tool_use_id, None, f"ui_click error: {e}")

        decision = evaluate("ui_click", {"element_name": el.name}, self.independent)
        if not decision.allow:
            return _tool_result(tool_use_id, None, f"REFUSED by policy: {decision.reason}")
        if decision.needs_approval and not self.approver(
            f"ui_click ref {ref} [{el.control_type}] {el.name!r} — {decision.reason}"
        ):
            return _tool_result(tool_use_id, None, "User declined this action.")

        self.kill.check()
        try:
            self.uia.click(ref)
        except Exception as e:
            return _tool_result(tool_use_id, None, f"ui_click error: {e}")
        return self._after(tool_use_id, f"ui_click on {el.name!r}")

    def _prune_images(self, messages: list) -> None:
        """Keep only the most recent N screenshots; replace older ones with a stub."""
        seen = 0
        for msg in reversed(messages):
            content = msg.get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if not (isinstance(block, dict) and block.get("type") == "tool_result"):
                    continue
                for c in block.get("content", []):
                    if isinstance(c, dict) and c.get("type") == "image":
                        seen += 1
                        if seen > SETTINGS.keep_recent_images:
                            c.clear()
                            c["type"] = "text"
                            c["text"] = "[old screenshot pruned to save tokens]"
