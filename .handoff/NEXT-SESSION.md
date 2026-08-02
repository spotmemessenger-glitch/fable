# START HERE — pickup brief

**Written:** 2026-08-02, ~13:00 UTC, mid Priority 2 build phase.
**Supersedes** the 2026-08-01 brief entirely (the identity-sequence/E2E-foundation
era, PRs up to #36). That text is in git history
(`git log .handoff/NEXT-SESSION.md`) and in `SESSION-*.md`.

**Why this brief exists now, specifically:** the owner is likely switching to a
new account (current one is hitting usage limits) and needs a new session to
pick this up cold. Everything below is written for that: what's true right
now, what's mid-flight, and exactly what a fresh session needs to re-attach.

**Rule that has not changed:** never claim something works because this brief
says so. It is a record, not a live check. Anything marked UNPROVEN stays
unproven until re-run. Every PR head below is a real SHA, verified at write
time — re-verify before trusting it, heads move.

---

## 0. Repository state (verified 2026-08-02 ~13:00 UTC)

`master` is `31e1894` (docs: owner amendment 2026-08-01 — execution order + AI
provider principle, #37). `feat/multi-device` (the tip of the still-open P1
crypto stack) is `fc26de4`. **Nothing has merged since the last brief** — the
review freeze (§4) still holds everything open.

### Every open PR, current heads

| PR | Title | Branch → base | State |
|---|---|---|---|
| **#56** | Camera Engine (AI Camera CAM-1) | `feat/camera-engine`→master | draft, `c7c8020`, **CI green (4/4)** |
| **#55** | Creative Studio (AI Camera CAM-4) | `feat/creative-studio`→master | draft, `d7ef3fa`, web-tests green, backend/e2e were still running at write time — **check before trusting** |
| #54 | Live Voice Translation platform (P2C) | `feat/live-voice-platform`→`feat/live-voice-scaffold` | draft, `4c60717`, CI green |
| #53 | AR/Snap-Camera-Kit research docs | `claude/snap-camera-kit-repos-65c88r`→master | **NOT MINE** — a separate session's PR, docs-only, out of scope; leave it alone |
| #52 | Push platform, production-hardened (P2 A) | `feat/push-platform`→`feat/push-notification-sdks` | draft, `642ed18`, CI green |
| #51 | Translation platform, completed (P2 B) | `feat/translation-abstraction`→master | draft, `839dd1e`, CI green |
| #50 | Adaptive Communication Network, production (P2 D) | `feat/adaptive-transport-scaffold`→master | draft, `a9c7b5f`, CI green |
| #49 | Live Voice scaffold (superseded by #54) | `feat/live-voice-scaffold`→master | draft, `3e6d6b7`, CI green, kept as #54's base |
| #48 | Push SDKs, packages-only | `feat/push-notification-sdks`→master | draft, `62adff1`, CI green |
| #47 | Priority 2 planning package + build report | `docs/priority-2-planning`→`docs/platform-adrs` | draft, `ed6e3e2`, CI green |
| #46 | P1 HIGH-only cleanup (H1/H2/NEW-4/B1) | `cleanup/priority-1-high`→`feat/multi-device` | draft, `13638f3`, CI green |
| #45 | P1 final review board — **verdict APPROVED** | `docs/priority-1-review`→`feat/multi-device` | draft, `57bb690`, CI green |
| #44 | P1 completion evidence (Phase 6) | `docs/priority-1-completion`→`feat/multi-device` | draft, unchanged since 08-01 |
| #43 | Multi-device safety numbers (Phase 5) | `feat/multi-device`→`feat/double-ratchet` | draft, **needs owner ratification** — the safety-number construction decision, unchanged |
| #42 | Double Ratchet, e2e_v3 (Phase 4) | `feat/double-ratchet`→`feat/x3dh-prekeys` | draft, unchanged since 08-01 |
| #41 | X3DH prekeys (Phase 3) | `feat/x3dh-prekeys`→`feat/signing-key-publication` | draft, unchanged since 08-01 |
| #40 | Platform ADRs 009–012 (planning) | `docs/platform-adrs`→master | draft, unchanged since 08-01 |
| #39 | Signing-key publication (ADR-008 Phase 2B) | `feat/signing-key-publication`→master | **NOT a draft** — ready-for-review, unchanged since 08-01 |
| #38 | Owner amendment 2 docs | `docs/owner-amendment-2`→master | draft, unchanged since 08-01 |
| #34 | Product audit docs | `docs/product-audit-2026-08-01`→master | draft, unchanged since 08-01 |
| #8 | ybot — unrelated, pre-existing | `claude/next-session-yol4aj`→master | draft, untouched this whole arc |

### Branches pushed but with NO PR open (deliberately — see §2)

| Branch | Head | What |
|---|---|---|
| `feat/ai-vision` | `3adf646` | AI Camera CAM-2 — **foundation only**, NOT reviewed, NOT gate-verified |
| `feat/ar-beauty` | `085b677` | AI Camera CAM-3 — **foundation only**, NOT reviewed, NOT gate-verified |

**Nothing is merged. Nothing should be merged without the owner's explicit
authorization** — see §4.

---

## 1. THE HARD STOP — unchanged, read before writing any crypto code

> **No production signing-key generation, persistence, publication, revocation
> transport, prekeys, X3DH, ratchet implementation, or multi-device
> implementation may begin until the publication-rollback problem in ADR-008
> §12 is resolved or separately authorized by the owner.**

Still enforced in code: `test/signing-not-shipped.test.js` fails the build if
any app module imports the signing foundation outside its fence. Also still
blocking: **what a safety number represents under multi-device** (ADR-008
§BLOCKING, four candidate constructions) — this is what #43 needs ratified.

**Extended this session, same principle:** the "seal-lift" (moving AES-GCM
seal/open above the transport, in #50's adaptive network design) and the
notification-encryption key (in #52's push platform) are BOTH new crypto-
adjacent surfaces gated the same way — implemented but held behind flags,
pending their own ADR-008 §12-style security review. Neither generates,
persists, or publishes a key today. Full detail: `91-ENGINEERING-RISK-REGISTER.md`
D1–D23 (below).

---

## 2. What happened between the last brief (08-01) and this one (08-02)

In order, each phase gated on the owner's explicit go-ahead:

1. **Priority 1 review board** (#45) — five specialist reviews folded in, every
   HIGH/CRITICAL cross-verified with a 12-axis analysis, one consolidated risk
   register, one cleanup plan. Full doc: `spotme/docs/18-PRIORITY-1-REVIEW-BOARD.md`
   on `docs/priority-1-review`.
2. **HIGH-only cleanup** (#46) — H1 (signing-key race, advisory-lock fix),
   H2 (base64 encoding canonicalization), NEW-4 (`onversionchange` IndexedDB
   handle leak), B1 (a wrong ratchet test vector). Verified via mutation
   testing, 17/17 e2e locally.
3. **Board re-verification** — an independent adversarial agent confirmed all
   7 required points; verdict flipped **APPROVED WITH FIXES → APPROVED**.
   Both #45 and #46 are sitting ready for the owner's final merge decision —
   **still not merged**, freeze holds regardless of verdict.
4. **Priority 2 planning** (#47) — five workstream design docs (push,
   translation, live voice, adaptive network, AI platform) plus cross-cutting
   synthesis. Read `spotme/docs/priority-2/00-EXECUTIVE-SUMMARY.md` first,
   then `90-IMPLEMENTATION-ORDER-AND-DEPENDENCIES.md` (phasing) and
   `91-ENGINEERING-RISK-REGISTER.md` (the D1–D23 owner-decision register —
   **this is the actual gate on activating anything built below**).
5. **Priority 2 autonomous build** — four draft PRs, additive/flag-gated:
   push SDKs (#48) → push platform completed to production (#52) →
   translation platform completed to production (#51) → live voice built to
   production (#49 scaffold → #54 platform) → adaptive network built to
   production (#50, scaffold → production in the same PR).
   Full report: `spotme/docs/priority-2/99-PRIORITY-2-BUILD-REPORT.md`.
6. **AI Camera & Creative Studio** (the newest mission, mid-flight) — see §3.

Every one of steps 1–5 ended with me independently re-running the full gate
(tests/lint/build/fence) myself before pushing — not trusting the building
agent's self-report. Same discipline applies to step 6.

---

## 3. AI Camera & Creative Studio — where this stands right now

Owner's mission: build the flagship AI Camera & Creative Studio platform,
split into 4 bounded sub-missions run as 2 waves (their own recommendation,
adopted): Wave 1 = camera engine + creative studio (disjoint); Wave 2 = AI
vision + AR/beauty (both stack on the camera engine's `FrameSource` seam).

### Wave 1 — DONE, reviewed, fixed, pushed

- **#56 Camera Engine** (`feat/camera-engine`): capture core, `FrameSource`
  seam, own FFT + phase-correlation alignment, Mertens HDR (refuses when
  there's no real exposure control), night stacking, TIER_BASIC EIS,
  negotiated video/timelapse/slow-mo/burst with an own EBML/WebM muxer.
  11 layered flags, all dark. Docs: `spotme/docs/ai-camera/*` (9 files) +
  ADR-014/014a.
- **#55 Creative Studio** (`feat/creative-studio`): non-destructive op-graph
  editor, real adjustments/looks/Telea inpainting/chroma+sky replace/2D
  relight, a from-spec WebM writer with Opus passthrough for stories/reels,
  drafts joined to the wipe path, dark D5/D1-gated cloud-AI legs behind an
  env-disabled `api/studio-ai.js`. 12 layered flags. Docs:
  `spotme/docs/ai-camera/studio*.md` + ADR-014d.
- **An independent adversarial review board** (read-only, re-ran every gate
  itself) found **2 HIGH bugs in the camera session lifecycle** (a
  late-`getUserMedia` stream leak past the open timeout; `release()` racing
  an in-flight `switchTo` and resurrecting a live camera) plus MED/LOW issues
  in both branches (a dark-stub shape-parity gap in the camera engine; an
  eager-evaluation flag-gate bug, a wrong azure provider leg, and an
  ImageBitmap leak in the studio). **All fixed by me directly** (not
  re-delegated — the weekly agent-call limit hit right as review landed),
  each with a regression test proved to fail without the fix and pass with
  it. Both branches are back to fully green (`c7c8020` / `d7ef3fa`).
- **One live integration issue, not yet resolved, needs a decision at
  wiring time:** the camera engine and the creative studio each independently
  defined an `ISegmenter` contract (portrait blur vs background replace) —
  same idea, incompatible shapes (mask type, geometry rule, registry
  lifecycle). Whoever wires activation needs to pick ONE and adapt the other.
  Full delta table is in the review board's findings (not committed as a
  standalone doc — reconstructible from the two ADRs' segmenter sections if
  needed, or re-run a review agent against both branches).

### Wave 2 — FOUNDATION ONLY, blocked, not reviewed

Two build agents (AI Vision on `feat/ai-vision`, AR & Beauty on
`feat/ar-beauty`) were launched in parallel and both died mid-build on the
**same** failure:

> `You've hit your weekly limit · resets Aug 4, 8pm (UTC)`

Each had completed and committed one solid foundation piece before dying
(vision: flags + a multi-format barcode/QR scan engine over `FrameSource`;
AR/beauty: flags + an `IFaceTracker` seam + Shape-Detection adapter + temporal
smoothing) — real work, not stubs, but nowhere near the scope their mission
briefs specified (document scanner, OCR/recognition/assistant legs, beauty
shaders, gesture classifiers, mask compositor all still unbuilt). Their
in-progress uncommitted diffs were committed as explicit `wip(...)` commits
("NOT reviewed or tested") so nothing was lost, then **pushed to origin as
plain branches — deliberately with no PR opened**, since a PR implies
reviewable/ready and this isn't. Don't open one until the work is actually
finished to the same bar as Wave 1.

**Next step, once agent calls work again (after 2026-08-04 20:00 UTC, or on a
fresh account with its own limit):** re-launch both builds from where the
committed work stops — read the existing `feat/ai-vision` / `feat/ar-beauty`
commits first so the continuation doesn't duplicate the foundation, then
finish each to the same production bar as Wave 1, run the same independent
review board over all four AI Camera branches together, fix findings, push,
open the two remaining draft PRs, then deliver the mission's 15-point report
and STOP — **the owner was explicit that no new implementation starts after
this platform's report lands.**

---

## 4. The standing freeze — what's actually blocking a merge

**Nothing merges until the owner:**
1. Accepts the Priority 1 **APPROVED** verdict (#45) and authorizes merging
   the crypto stack (#39 → #41 → #42 → #43 → #46, in that dependency order).
2. Ratifies #43's safety-number construction (the ADR-008 §BLOCKING decision).
3. Green-lights Priority 2 **activation/wiring** — everything built (#48–#56)
   ships dark behind flags; being CI-green is not the same as being wired in.
4. Rules on the two crypto-adjacent security reviews: the notification-
   encryption key (#52) and the transport seal-lift (#50) — both ADR-008
   §12-style, both currently just held behind flags pending review.
5. Answers the D1–D23 owner-decision register in
   `spotme/docs/priority-2/91-ENGINEERING-RISK-REGISTER.md` — the P0 cluster
   (D1 provider-plaintext boundary, D2 server translation cache, D3 no
   server-side plaintext index, D4 notification key ≠ "key publication",
   D5 cost-governance policy) is the real gate on translation/live-voice/AI
   shipping in a form consistent with the E2EE brand promise.

None of this is optional or assumed — if a new session is asked to merge
anything, the answer is "not yet" until it can point to the owner's explicit
word on the specific item.

---

## 5. Process notes specific to THIS handoff (account-switch aware)

- **The armed safety-net check-ins (`send_later`/Routines) do NOT transfer to
  a new account.** They're bound to this session/account. A new session
  either re-arms its own babysitting or just checks PR status directly on
  request — don't assume anything is being watched until you've re-armed it.
- **Local worktrees under `.claude/worktrees/` are container-local and
  ephemeral.** Every piece of real work this session produced was pushed to
  `origin` before the worktree was removed — if you ever find an unpushed
  worktree with commits, push the branch before doing anything else with it.
- **Weekly agent-call limit**: hit once already this session (mid Wave-2
  build), resets **2026-08-04 20:00 UTC**. If build agents fail immediately
  with a "weekly limit" error, don't retry in a loop — either wait for reset
  or do the fix/build directly without spawning a sub-agent (as was done for
  the review-board fixes above).
- **`node_modules` is not present in a fresh worktree** — symlink it from the
  main checkout (`ln -s /home/user/fable/spotme/web/node_modules
  <worktree>/spotme/web/node_modules`) before running `npm test`/`build`;
  remove the symlink before committing (a real `node_modules` must never be
  committed, and neither should a symlink to one outside the worktree).
- All prior environment traps from the 08-01 brief (proxy 403s on
  `/actions` REST paths → use `mcp__github__*` tools; stale check-runs
  caching; Playwright browser path; hash-routing navigation killing
  `page.evaluate`) are unchanged and still apply — see that section preserved
  in git history if needed (`git log -p .handoff/NEXT-SESSION.md`).

---

## 6. Standing constraints (owner-set, all still in force)

- No AGPL code or dependencies. No cryptographic primitives from scratch —
  WebCrypto/`node:crypto` only.
- Private keys never reach the server; transports never see plaintext or own
  keys (extended this session to cover the adaptive network's transport
  adapters explicitly).
- No production signing keys until the owner confirms — §1.
- No `Co-Authored-By` trailer (CLAUDE.md; `attribution.commit` unset). No
  secrets/.env in commits. Files under 500 lines; read before edit.
- Every Priority 2 feature ships **additive, flag-gated OFF, byte-identical
  when off** — proven by a fence test + a post-build dist string-scan on
  every single platform built this session, not just asserted.
- Model running this work is `claude-fable-5` / `claude-sonnet-5` /
  `claude-opus-5` depending on point in session — never put a model
  identifier in commits, PR bodies, or any file pushed to the repo.

---

## 7. UNPROVEN — do not claim these work

Carried forward from 08-01 (still true, nothing has changed them):
camera-scan-on-real-hardware, genuine multi-device, real OS key loss,
IndexedDB version-change blocking between live connections, the E2E seam
(§4 of the old brief — still designed-not-built), socket transport under
Playwright scenario 3.

New this session:
- **All of AI Camera Wave 2** (AI vision, AR/beauty) beyond the committed
  foundation pieces — not built, let alone proven.
- **GPU/CPU visual equivalence** for both the camera engine's and the
  studio's WebGL paths — no headless GPU in this environment; both ship with
  CPU-path golden tests and an honest "manual matrix" admission for the rest.
- **Real-device behavior for every AI Camera capability** — HDR/night/
  portrait/slow-mo/stabilization, the studio's inpaint/chroma/sky/relight —
  all tested against deterministic fakes, none against a real camera or a
  real browser's WebCodecs/MediaRecorder/Web Bluetooth implementation.
- **The four Priority 2 platforms' behavior once actually wired** — CI-green
  and fence-proven-dark is not the same claim as "works when a flag flips
  on"; that's what activation-guide.md in each platform's docs is for, and
  none of those steps have been executed yet.
