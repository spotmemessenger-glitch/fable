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
| `ybot/perf.py` | latency instrumentation (off unless `YBOT_PERF=1`) |
| `ybot/voice/` | conversation logic + OpenAI Realtime front end |
| `scripts/bench.py` | local microbenchmark — capture, change detection, UIA walk |

## Voice layer (`ybot/voice/`)

The conversation logic, with no audio vendor baked in. What ships:

| Module | Does |
|---|---|
| `chunker.py` | Cuts a token stream into speakable chunks — first on a clause (latency wins), later on full sentences (prosody wins) |
| `state.py` | Turn state and barge-in, including truncating an interrupted turn to what was actually heard |
| `router.py` | LOCAL / FAST / SMART tiering; "stop" never reaches a model |
| `engines.py` | `SpeechRecognizer` / `SpeechSynthesizer` Protocols, plus test doubles |

Run `python -m pytest tests/test_voice.py` — 33 tests, no hardware needed.

### The ChatGPT voice (OpenAI Realtime)

`openai_realtime.py` + `tools.py` wire the OpenAI Realtime API in as the
conversational front end. Realtime is **speech-to-speech** — recognition,
reasoning and synthesis all happen server-side with its own VAD — so it replaces
the local chunker and STT/TTS entirely. The split:

```
mic ──audio──> OpenAI Realtime ──audio──> speaker
                    │    ▲
             function_call │ result
                    ▼    │
        ybot: desktop Operator, browser, memory
```

The voice model never sees a screenshot or a coordinate. It asks for an outcome
and the existing Operator does the work — so `guard.evaluate()` still gates
every action and voice does not become a second, unguarded path to the mouse.
Desktop goals run on a background thread and return a task id immediately,
because an assistant that goes silent for ninety seconds while it works is
broken however good the result is.

```
OPENAI_API_KEY=sk-...
YBOT_REALTIME_VOICE=marin      # try: marin, cedar, alloy, echo, shimmer
```

**Not implemented:** the websocket loop and audio device I/O — they need a
socket, a microphone and a speaker, none of which can be covered by tests. The
loop is ~10 lines and is written out at the bottom of `openai_realtime.py`. The
one requirement that is easy to get wrong: `stop_audio` must **discard audio
already handed to the output device**. A stream that merely stops accepting new
data keeps playing its buffer, and the assistant talks over the user after being
interrupted.

Run `python -m pytest tests/test_realtime.py` — 19 tests, no socket or API key.

## Measuring performance

Optimise nothing without a number. Two tools:

**Live run.** Set `YBOT_PERF=1` and every span is timed; a ranked table prints when
the run ends (including after a kill-switch abort).

```powershell
$env:YBOT_PERF=1; $env:YBOT_PERF_OUT="before.json"; python run.py
```

Spans are ranked by *total* time, so the top row is the highest-impact target.
Percentiles are reported rather than means — a p95 of 2s with a mean of 300ms is
the shape that makes an assistant feel broken, and a mean alone hides it.

Overhead is 1.5µs per span enabled, 0.3µs disabled — against a ~105ms capture
that is 0.0014%, i.e. the instrument does not move the reading.

**Local microbenchmark.** `python scripts/bench.py` breaks a capture into stages,
compares four ways of answering "did the screen change?", and times one
accessibility-tree walk. It never clicks or types, so it is safe to run anytime.
Run it twice — once with Notepad focused, once with a browser — because the UIA
walk scales with window complexity.

**Comparing runs.** Every optimisation must show up as a number:

```powershell
python -c "from ybot.perf import compare; compare('before.json','after.json')"
```

### Counters worth watching

| Counter | Reads as |
|---|---|
| `tokens.cache_read` | If 0, the tools+system prefix cache is not working and every step pays full price |
| `batch.steps_executed` vs `agent.steps` | The batching doctrine's payoff — steps per round trip |
| `screen.wait_change.polls` | Each poll is a full capture; multiply by capture cost |
| `screen.wait_change.timeouts` | Actions that changed nothing — missed clicks |
| `uia.inspect.nodes_walked` | Tree size; the walk cost scales with it |
