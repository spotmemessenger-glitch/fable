# START HERE — pickup brief

**Written:** 2026-07-29, end of session (~$341 spent).
**Updated:** 2026-07-30 late evening. Everything below was verified by RUNNING
it, not by exit codes.

---

## 000. LATEST (2026-07-31 morning) — READ THIS FIRST, IT SUPERSEDES 00

**Repo: `spotmemessenger-glitch/fable`, branch `master`, HEAD `ad0b123`, fully
pushed.** Git here is HTTPS + Windows Credential Manager — there is NO ssh key
on this machine and never was. On the Mac: `gh auth login` then
`gh repo clone spotmemessenger-glitch/fable`.

### What is live, and what is not

- **Vercel IS live with every fix.** Verified in the served bundle:
  `sends 'authorization' 1`, `view-once burn 3`, `'Storage full' 2`.
- **Railway is NOT deployed.** Server-side view-once deletion and the
  voice-note truncation guard are inert until
  `cd spotme/backend && npm run deploy`. Nothing is broken meanwhile: the new
  bundle sends a token, the old backend ignores it.
- **DEPLOY ORDER MATTERS: Vercel first, then Railway.** Railway-first makes the
  new backend demand a token from every user still on the old bundle → 401 on
  every call, and `lib/voice.js` throws on non-OK, so voice breaks visibly.

**TRAP THAT COST AN HOUR — read before writing any verification loop.** The
bundle path is `/assets/index-*.js`. A check that greps `index-*.js` without
the `/assets/` prefix fetches a 404 PAGE and reports 0 matches forever. That
produced 19 consecutive false "not deployed" readings against a deploy that
had already succeeded.

### The overnight audit — 12 agents, 12 reports in `.reports/`

8 auditors (T1 T2 TL1 TL2 V1 V2 P1 P2) then 4 fixers (voice, viewonce,
language, security). ~40 fixes in 17 commits. Gates on the combined tree:
web 11 suites / 241 checks, backend 34/34, both builds real.

**Two decisions are waiting on the user — neither is engineering:**

1. **V-19, the biggest open item.** DM room keys derive from
   `stableHash("spotme-dm-secret-v1:" + sorted user ids)` — cyrb53, a
   NON-cryptographic hash of two values the server already stores. The server
   can recompute any room key and decrypt everything. Four agents independently
   ranked this top; none touched it because changing the derivation makes every
   existing conversation permanently unreadable. Safe shape: VERSIONED
   derivation — old rooms keep the old scheme, new rooms get real entropy.
   **The onboarding screen says "no server reading your messages." That is
   currently false — change the copy even if the fix waits.**
2. **View-once in PUBLIC groups.** The server holds the room key there, and the
   composer offers the "Private photo" tile with no warning. Disable it in
   public groups, or warn unmissably.

### Environment changes made 2026-07-31

- `ANTHROPIC_API_KEY` + `READ_MODEL=claude-haiku-4-5-20251001` set on Railway
  AND Vercel. Haiku ~1.6s vs the old 3.7s read path. **Caveat:** on
  `"naan innaiku vetuku varen"` both Claude models said "hunting" where the
  chain says "coming home" — Anthropic is now the PRIMARY reader, so if
  quality dips that is why, and the fix is reordering one list in `llmRead`.
- **All 7 vendor keys were REMOVED from Vercel** (Anthropic/OpenAI/Gemini/
  Sarvam/ElevenLabs/Azure/Google) because both `/api/translate` and
  `/api/voice` were open, unauthenticated and unthrottled there. The app is
  unaffected — it calls Railway (`VITE_SPOTME_SERVER`), so those Vercel
  functions are vestigial. The code fix is deployed now too, but the keys are
  still absent: **restore them only if something is actually meant to serve
  from Vercel.**
- 260 shell-debris files deleted from the repo (names like `!(m.viewOnce`,
  `(4-n%4)%4`). List at the session scratchpad `deleted-junk.txt`. **Do not
  bulk-delete untracked entries**: real cloned tools (`MetaGPT/`,
  `OmniParser/`, `ClaudeDesktopCommander/`, `eas-cli/`) are untracked too.

### iPhone re-test list — EVERY measurement was Chromium on Windows

The reported bugs were iPhone Safari, where the codec (AAC/mp4 vs Opus/webm),
autoplay policy, storage limit and tab suspension all differ. Five minutes on
the phone, in order:
1. 30s voice note — sends fast? first tap makes sound?
2. Several notes, then reload — any "tap to load"? (that was bytes discarded)
3. Note while the other phone is locked — still "Not delivered"?
4. Plain English in a Tamil chat — stays English?
5. Private photo — countdown appears on the SENDER's side?

If 1 or 2 fail, the `audioBitsPerSecond: 24000` hint is being ignored by Safari
and the fix has to become a transcode, not a tweak.

### Still uncommitted, deliberately (predates the audit, separate track)

`spotme/admin-dashboard/`, `spotme/app/lib/{db,reach}.js`,
`spotme/app/screens/`, `spotme/app/theme.js`, and modifications to
`spotme/app/package.json` + `worklet/app.bundle.mjs`.

### TestFlight

Blocked on the Mac — Windows cannot build iOS. There is still no
`spotme/web/ios/`. Start with `cd spotme/web && npm install && npx cap add ios`,
then an APNs `.p8` uploaded to Firebase project `spot-messenger-48a74`.

---

## 00. LATEST (2026-07-30 late evening) — read this first

**The Vercel 404 had a root cause nobody had found, and it was not the code.**
The Vercel project is git-linked to `spotmemessenger-glitch/fable` with **no
Root Directory set**, so every push to master built the REPO ROOT: no app
there, empty `/vercel/output`, a 1-second "success", and that empty deployment
then took the production alias away from the good CLI deploy. That is why the
site went 404 within minutes of each `git push` — including right after the
"fix" commit `c76f097`. Root Directory is now set to `spotme/web` via the
Vercel API. A git-triggered deploy was then run and verified: root **200**,
real HTML, `api/*` lambdas built, `/api/translate` returning
`{"engine":"sarvam+azure/openai","confirmed":true}`.
**If the site 404s again, check that setting before touching any code.**

**Groups v2 P3 (web UI) is BUILT and verified** — see
`spotme/docs/GROUPS-BUILD.md` for the full record. New: `lib/groups-api.js`,
`lib/group-perms.js`, `views/group-new.js` (3-step wizard),
`views/group-manage.js`, rewritten `views/groups.js`, route `#/group/<id>`.
Driven in a real browser against the local backend: wizard create → 3 members
+ OWNER on the server, promote to ADMIN, permission toggle persisted, ban,
lift ban. Backend 26/26, web +11 new tests. Commit is local — **not pushed**.

**Three bugs found by building it, all fixed:**
1. `ui.js el()` wrote `disabled="false"`, which HTML reads as disabled — the
   wizard's Create button was dead from first paint.
2. **Un-banning was impossible**: `setBan` stamps `leftAt` too, `memberInclude`
   filtered on it and `requireTarget` rejected it, so banned members vanished
   from every payload and the unban route 404'd.
3. Lifting a ban cleared only `bannedAt`, leaving `leftAt` set and the
   `RoomMember` row deleted — restored to the roster but still receiving
   nothing.

**New trap — `nest build` can exit 0 and emit NOTHING.** `deleteOutDir: true`
wipes `dist/` while `incremental: true` makes tsc decide there is nothing to
emit, so you get an empty `dist` and a 0 exit code. Worse: a stale backend may
still hold :4000, so you are testing hours-old code. Delete
`tsconfig.build.tsbuildinfo` before building, and prove a route you just added
actually answers (404 on a new route = stale process).

**Google Maps was dead in production for the same class of reason.**
`VITE_GMAPS_KEY` lives only in `spotme/web/.env.local` (gitignored, correctly),
and it had never been added to Vercel — the only `VITE_*` var there was
`VITE_SPOTME_SERVER`. Vite inlines `import.meta.env.*` at BUILD time, so every
production bundle shipped `maps/api/js?key=` with nothing after it and Google
refused the script; the app fell back to its drawn map. Fixed by adding
`VITE_GMAPS_KEY` to the Vercel project (production+preview+development) and
redeploying; the live bundle now carries the real key and the Maps API
authenticates on the Vercel origin with no `gm_authFailure`. **Rule: any new
`VITE_*` var must be added to Vercel too — `.env.local` never travels.**

**Everything above is pushed and deployed.** Web is live; the backend ban/unban
fix was confirmed in production by running a real ban → unban round trip
(Railway served the PREVIOUS container for ~4 minutes after `npm run deploy`
reported success — a health check cannot tell the difference).

---

## 0a. IF YOU ARE ON THE MacBOOK — this is your task

The Windows PC cannot do iOS at all (verified: `MINGW64_NT-10.0-19045`, no
`/System/Library`, no `sw_vers`). Xcode is macOS-only, so everything iOS was
blocked until now. The user has a MacBook AND an Apple Developer account, and
both an Android and an iOS device connected **to the Mac**.

**There is no `spotme/web/ios/` directory yet.** First commands:

```bash
cd spotme/web && npm install && npx cap add ios && npx cap sync ios
```

Then, for iOS push:
1. Apple Developer → Keys → create an **APNs key** (`.p8`).
2. Upload it into the Firebase project **`spot-messenger-48a74`**
   (Project Settings → Cloud Messaging → APNs Authentication Key).
3. Build/run on the connected iPhone from Xcode.

**The server needs NO changes for iOS.** Already deployed and live: the `apns`
block (`apns-priority: 10`, `content-available`, `thread-id`),
`DeviceToken.platform` accepts `'ios'`, and the client's `registerNativePush()`
already reports `ios` via `Capacitor.getPlatform()`.

**Do not commit `.keys/`** — gitignored, and the Mac does not need it. Only the
server does, and Railway already holds it.

## 0b. THE ONE THING STILL UNPROVEN

**No real phone has ever received a push.** Production holds exactly ONE device
token (`@qa_probe_02`, the Android emulator) and ZERO web-push subscriptions.
The whole chain is verified on the emulator — real chat message → server → FCM
→ tray notification on an idle, screen-off device — but never on a real handset.
Getting one notification onto a real phone is the next milestone.

This route was IMPOSSIBLE until 2026-07-30 late evening — the site was 404, so
there was nothing to add to a Home Screen. It is live now (see section 00), and
the PWA prerequisites were checked on the live site: `display: standalone`,
`apple-mobile-web-app-capable`, `/sw.js` 200, `/api/push` reports
`enabled:true` with a VAPID public key.

Fastest route on iPhone, needing no build at all: open
https://spotme-messenger.vercel.app in Safari → **Add to Home Screen** → open
**from the icon** → allow notifications. iOS 16.4+ supports Web Push only for a
Home Screen install, and the first-run prompt now asks directly.

## 0c. What landed 2026-07-30 (6 commits, `8fe2753..47247d5`, pushed)

- **The Railway deploy had been silently failing for a DAY.** `.deploy/` was
  gitignored and `railway up` skips gitignored paths, so the staged `web/api`
  never reached the build context, the Dockerfile's own assert failed the
  build, and Railway kept serving the PREVIOUS container. Staging is now
  `deploy-api/` (untracked but NOT ignored). A `.railwayignore` does not help —
  it only ADDS exclusions. Production now returns
  `{"engine":"sarvam+azure/openai","confirmed":true}`.
- **The Vercel site had been 404 for days**, same class of bug: `spotme-core`
  was `"file:.."`, outside the only directory Vercel uploads. Now a real local
  package at `web/vendor/spotme-core` — which must NEVER be gitignored.
- **Azure Translator key was dead** (401 everywhere). Replaced; the new key
  works ONLY against the resource endpoint
  (`ytranslator-yuvraj-2026.cognitiveservices.azure.com`) — the global host
  `api.cognitive.microsofttranslator.com` 401s for every region. Do not
  "simplify" `azureBase()` to the global host.
- **Groups v2**: roles (OWNER/ADMIN/MODERATOR/MEMBER), granular grants,
  ban/mute, transfer, public groups with @username, 30-day soft delete. 26
  tests pass. **The rooms gateway previously authorised NOTHING** — knowing a
  roomId was the whole access model, so a ban was decorative; join/send are now
  policy-checked. Delete-permission is only partly enforceable (the target id
  is inside the ciphertext — clients must send cleartext `meta.owner`).
- **FCM push** built and verified on the emulator. Web Push can NEVER work in
  the packaged app: Capacitor's WebView has no `PushManager` and no
  `Notification` (verified on-device).
- Composer no longer zooms the app on mobile (16px floor on coarse pointers).

**Groups has NO web UI yet** — `groups.js` still says "no admin, no server".
The 3-step wizard, roles screens and chat-list integration are unbuilt.

---

## 0. LATEST (2026-07-30 overnight): Spot Me now runs on a server backend

**IT IS LIVE.** Web: https://spotme-messenger.vercel.app — Backend API +
`/rooms` socket: https://api-production-0a4ca.up.railway.app (Railway project
`spotme-backend`, services `api` + `Postgres`). Deploy commands and the reasons
behind them are in `spotme/web/DEPLOY.md`. Verified in production: username
availability + search, knock opens the chat on both devices, and a message sent
while the recipient's tab was CLOSED arrived on reopen. Note: a Railway "Deploy
Crashed" email refers to the FIRST attempt (Prisma/libssl), fixed in `8e734e2`.

**FIRST TASK NEXT SESSION (one command, then one check):**
```
cd spotme/backend && npm run deploy
curl -s -X POST https://api-production-0a4ca.up.railway.app/api/translate \
  -H "content-type: application/json" -d '{"q":"are you coming tonight?","target":"ta"}'
```
Expect a `"confirmed"` field. At the end of 2026-07-30 production was still
answering `{"engine":"azure"}` with no `confirmed` — the cross-confirmation
deploy had not taken effect. Code and keys are committed and set; it just needs
the deploy to land. **Never plain `railway up`** — `npm run deploy` stages
`web/api` into the image, and without it every /api/* route 404s.

**Also done 2026-07-30 (all committed):**
- **Push notifications** live: the server pushes when an event lands for
  someone not connected. Only msg/knock, never the sender, no text in the
  payload. Real-device delivery still unverified.
- **Translation + transliteration fixed** after five packaging faults —
  see the memory note `spotme-language-pipeline`. Engines now cross-confirm:
  Sarvam in parallel with Azure/Google, LLM adjudicates disagreements. User
  confirmed Google Input Tools should win transliteration disputes.
- **ybot**: voice loop (ElevenLabs streaming, real barge-in, ctrl+space
  push-to-talk) and a 3D saree avatar with 15-viseme lip sync, wired live to
  the voice service. Run: `python run.py --voice` plus
  `python -m ybot.avatar_server`. Never tested with a real microphone — that
  needs the user.
- Working keys: Sarvam `sk_w64e4low…`, OpenAI `sk-proj-OrZ…`. Gemini
  authenticates but its AI Studio project has no credit (429).

**What happened:** the web app's Trystero/BitTorrent-tracker transport was
replaced by a server-backed one. Commits `7aad447` (backend), `43cfc02` (web),
`9603543` (docs). The UI is UNTOUCHED (user: "stick to this UI").

**PROVEN by two-browser Playwright E2E** (screenshots in
`spotme/docs/verification/`): onboarding + username registry on the backend,
knock→chat both sides, live encrypted text, presence Online/Last-seen, Read
receipts, **offline text delivery via replay**, live photo (5 encrypted slices
+ binack), **offline photo (envelope replay + tap-to-load lazy fetch from the
server)** — the old P0 media-persistence bug is structurally fixed. Test
suites: web 24/24 + 32/32 + 21/21.

**How to run:**
```
docker start spotme-postgres                     # port 5433
cd spotme/backend && node dist/main.js           # :4000 (or npm run start:dev)
cd spotme/web && npx vite                        # :5173, proxies /api + /socket.io
```
Two isolated identities for testing: open localhost:5173 AND 127.0.0.1:5173
(different origins → different localStorage). `?fresh` resets a device.

**Architecture (see spotme/docs/02-SYSTEM-ARCHITECTURE.md):** rooms are
Socket.IO rooms on NestJS; persistent actions append to Postgres `RoomEvent`
(AES-GCM ciphertext, key derived client-side from the room secret — server
never sees plaintext); clients replay from a per-room cursor. Calls remain
true P2P (WebRTC, signalling relayed). `web/src/lib/socket-transport.js` is a
drop-in for the Trystero API; `localStorage['spotme.transport']='p2p'` reverts.

**Morning session (2026-07-30 ~10:30-11:30) — one serious bug found and fixed.**
Commit `8e1853c`. Symptom: chat silently stopped delivering. Cause: payloads
crossed the wire as Buffers, and socket.io frames each Buffer separately after
the JSON packet; when anything interleaves (a heartbeat, another emit) the
client decoder reads text where it expects binary and drops the socket with
`parse error`. A join replaying ~8-11 events did that every time, then sat in a
permanent reconnect loop — invisible because sends fail asynchronously.
Fix: base64 text payloads end to end, token minted per handshake (so a tab that
slept past the 15-min TTL can reconnect), one retry when a send beats its
room's rejoin, per-profile replay cursors (a stale cursor used to survive
Clear-all-data and start the next identity mid-history). Also moved the
Discovery lobby onto the same transport — it was still on BitTorrent trackers;
nearby peers now appear in ~1s instead of ~25s, and `hello` is ephemeral so no
replayed "I am nearby" can lie. **Backend now has its first 4 tests**
(`spotme/backend/test/rooms.gateway.e2e-spec.ts`), the first of which fails if
payload framing ever regresses to binary. `npx jest` in spotme/backend.
Additionally verified live: reaction, edit (with the "edited" label on the
receiver), delete-for-everyone, peer-to-peer history backfill, nearby discovery.

**UNPROVEN / open:** calls over the new signalling path (machinery written,
never dialed — needs fake media devices to test headless); **video** media
specifically (photos are verified both live and offline); groups/bluetooth
screens on server transport; multi-tab same-profile; knock payloads are
server-readable (Phase 2: seal to recipient publicKey — field already in
schema); RoomEvent retention/TTL job not written (disappearing messages are
still client-enforced only); translate/voice/push bridges return 400 locally
until their vendor env keys are set in backend/.env (client degrades
gracefully). One global lobby room is Phase-1 only — presence needs geo-
sharding before it scales.

**Deploy decision (deliberate):** spotme-messenger.vercel.app is still 404 and
was NOT redeployed — the new build needs a hosted backend first (Railway/Fly +
Neon per backend/README.md, then set VITE_SPOTME_SERVER at build). Deploying
the new web build to Vercel without that would ship a dead transport.

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

## 3b. Git on this machine — already fixed, do not re-debug

`git push` / `git ls-remote` used to **hang forever** (exit 124), while `gh`
worked fine. Cause: the Windows credential helper blocking. Fixed with:

```bash
gh auth setup-git      # points git at gh's token
```

If git ever hangs again, that is the fix. Also: **never read a git exit code
through a pipe** — `git ... | head; echo $?` reports *head's* status, so a
hanging command looks successful. Redirect to a file and check `$?` directly.

Everything is committed and pushed to `origin/master`:
- `e4c8987` handoff docs + CLAUDE.md pointer
- `5035d7f` ybot voice subsystem (10 files, 8/8 self-checks passing)

`ybot/voice_memory/` is gitignored — it holds runtime conversation transcripts
and must not be committed.

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
