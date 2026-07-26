"""Free desktop operator: screenshot -> Ollama VISION model -> JSON action -> execute.

The paid path (agent.Operator) uses Anthropic's computer-use tool, which no free
model can do. This is the $0 alternative: it sends the current screenshot to a
vision-capable Ollama model (local or Ollama Cloud) and asks for the SINGLE next
action as a JSON object, then runs it through the exact same hands (actions.py),
safety guard (guard.py), and kill switch (killswitch.py) as the paid operator.

Grounding on open vision models is less reliable than Claude's computer-use — it
misjudges coordinates more often — so this trades accuracy for cost. Pick a
strong vision model (e.g. qwen3.5:397b) for the best hit rate.
"""
from __future__ import annotations

import base64
import json
import re
import time
from typing import Callable

import httpx

from . import actions
from .config import SETTINGS
from .guard import evaluate
from .killswitch import KillSwitch
from .screen import Screen

# Actions the model may emit — these map 1:1 to actions.execute() keys.
_ALLOWED = {
    "left_click", "right_click", "middle_click", "double_click", "triple_click",
    "mouse_move", "left_click_drag", "type", "key", "scroll", "wait", "screenshot",
}

_SCHEMA_HINT = (
    'Reply with ONE JSON object, nothing else:\n'
    '{"reasoning": "<one short sentence>", "action": "<name>", '
    '"coordinate": [x, y], "start_coordinate": [x, y], "text": "<text or key combo>", '
    '"scroll_direction": "up|down|left|right", "scroll_amount": 3, '
    '"duration": 1, "done": false, "summary": "<final summary when done>"}\n'
    "Only include the fields the chosen action needs. Actions:\n"
    "- left_click / right_click / middle_click / double_click / triple_click: needs coordinate [x,y]\n"
    "- mouse_move: needs coordinate\n"
    "- left_click_drag: needs start_coordinate and coordinate\n"
    "- type: needs text (types the string)\n"
    "- key: needs text as a combo like \"ctrl+s\" or \"enter\"\n"
    "- scroll: needs coordinate + scroll_direction + scroll_amount\n"
    "- wait: needs duration seconds\n"
    "- screenshot: just re-look at the screen (no other field)\n"
    'When the goal is fully done and VISIBLE on screen, return {"action":"done","done":true,'
    '"summary":"..."}.\n'
    "SPEED: when the next several steps are mechanical and predictable (type text, press "
    'enter, a keyboard shortcut), return them as ONE plan: {"reasoning":"...", "actions": '
    '[{"action":"type","text":"hello"}, {"action":"key","text":"enter"}]} (max 8). '
    "Keyboard steps run back-to-back; if the screen changes and a later step needs "
    "coordinates, execution stops so you can look again — so put clicks FIRST or alone."
)


class OllamaOperator:
    """Drop-in free replacement for agent.Operator (same constructor + run())."""

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
        self.model = model or SETTINGS.ollama_model
        self.screen = Screen(SETTINGS.target_width)
        self.kill = KillSwitch(SETTINGS.kill_hotkey)
        self.kill.arm()

        key = SETTINGS.ollama_api_key
        self.host = (SETTINGS.ollama_host or ("https://ollama.com" if key else "http://localhost:11434")).rstrip("/")
        self.headers = {"Authorization": f"Bearer {key}"} if (key and "localhost" not in self.host) else {}

    # ---------------------------------------------------------------- loop

    def run(self, goal: str) -> str:
        history: list[str] = []
        parse_fails = 0
        for _ in range(SETTINGS.max_steps):
            self.kill.check()
            if self.should_stop():
                return "(stopped by user)"

            frame = self.screen.capture()
            try:
                decision = self._decide(goal, frame, history)
            except Exception as e:  # transport / model error — surface, don't fall back to paid
                return f"Couldn't reach the Ollama model at {self.host}: {e}"

            if decision is None:
                parse_fails += 1
                if parse_fails >= 3:
                    return "(stopped: the model kept returning unparseable output)"
                history.append("model output was not valid JSON; retrying")
                continue
            parse_fails = 0

            action = str(decision.get("action", "")).strip()
            reasoning = str(decision.get("reasoning", "")).strip()
            if reasoning:
                try:
                    print(f"\n[operator] {reasoning}")
                except Exception:
                    pass

            if decision.get("done") or action == "done":
                return str(decision.get("summary") or reasoning or "(done)")

            # A PLAN arrives as {"actions":[...]} and legitimately has NO top-level
            # "action" — so it must be extracted BEFORE the empty-action guard below,
            # or every planned turn is silently discarded as "just looked".
            raw_plan = decision.get("actions")
            queue = [q for q in raw_plan if isinstance(q, dict)][:8] if isinstance(raw_plan, list) else []

            if not queue:
                if action == "screenshot" or not action:
                    history.append("looked at the screen")
                    continue
                if action not in _ALLOWED:
                    history.append(f"unknown action {action!r} ignored")
                    continue
                queue = [decision]

            screen_changed = False
            for q in queue:
                q_action = str(q.get("action", action)).strip()
                if q_action not in _ALLOWED:
                    history.append(f"unknown action {q_action!r} ignored")
                    continue
                # Coordinates were grounded on the LAST screenshot; once the screen
                # has changed they are stale — stop and let the model look again.
                if screen_changed and (q.get("coordinate") or q.get("start_coordinate")):
                    history.append("plan paused: screen changed, later coords are stale")
                    break

                verdict = evaluate(q_action, q, self.independent)
                if not verdict.allow:
                    history.append(f"{q_action}: REFUSED ({verdict.reason})")
                    break
                if verdict.needs_approval and not self.approver(
                        f"{q_action} {self._short(q)} — {verdict.reason}"):
                    history.append(f"{q_action}: user declined")
                    break

                self.kill.check()
                self._denormalize(q, frame)  # 0-1000 grid -> sent-image pixels
                try:
                    actions.execute(q_action, q, frame)
                    history.append(f"did {q_action} {self._short(q)}")
                except Exception as e:  # keep the loop alive; tell the model next turn
                    history.append(f"{q_action} failed: {e}")
                    break
                # Event-ish settle: continue the moment the UI reacts (or 0.8s).
                if self.screen.wait_change(timeout=0.8) is not None:
                    screen_changed = True
        return "(stopped: reached max steps)"

    # ------------------------------------------------------------- model

    def _decide(self, goal: str, frame, history: list[str]) -> dict | None:
        img_b64 = base64.standard_b64encode(frame.png).decode()
        messages = [
            {"role": "system", "content": self._system(frame)},
            {"role": "user", "content": self._user_text(goal, history), "images": [img_b64]},
        ]
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "format": "json",
            "options": {"temperature": 0, "num_predict": 512},
        }
        r = httpx.post(self.host + "/api/chat", json=payload, headers=self.headers, timeout=180)
        r.raise_for_status()
        content = (r.json().get("message") or {}).get("content", "") or ""
        return self._parse(content)

    def _system(self, frame) -> str:
        return (
            "You operate a real Windows desktop by looking at screenshots and choosing ONE "
            "action at a time. Coordinates use a 0-1000 grid: x goes 0 (far left) to 1000 (far "
            "right), y goes 0 (top) to 1000 (bottom), regardless of the image's real pixel size. "
            "Top-left is [0,0], center is [500,500], and the taskbar Start button sits near "
            "[15,985]. Look carefully at the current screenshot, decide "
            "the single best next action toward the goal, and return it as JSON. Prefer clicking "
            "clearly-visible targets; if unsure, use the screenshot action to look again. Never "
            "attempt payments, purchases, checkouts, or any financial transaction. Only mark the "
            "task done after you can SEE the finished result on screen.\n\n" + _SCHEMA_HINT
        )

    @staticmethod
    def _user_text(goal: str, history: list[str]) -> str:
        recent = history[-15:]
        past = ("\n".join(f"- {h}" for h in recent)) if recent else "- (nothing yet)"
        return f"GOAL: {goal}\n\nActions so far:\n{past}\n\nWhat is the single next action? Reply with the JSON object."

    @staticmethod
    def _parse(raw: str) -> dict | None:
        raw = raw.strip()
        try:
            obj = json.loads(raw)
            return obj if isinstance(obj, dict) else None
        except Exception:
            pass
        m = re.search(r"\{.*\}", raw, re.DOTALL)  # last resort: grab the first {...}
        if m:
            try:
                obj = json.loads(m.group(0))
                return obj if isinstance(obj, dict) else None
            except Exception:
                return None
        return None

    @staticmethod
    def _denormalize(decision: dict, frame) -> None:
        """Map the model's 0-1000 grid coords into sent-image pixels for actions.execute."""
        for k in ("coordinate", "start_coordinate"):
            c = decision.get(k)
            if isinstance(c, (list, tuple)) and len(c) == 2:
                try:
                    decision[k] = [
                        round(float(c[0]) / 1000 * frame.sent_w),
                        round(float(c[1]) / 1000 * frame.sent_h),
                    ]
                except (TypeError, ValueError):
                    pass

    @staticmethod
    def _short(decision: dict) -> str:
        bits = []
        for k in ("coordinate", "start_coordinate", "text", "scroll_direction"):
            if decision.get(k) not in (None, ""):
                v = decision[k]
                bits.append(f"{k}={v!r}" if k == "text" else f"{k}={v}")
        return " ".join(bits)
