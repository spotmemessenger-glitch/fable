# START HERE — pickup brief

**Written:** 2026-07-29, end of session (~$341 spent).
**Read this file first.** It exists so the user does not have to re-explain
anything. Everything below was verified by RUNNING it, not by exit codes.

---

## 1. The one constraint that shapes every decision

**ybot runs Python 3.14. Every ML stack runs Python 3.11** — torch publishes no
3.14 wheels. They cannot share a process. Anything touching torch/whisper/
OmniParser must run in a 3.11 venv and talk to ybot over a socket.

| Interpreter | Path | Holds |
|---|---|---|
| ybot | `py -3.14` (system) | pyautogui, pywinauto, pynput, mss, watchdog, GitPython |
| vision | `~/.venvs/vision` | OmniParser, SAM 2, EasyOCR, OpenCV, **torch 2.13.0+cu126** |
| voice | `~/.venvs/voice` | whisper, piper-tts, kokoro, coqui-tts, sounddevice, webrtcvad |
| threed | `~/.venvs/threed` | cadquery, build123d, trimesh, open3d, usd-core, MaterialX, warp |
| others | `~/.venvs/` | metagpt, sweagent, langchain, crewai, mem0, browser-use, autogen |

---

## 2. THE NEXT TASK (agreed with the user)

**Bolt OmniParser + a verify-after-every-action loop onto ybot. Not a rewrite.**

Why this and nothing else: ybot today is 2057 lines that screenshot, ask a
model, and click a guessed coordinate. It never checks the click worked. The
single biggest cause of "autonomous agent failed" is a missing verification
step, not a wrong decision.

Target loop:
```
PERCEIVE (OmniParser -> numbered elements)
  -> GROUND (pick element id, never a bare coordinate)
  -> ACT
  -> VERIFY (re-capture; did the expected change happen?)
  -> RECOVER (retry with a DIFFERENT strategy, then escalate)
```

Read `ybot/ybot/agent.py` (420 lines) and `screen.py` / `uia.py` **before**
editing — target the real code paths, not assumed ones.

After that: `langgraph` 1.2.9 is installed and is the intended fix for ybot
having **no durable state** (a crash currently loses everything).

---

## 3. Hard-won traps — do NOT rediscover these

- `uv pip install torch` on Windows silently installs **CPU-only**. Always
  `--index-url https://download.pytorch.org/whl/cu126`.
- **OmniParser v3 weights are broken** (TorchScript; `RecursiveScriptModule has
  no attribute 'fuse'`). Use `weights/icon_detect/model.pt` (v2) **and pin
  `ultralytics==8.3.70`** — 8.4.x cannot load them.
- **Import success proves nothing.** SAM 2 imported fine but shipped no
  checkpoints; trimesh imported fine but decimation needed
  `fast-simplification`; MetaGPT "installed" from PyPI as a v0.1 stub. Always
  run a functional check.
- **PyPI `metagpt` is v0.1**, unrelated to the real project. Install from GitHub.
- **UAC-elevated winget installers always fail** here (`0x800704c7`):
  Tesseract, FreeCAD, MeshLab. Per-user installs work fine.
- **Never install NVIDIA Kaolin** into `vision`/`threed` — it pins older torch
  and would break OmniParser + SAM 2 + Warp. Isolated venv only.
- `pyassimp` is installed but **dead** (missing native lib). Use trimesh.
- **graphify must be scoped to one project.** At fable root it swept
  node_modules: 134,090 nodes / **0 edges**. Scoped to spotme: 1627 / 2823.
- Blender: `len(obj.data.vertices)` reports the **pre-modifier** cage — use the
  depsgraph. `ng.interface.new_socket` is the 4.0+ API (Blender here is 5.2).
- **Redirect big install logs to a file and grep them.** Streaming pip output
  into context was the main driver of this session's $341.

---

## 4. Measured numbers (GTX 1050 Ti, 4 GB VRAM)

| Operation | Measured |
|---|---|
| OmniParser detect (warm, GPU) | **0.17 s, 222 elements** @1920x1080 |
| OmniParser cold start | ~7 s CUDA warmup — keep a long-running process |
| EasyOCR full screen | 4.4 s, 166 regions (25x slower — fallback only) |
| SAM 2 tiny segment | 0.54 s |
| OmniParser + SAM 2 co-resident | **0.75 GB / 4 GB** |

---

## 5. What exists now

**8 agents** (`~/.claude/agents/`): ceo-agent, planner-agent, vision-agent,
desktop-operator, browser-operator, memory-agent, recovery-agent,
optimization-agent. Coding/QA/Security/Research were deliberately NOT built —
~89 existing agents already cover them.

**8 3D skills** (`~/.claude/skills/`): blender-automation,
cad-parametric-modeling, mesh-optimization, usd-gltf-pipeline,
pbr-materials-openpbr, game-ready-3d-assets, physics-simulation-3d,
web3d-development. Every code sample was executed before being written.

**118 skills installed**: google/skills (93), android/skills (20),
compose-kotlin (4), modern-jetpack-compose (1). A Windows Scheduled Task
`AndroidSkillsDailyUpdate` refreshes the official Android set daily at 09:07;
log at `fable/android-skills/.update.log`. Google/community sets do NOT
auto-update.

**ybot voice subsystem** — `fable/ybot/ybot/voice/`, 1059 lines, 9 modules,
every one with a passing `demo()`:
`mic, vad, providers, style, memory, intent, orchestrator, service, bridge`
```bash
~/.venvs/voice/Scripts/python.exe -m ybot.voice.service --demo
```
`bridge.py` is stdlib-only, verified on 3.14 — it must never import
torch/numpy/sounddevice. Service emits newline-JSON on `127.0.0.1:8765`:
`{"type":"transcript|reply|error","text":..,"domain":..,"agent":..}`.
Long-term memory JSONL: `{"ts","role","text","tags"}`.

---

## 6. UNPROVEN / NOT DONE — never claim otherwise

- **Voice has never run with a real microphone.** Whisper needs a model
  download; Piper needs `YBOT_PIPER_VOICE` pointing at a `.onnx` voice.
- ElevenLabs TTS provider raises `NotImplementedError` (marked SCAFFOLD).
- **Orchestrator handlers are unregistered** — every route currently returns
  "No handler registered".
- Voice is **not wired into ybot `main.py`**. `Operator`, `Settings` and
  `main.py` were deliberately untouched; the package is additive/opt-in.
- Florence-2 captioner untested under VRAM pressure.
- The "study 40-70 repos and extract prompts" brief was **never done as a
  literal crawl**. The skills distil installed+verified tooling instead.
- `llama-cpp-python` failed to build (needs MSVC). Ollama covers local serving.
- Not installed by choice: vLLM (no Windows), Milvus/Qdrant/Prometheus/Grafana
  servers (daemons, no agent value), CUA (would replace ybot), Kaolin.

---

## 7. Blocked on the user — will stall work if forgotten

1. **`CEREBRAS_API_KEY` in `fable/.env` is EMPTY** (verified: length 0, API
   returns `Not authenticated`). Free signup at cloud.cerebras.ai, no card.
2. **Rotate the exposed OpenRouter keys** — still live.
3. **getlayers OAuth** — needs an interactive session.
4. MetaGPT `fable/MetaGPT/config/config2.yaml` still has `YOUR_API_KEY`.
5. OpenHands v1.6.1 at `:8000` is showing its onboarding wizard — needs an
   agent + LLM key chosen.
6. Tesseract / FreeCAD / MeshLab need installing from an **elevated** terminal.

---

## 8. Working style the user expects

- **Verify by running, not by exit code.** They said "registered isn't the same
  as working" and were right every time.
- **Say what failed.** Partial success reported as success is the thing to avoid.
- **Flag cost.** This session hit $341; they want to choose that spend.
- Terse prompts, wants end-to-end delivery, will course-correct directly.

See also memory note `ai-os-stack-2026-07-29` and `SESSION-2026-07-29.md`
in this folder for the full chronological log.
