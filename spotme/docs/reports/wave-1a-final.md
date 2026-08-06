# Wave 1A — Production Readiness — FINAL REPORT

**Programme:** Activation Programme, Wave 1A. **No activation, no user-facing
change; ends at a STOP.** Target: Railway `spotme-backend` / `production` /
`api` (backed by the `postgis` service).
**Branch:** `feat/activation-wave-1a` (base: Wave-0 merge). Run date 2026-08-05 (UTC).

> Aggregate metadata only throughout — versions, counts, durations, HTTP codes,
> error classes. No connection URL, host, or credential value appears here or in
> any harness output/log.

### Disposition — summary by rung

| Rung | Outcome |
|---|---|
| R1 Land Wave 0 | ✅ **MERGED** — merge SHA `ac7f8816` |
| R2 Queue runtime | ✅ **CLOSED — 8/8 PASS** (remedy (c), owner-directed): in-project **`valkey`** service (Valkey 8.1.9, `asia-southeast1`, AOF on volume, password-auth, private network); `api.REDIS_URL` → `${{valkey.REDIS_URL}}` reference; **`server_mode:standalone`** verified from INFO; the full unmodified acceptance suite passed **8/8** in-network (§R2 Resolution). Both Dragonfly datastores parked untouched. |
| R3 Dependencies | ✅ **0 high / 0 critical** (was 5 high); 15 moderates documented |
| R4 #115 CI failure | ✅ **REAL, root-caused, fixed** — CI now applies migrations (prod parity); master green |
| R5 Region | ✅ **MOVED to Southeast Asia** — before/after per dependency (§R5); **postgis co-location is the follow-up** |
| R6 Firebase key | ⚠️ **UNDER-RESTRICTED** (report-only, no rotation) — §R6 |
| R7 Kill-switch | ✅ **BUILT + PROVEN** — one-row flip, fail-dark, **measured rollback 4,994 ms** (bar 60 s) |

---

## R1 — Wave 0 landed

PR #116 taken out of draft after CI went green and **merged to `master`**.

- **Merge SHA: `ac7f8816`** (`Wave 0 — infra validation harness, health/ready, ops docs (#116)`)
- Master now contains `/health`, `/ready`, the 4-leg validation harness, the ops
  docs (`WAVE-0-VALIDATION.md`, `DEPLOYMENT.md`), and the R4 CI fix below.
- All checks green pre-merge: backend (tests/typecheck/build), web, e2e,
  compose, secret-scan.

## R2 — Dragonfly queue remediation — **evidence complete; endpoint change is owner-only**

**Why this rung exists:** Dragonfly Cloud runs `redis_mode=cluster`; BullMQ
workers **do not process** reliably against it. Wave 1C cannot activate any
queue-backed feature until this is resolved.

**Topology (in-network probe):** `redis_mode=cluster`, redis_version 7.4.0,
**1 slot range / 1 advertised node** (single shard), and the advertised node
address does **not** match the public endpoint (`advertisedMatchesEndpoint=false`
— a cluster client requires host-pinning, which the evaluation harness did).

**Evaluation:** the committed `wave1a` harness ran the mission's 8 acceptance
checks **in-network against the real Dragonfly** for BOTH remedies:

| # | Acceptance check | (a) standalone client | (a′) cluster client |
|---|---|---|---|
| 1 | enqueue → process → ack | ❌ Lua `undeclared key` — **intermittent** (passed on a later single run) | ✅ 1,018 ms |
| 2 | real job via committed `MaintenanceQueue` path | — (not reached) | ✅ 1,087 ms |
| 3 | delayed job fires on schedule | — | ❌ Lua `undeclared key` (`…:{q}:1`) |
| 4 | retry per backoff policy | — | ❌ timeout 25 s (internal move ops hit the same class) |
| 5 | dead-letter: exhausted retries in failed set, inspectable | — | ❌ Lua `undeclared key` (`…:failed`) |
| 6 | repeatable fires ≥ twice | — | ❌ Lua `undeclared key` (`…:repeat:…`) |
| 7 | recovery after worker crash (no loss) | — | ✅ 6/6 jobs, 0 lost, 3,438 ms |
| 8 | concurrency: no double-processing | — | ✅ 12/12 distinct, 0 doubles |

**Best case is 4/8.** The four failures (delayed, retry, DLQ, repeatable) are
exactly the properties the owner flagged as where cluster mode bites, and they
fail **inside Dragonfly's strict cluster-mode Lua key enforcement** — BullMQ's
internal scripts access computed keys (`…:1:dependencies`, `…:failed`,
`…:repeat:…`) that cluster mode rejects as undeclared. **No client-side change
fixes this**; the standalone basic path even passing *intermittently* (one run
in three) makes it worse: a queue that sometimes processes is not
production-grade infrastructure.

**Decision: remedy (b) — a single-shard / NON-cluster Dragonfly endpoint.**
On a non-cluster runtime the existing standalone `createRedisConnection` and the
committed hash-tagged queue names work unchanged (CI's standalone Valkey proves
the code path: the queue integration spec passes there).

**Exact owner steps (Dragonfly Cloud dashboard):**
1. Log in at the Dragonfly Cloud console → select the datastore behind
   `REDIS_URL`.
2. Check its configuration for **“Cluster mode”** (Dragonfly Cloud calls this
   *Cluster* / *emulated cluster* on some plans). If it can be disabled in
   place, disable it and save (the endpoint stays the same).
3. If cluster mode cannot be toggled on the existing datastore: **create a new
   datastore with cluster mode OFF** (same region — it is your APAC/Hyderabad
   one), then update `api.REDIS_URL` to the new datastore's `rediss://` URI
   (Railway → `spotme-backend` / `production` / `api` → Variables). You paste
   the value; per standing rules this harness never handles the credential.
4. Reply “redis endpoint switched” — the 8-item acceptance suite is committed
   (`src/scripts/wave1a/`) and re-runs as-is; **all 8 must pass before Wave 1B/1C
   activates any queue worker.**
5. Keep the old datastore until the acceptance passes (instant rollback path).

**Constraint honoured:** production `createRedisConnection` was **not** changed
in this wave — under remedy (b) it is already correct.

### R2 re-run (2026-08-05, after the owner's endpoint switch) — **NOT 8/8: still 0/8; the NEW datastore also runs cluster mode**

The owner provisioned a new Dragonfly Cloud datastore (GCP `asia-southeast1`,
intended cluster-mode OFF, TLS) and repointed `api.REDIS_URL`. The committed
acceptance suite re-ran in-network (boot-runner, reverted after):

| Evidence | Value |
|---|---|
| Variable switch took effect | ✅ **yes** — in-network PING from the Singapore api is now **47.95 ms** (the old Iowa datastore measured 468–1,087 ms from the same vantage points). `REDIS_URL` parses clean (`rediss://`, credential present). |
| Runtime mode reported by the NEW datastore | ❌ **`redis_mode: cluster`** (INFO, in-network; `CLUSTER SLOTS` answers with 1 range / 1 node advertising a non-public address) |
| Acceptance | ❌ **0/8** — check 1 (enqueue→process→ack) fails immediately with the same class of error as before: BullMQ Lua rejected by strict cluster-mode key enforcement (`script tried accessing undeclared key, key: bull:{wave1a-rt}:1`); the wave0 leg confirms enqueue succeeds and the Worker consume path never completes (12 s timeout). |

**Conclusion: the "cluster mode OFF" setting did not take effect on the new
datastore** — the runtime still answers as an (emulated) cluster, and BullMQ
cannot pass acceptance against any runtime that reports `redis_mode: cluster`.
The latency goal of the move was achieved (47.95 ms, ~10–20× better); the mode
goal was not.

**Owner options, in order of recommendation:**

1. **(b′) Make the new datastore actually non-cluster.** In Dragonfly Cloud,
   open the new datastore's configuration and verify its cluster-mode setting;
   if the console shows it off yet the runtime still reports cluster, that is a
   Dragonfly Cloud provisioning question — ask their support for a datastore
   whose `INFO` reports **`redis_mode: standalone`**. That single line is the
   acceptance precondition; the suite re-runs unchanged once it reads
   standalone.
2. **(c) Provision the queue runtime in-project instead:** a Railway
   **Valkey 8** service in this project/environment (standalone by definition,
   private-network, sub-ms from the api, no egress). CI already proves the
   exact production queue code green against standalone Valkey 8 — this is the
   zero-unknowns path, and Dragonfly Cloud can stay for any future cache use.
   This follows the Wave-0 postgis playbook (new service + `api.REDIS_URL`
   repoint via reference; the Dragonfly datastores stay parked as fallback).

**Wave 1A therefore remains open on R2 only.** Everything else in the wave is
closed; no queue-backed activation may proceed until the acceptance suite
reports **8/8** against a runtime whose INFO says the server runs standalone.

### R2 RESOLUTION (2026-08-05, remedy (c) adopted by owner directive) — **8/8 PASS. Wave 1A fully closed.**

Under the owner's narrow authorization, the queue runtime moved **in-project**:

**Provisioning (the postgis playbook, applied to Valkey):**

| Item | Value |
|---|---|
| Service | **`valkey`** — new service in `spotme-backend` / `production`, image `valkey/valkey:8` (runs **Valkey 8.1.9**) |
| Region | `asia-southeast1` (same as `api`) |
| Volume | `valkey-volume` mounted at `/data` |
| Persistence | **AOF on** (`--appendonly yes --dir /data`; log-verified: AOF base+incr load on restart) |
| Auth | `--requirepass` from a self-generated 43-char password stored only as a `valkey` service variable (**never printed/committed/reported**). One fix along the way: Railway does not shell-interpolate a bare start command, so the server briefly ran with a literal `$VALKEY_PASSWORD` (caught as `WRONGPASS` by the first acceptance attempt); wrapped in `sh -c '…'` and redeployed — the failure and fix are both recorded here deliberately. |
| Wiring | `valkey.REDIS_URL` = `redis://default:${{VALKEY_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:6379`; **`api.REDIS_URL` = `${{valkey.REDIS_URL}}`** (variable **reference**, the authorized single-variable exemption — no literal credential ever entered the api config) |
| Dragonfly datastores | **Both parked, untouched** — neither the Iowa cluster datastore nor the new asia-southeast1 datastore was modified, redeployed, renamed, or deleted; the only change on the api side was the `REDIS_URL` reference above. Instant rollback = point `REDIS_URL` back. |

**Verification (all in-network, on the deployed api):**

- **`/ready` → `200` `{db:up, redis:up}`** against the new endpoint.
- **Active endpoint is the valkey service:** api's resolved `REDIS_URL` is a
  `redis://…@….railway.internal:6379` reference (private network), and the
  runtime identifies as Valkey — not Dragonfly.
- **Standalone mode, verbatim INFO evidence:**
  `valkey_version:8.1.9` · `redis_version:7.2.4` (compat) ·
  **`server_mode:standalone`** (Valkey 8's name for the field `redis_mode`
  carried in Redis; captured verbatim from full `INFO`). Corroborated by
  `CLUSTER SLOTS` answering as a non-cluster runtime, and functionally by the
  four previously-cluster-blocked checks passing below.

**The 8-item acceptance — run in-network by the committed, unmodified suite
(boot-runner pattern, reverted after; hash-tagged `{wave1a-*}` queues,
obliterated on cleanup; the live `{maintenance}` path exercised via the real
class):**

| # | Acceptance check | Result | Latency (ms) | Evidence |
|---|---|---|---|---|
| 1 | enqueue → process → ack | ✅ PASS | 2,039 | round-trip completed |
| 2 | real job via committed `MaintenanceQueue` path | ✅ PASS | 1,812 | enqueue ok, processed by the real class |
| 3 | delayed job fires at its scheduled time | ✅ PASS | 5,305 | 3,000 ms delay → fired at 4,752 ms (≥ delay, never early) |
| 4 | retry per backoff policy | ✅ PASS | 2,768 | failed attempt 1, completed on attempt 2 |
| 5 | dead-letter: exhausted retries in failed set, inspectable | ✅ PASS | 2,956 | exhausted after 2 attempts; failedCount 1; `getFailed()` inspectable |
| 6 | repeatable/scheduled fires ≥ twice | ✅ PASS | 3,553 | 2 fires (1 s scheduler) |
| 7 | recovery after worker crash | ✅ PASS | 5,552 | 6/6 jobs; 2 pre-crash, force-killed worker, resumed; **0 lost** |
| 8 | concurrency: two workers, no double-processing | ✅ PASS | 4,634 | 12/12 distinct; **0 double-processed** |

**PLAIN FINAL STATUS: 8/8 PASS.** No check was weakened, skipped, replaced, or
reinterpreted; the suite is byte-identical to the one that failed 0/8 and 4/8
against the cluster-mode Dragonfly endpoints. The boot-runner was reverted and
the final RUNNING deployment is the clean build (verified live by `/api/version`
and 0 `WAVE1A` log lines).

**R2 is closed. With it, every rung of Wave 1A is closed.**

## R3 — Dependency remediation — 0 high / 0 critical

**Before:** 20 production vulnerabilities (15 moderate, **5 high**: lodash
`_.template` code injection + prototype pollution, multer DoS ×5,
brace-expansion DoS ×2, glob CLI command injection, @nestjs/platform-express
chained). **After: 15 moderate, 0 high, 0 critical.**

| Fix | Mechanism |
|---|---|
| brace-expansion (2 highs) | `npm audit fix` (non-breaking range bump) |
| multer ≤2.1.1 (5 advisories) | override → **2.2.0** (same-major, API-compatible; platform-express@10 bundles 2.0.2) |
| lodash ≤4.17.23 (3 advisories) | override → **^4.18.1** (semver-minor) |
| glob 10.2–10.4 CLI injection | override `glob@10` → **^10.5.0** — every 10.x copy incl. `google-gax→rimraf`; glob@7 consumers (callback API) untouched |
| @nestjs/platform-express HIGH | chained flag via multer/express/body-parser — clears with them |

**Verification with the upgraded tree:** `tsc` clean · `nest build` clean ·
full suite **523 passed / 0 failed** on a migrate-deployed PostGIS DB · **all 5
dark-fence suites green by filename (63 tests)**.

**Remaining 15 moderates — all require MAJOR upgrades, deliberately deferred:**

| Cluster | Advisories | Fix path | Risk now / mitigation |
|---|---|---|---|
| NestJS 10 line (`common`, `core`, `platform-express`, `platform-socket.io`, `websockets`, `body-parser`, `express`, `qs`) | moderate DoS-class | NestJS **11** major | Moderate severity; API surface is behind auth/validation pipes; schedule the NestJS 11 migration as its own change with full-suite gate before Wave 1C |
| firebase-admin chain (`@google-cloud/storage`, `gaxios`, `retry-request`, `teeny-request`, `uuid`, `file-type`) | moderate | firebase-admin major | Used server-side only for push; not exposed to user input parsing paths |

**Rule satisfied:** no known highs remain (Wave 1C precondition met on the
dependency front).

## R4 — PR #115's pre-existing backend CI failure — REAL, root-caused, FIXED

**Classification: real and deterministic — not a flake.**

- **Symptom:** 2 failures in every run, including on docs-only #115:
  `discovery-people.e2e-spec.ts` (`DiscoveryVisibility_geog_idx` GIST index
  missing) and `moments-lifecycle.e2e-spec.ts` (`MomentReactionRow` closed-
  registry CHECK missing).
- **Root cause:** CI prepared its test DB with `prisma db push`, which syncs
  only what `schema.prisma` expresses — **silently omitting raw-SQL-managed
  objects** (the GiST index on the `Unsupported geography` column and the CHECK
  constraint), which exist only in migration SQL. The two failing tests are
  drift *guards*; they were doing their job.
- **Fix:** the backend CI job now runs **`npx prisma migrate deploy`** — the
  same mechanism production boots with (prod parity). Local proof: `db push` →
  both objects absent, 2 specs fail; `migrate deploy` → both present, full
  suite green. **CI proof:** the very next #116 run was green across all jobs,
  and master (`ac7f8816`) carries the fix.

## R5 — Region migration — MOVED, measured, one follow-up

**The api service now deploys to Railway `Southeast Asia` (Singapore)**
(`multiRegionConfig: asia-southeast1-eqsg3a`; changed via `serviceInstanceUpdate`
— settings only, no variables). `/health`, `/ready`, dark-404s and live-401s
re-verified after the move on the final clean deployment.

**Per-dependency latency, in-network, before (SFO) → after (Singapore):**

| Dependency | SFO | Singapore | Verdict |
|---|---|---|---|
| Typesense Cloud (APAC) health | 894–1168 ms | **280 ms** | ✅ ~3–4× better |
| Typesense warm query p50/p95 | 218 / 219 ms | **52 / 53 ms** | ✅ ~4× better |
| Typesense 500-doc index | 660–864 ms (579–758 docs/s) | **163 ms (3,067 docs/s)** | ✅ ~4–5× better |
| Dragonfly PING | 468–481 ms | 1,087 ms — single cold-boot sample | ⚠️ anomalous (should improve toward APAC); treat as unmeasured — fresh numbers come free with the R2 acceptance re-run after the endpoint switch |
| Postgres (postgis, **still SFO**) connect | 46–66 ms | **927 ms** | ❌ expected regression — DB is now cross-Pacific |
| Postgres geo smoke (5 stmts) | 64–78 ms | **3,218 ms** | ❌ same cause |
| R2 storage PUT/GET | 453 / 372 ms | 699 / 550 ms | ≈ / slightly worse (bucket location unchanged) |

**The headline follow-up:** the **`postgis` database must follow the api to
Southeast Asia** before Wave 1C — its regional volume cannot be moved in place,
so this is a provision-new + dump/restore + repoint operation (owner-gated: it
is a data migration on the staging DB). Until then every DB round-trip pays a
cross-Pacific tax that outweighs the Typesense/Dragonfly gains on DB-heavy
paths. Recommended sequence: provision `postgis-sgp` (same image
`postgis/postgis:16-3.4`, volume in `asia-southeast1`), `pg_dump | pg_restore`
(17+1 migrations' schema + zero user rows today, so this is minutes),
repoint `api.DATABASE_URL`, keep the SFO instance untouched as fallback —
exactly the Wave-0 playbook.

## R6 — Firebase Android client key — UNDER-RESTRICTED (report-only)

`spotme/web/android/app/google-services.json` (project `spot-messenger-48a74`,
package `io.ysnapai.spotme`) embeds an `AIza…` Android client API key — normal
for FCM config (these keys ship inside every APK), **but a non-mutating probe
shows it is not locked down server-side**: an Identity Toolkit call **from a
plain server context (no Android package/signature headers)** was *not* rejected
by key restrictions (no `API_KEY_ANDROID_APP_BLOCKED` / service-blocked error —
the request reached the API itself). So the key currently has **neither
application restriction (Android package + SHA-1) nor API restriction**.

**Owner remedy (Google Cloud console → APIs & Services → Credentials → this
key):** set *Application restrictions* = Android apps (`io.ysnapai.spotme` +
release/debug SHA-1s) **and** *API restrictions* = only the APIs the app uses
(Firebase Installations, FCM Registration, and — only if Firebase Auth is
actually used from Android — Identity Toolkit). **Not rotated** — restriction
changes are non-breaking and rotation was explicitly out of scope without
asking.

## R7 — Kill-switch — built and PROVEN BY EXERCISE, measured 4,994 ms

**Mechanism (committed, live on staging, posture-neutral):**

- **`RuntimeFlag` table** (additive migration `20260805120000_runtime_flags`,
  zero rows — applied cleanly on staging at boot: migrations 17→18). One row
  per dark domain (`discovery`, `exchange`, `events`, `moments`, `assistant`).
- **Fail dark:** a MISSING row is disabled; a DB error is disabled; a read
  timeout is disabled. Only an affirmative `enabled=true` answers.
- **`DomainGate(key)` guard:** gated routes answer **404** — byte-identical to
  the unmounted-module state the dark fences assert. Wave 1C's activation
  contract: domains mount **behind this gate**, so "activated" is always one
  row-flip from "fully dark".
- **One config change:** flip = a single-row `UPDATE`/`INSERT`. No migration,
  no redeploy, no restart. Propagation bound = the service's 5 s read-through
  cache. The same service is the gate for background processors, so a flip
  stops a domain's jobs within one cache window too.
- **Probe surface:** one internal route behind pseudo-key `wave1a-probe` (read
  by no product surface; 404 while dark — indistinguishable from today).

**The measured exercise (live server, real PostGIS, single OS process
throughout — PID verified unchanged):**

| Step | Result |
|---|---|
| Baseline (no row) | probe **404**; dark `v2/discovery` 404; `/health` 200 |
| Flip ON (1 `INSERT`) | probe **200** `{"gate":"open"}` within one cache window |
| **Flip OFF (1 `UPDATE`) → fully dark** | **404 after 4,994 ms** |
| R7 bar | 60,000 ms — **met with 12× margin** |
| After rollback | dark routes 404 · `/health` 200 · no restart (same PID) · flag data intact · no new writes |

**Fences:** `test/flags-kill-switch.spec.ts` — 6 tests: fail-dark on missing
row, fail-dark on DB error, affirmative-enable only, one-flip propagation bound
(measured in-suite at ~5.07 s), 404-not-403, and **every real domain key
defaults dark on a migrated DB**. Full suite after: **523 passed / 0 failed**.

**Today's posture is stronger still:** the dark domains are not even mounted in
`app.module.ts`; the kill-switch adds the runtime rollback path Wave 1C needs
*on top of* that, before any activation exists to need it.

## Validation (before/after every change in this wave)

| Check | Result |
|---|---|
| Full backend suite | ✅ 523 passed / 0 failed (was 517 pre-R7; +6 kill-switch fences) |
| Dark fences by filename | ✅ 5/5 suites, 63 tests (`assistant-`, `discovery-`, `events-`, `exchange-`, `moments-dark-fences.spec.ts`) |
| Crypto conditions | ✅ false (unchanged; no crypto code touched) |
| Secret scan (wave paths) | ✅ CI `scan` job green on every push |
| Dark routes on deployed api | ✅ `v1/exchange`, `v1/moments`, `v2/discovery` → 404 |
| Live route class | ✅ `/api/users/me` → 401 |
| `/health` `/ready` | ✅ 200 / 200 `{db:up, redis:up}` |
| Temporary scaffolding | ✅ all boot-runners reverted; final deployment's build is clean |

## What remains dark

Everything. **No dark module was mounted, no route activated, no flag flipped
on** (`RuntimeFlag` has zero rows). Discovery, Exchange, Events, Moments and
the Assistant remain unmounted and 404. The kill-switch registry, the gate
guard, and one internal always-dark probe are the only additions to the running
surface, and each is posture-neutral by construction.

## Open owner actions

1. ~~**R2 (was blocking Wave 1B/1C)**~~ ✅ **CLOSED** — remedy (c) executed
   under owner directive: in-project `valkey` service provisioned, `api`
   repointed by reference, `server_mode:standalone` verified, **acceptance
   8/8 PASS** (§R2 Resolution). *Optional housekeeping, owner's call:* the two
   parked Dragonfly datastores can be decommissioned once Wave 1C is stable on
   Valkey (they are the rollback path until then), and the stray lowercase
   `redis` variable on `api` (structurally not a URL, read by no code) can be
   deleted or declared parked.
2. **R5 follow-up (before Wave 1C):** migrate the `postgis` DB to
   `asia-southeast1` (playbook in §R5) so the api and its DB are co-located
   again; SFO instance stays as fallback.
3. **R6:** add Android app + API restrictions to the Firebase Android key
   (console click-path in §R6). Report-only here; no rotation performed.
4. **R3 (before Wave 1C, scheduled):** NestJS 11 migration to clear the
   remaining moderate advisories (no highs remain now).
5. Housekeeping carried from Wave 0: `s3_bucket` orphan var; stale
   `JWT_REFRESH_*` entries in `.env.example`.

---

**STOP.** Wave 1A ends here, **fully closed — all seven rungs, including R2 at
8/8.** Wave 1B is not begun. No activation occurred: no dark module mounted, no
flag flipped (`RuntimeFlag` still has zero rows), dark routes 404, crypto
conditions false. The queue runtime the Activation Programme will build on is
the in-project Valkey, proven by the full acceptance suite.
