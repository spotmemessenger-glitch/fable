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
| **Postgres / PostGIS** | PostgreSQL **16** / PostGIS **3.4** (`postgis/postgis:16-3.4`) | ✅ **Phase-1A gate = PASS** | migrate from zero clean | **Resolved:** original `postgres-ssl:18` could **not** enable PostGIS (`enable_postgis` failed → `P3009`) = Phase-1A BLOCKED on that image. A **new PostGIS service was provisioned** (owner-authorized) and `api` repointed to it. On the fresh DB, boot `prisma migrate deploy` applied **all 17 migrations from zero incl. `enable_postgis` + `discovery_postgis`** → *"All migrations have been successfully applied."* **ADDENDA #3 (ST_DWithin/GiST) CONFIRMED:** `discovery_postgis` created `geog geography(Point,4326)` + `CREATE INDEX … USING GIST (geog)` and applied cleanly — a GiST-on-geography index cannot build without the PostGIS GiST operator classes, so Discovery's radius-query dependency **functions on this image.** DB is brand-new → user-data check safe by construction (0 rows). *Disposition: default Railway PostgreSQL image = **BLOCKED**; resolved by provisioning a PostGIS-capable service.* Formal harness `--legs=postgres` numbers (explicit `ST_DWithin` planner proof + latencies) need in-network exec — see §7. |
| **Dragonfly / Redis** | Dragonfly Cloud (external, Hyderabad) | ✅ **Connectivity PASS (in-network)** | in-network ping (via `/ready`) | Owner corrected `REDIS_URL` (now a valid `rediss://…@…:port` string, shape verified). The api **redeployed** and live **`/ready` → `{db:up, redis:up}`** — the deployed container connects to Dragonfly Cloud and PINGs successfully via the app's own `createRedisConnection` (the leg's connect+ping step, proven **in-network**). The full BullMQ **enqueue→process→ack** round-trip + Dragonfly version need an **in-network harness run** — from the agent container the `rediss://` custom-port connection is blocked by the HTTPS-only egress proxy (leg timed out), so run `railway ssh --service api -- node dist/scripts/wave0/run.js --legs=redis` (owner holds the SSH key) for the latencies. |
| **Typesense** | Typesense Cloud **v30.2** (external, Hyderabad) | ✅ **PASS** (after structural fix) | health ~1.9 s · index 500 docs ~0.8 s · warm q p50/p95 ~269/273 ms (cross-region) | `TYPESENSE_URL` was **missing its scheme** (host-only) — structurally repaired by prepending `https://` (never-echo). Leg then connected to **Typesense Cloud v30.2**: health OK, 500-doc `wave0_smoke` create→index→query (50 warm, **0 errors**)→drop (cleaned up). Latencies are cross-region from the agent container (connectivity evidence, not cluster perf). Benchmark = **INCOMPARABLE** (§3): in-image smoke ≠ committed 20k harness; **v30.2 vs 27.1** major-version gap. `TYPESENSE_API_KEY` shape valid (32-char alphanumeric). |

Note: the harness itself is verified — it compiles (`nest build` clean), enforces
the designated-target gate, and executed end-to-end for the reachable (R2) leg.
The three private-network legs are code-complete and run in-network unchanged.

---

## 3. Typesense benchmark block

| Field | Value |
|---|---|
| Status | **INCOMPARABLE** (per ADDENDA #2 — not simulated/estimated) |
| Tool | `@spotme/search-bench` (`node bench.mjs`, `CORPUS_SIZE=20000`) — committed, **not** in the backend image |
| Recorded baseline (Typesense 27.1) | index **33,603 docs/s**; warm **p50/p95 3.60 / 5.05 ms**; typo 100%; RSS 223 MB |
| Why INCOMPARABLE | (a) the exact committed 20k harness isn't in the image, so it cannot run in-network here; the in-image smoke uses a different corpus/seed/schema/query-set/methodology — connectivity evidence only, never a verdict. (b) Typesense is also currently **unconfigured** (§2). (c) Cluster is **v30.x vs the 27.1 baseline** — a major-version gap to note in any eventual verdict. |
| Selection conclusion | **NOT DRAWN** — requires the committed 20k `@spotme/search-bench` run against a validly-configured Typesense, in-network. Owner action. |

Command (owner, in-network): see `docs/ops/DEPLOYMENT.md §5`.

---

## 4. Deployment, health & routes

**Railway deploy: ✅ SUCCESS — live on the PostGIS DB.** Deployment `814f192f`
RUNNING on `spotme-backend/production/api` (commit `13cc509`). Path to green:
1. The deploy source was misconfigured (no repo connected; root-directory field
   held a stray branch name). Corrected under owner authorization (repo + branch
   + **root directory `spotme/backend`**), which made `npm run deploy` resolve the
   Dockerfile. Redundant GitHub source later disconnected (its builds fail the
   untracked-`deploy-api` assert).
2. The original `postgres-ssl:18` DB could not `CREATE EXTENSION postgis`
   (`enable_postgis` migration failed → `P3009`) — Phase-1A gate BLOCKED.
3. **Resolution (owner-authorized, performed by this harness):** provisioned a
   NEW `postgis` service (`postgis/postgis:16-3.4`, PostgreSQL 16 / PostGIS 3.4)
   with its own `postgis-volume`, generated a strong password (never printed),
   set `DATABASE_URL` on it as a reference template, and repointed `api`'s
   `DATABASE_URL` → `${{postgis.DATABASE_URL}}` (host fingerprint changed
   `f51137a6cc06` → `5b737fc21bd4` = `postgis.railway.internal`). The original
   `Postgres` service was left **untouched** as the fallback.
4. On the fresh PostGIS DB, boot `prisma migrate deploy` applied **all 17
   migrations from zero** — including `enable_postgis` and `discovery_postgis` —
   ending **"All migrations have been successfully applied."** `main.js` booted,
   `/health` gate passed → deployment **SUCCESS**. **No outage throughout.**

**Health/route behaviour — verified LIVE on the deployed service:**

| Probe | Result |
|---|---|
| boot | ✅ Nest started; connected to `postgis.railway.internal`; migrations clean |
| `/health` | ✅ `200` `{"status":"ok"}` |
| `/ready` | ✅ `200` `{"db":"up","redis":"up"}` — both PostGIS and Dragonfly reachable in-network (was `503`/`redis:down` until `REDIS_URL` was corrected — reported honestly throughout, never loosened) |
| `/api/version` | ✅ `200` |
| dark `v1/exchange`, `v1/moments`, `v2/discovery` | ✅ **`404`** |
| live `/api/users/me` | ✅ `401` (expected class) |

Live health URL: `https://api-production-0a4ca.up.railway.app/health`.

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
2. ~~**Provision PostGIS + deploy**~~ ✅ **DONE** — new `postgis` service
   (`postgis/postgis:16-3.4`) + volume provisioned, `api` repointed, deployed;
   all 17 migrations applied from zero, Phase-1A gate **PASS**, `/health` `200`.
   Original `Postgres` untouched (fallback).
3. ~~**Fix `REDIS_URL` value**~~ ✅ **DONE** — owner pasted the correct Dragonfly
   Cloud connection URI; api redeployed; live `/ready` → `redis: up`
   (in-network connectivity confirmed). *Optional:* for the full
   enqueue→process→ack latencies + Dragonfly version, run
   `railway ssh --service api -- node dist/scripts/wave0/run.js --legs=redis`
   from your machine (agent container can't reach `rediss://` custom-port).
4. ~~**Typesense endpoint**~~ ✅ **DONE** — `TYPESENSE_URL` was missing its scheme;
   repaired (prepended `https://`). Leg re-run **PASS** against Typesense Cloud
   **v30.2**. *Remaining:* run the committed **20k `@spotme/search-bench`**
   benchmark in-network for the INCOMPARABLE-rule verdict (owner action;
   `DEPLOYMENT.md §5`).
5. **Formal `--legs=postgres` numbers (optional).** The gate + ST_DWithin/GiST
   capability are already proven (§2). For explicit runtime `ST_DWithin` planner
   proof + latencies, run the harness in-network — either via your own
   `railway ssh --service api -- WAVE0_DB_MUTATE=1 node dist/scripts/wave0/run.js
   --legs=postgres` (you hold the SSH key), or authorize an env-gated boot-runner.
6. **Resolve `s3_bucket` orphan** (delete or declare parked).
6. **Docs follow-up:** prune stale `JWT_REFRESH_SECRET`/`JWT_REFRESH_TTL` from
   `spotme/backend/.env.example` (read by no code).
7. **PR #115:** classify the pre-existing backend-CI failure before Wave 1.

---

## 8. Attestation

- **Nothing user-facing was activated.** No dark module imported, no shell mount,
  no flag flip. Dark routes enumerated return `404`; crypto conditions false.
- **Postgres:** the **original `Postgres` service was never modified, migrated,
  truncated, deleted, or disconnected** — it remains intact as the fallback. A
  **new `postgis` service** (owner-authorized) was provisioned with a volume and
  a self-generated password (never printed/committed/reported). All migrations
  ran **from zero on the new, empty PostGIS DB** using only existing committed
  migrations — no new/edited migration; the DB being brand-new, there is no
  real user data (user-data safety satisfied by construction).
- **Railway settings changed (all owner-authorized):** created service `postgis`
  (+ volume); on `postgis` set `POSTGRES_*`/`PGDATA`/`DATABASE_URL`; repointed
  **`api.DATABASE_URL` → `${{postgis.DATABASE_URL}}`**; structurally repaired
  **`api.TYPESENSE_URL`** (prepended missing `https://` scheme — value never
  echoed); earlier, `api`'s deploy source/branch/root-directory (then
  disconnected). `REDIS_URL` was **not** touched (wrong value, owner to fix). No
  other service's variables or settings were touched; nothing was deleted. R2
  wrote only the wave0 smoke object, which was deleted.
- **No credential value** was printed or persisted anywhere (output, logs,
  commits, PR, this report).
- **Only mission-created / agent-local test resources were deleted.**
- **All dark fences green** (5 suites by filename, 63 tests).
