# Ybot (Phase 1)

A Claude-driven agent that controls your **whole Windows desktop** — not just the
browser. It takes screenshots, and Claude (Opus 4.8, via the computer-use tool)
decides where to click and what to type. It can drive any app: VS Code, Chrome,
Blender, the command prompt, file explorer.

> **Phase 1 scope:** the core safe loop — kill switch, DPI-correct screenshots,
> the Opus 4.8 computer-use loop, and the permission guard (purchases blocked,
> terminal input gated). Later phases add element-level targeting (pywinauto),
> elevated-window handling, and a Fable 5 planner layer.

## The brain

Anthropic's **computer-use tool does not run on Claude Fable 5** — it runs on
Opus 4.8 / Opus 4.7 / Sonnet 5 / Sonnet 4.6 / Opus 4.6 / 4.5. So the operator
(the "hands") runs on **Opus 4.8** by default. A Fable 5 *planner* can be layered
on top later for hard multi-step reasoning; it isn't required for Phase 1.

## Setup

```powershell
cd C:\Users\yuv\fable\ybot
python -m pip install -r requirements.txt
copy .env.example .env        # then edit .env and paste your ANTHROPIC_API_KEY
python run.py
```

Run the terminal **as Administrator** if you want the global kill-switch hotkey
to register and if you want the agent to drive elevated windows.

## Safety (read before running)

- **Kill switch:** press `Ctrl+Alt+Q` (configurable) to stop instantly.
- **Failsafe:** slam the mouse into any screen corner to abort (pyautogui).
- **Assisted mode** confirms every single action before it runs — use this first.
- **Independent mode** runs safe GUI actions automatically, but still:
  - **hard-blocks** anything resembling a payment / card entry, and
  - **asks first** before sending input to a terminal window.
- The agent controls your real mouse and keyboard. Start in assisted mode with a
  small task and watch it before trusting independent mode.

## Config (.env)

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | required |
| `OPERATOR_MODEL` | `claude-opus-4-8` | operator brain (must support computer use) |
| `OPERATOR_TARGET_WIDTH` | `1280` | screenshots downscaled to this width |
| `OPERATOR_MAX_STEPS` | `60` | safety cap on loop iterations |
| `OPERATOR_KILL_HOTKEY` | `ctrl+alt+q` | global stop hotkey |

## Files

| File | Role |
|---|---|
| `run.py` / `ybot/main.py` | CLI entry, mode select, approval prompt |
| `ybot/agent.py` | the screenshot → decide → execute loop |
| `ybot/screen.py` | DPI awareness, capture, coordinate scaling |
| `ybot/actions.py` | maps computer-use actions to mouse/keyboard |
| `ybot/guard.py` | permission policy (purchases, terminal) |
| `ybot/killswitch.py` | global hotkey + corner failsafe |
| `ybot/config.py` | settings from `.env` |
