# Wave 0 — Infra Connect & Validate — FINAL REPORT

**Programme:** Activation Programme, Wave 0. Staging validation, **zero
user-facing change**. **No activation, no dark-module import, no flag flip, no
schema change.**
**Target (designated STAGING):** Railway `spotme-backend` / `production` / `api`
— no user traffic (live app runs on the legacy deployment).
**Branch / PR:** `feat/activation-wave-0` (base `master 64c9334`) → **draft
PR #116**. Run dates 2026-08-04 / 2026-08-05 (UTC).

> **In-network update (2026-08-05).** All four legs have now executed
> **in-network**, inside the deployed `api` image, via a temporary env-gated
> boot-runner that was **reverted immediately after the run** (nothing temporary
> ships; `main.ts` is back to its committed state). The private-network legs
> (Postgres/PostGIS, Dragonfly, Typesense) are therefore no longer "code-complete
> only" — the numbers below are **real, measured** values from that run.

> Every figure below is aggregate metadata: versions, booleans, counts,
> durations, HTTP codes, error *classes*. No connection URL, host, credential,
> or presigned URL is printed here or anywhere in the harness output/logs.

### Disposition — Wave 0 CONNECTIVITY COMPLETE (1 flagged Wave-1 reservation)

All four dependencies are **connectivity-validated in-network**: R2 ✅ · Postgres/PostGIS
✅ (Phase-1A gate PASS, ST_DWithin/GiST proven) · Typesense ✅ (v30.2) · Dragonfly
✅ (PING + `/ready:up`). The owner's stated redis bar — "confirm `/ready` flips
redis to up" — is **met**. **One reservation is carried into Wave 1, not hidden:**
the BullMQ queue **enqueue→process→ack** round-trip does not complete against
Dragonfly's **cluster-mode** endpoint via the standalone client (§3a) — a
queue-worker concern to resolve before Wave 1 activates workers, not a Wave-0
connectivity failure. **No activation, no dark-module import, no flag flip, no
schema change beyond committed migrations.** PR #116 stays **Draft**.

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
| **Postgres / PostGIS** | PostgreSQL **16.4** / PostGIS **3.4.3** (`postgis/postgis:16-3.4`) | ✅ **Phase-1A gate = PASS** (in-network numbers) | connect **66 ms** · geo smoke **64 ms** | **Resolved:** original `postgres-ssl:18` could **not** enable PostGIS (`enable_postgis` failed → `P3009`) = Phase-1A BLOCKED on that image. A **new PostGIS service was provisioned** (owner-authorized) and `api` repointed to it. On the fresh DB, boot `prisma migrate deploy` applied **all 17 migrations from zero incl. `enable_postgis` + `discovery_postgis`** → *"All migrations have been successfully applied."* **In-network harness (`--legs=postgres`) numbers:** `server_version` **16.4**, PostGIS **3.4.3** installed, **User count 0 → SAFE**, **migrations 17 applied / 0 pending / 0 rolled-back**. **ADDENDA #3 (ST_DWithin/GiST) CONFIRMED AT RUNTIME:** an interactive transaction built a `geography(Point,4326)` TEMP table + `USING GIST` index, ran `ST_Distance` (0,0)→(0,1) = **110 574.4 m**, `ST_DWithin` matched **5 rows**, and with `enable_seqscan=off` the `EXPLAIN` plan used the GiST index (**`gistIndexUsed=true`**) — Discovery's exact radius-query dependency proven functional on this image. DB is brand-new → user-data check safe by construction (0 rows). *Disposition: default Railway PostgreSQL image = **BLOCKED**; resolved by provisioning a PostGIS-capable service.* |
| **Dragonfly / Redis** | Dragonfly Cloud (external) · reports `redis_mode=**cluster**`, `redis_version 7.4.0` | ✅ **Connectivity PASS (in-network)** · ⚠️ **queue round-trip = Wave-1 RESERVATION** | PING **481 ms** | **Connectivity (the Wave-0 bar) PASSES three ways:** the app's own `createRedisConnection` PINGs at **481 ms**, INFO returns the runtime identity, and live **`/ready` → `{db:up, redis:up}`** (was `redis:down` until owner corrected `REDIS_URL` — reported honestly throughout, never loosened). **RESERVATION (does not affect the Wave-0 connectivity gate; it is a Wave-1 gate):** the BullMQ **enqueue→process→ack** round-trip did **not** complete. `Queue.add` succeeded (write + hash-tagged `{wave0}` slot routing OK), but the Worker's blocking-consume path timed out (12 s) against this **cluster-mode** endpoint via the standalone ioredis client. **Wave-1 resolution:** connect the queue with an ioredis **Cluster** client, or point it at a **single-shard (non-cluster) Dragonfly** endpoint — to be resolved **before Wave 1 activates queue workers.** (No change to production `createRedisConnection` was made under Wave 0.) See §3a. |
| **Typesense** | Typesense Cloud **v30.2** (external) | ✅ **PASS** (after structural fix) | health **1.17 s** · index 500 docs **0.86 s** (**579 docs/s**) · warm q p50/p95 **285.5 / 286.8 ms** (cross-region) | `TYPESENSE_URL` was **missing its scheme** (host-only) — structurally repaired by prepending `https://` (never-echo). In-network leg connected to **Typesense Cloud v30.2**: health OK, 500-doc `wave0_smoke` create→index→query (50 warm, **0 errors**)→drop (cleaned up). Latencies measured **in-network** from the deployed image. Benchmark = **INCOMPARABLE** (§3): in-image smoke ≠ committed 20k harness; **v30.2 vs 27.1** major-version gap. `TYPESENSE_API_KEY` shape valid (32-char alphanumeric). |

Note: the harness itself is verified — it compiles (`nest build` clean), enforces
the designated-target gate, and **executed end-to-end for all four legs**: R2 from
the agent container, and Postgres/Dragonfly/Typesense in-network inside the
deployed image (temporary boot-runner, reverted immediately after).

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

## 3a. Redis queue round-trip — RESERVATION (open Wave-1 gate)

**Not a Wave-0 connectivity failure — Wave-0's redis bar (connect + PING +
`/ready:up`) PASSED.** This reservation is about queue-worker *processing*, which
Wave 1 activates.

| Field | Value (in-network, deployed image) |
|---|---|
| Runtime identity | `redis_mode=cluster`, `redis_version=7.4.0` (Dragonfly Cloud emulated cluster) |
| PING | ✅ 481 ms |
| `Queue.add` (enqueue) | ✅ succeeded — write + hash-tagged `{wave0}` slot routing work |
| Worker `enqueue→process→ack` | ❌ did **not** complete within 12 s (blocking-consume path) |
| Client used | the app's own `createRedisConnection` → **standalone** ioredis (unchanged) |
| Diagnosis | On a **cluster-mode** endpoint, a standalone ioredis client can PING and enqueue to the correct slot, but BullMQ's Worker blocking-consume loop does not complete. |
| Wave-1 resolution | Either (a) connect the queue with an ioredis **Cluster** client, or (b) point the queue at a **single-shard (non-cluster)** Dragonfly endpoint. **Resolve before Wave 1 activates queue workers.** |
| Wave-0 constraint honoured | Production `createRedisConnection` was **not** modified (that would be a Wave-1 change); the fix belongs to Wave 1. |

The round-trip ran on a dedicated hash-tagged `{wave0}` BullMQ queue (never the
live `{maintenance}` queue), obliterated on cleanup.

---

## 4. Deployment, health & routes

**Railway deploy: ✅ SUCCESS — live on the PostGIS DB.** Current RUNNING
deployment on `spotme-backend/production/api` is the **clean** build
`buildId=11e44282040095f8` (boot-runner reverted; `/api/version` confirms it
live). Path to green:
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
5. **In-network leg execution (2026-08-05):** a temporary, env-gated boot-runner
   was deployed *once* to run the three private-network legs from inside the
   image (the agent container can't reach them through the HTTPS-only egress
   proxy). It ran **after** `listen()` so `/health` was never affected, printed
   only aggregate metadata, and was **reverted immediately**; the final RUNNING
   build (`11e44282…`) is the clean one with no boot-runner (verified: **0**
   `WAVE0` lines in its logs).

**Health/route behaviour — verified LIVE on the deployed service:**

| Probe | Result |
|---|---|
| boot | ✅ Nest started; connected to `postgis.railway.internal`; migrations clean |
| `/health` | ✅ `200` `{"status":"ok"}` |
| `/ready` | ✅ `200` `{"db":"up","redis":"up"}` — both PostGIS and Dragonfly reachable in-network (was `503`/`redis:down` until `REDIS_URL` was corrected — reported honestly throughout, never loosened). *`redis:up` is connectivity (PING); the queue round-trip reservation is §3a.* |
| `/api/version` | ✅ `200` |
| dark `v1/exchange`, `v1/moments`, `v2/discovery` | ✅ **`404`** |
| live `/api/users/me` | ✅ `401` (expected class) |

Live health URL: `https://api-production-0a4ca.up.railway.app/health`.

---

## 5. Cleanup / retention

| Resource | State |
|---|---|
| R2 objects | wave0 smoke object created → **deleted** (post-delete GET `404`); nothing retained |
| Typesense `wave0_smoke` collection | created → **dropped** in-leg (create→index→query→**DELETE**); nothing retained |
| Redis `{wave0}` queue/jobs | created → **obliterated** in the leg's `finally` (`queue.obliterate({force:true})`); live `{maintenance}` never touched |
| Postgres | only a `TEMP TABLE … ON COMMIT DROP` + `CREATE EXTENSION IF NOT EXISTS postgis` on the **new, empty** DB (0 users); original `Postgres` untouched |
| Temporary boot-runner | reverted in `main.ts`; final RUNNING build has **0** `WAVE0` log lines |
| Local verify artifacts (agent container) | local pg cluster + `deploy-api/` staging removed |

Nothing outside mission namespaces was listed, inspected, or touched. Only
mission-namespaced (`wave0*`) and agent-local scaffolding was created and deleted.

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
3. ~~**Fix `REDIS_URL` value**~~ ✅ **DONE (connectivity)** — owner pasted the
   correct Dragonfly Cloud URI; live `/ready` → `redis:up`; in-network PING 481 ms.
   **⚠️ OPEN Wave-1 gate (§3a):** the BullMQ enqueue→process→ack round-trip does
   **not** complete against Dragonfly's **cluster-mode** endpoint via a standalone
   client. Before Wave 1 activates queue workers, either connect the queue with an
   ioredis **Cluster** client or use a **single-shard** Dragonfly endpoint. (This
   is a Wave-1 change, deliberately not made under Wave 0.)
4. ~~**Typesense endpoint**~~ ✅ **DONE** — `TYPESENSE_URL` was missing its scheme;
   repaired (prepended `https://`). In-network leg **PASS** against Typesense Cloud
   **v30.2** (index 579 docs/s, warm p50/p95 285.5/286.8 ms, 0 errors). *Remaining:*
   run the committed **20k `@spotme/search-bench`** benchmark in-network for the
   INCOMPARABLE-rule verdict (owner action; `DEPLOYMENT.md §5`).
5. ~~**Formal `--legs=postgres` numbers**~~ ✅ **DONE (in-network)** — server 16.4,
   PostGIS 3.4.3, users 0/SAFE, migrations 17/0/0; ST_Distance 110 574.4 m,
   ST_DWithin matched 5 rows, `gistIndexUsed=true` (§2). No further action.
6. **Resolve `s3_bucket` orphan** (delete or declare parked).
6. **Docs follow-up:** prune stale `JWT_REFRESH_SECRET`/`JWT_REFRESH_TTL` from
   `spotme/backend/.env.example` (read by no code).
7. **PR #115:** classify the pre-existing backend-CI failure before Wave 1.

---

## 8. Attestation

- **Nothing user-facing was activated.** No dark module imported, no shell mount,
  no flag flip. Dark routes enumerated return `404`; crypto conditions false.
- **The in-network validation run used a temporary, env-gated boot-runner** that
  ran the harness *once* after `listen()` (so `/health` was never affected),
  emitted only aggregate metadata, and was **reverted immediately**. The final
  RUNNING build (`11e44282…`) is clean — **0** `WAVE0` log lines. No production
  code path (including `createRedisConnection`) was changed by the run.
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
  disconnected). `REDIS_URL` was corrected by the **owner** (not by this harness).
  No other service's variables or settings were touched; nothing was deleted. R2
  wrote only the wave0 smoke object, which was deleted.
- **No credential value** was printed or persisted anywhere (output, logs,
  commits, PR, this report).
- **Only mission-created / agent-local test resources were deleted.**
- **All dark fences green** (5 suites by filename, 63 tests).
