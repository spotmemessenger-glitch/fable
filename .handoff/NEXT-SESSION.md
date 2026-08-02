# START HERE — pickup brief

**Written:** 2026-08-01, end of the identity-sequence + E2E-foundation session.
**Supersedes** the 2026-07-31 brief entirely (PRs #2–#7 era). That text is in
git history (`git log .handoff/NEXT-SESSION.md`) and in `SESSION-*.md`; nothing
below depends on it.

**Rule that has not changed:** never claim something works because this brief
says so. The brief is a record, not a live check. Anything marked UNPROVEN
stays unproven until re-run. Every number below says where it was measured.

---

## 0. Repository state (verified 2026-08-01 ~16:10 UTC)

```
master  fb02b99   feat(web): signing-key storage per ADR-008 (#36)
        43fce9e  feat(web): send enforcement, computed always and switched off (A5) (#31)
        d29c1b6  test(web): mechanise the A5 device matrix, and fix the race it found (#30)
        7f78a11  docs: roadmap V2 controlling + V1→V2 mapping (#35)
        f9a5af8  docs(handoff): rewrite the pickup brief for the post-#29 state (#33)
        a934e11  feat(web): a signing identity, and bindings that prove possession (A7) (#29)
```

Measured on post-#36 `master` in this container: **web 936/936**, lint clean,
build clean; backend 13 suites / 121 tests (in CI); **e2e 15/15** (in CI).

### Merged this session, newest first

| PR | What | Merge SHA |
|---|---|---|
| #36 | ADR-008 signing-key **storage** (publication still design-only) | `fb02b99` |
| #31 | A5 enforcement — verdict always computed, flag **OFF** | `43fce9e` |
| #30 | A5 matrix mechanised + `loadIdentity` race fix | `d29c1b6` |
| #35 | Roadmap V2 controlling + V1→V2 mapping | `7f78a11` |
| #33 | Handoff rewrite (the pre-V2 edition of this file) | `f9a5af8` |
| #29 | A7 signing foundation + six review revisions | `a934e11` |
| #32 | Playwright E2E foundation + warm-build fix | `ad36a37` |
| #28 | QR scanner wired into verify screen | `8fc603b` |
| #27 | A6a availability axis | `6f0fd15` |
| #26 | A4 scanned code bound before believed | `0fa467b` |
| #25 | A2+A3 propose-never-adopt | `a7235d1` |
| #24 | A1 trust state machine | `08e3c0a` |
| #23 | MinIO in CI + R2 smoke test | `8f3cebc` |

#30/#31/#36 were merged on the owner's explicit 2026-08-01 approval ("Approve
#30, #31, and #36 — those are all foundational security work"), each only
after GitHub CI ran green **on its exact head** and the displayed diff showed
only its own files. #31 and #36 were rebuilt onto master first (§5's
`checkout -B` + cherry-pick discipline; #36's two conflicts resolved as a
union — every test suite kept, `wipeDevice` keeps `clearedTrust` +
`clearedSigning` + all three `dropDatabase` calls).

### Open PRs

| PR | Branch | State |
|---|---|---|
| **#34** product audit (draft) | `docs/product-audit-2026-08-01` | voice-cloning + translation-provider corrections pushed; awaiting owner review |
| **#53** AR/reference docs (draft) | `claude/snap-camera-kit-repos-65c88r` | Camera Kit was installed in `ysnap`, then **reverted on owner instruction**. Now **docs-only**. See below |
| governance amendment | `docs/execution-order-2026-08-01` | the PR carrying this very edit + the roadmap "Owner Amendment" + CLAUDE.md pointer |

For A5: enforcement stays default-OFF, and **disabling the flag — not
reverting — is the supported operational rollback** (ADR-007 §Rollback says
why: reverting removes the review UI and strands a `Changed` peer).

### AR platforms — reference only, NOT scheduled

`spotme/docs/15-AR-PLATFORM-REFERENCE.md` records every AR camera platform
evaluated: Snap Camera Kit (versions, Maven/SPM coordinates, credentials,
measured sizes, environment traps) and Meta/Spark AR. **AR is in no roadmap
priority and no owner execution order** — the record exists so an evaluation
would not start cold, and so the closed options are not re-investigated.

**Meta / Spark AR is a dead end — do not spend time on it.** Meta shut the
platform down on 2025-01-14; third-party effects were pulled from Facebook,
Instagram and Messenger and the Studio/Hub/Player are gone. `sparkar-pftween`
installs from npm but `require`s Spark sandbox modules (`Reactive`, `Scene`,
`Time`…) that resolve nowhere, so it throws on import; `juanmv94/Spark-AR` is
468 MB with **no licence at all** (all rights reserved — not ours to vendor).
Snap Camera Kit is the only live vendor path of those examined.

`spotme/docs/16-EXTERNAL-CODE-REFERENCES.md` is the register of third-party
codebases examined for reference (not dependencies, none vendored). Standing
rule recorded there: **no licence file = all rights reserved = read it, then
write our own** — never paste or vendor. First entry,
`kumarharsh13/instagram-clone-fullstack`: no licence; its follow/like/comment
schema is a fair shape reference for Priority 7 and nothing else; **its
advertised chat does not exist** (`chatRoutes.js` is 0 bytes, `socket` is never
imported), and its `notification` model is in-app DB rows, not push.

Second entry, `TowhidKashem/snapchat-clone`: **MIT** (the first one we may
legally borrow from), genuine, 1.1k stars, but a 2020 stack (React 16, CRA,
Enzyme, node-sass) and frontend-only — a UI reference, not a base. Its
`postinstall` auto-clones a second repo **over SSH**, so `npm install` fails
without keys. **The lead worth chasing is `jeeliz/jeelizFaceFilter`**
(Apache-2.0, 2.9k stars, maintained): client-side WebGL face filters that may
give the AR capability Camera Kit was wanted for, without a vendor backend —
the exact objection that got Camera Kit reverted. UNVERIFIED whether it is
truly offline-only, and whether the licence covers the model weights.

Three things that will otherwise be re-learned the hard way:

- **Nothing is installed today.** The web SDK briefly went into `ysnap` (the
  only React host) and was reverted; `ysnap`'s manifests are byte-identical to
  `origin/master`. **It must not be added to `spotme/` without owner sign-off** —
  a camera SDK that speaks gRPC-web to Snap's backend inside an E2EE messenger
  is a §7 integration review, not a dependency bump.
- `dl.google.com` is **proxy-blocked** here, so an Android Camera Kit resolve
  can only be verified with `transitive = false`. The Snap AARs themselves are
  on Maven Central and fetch fine (main AAR **47.4 MB**).
- `camera-kit-reference` is a **1.3 GB** clone at `--depth 1`. Never vendor it.

Discovered while checking that PR: **`ysnap` has no automated coverage at
all.** CI runs only `spotme/backend`, `spotme/web`, `spotme/e2e`, and the one
Vercel project (`spotme-messenger`) has root directory `spotme/web` — the
`-ysnap` in its preview URL is the Vercel *team* slug, not the directory. A
green PR proves nothing about `ysnap`; build it by hand or it is unverified.

### Untouched / blocked (standing)

- **#8 (ybot)** untouched. **Railway deployment blocked.** **Priorities 2 and 3
  blocked.**
- `r2-staging` GitHub environment (required reviewers + R2_* secrets) is
  owner-only work; the proxy blocks the environments API from here.
- Stage B of the S3 plan blocked.

---

## 1. THE HARD STOP — read before writing any crypto code

> **No production signing-key generation, persistence, publication, revocation
> transport, prekeys, X3DH, ratchet implementation, or multi-device
> implementation may begin until the publication-rollback problem in ADR-008
> §12 is resolved or separately authorized by the owner.**

ADR-008 §12, short form: before a key is published, rollback is free; after,
reverting the client leaves a signing key on the server that peers may have
pinned, and withdraw-vs-leave-inert needs a server-side key lifecycle that does
not exist. A rollback plan that cannot be executed is not a rollback plan.

Enforced in code today: `test/signing-not-shipped.test.js` fails the build if
any app module imports the signing foundation, names the generator, or
references a signing-key field.

Also blocking, recorded in ADR-008 §BLOCKING: **what a safety number represents
under multi-device** (four candidate constructions). Must be decided before
multi-device implementation, not during.

---

## 2. Governance

**2026-08-01, later: the owner supplied `MASTER-ENGINEERING-ROADMAP-V2.md`**
(committed under `spotme/docs/` with the source .docx) and ordered it consulted
on every coding change — CLAUDE.md now points at it. Its V1→V2 mapping
(`14-ROADMAP-V1-TO-V2-MAPPING.md`) was **APPROVED by owner directive
2026-08-01** — V2 is controlling; V1 is historical; stricter gate still wins
(V2 Appendix B). **Execution order AMENDED by the owner 2026-08-01** (recorded
in the roadmap's "Owner Amendment" section — read that, not the superseded
phase list): #30/#31/#36 were approved and merged, and the strategic order is
now ① push notifications (Android+iOS, background/terminated/foreground,
production-grade) → ② translation platform (provider abstraction over the
existing multi-provider engine in `web/api/translate.js`) → ③ live voice
translation (flagship; dedicated architecture, NOT a voice-notes extension;
MVP < 2.5 s) → ④ adaptive communication layer (automatic transport switching
incl. native Bluetooth offline) → ⑤ remaining Priority 1 crypto (X3DH →
Double Ratchet → multi-device → completion evidence), which **remains
mandatory before Priority 1 is declared complete**. AI Communication ADRs:
planning may proceed. New standing principle: every AI feature optimises
accuracy + latency + privacy simultaneously; no hard provider dependency.
ADR-008 §12 is UNCHANGED by the amendment. **V1/V2 priority numbers differ —
the mapping
§1 restates every standing owner block under V2 numbering; renumbering never
unblocks.** Our A1–A7 / B1–B10 labels remain an implementation breakdown only.
Priority 1 completes only when every requirement and checklist item passes.

Priority 1 checklist, honestly, as of this write:

| Item | State |
|---|---|
| Compile / lint / unit / integration / no regressions / docs | ✅ |
| End-to-end tests | ✅ foundation + scenario 1 in CI; **scenarios 2–12 open** |
| Rollback documented | ✅ ADR-005/006/007/008 |
| Web type checking | ❌ plan approved (tsconfig `allowJs`+`checkJs`, JSDoc on crypto modules, `tsc --noEmit` in CI, must fail on a deliberate error) — not built |
| Identity benchmarks | ❌ scope defined by owner (pin-store r/w, concurrent observations, verification persistence, Changed resolution, startup, 100s–1000s of peers, A5 gate overhead on/off) |
| Formal security review | ❌ owner wants a dedicated adversarial report (silent substitution, decrypt-refetch, TOFU limits, stale verification, replay, cross-device binding, wipe, key export, IndexedDB tampering, flag bypass, rollback risks) — self-review + mutation testing is evidence, not the report |
| Performance review | ❌ |
| Secure key storage | **storage half implemented + merged (#36)** — `spotme-signing` DB, promise-cached load, write-then-read-back, UNREADABLE≠absent, explicit-only rotation, wipe integration; publication + rollback-after-publication remain design-only (§1 / ADR-008 §12, the second Phase 2 PR) |
| Prekeys / X3DH / Double Ratchet / FS / break-in recovery / rotation | ❌ blocked by §1 |
| Multi-device | ❌ blocked by §1 + the safety-number question; minimum spec is **normative in ADR-006** (9 points; backup/history/restore deferrable if documented, core crypto flow not) |
| Manual device matrix | ❌ owner executes; the automatable rows are #30 |

---

## 3. Next work — the owner's AMENDED order (2026-08-01)

The pre-amendment queue (E2E seam next, then scenarios 2–12) is
**re-sequenced, not cancelled**. The strategic order is now:

1. **① Push notifications** — Android AND iOS; background/terminated/
   foreground; messages, calls, mentions, group events, stories;
   production-grade delivery. Starting point: web-push/VAPID and Android FCM
   are live; **iOS APNs is a dead dep** (`@parse/node-apn` installed, 0
   imports) and needs Apple Developer/APNs credentials from the owner.
2. **② Translation platform** — formal provider abstraction over the
   existing multi-provider engine (`web/api/translate.js`: Google Cloud v2,
   Azure v3, Sarvam, Gemini leg + Anthropic/Gemini/OpenAI LLM chain);
   dynamic best-provider by language pair/latency/quality/availability;
   conversation context; quality metrics, fallback, retries, caching,
   observability.
3. **③ Live voice translation** — flagship; DEDICATED architecture (owner:
   "Do not treat this as an extension of voice notes"); capture → streaming
   STT → incremental translation → streaming TTS → voice preservation;
   MVP < 2.5 s end-to-end, production target < 1 s.
4. **④ Adaptive communication layer** — flagship; Socket.IO, Centrifugo,
   P2P, native Bluetooth offline messaging; automatic transport switching
   ("Users should never manually select a transport"); offline sync; future
   Wi-Fi Direct/mesh.
5. **⑤ Remaining Priority 1 crypto** — X3DH → Double Ratchet → multi-device
   → completion evidence. **Still mandatory before Priority 1 is declared
   complete**; the §1 hard stop governs when this begins.

The approved E2E seam design (§4) and scenarios 2–12 stay valid and fold
into the completion-evidence phase (or earlier if the owner pulls them
forward). Do NOT mix into any feature PR: A5 activation, signing-key
publication, revocation transport, prekeys, X3DH, ratchet code,
multi-device.

---

## 4. The E2E seam — APPROVED design (build exactly this)

Purpose, narrow: *"for E2E fixture account X, the next
`GET /api/v2/auth/keys/:userId` returns this controlled alternate public
key."* One-shot, one account, public keys only. Needed by scenario 7.

### Gates and controls (all owner-approved, all required)

- `NODE_ENV=test` **AND** `SPOTME_E2E_CONTROL=1` — either alone does nothing.
- **Production boot FAILS** if `SPOTME_E2E_CONTROL` is set while
  `NODE_ENV !== 'test'` (same pattern as the existing JWT-length boot guard in
  `backend/src/main.ts`).
- Namespace **`/__e2e/`** — outside `/api`, never confusable with product
  surface.
- Loopback binding — **defense in depth only, not the security boundary**
  (owner: CI container networking makes loopback ambiguous).
- **Per-run random token**, generated by the Playwright config, passed via
  env; **constant-time comparison** (`crypto.timingSafeEqual` with a length
  pre-check).
- **Fixture/run ownership**: allowlisted fixture-account prefix / run id;
  reject if the target account is not owned by the current E2E run.
- **Short expiry** (~60s), **one successful use only**.
- **In-memory only**; cleared on process restart; never persisted to
  PostgreSQL, Redis, files, logs, or application caches; never logged.
- **No read endpoint.** Accepts a public key + fixture id, returns an
  acknowledgement only. It cannot read or return private key material.

### The path stays real (owner refinement 2)

The seam substitutes **only the public-key value at the final serialization
boundary** of the keys route. It must NOT bypass: authentication, account
lookup, authorization, normal route handling, response serialization, client
fetch logic, socket transport, `identity-store.js`, `rooms.js`. The test is
valuable only because everything around the substituted value is production
code.

### Forbidden (owner-listed)

No general DB mutation endpoint. No hidden query parameter on production APIs.
No Playwright IndexedDB edits for scenario 7. No mocking of `rooms.js`,
`identity-store.js`, or the transport. Not reachable in previews or Railway.
No separate compile-time build shape (owner: runtime gates + absence tests are
better than maintaining a second build).

### The 12 seam tests (all required)

1. Missing token → rejected
2. Wrong token → rejected
3. Wrong run/account prefix → rejected
4. Invalid public-key encoding → rejected
5. Oversized body → rejected
6. Override applies once only
7. Override expires unused
8. Restart clears it
9. A second E2E run cannot consume the first run's override
10. No key value or token appears in logs
11. Endpoint absent (404) in production mode
12. Boot fails when the flag is set outside `NODE_ENV=test`

### Scenarios 2–12 (owner-scoped)

Conversation create/open · **real two-context send/receive over the socket
path** (sender sees sent; recipient receives via socket; reload preserves;
reconnect does not duplicate; contexts isolated) · reload/history · offline/
reconnect · first-key pinning · different-key proposal (via the seam; 8 proofs:
initial key trusted → server returns different key → original pin unchanged →
proposal raised → warning/review UI appears → send behaviour matches flag state
→ reload preserves pin AND proposal → restoring the original server key does
NOT silently clear Changed) · verification persists across reload · A5
flag-off behaviour · **device wipe deletes localStorage + `spotme-e2e` +
media/blob IndexedDB + `spotme-identity-pins`, and a store that cannot be
cleared surfaces a failure to the user** (`wipeDevice` returns
`{ ok, failures }` — assert both paths) · unauthorized room access rejected ·
log/secret hygiene (harness already exists in
`spotme/e2e/tests/log-hygiene.spec.js`).

---

## 5. Process guidance — learned the hard way this session

### The squash-merge stacked-rebase trap (this happened today)

After #29 squash-merged, `git rebase origin/master` on the stacked #30
**conflicted with its own parent's content** — the four A7 commits were now in
master as one squash. Worse: commands were chained with `;`, so
`git push --force-with-lease` ran on a conflicted tree and **briefly pushed an
invalid state**. A second `;`-chain then made a `cd` failure read as a passing
test run (`exit=0` was the failed `cd`, not the suite).

**Recovery that works:** `git checkout -B <branch> origin/master` then
`git cherry-pick <only its own commits>`. Verify, then push.

**Rules, permanent:**

- `set -euo pipefail`, or chain **only** with `&&`. Never `;` between
  a mutation and its verification.
- Before EVERY push: `git status --short` (clean?) →
  `git merge-base HEAD origin/master` (expected base?) →
  `git diff --stat origin/master...HEAD` (only intended files?) →
  `npm test` (exit code checked on its own line).
- After every push: verify **GitHub's displayed file list**, not just the
  local three-dot diff. (Standing owner rule since the PR #2 era.)
- **GitHub CI is the final authority before any merge — never local runs.**

### Environment traps (all hit and verified this session)

- `curl` to `api.github.com` `/actions` paths → **403 via the proxy**. Use the
  GitHub MCP tools (`mcp__github__*`); they work.
- The check-runs endpoint **served stale `in_progress` ~10 min after a job
  finished** (once). Before diagnosing a "hung" job, re-fetch;
  `actions_get get_workflow_job` was accurate when the check-runs list was not.
- Playwright in this sandbox: the pinned browser needs
  `E2E_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. CI
  installs its own (`playwright install --with-deps chromium`) and must NOT
  set `E2E_CHROMIUM`. Do not run `playwright install` locally.
- `reuseExistingServer: !CI` means a **stale local backend** (`pkill -f
  "dist/main.js"`) will be reused — the build-identity spec then fails,
  *correctly*. Kill stale backends before local e2e runs.
- The web app uses **hash routing** and assigns `location.hash` during boot —
  a navigation that kills in-flight `page.evaluate`. Use the `booted(page)`
  helper in `spotme/e2e/tests/foundation.spec.js`; never inspect the page
  before it.
- Local stack bring-up (verified): `service postgresql start` →
  `su postgres -c "createdb spotme_e2e"` → backend env `DATABASE_URL`,
  `JWT_ACCESS_SECRET` (**≥32 chars or it refuses to boot — keep that guard**),
  `PORT`. Guest accounts: `POST /api/auth/guest` with client-chosen
  `{id: hex 8-64, username: /^[a-z0-9_]{3,16}$/, secret: ≥8}` — this is what
  makes `spotme/e2e/lib/accounts.js` deterministic.
- The backend warm-build bug (emit-nothing-exit-0) is fixed
  (`tsBuildInfoFile` inside `dist/`) and regression-tested as its own CI step.
  `dist/BUILD_ID` is a **source** hash served at `GET /api/version`; the e2e
  suite fails if the running process does not report the current source's id.

---

## 6. Map of the identity code

| Module | Role | Where |
|---|---|---|
| `web/src/lib/crypto/e2e-v2.js` | X25519/P-256 ECDH → HKDF → AES-GCM room keys | master |
| `…/identity-pin.js` | pure five-state trust machine (Unverified·Pinned·Verified·Changed·Revoked) | master |
| `…/identity-pin-store.js` | its own DB `spotme-identity-pins`; refused transition ABORTS | master |
| `…/identity-availability.js` | server axis only; structurally cannot touch trust | master |
| `…/identity-store.js` | device identity; pin seeded from local, never fetch; `loadIdentity` caches the **promise** (race fix in #30) | master (+#30 fix) |
| `…/safety-number.js` | 60 digits; v2 QR payload binds room+time+version before digits | master |
| `…/signing-identity.js` | Ed25519/P-256 signing, canonical `transcript()` (normative, ADR-006 §3a/3b), runtime non-extractability | master |
| `…/identity-binding.js` | claim + signature + DH proof-of-possession; HISTORICAL vs LIVE results are **typed**, `requireLiveAuthentication` throws on the weaker; unknown trust fails **closed** | master |
| `…/identity-enforcement.js` | A5 send verdicts, always computed, flag OFF | **#31 only** |
| `web/src/lib/qr-scan.js` | native BarcodeDetector, lazy jsQR fallback | master |
| `spotme/e2e/` | Playwright foundation, 15/15 | master |

ADRs: 005 (pinning), 006 (signing + normative claim fields + multi-device
minimum), 007 (**#31 branch only** until merged), 008 (storage design +
§12 hard stop + §BLOCKING multi-device safety numbers).

Deliberate asymmetry a reviewer WILL flag: `identity-binding.js` fails
**closed** on unknown trust; `identity-enforcement.js` fails **open** on an
unreadable pin store. Different questions — "should I START trusting this
claim" vs "may I send to a peer I already trust (message still goes to the
pinned key)". Both headers cross-reference. Keep them doing so.

---

## 7. Standing constraints (owner-set, all still in force)

- No AGPL code or dependencies (lockfile is the audit trail: jsqr
  Apache-2.0, qrcode-generator MIT).
- No cryptographic primitives from scratch — WebCrypto only.
- Private keys never reach the server; non-extractable everywhere.
- **No production signing keys** until the owner confirms — see §1.
- ADR-008 §6: there is **no backup and no recovery** for the signing key;
  the eventual UI must warn before key creation and before destructive local
  actions, and must never imply account recovery restores identity trust.
- R2 credentials: rotated, least-privilege, GitHub-secrets only, one isolated
  bucket/prefix, unique object names, delete after, never in memory/chat/
  code/logs/PR text, never connected to production.
- A `Changed` peer gets NO "dismiss" — verify, accept, or reject only.
- CLAUDE.md: files under 500 lines; read before edit; no Co-Authored-By; never
  commit secrets; `.handoff/` updated and committed at session end.

---

## 8. UNPROVEN — do not claim these work

- The camera scan path on real hardware (no phone in any session yet).
- Genuine multi-device, real OS key loss, IndexedDB version-change blocking
  between live connections — the manual matrix rows (#30 prints them every run).
- The E2E seam: **designed, approved, not built.**
- Socket transport under Playwright (scenario 3): expected to work, never run.
- The A5 gate in `rooms.js` under enforcement ON: covered by decision tests +
  a source tripwire; the tripwire cannot catch a present-but-wrong gate.
  Scenario 9 / the manual matrix close this.
