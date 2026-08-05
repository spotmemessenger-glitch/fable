# Wave 0 — Infra Connect & Validate — FINAL REPORT

**Programme:** Activation Programme, Wave 0. Staging validation, **zero
user-facing change**. **No activation, no dark-module import, no flag flip, no
schema change.**
**Target (designated STAGING):** Railway `spotme-backend` / `production` / `api`
— no user traffic (live app runs on the legacy deployment).
**Branch / PR:** `feat/activation-wave-0` (base `master 64c9334`) → **draft
PR #116**. Run date 2026-08-04 (UTC).

> Every figure below is aggregate metadata: versions, booleans, counts,
> durations, HTTP codes, error *classes*. No connection URL, host, credential,
> or presigned URL is printed here or anywhere in the harness output/logs.

---

## 1. Gate — PASS

| Item | Result |
|---|---|
| master at `64c9334` or descendant | ✅ `origin/master = 64c9334` |
| dark-fence suites green (by filename) | ✅ **5/5, 63 tests** — `assistant-dark-fences.spec.ts`, `discovery-dark-fences.spec.ts`, `events-dark-fences.spec.ts`, `exchange-dark-fences.spec.ts`, `moments-dark-fences.spec.ts` |
| crypto conditions false | ✅ `spotme.e2e3` never enabled; `web/src/lib/crypto/{x3dh,ratchet}.js` unimported by wired code; `SIGNING_PUBLICATION_ENABLED`/e2e_v3 false |
| Railway CLI authenticated + linked | ✅ `spotme-backend` / `production` / `api` |
| 13 REQUIRED names present | ✅ 13/13 |
| Parked legacy report-only | ✅ untouched |

**Report-only observation:** lowercase `s3_bucket` orphan coexists with REQUIRED
`S3_BUCKET`; code reads only `S3_BUCKET`, so no runtime ambiguity (owner: delete
or declare parked).

---

## 2. Per-dependency results

| Dependency | Version | Result | Latency | Notes |
|---|---|---|---|---|
| **R2 / storage** | — | ✅ **PASS** (after owner var fix) | PUT 200 ~1.93 s · GET 200 ~0.56 s · DELETE ~0.25 s | Real `S3StorageAdapter` port. **`STORAGE_PROVIDER=s3` in effect (no silent local fallback).** Full round-trip verified: presigned PUT → GET, **byte-integrity sha256 in==out ✅**, delete confirmed (post-delete GET `404`). EXIF sentinel **survived** the round trip — expected/correct: the port is a forbidden-to-inspect pass-through (never strips/transcodes); EXIF protection is client-side sealing, not storage. Wave 0 surfaced **three layered misconfigs**, all owner-corrected: `S3_ACCESS_KEY_ID` held a 64-char secret (needs the 32-char ID); `S3_BUCKET` held a wrong 32-char value, then the name with trailing whitespace — fixed to `spot-media-staging`. |
| **Postgres / PostGIS** | Postgres on `postgres-ssl:18` | ⛔ **Phase-1A gate = BLOCKED** | — | **Answered by the deploy's boot migration.** `npx prisma migrate deploy` at boot ran `20260803120000_enable_postgis` (`CREATE EXTENSION postgis`) against `postgres.railway.internal` and it **FAILED** — PostGIS is not installable on this image / the app role lacks the privilege (exactly the production-permission gate the migration's own header warns about). The DB is now in `P3009` (failed-migration) state, which blocks `migrate deploy` and therefore all deploys. **Do NOT substitute** — owner remedy below. The harness `--legs=postgres` (user-data check + geospatial smoke) will run once PostGIS is provisioned and the deploy boots. |
| **Dragonfly / Redis** | (in-network) | ⛔ **BLOCKED — MUST RUN IN-NETWORK** | — | Private-network. Harness ready: PING + version + wave0 BullMQ enqueue→process→ack via the app's `createRedisConnection`. |
| **Typesense** | (in-network) | ⛔ **BLOCKED — MUST RUN IN-NETWORK** | — | Private-network. Harness does a `wave0_smoke` create→index→query→drop; the authoritative 20k re-benchmark is a `@spotme/search-bench` run (below). |

Note: the harness itself is verified — it compiles (`nest build` clean), enforces
the designated-target gate, and executed end-to-end for the reachable (R2) leg.
The three private-network legs are code-complete and run in-network unchanged.

---

## 3. Typesense benchmark block

| Field | Value |
|---|---|
| Status | **DEFERRED to in-network owner run** (not simulated/estimated) |
| Tool | `@spotme/search-bench` (`node bench.mjs`, `CORPUS_SIZE=20000`) — committed, **not** in the backend image |
| Recorded baseline (Typesense 27.1) | index **33,603 docs/s**; warm **p50/p95 3.60 / 5.05 ms**; typo 100%; RSS 223 MB |
| Why deferred | Typesense is Railway-private and the bench package isn't deployed; must run from an in-network context that has the package |
| Selection conclusion | **PENDING** the in-network run → then record CONFIRMS / CONFIRMS-WITH-RESERVATIONS / CHALLENGES vs 27.1 |

Command (owner, in-network): see `docs/ops/DEPLOYMENT.md §5`.

---

## 4. Deployment, health & routes

**Railway deploy: ⛔ BLOCKED on the PostGIS migration (owner action).** Timeline:
1. The service's deploy source was **misconfigured** — no GitHub repo connected,
   and the root-directory field held a stray branch name (`feat/activation-wave-0`).
   With owner authorization, this was corrected (repo `spotmemessenger-glitch/fable`,
   branch `feat/activation-wave-0`, **root directory `spotme/backend`**; nothing
   else changed). That root-directory fix is also what made `railway up` /
   `npm run deploy` resolve the Dockerfile — the earlier "Dockerfile not found"
   failures were caused by the stray root-directory value, not a CLI limitation.
2. `npm run deploy` then **built successfully** (Dockerfile found, `deploy-api`
   staged, assert passed) and the container **booted**.
3. Boot ran `npx prisma migrate deploy`, which **failed** on
   `20260803120000_enable_postgis` (`CREATE EXTENSION postgis`) — PostGIS is not
   installable on the `postgres-ssl:18` image / the app role lacks the privilege.
   `migrate deploy` aborted, `main.js` never started, and the `/health` gate
   timed out (~5 min) → deployment FAILED. The DB is left in `P3009`.

**Note (GitHub source):** the connected GitHub source is redundant — `npm run
deploy` works now — and its builds fail at the `deploy-api/translate.js` assert
(`deploy-api` is untracked, staged only by `npm run deploy`, so GitHub-source
builds never have it). Recommend disconnecting it: `railway service source
disconnect --service api`. **The known-good instance served throughout — no
outage, no user-facing change.**

**Health/route behaviour verified on the built `dist/` artifact (local boot with
a DB), substituting for the blocked Railway verification:**

| Probe | Result |
|---|---|
| boot | ✅ "Nest application successfully started" |
| `/health` | ✅ `200` `{"status":"ok"}` |
| `/ready` | ✅ `200` `{"status":"ready","checks":{"db":"up","redis":"disabled"}}` |
| `/api/version` | ✅ `200` |
| dark `v1/exchange`, `v1/moments`, `v2/discovery` | ✅ **`404`** |
| live `/api/users/me` (on the running staging instance) | ✅ `401` (expected class) |

Health URL after the owner deploys: `https://api-production-0a4ca.up.railway.app/health`.

---

## 5. Cleanup / retention

| Resource | State |
|---|---|
| R2 objects | **none created** (upload blocked); nothing to clean |
| Typesense `wave0_` collections | none created (leg not run externally) |
| Redis `wave0` queue/jobs | none created (leg not run externally) |
| Postgres | untouched — no connection, no mutation |
| Local verify artifacts (agent container) | local pg cluster + `deploy-api/` staging removed |

Nothing outside mission namespaces was listed, inspected, or touched. Only
agent-local test scaffolding was deleted.

---

## 6. PR #115 backend-CI reproduction note (report-only; not fixed here)

- #115's failing check is **`backend — tests against Postgres, typecheck, build`**
  (run `30935125806`). CI provides a **PostGIS Postgres + Valkey**; infra came up
  cleanly, so the failure is in **test execution**, not infra or compile.
- **In this session:** `nest build` (typecheck+build) is **clean**, and the 5
  dark-fence suites pass. The full DB-backed suite **cannot be faithfully run
  here** (no Postgres; staging DB is private) — the 100 local failures are all
  "database unreachable," an environment artifact, **not** the CI failure.
- **Key signal:** PR #115 is **docs-only (no code changed)**, yet its backend CI
  fails — so the failure is a **pre-existing condition on `master`**, not
  introduced by #115. Whether it is a flaky test or a deterministic break needs a
  DB-backed run (re-run CI, or run the suite against the CI's PostGIS service).
  This matters for Wave 1: treat it as pre-existing.

---

## 7. Owner actions (open)

1. ~~**Fix R2 credentials + bucket**~~ ✅ **DONE** — owner corrected
   `S3_ACCESS_KEY_ID` (→ 32-char ID), `S3_SECRET_ACCESS_KEY` (64), and
   `S3_BUCKET` (→ `spot-media-staging`, whitespace removed); storage leg re-run
   **PASS**. *(Optional hardening: `s3-storage.adapter.ts:48` reads `S3_BUCKET`
   raw — a `.trim()` there would tolerate stray whitespace. Separate follow-up.)*
2. **⚠️ PROVISION POSTGIS (the deploy blocker).** The `Postgres` service image
   (`postgres-ssl:18`) cannot run `CREATE EXTENSION postgis`. Switch it to a
   PostGIS-capable image (e.g. `ghcr.io/railwayapp-templates/postgres-postgis`,
   or a `postgis/postgis:16` image), or make the `postgis` extension available
   and grant the app DB role `CREATE EXTENSION` privilege. **Do not substitute
   anything else.**
3. **Clear the failed migration** so `migrate deploy` can proceed:
   `npx prisma migrate resolve --rolled-back 20260803120000_enable_postgis`
   (run against the staging DB), then redeploy — the migration re-applies and
   succeeds once PostGIS is available.
4. **Redeploy** (`npm run deploy` from `spotme/backend` — works now that
   root-directory is `spotme/backend`). On green boot the harness lands; then the
   **Redis, Typesense, and Postgres legs** + the **20k Typesense re-benchmark**
   run in-network (`DEPLOYMENT.md §5`) and fold into this report. Optionally
   `railway service source disconnect --service api` first (redundant source).
5. **Resolve `s3_bucket` orphan** (delete or declare parked).
6. **Docs follow-up:** prune stale `JWT_REFRESH_SECRET`/`JWT_REFRESH_TTL` from
   `spotme/backend/.env.example` (read by no code).
7. **PR #115:** classify the pre-existing backend-CI failure before Wave 1.

---

## 8. Attestation

- **Nothing user-facing was activated.** No dark module imported, no shell mount,
  no flag flip. Dark routes enumerated return `404`; crypto conditions false.
- **Postgres:** not touched from the agent container. The **owner-authorized
  deploy's boot** ran `prisma migrate deploy` in-network (the app's normal boot
  step) using only **existing committed migrations** — no new/edited migration,
  no schema beyond what's in the repo. `20260803120000_enable_postgis` failed
  (PostGIS unavailable), leaving a `P3009` state to be resolved (action #3). No
  data was read or written; the user-data safety check has not run.
- **Railway settings:** only the deploy **source / branch / root-directory** were
  changed (owner-authorized, one-time) — no variables, no other settings, no
  deletions. R2 wrote only the wave0 smoke object, which was deleted.
- **No credential value** was printed or persisted anywhere (output, logs,
  commits, PR, this report).
- **Only mission-created / agent-local test resources were deleted.**
- **All dark fences green** (5 suites by filename, 63 tests).
