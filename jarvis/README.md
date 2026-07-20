# JARVIS

A personal assistant with voice, persistent memory, tools, and a permission gate.
Claude is the brain; ElevenLabs is the voice; everything runs locally on your machine.

This is **v1 — the core**. It works today: you can talk to it (by text or voice),
it remembers you across sessions, it can use tools, and it refuses to do anything
that spends money, publishes, or deletes without asking you first.

## What works now

- **Reasoning** — Claude with streaming replies, chunked into natural sentences.
- **Memory** — durable facts about you + a searchable history of every
  conversation, in a local SQLite database. Survives restarts. No cloud, no
  embedding service.
- **Tools** — read/write files, run commands, and manage memory, each with a
  risk tier. Adding a tool is a one-function decorator.
- **Permission gate** — three tiers (auto / notify / confirm). Confirm-tier
  actions (writing files, running commands) require an explicit yes. Enforced in
  code, so nothing the model reads on a web page can talk its way past it.
- **Audit log** — every tool call is recorded with its approved/denied status,
  so you can see what it did while you were away.
- **Voice** — wake word ("Jarvis" / "Hey Jarvis"), listen, think, speak, with a
  spoken approval gate. Falls back to text automatically if no microphone.

## Setup

```powershell
# from C:\Users\yuv\fable
copy jarvis\.env.example .env      # then fill in ANTHROPIC_API_KEY (already set here)
.venv\Scripts\python.exe -m pip install -e jarvis
```

## Run

```powershell
# text mode (no microphone needed) — the default
.venv\Scripts\python.exe -m jarvis.app

# voice mode — wake word + speech
.venv\Scripts\python.exe -m jarvis.app --voice

# tell it who you are so it addresses you properly
.venv\Scripts\python.exe -m jarvis.app --owner Yuv
```

In text mode: type to chat, `/help` for commands, `/facts` to see what it
remembers, `/actions` for the audit log, `/quit` to exit.

## Test

```powershell
.venv\Scripts\python.exe -m pytest jarvis/tests -q     # unit tests
.venv\Scripts\python.exe jarvis/scripts/smoke.py        # live end-to-end
```

## Layout

```
jarvis/
  src/jarvis/
    config.py        all configuration, loaded from .env
    memory.py        SQLite facts + history + audit, with full-text search
    persona.py       the system prompt (identity, voice style, rules)
    brain.py         the Claude loop: streaming, tools, history management
    app.py           wiring + text REPL + the approval gate
    voice_loop.py    wake-word voice front end
    tools/
      registry.py    tool registration + risk tiers
      builtin.py     the starting toolset
    voice/
      ears.py        microphone + speech-to-text (swappable)
      mouth.py       ElevenLabs speech output (raw PCM, no ffmpeg needed)
  tests/             unit tests, incl. the history-trimming regression guard
  scripts/smoke.py   live end-to-end check
```

## What's next (not built yet)

The bigger vision — a CEO orchestrator with specialist sub-agents, autonomous
browser/computer control, the YouTube video pipeline, deployment automation, a
phone companion, and a proper UI — is being researched in depth. This core is
the foundation those bolt onto: the memory, the tool registry, and the
permission gate are the seams they'll use. See `docs/jarvis-architecture.md`
(pending) for the full plan.

## Design notes

- **The permission gate is in code, not the prompt.** A model can be talked into
  anything; a risk tier on a tool cannot. Confirm-tier tools call the approver
  before running, full stop.
- **History is trimmed in a way that stays API-valid.** The previous version of
  this assistant died after ~10 exchanges because a naive slice left an
  assistant message at the head of the conversation. `brain.py` trims to size
  then walks the head forward to a valid user turn. There's a regression test.
- **Voice output uses raw PCM** straight to PyAudio, so it needs no ffmpeg or
  mpv — one less thing to install on Windows.
- **STT is a swappable seam.** It ships with Google's free recognizer; local
  Whisper or ElevenLabs Scribe drops into `ears.transcribe()` later.
```
