---
name: ai-os-stack-2026-07-29
description: "The autonomous-AI-OS build of 2026-07-29 — verified vision/voice/3D stacks, the 3.14-vs-3.11 split that forces ybot voice to be a microservice, 8 new agents, 8 3D skills, and exactly what is still unproven"
metadata: 
  node_type: memory
  type: project
  originSessionId: 52910b4a-1ea3-41b6-9985-de991ce0e6ed
  modified: 2026-07-29T17:42:22.733Z
---

Everything below was verified by RUNNING it on 2026-07-29, not by exit codes.
Session cost ~$330 — do not re-derive this.

## The constraint that shapes everything

**ybot runs Python 3.14. The vision/voice/3D stacks run Python 3.11**, because
torch publishes no 3.14 wheels. They cannot share a process. This is why the
ybot voice subsystem is a microservice, not a module.

Interpreters:
- ybot: system `py -3.14` (pyautogui, pywinauto, pynput, mss, watchdog, GitPython)
- `~/.venvs/vision` — OmniParser, SAM 2, EasyOCR, OpenCV, torch 2.13.0+**cu126**
- `~/.venvs/voice` — whisper, piper-tts, kokoro, coqui-tts, sounddevice, webrtcvad
- `~/.venvs/threed` — cadquery, build123d, trimesh, open3d, usd-core, MaterialX, warp
- also: metagpt, sweagent, langchain, crewai, mem0, browser-use, autogen

## Measured performance (GTX 1050 Ti, 4 GB)

| Op | Number |
|---|---|
| OmniParser detect, warm GPU | **0.17 s, 222 elements** @1920x1080 |
| OmniParser cold start | ~7 s (CUDA warmup) — keep a long-running process |
| EasyOCR full screen | 4.4 s, 166 regions — 25x slower, use as fallback only |
| SAM 2 tiny | 0.54 s |
| OmniParser + SAM 2 resident together | **0.75 GB / 4 GB** — lots of headroom |

## Traps that cost real time — do not repeat

- `uv pip install torch` on Windows silently installs **CPU-only**. Use
  `--index-url https://download.pytorch.org/whl/cu126`.
- **OmniParser v3 weights are broken** (TorchScript, `RecursiveScriptModule has
  no attribute 'fuse'`). Use `weights/icon_detect/model.pt` (v2) and pin
  **ultralytics==8.3.70** — 8.4.x cannot load them.
- SAM 2 and trimesh both **import fine while being unusable**: SAM 2 ships no
  checkpoints (use `SAM2ImagePredictor.from_pretrained('facebook/sam2.1-hiera-tiny')`),
  trimesh decimation needs `fast-simplification`. Import success proves nothing.
- **PyPI `metagpt` is v0.1**, an ancient stub — install from the GitHub repo.
- **UAC-elevated winget installers always fail** in non-interactive sessions
  (`0x800704c7`): Tesseract, FreeCAD, MeshLab. Per-user installs succeed
  (PowerShell 7, PowerToys, Godot, Windows Terminal, Trivy).
- `pyassimp` is installed but **dead** (no native lib). Use trimesh.
- **Do NOT install NVIDIA Kaolin** into `vision`/`threed` — it pins older torch
  and would break OmniParser/SAM2/Warp. Isolated venv only.
- Blender `len(obj.data.vertices)` reports the **pre-modifier** cage; use the
  depsgraph. Blender 5.2 needs `ng.interface.new_socket` (4.0+ API).
- graphify must be **scoped to one project**. Run at fable root it swept
  node_modules and produced 134,090 nodes / **0 edges**. Scoped to spotme:
  1627 nodes, 2823 edges — that graph is at `fable/graphify-out/graph.json`.

## What was built

**8 agents** in `~/.claude/agents/`: ceo-agent, planner-agent, vision-agent,
desktop-operator, browser-operator, memory-agent, recovery-agent,
optimization-agent. Coding/QA/Security/Research deliberately NOT built —
covered by the ~89 existing agents.

**8 3D skills** in `~/.claude/skills/`: blender-automation,
cad-parametric-modeling, mesh-optimization, usd-gltf-pipeline,
pbr-materials-openpbr, game-ready-3d-assets, physics-simulation-3d,
web3d-development. Every code sample was executed before being written down.

**ybot voice subsystem** — `fable/ybot/ybot/voice/`, 1059 lines, 9 modules,
each with a passing `demo()` self-check:
`mic, vad, providers, style, memory, intent, orchestrator, service, bridge`.
- run offline: `~/.venvs/voice/Scripts/python.exe -m ybot.voice.service --demo`
- `bridge.py` is **stdlib-only** and verified on 3.14; it must never import
  torch/numpy/sounddevice.
- service emits newline-JSON on `127.0.0.1:8765`:
  `{"type":"transcript|reply|error","text":..,"domain":..,"agent":..}`
- long-term memory JSONL: `{"ts","role","text","tags"}`

## STILL UNPROVEN / NOT DONE — say so, do not claim otherwise

- Voice has **never run with a real mic**. Whisper needs a model download;
  Piper needs `YBOT_PIPER_VOICE` pointing at a `.onnx`.
- ElevenLabs provider raises `NotImplementedError` (marked SCAFFOLD).
- Orchestrator handlers are **unregistered** — every route currently returns
  "No handler registered".
- Voice is **not wired into ybot main.py**; the package is additive/opt-in.
  `Operator`, `Settings`, `main.py` were deliberately untouched.
- Florence-2 captioner untested under VRAM pressure.
- The "study 40-70 repos and extract prompts" brief was never done as a literal
  crawl — skills distil the installed+verified tooling instead.

## Ybot as it stands

2057 lines: `agent.py` (420), `ollama_operator.py`, `actions.py`, `screen.py`,
`uia.py`, `guard.py`, `killswitch.py`, `charts.py`, `ssh.py`, `deploy.py`,
`crash_reporter.py`. Frozen `Settings` dataclass, `Operator.run(goal)`,
provider switch anthropic|ollama, `console_approver`, kill hotkey ctrl+alt+q.
**No durable state — a crash loses everything.** langgraph 1.2.9 is installed
and is the intended fix.

**Next step agreed:** bolt OmniParser + a verify-after-every-action loop onto
ybot. Not a rewrite. See [[ybot-crash-bridge]], [[desktop-operator]].

Still open, needs the user: OpenRouter key rotation, getlayers OAuth, empty
`CEREBRAS_API_KEY`, MetaGPT `config2.yaml` key, OpenHands onboarding.
