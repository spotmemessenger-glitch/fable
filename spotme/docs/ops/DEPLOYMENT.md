# Spot Me backend — staging deployment (Wave 0)

Operational reference for the `api` service on Railway project
`spotme-backend`, environment `production` (the designated **staging** target;
no user traffic — the live app runs on the legacy deployment). Env variables are
referenced by **NAME only**; no values appear here.

---

## 1. Service topology

| Service | Role |
|---|---|
| `api` | The NestJS backend. Builder: **Dockerfile** (`spotme/backend/Dockerfile`, path set via `RAILWAY_DOCKERFILE_PATH`). |
| `Postgres` | Managed Postgres (`ghcr.io/railwayapp-templates/postgres-ssl:18`). Reached over Railway's **private network**. |

Dragonfly (Redis), Typesense, and R2 are the other Wave-0 dependencies;
Dragonfly/Typesense are private-network, R2 (`S3_ENDPOINT`) is external HTTPS.

---

## 2. Environment-NAME matrix (values owner-only)

**REQUIRED (13):**

| Name | Purpose | Boot behaviour if absent |
|---|---|---|
| `DATABASE_URL` | Postgres — Prisma datasource (`prisma/schema.prisma`) | boot fails (Prisma) |
| `JWT_ACCESS_SECRET` | access-token signing | **boot refuses** if unset or <32 chars (`main.ts`) |
| `JWT_ACCESS_TTL` | access-token TTL | defaults `15m` |
| `NODE_ENV` | runtime mode | set to `production` in the image |
| `PORT` | listen port | defaults `4000` |
| `REDIS_URL` | Dragonfly / BullMQ | queues **disabled** (graceful) |
| `TYPESENSE_URL`, `TYPESENSE_API_KEY` | search adapter | search adapter inactive |
| `STORAGE_PROVIDER` | `s3` selects R2 | defaults `local` |
| `S3_BUCKET` | R2 bucket (`spot-media-staging`) | if `s3` requested but unset → **silent fallback to local** |
| `S3_ENDPOINT` | R2 endpoint | undefined (real-AWS mode) |
| `S3_ACCESS_KEY_ID` | R2 access key ID (**32 chars**) | AWS default credential chain |
| `S3_SECRET_ACCESS_KEY` | R2 secret (**64 chars**) | AWS default credential chain |

`S3_REGION` is optional (code default `auto`, correct for R2).

**Parked / report-only (never deleted, code-confirmed unread):** `redis`,
`typesense`, `google r2`, `READ_MODEL`, `livekit`, `metered`, `POSTHOG_KEY`,
`JWT_REFRESH_SECRET`, `JWT_REFRESH_TTL`. Also present: lowercase `s3_bucket`
orphan (delete or declare parked).

---

## 3. Build, migration & boot order

The Dockerfile is two-stage (`node:22-slim`). Order:

1. **Build:** `npm install` → assert `deploy-api/translate.js` exists →
   `npx prisma generate` → `npm run build` (→ `dist/`, incl. `dist/scripts/wave0/`).
2. **Boot (`CMD`):** `npx prisma migrate deploy` → `node dist/main.js`.
   - `migrate deploy` runs **in-network at boot** and is a **no-op when there is
     nothing to apply**. The `feat/activation-wave-0` branch adds **no new
     migrations**, so it applies the same 17 migrations as `master`.
   - `main.ts` refuses to boot if `JWT_ACCESS_SECRET` is missing/<32 chars.

> **DEPLOY WITH `npm run deploy`, NOT `railway up`.** `predeploy` stages
> `../web/api` → `deploy-api/` (the serverless handlers the Dockerfile asserts).
> A bare `railway up` skips that step and the **build fails on the assert**.
> Run from `spotme/backend`:
> ```bash
> npm run deploy      # = predeploy staging + railway up --detach
> ```
>
> **CLI-deploy build-context finding (Wave 0).** `railway up` invoked from an
> external agent container **uploads the git repository root**, and the service's
> dashboard-configured root directory (`spotme/backend`) is **not applied to CLI
> uploads** — so the build fails with `couldn't locate the dockerfile at path
> Dockerfile in code archive`. This is why the Wave-0 deploy could not complete
> from the agent environment. **Owner deploy path** (either works):
> 1. **GitHub-integration deploy** — merge `feat/activation-wave-0` into the
>    branch the `api` service watches (or point the service at the branch); the
>    Railway GitHub builder applies the `spotme/backend` root directory correctly.
> 2. **From your own checkout** with a Railway CLI whose service link resolves the
>    root directory: `cd spotme/backend && npm run deploy`.
>
> The health gate is `spotme/backend/railway.json` → `healthcheckPath:/health`.
> `/health` was verified to return `200` on the built `dist/` artifact (local
> boot); if a deploy's `/health` gate ever fails, Railway safely **keeps the
> current instance** (no outage) — no schema change means nothing to roll back.

---

## 4. Health checks

Both sit OUTSIDE the `api` global prefix, at root paths:

| Path | Meaning | Codes |
|---|---|---|
| `/health` | liveness — process serving | always `200` once booted |
| `/ready` | readiness — bounded DB + Redis checks | `200` ready / **`503`** when a dep is down |

`/ready` exposes only `{status, checks:{db,redis}}` — no config, infra IDs,
URLs, stack traces, or credential-presence matrix. Railway's health gate points
at **`/health`** (liveness) via `spotme/backend/railway.json`
(`healthcheckPath:/health`), so a degraded dependency does not fail the deploy;
`/ready` is for honest readiness inspection.

---

## 5. Wave-0 validation harness — in-network invocation

The harness (`src/scripts/wave0/`, compiled to `dist/scripts/wave0/`) refuses to
run unless `RAILWAY_PROJECT_ID` / `RAILWAY_ENVIRONMENT_ID` / `RAILWAY_SERVICE_NAME`
match the designated target. `DATABASE_URL`/`REDIS_URL`/`TYPESENSE_URL` are
private-network, so the pg/redis/typesense legs **must run inside the Railway
network** — from an in-network shell on the running `api` container:

```bash
# in-network shell (after deploy):
railway ssh --project spotme-backend --environment production --service api

# then, inside the container:
node dist/scripts/wave0/run.js --legs=redis,typesense
# Postgres incl. PostGIS install (gated: user-data check must return SAFE):
WAVE0_DB_MUTATE=1 node dist/scripts/wave0/run.js --legs=postgres
```

The storage (R2) leg is reachable from anywhere and can also be run via
`railway run npx ts-node src/scripts/wave0/run.ts --legs=storage`.

**Mandatory Typesense 20k re-benchmark** (authoritative; not in the backend
image): run the committed `@spotme/search-bench` from an in-network context
(owner action — a Railway one-off/job, or a machine on the private network):
```bash
cd spotme/packages/search-bench && CORPUS_SIZE=20000 \
  TYPESENSE_URL=$TYPESENSE_URL TYPESENSE_API_KEY=$TYPESENSE_API_KEY node bench.mjs
```
Record vs the recorded Typesense 27.1 baseline (33,603 docs/s; warm p50/p95
3.60/5.05 ms) and conclude CONFIRMS / RESERVATIONS / CHALLENGES.

---

## 6. Safe diagnostics (names only)

```bash
railway status                                   # link + service status
railway variables --kv | sed -E 's/=.*//'        # variable NAMES only
railway logs --service api                        # boot + runtime logs
curl -fsS https://<api-public-domain>/health      # liveness
curl -s  -o /dev/null -w '%{http_code}' https://<api-public-domain>/ready
```

---

## 7. Rollback (to the previous known-good deployment)

Wave 0 changes are infrastructure + health only — **no activation, no dark
import, no flag flip** — so the dark posture is identical before and after. To
roll back:

1. Railway dashboard → `api` → Deployments → the previous known-good deployment
   → **Redeploy** (or `railway redeploy` after linking that deployment).
2. Verify after rollback:
   - `/health` → `200` (or endpoint absent if rolling back before Wave 0 — that
     is expected and is itself the proof the older image is serving);
   - every dark route still `404` (unchanged — Wave 0 never activated anything);
   - representative live routes in their expected class (`401/403`, never
     unexpected `404`/`5xx`);
   - dark-fence suites green by filename (§ validation report).

Because Wave 0 added only `/health`, `/ready`, the env-gated harness, and this
config, rolling it back **restores the exact prior dark posture** — there is no
activated surface to unwind.

---

## 8. Wave 1A addenda (2026-08-05)

- **Region:** the `api` service now deploys to **Southeast Asia**
  (`multiRegionConfig: asia-southeast1-eqsg3a`, set via Railway
  `serviceInstanceUpdate`). The `postgis` DB is still in SFO — co-locating it
  (provision new + dump/restore + repoint, SFO kept as fallback) is an open
  owner action; until then DB round-trips pay a cross-Pacific tax.
- **Kill-switch (R7):** dark domains gate on the `RuntimeFlag` table
  (migration `20260805120000_runtime_flags`). A missing row is DISABLED
  (fail-dark). Flip = one row `UPDATE`/`INSERT`; propagation ≤ ~5 s (the flag
  cache TTL), measured rollback-to-dark 4,994 ms, no restart/redeploy. The
  internal probe `/api/internal/wave1a/gate-probe` (pseudo-key `wave1a-probe`)
  exercises the switch end-to-end; it 404s while dark.
- **Queue acceptance (R2):** `dist/scripts/wave1a/run.js` runs the Dragonfly
  topology probe + the 8-item BullMQ acceptance for standalone and cluster
  clients. Current Dragonfly (cluster mode) caps at 4/8 — a **non-cluster
  endpoint is required** before any queue worker activates; re-run this suite
  after the owner switches the endpoint and require **8/8**.
