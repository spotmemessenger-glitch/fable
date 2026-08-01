# START HERE — pickup brief

**Written:** 2026-08-01, end of the identity-sequence + E2E-foundation session.
**Supersedes** the 2026-07-31 brief entirely (PRs #2–#7 era). That text is in
git history (`git log .handoff/NEXT-SESSION.md`) and in `SESSION-*.md`; nothing
below depends on it.

**Rule that has not changed:** never claim something works because this brief
says so. The brief is a record, not a live check. Anything marked UNPROVEN
stays unproven until re-run. Every number below says where it was measured.

---

## 0. Repository state (verified 2026-08-01 ~15:00 UTC)

```
master  a934e11  feat(web): a signing identity, and bindings that prove possession (A7) (#29)
        ad36a37  test(e2e): Playwright foundation, and the silent backend build it uncovered (#32)
        8fc603b  feat(web): wire the QR scanner into the verify screen (#28)
```

Measured on `master` in this container: **web 833/833**, backend 13 suites /
121 tests (in CI), **e2e 15/15** (local + CI).

### Merged this session, newest first

| PR | What | Merge SHA |
|---|---|---|
| #29 | A7 signing foundation + six review revisions | `a934e11` |
| #32 | Playwright E2E foundation + warm-build fix | `ad36a37` |
| #28 | QR scanner wired into verify screen | `8fc603b` |
| #27 | A6a availability axis | `6f0fd15` |
| #26 | A4 scanned code bound before believed | `0fa467b` |
| #25 | A2+A3 propose-never-adopt | `a7235d1` |
| #24 | A1 trust state machine | `08e3c0a` |
| #23 | MinIO in CI + R2 smoke test | `8f3cebc` |

### Open PRs

| PR | Branch | Base | Own files | Local suite | CI |
|---|---|---|---|---|---|
| **#30** A5 device matrix | `feat/a5-matrix` @ `3c9dbc1` | `master` | 5 | 864/864 | confirm green before review |
| **#31** A5 enforcement, flag **OFF** | `feat/a5-enforcement` @ `3884db3` | `feat/a5-matrix` | 8 (12 vs master — `package.json` is shared with #30) | 912/912, lint+build clean | confirm green before review |

Both are **held for independent owner review**. Do not infer either is safe
from the stacked tip passing — the owner said so explicitly.

**#31 RULE (owner-set):** while stacked on #30, its displayed diff vs its base
branch is its own 8 files. **After #30 squash-merges, #31 MUST be rebuilt**
(reset to `origin/master`, cherry-pick only its own two commits) so GitHub's
displayed diff shows ONLY those 8 files against master. **Do not merge #31
while its displayed diff includes #30's files.**

For #30/A5: enforcement stays default-OFF, and **disabling the flag — not
reverting — is the supported operational rollback** (ADR-007 §Rollback says
why: reverting removes the review UI and strands a `Changed` peer).

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
(`14-ROADMAP-V1-TO-V2-MAPPING.md`) is **awaiting owner approval**; until then
the V1 plan (preserved as `MIGRATION-PLAN-V1.md`) still governs, stricter gate
wins either way (V2 Appendix B). **V1/V2 priority numbers differ — the mapping
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
| Secure key storage | design done (ADR-008), **implementation blocked by §1** |
| Prekeys / X3DH / Double Ratchet / FS / break-in recovery / rotation | ❌ blocked by §1 |
| Multi-device | ❌ blocked by §1 + the safety-number question; minimum spec is **normative in ADR-006** (9 points; backup/history/restore deferrable if documented, core crypto flow not) |
| Manual device matrix | ❌ owner executes; the automatable rows are #30 |

---

## 3. Next work, in the owner's stated order

1. **Confirm #30's CI green** (its run was still reporting at write time).
2. Handoff updated ← this file.
3. Fresh session starts here.
4. **Build the E2E test seam** in a new isolated PR — full design in §4.
   Present the seam design in the PR description before merge.
5. **Add E2E scenarios 2–12** (same PR as the seam per the owner's scope:
   "tests, fixtures, and the minimal test-only seam").
6. Run complete backend, web, lint, build, and E2E CI.
7. **Prove the seam is absent in a production-mode startup.**
8. Return the PR for review before merge.
9. Review #30 and #31 independently after their CI is green (owner does this;
   #31 needs a scope/dependency summary from us — the owner said the update
   they had "does not provide enough detail to authorize it").

Do NOT mix into the E2E PR: A5 activation, signing-key persistence,
publication, revocation transport, prekeys, X3DH, ratchet code, multi-device.

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
