# Wave 0 — Infra Connect & Validate (staging validation record)

**Programme:** Activation Programme — Wave 0 (infra connect & validate).
**Nature:** staging validation, **zero user-facing change**. No activation, no
dark-module import, no flag flip.
**Environment (designated STAGING target):** Railway project `spotme-backend`,
environment `production`, service `api`. No user traffic reaches it; the live
user-facing app runs on the legacy deployment, untouched.
**Base commit:** `feat/activation-wave-0` off `origin/master` `64c9334`.
**Run window:** 2026-08-04 (UTC); timestamps captured in each harness run's
`at` field.

> **Credential discipline.** Nothing in this document — or anywhere in the
> harness output, logs, or commits — prints a connection URL, host, user,
> password, token, or presigned URL. Every figure below is aggregate metadata:
> versions, booleans, counts, durations, and error *classes*. Endpoints are
> referenced by env NAME only.

---

## 1. Gate (run first)

| Gate item | Result |
|---|---|
| master at `64c9334` or descendant | ✅ `origin/master = 64c9334` |
| dark-fence suites green (by filename) | ✅ `assistant-dark-fences.spec.ts`, `discovery-dark-fences.spec.ts`, `events-dark-fences.spec.ts`, `exchange-dark-fences.spec.ts`, `moments-dark-fences.spec.ts` — **5 suites / 63 tests pass** |
| crypto conditions false | ✅ `spotme.e2e3` never enabled; `web/src/lib/crypto/{x3dh,ratchet}.js` not imported by any wired code; `SIGNING_PUBLICATION_ENABLED` / e2e_v3 false (G8 playbook §36/§76) |
| Railway CLI authenticated + linked (`spotme-backend` / `production` / `api`) | ✅ |
| 13 REQUIRED names present | ✅ 13/13 |
| Parked legacy report-only | ✅ untouched: `redis`, `typesense`, `google r2`, `READ_MODEL`, `livekit`, `metered`, `POSTHOG_KEY`, `JWT_REFRESH_SECRET`, `JWT_REFRESH_TTL` |

**Gate observation (report-only):** a lowercase `s3_bucket` sits alongside
REQUIRED `S3_BUCKET`. Code reads **only** `process.env.S3_BUCKET`
(`s3-storage.adapter.ts:48`, `storage.module.ts:45`), so there is no runtime
ambiguity; `s3_bucket` is a dead orphan. Owner action: delete or declare parked.

---

## 2. Execution model & the private-network constraint

Step 1 assumed the ops suite runs where it can reach the infra. From an
**external** Claude container it cannot, for two independent reasons:

- `DATABASE_URL`, `REDIS_URL`, `TYPESENSE_URL` resolve on Railway's **private
  network** (`*.railway.internal` / scheme-less internal `host:port`) —
  unreachable outside a Railway deployment (`DATABASE_URL` probe: `ENOTFOUND`).
- This container's egress proxy is **HTTPS-only and blocks raw-TCP databases**,
  so even a public TCP-proxy URL would not connect.

Only `S3_ENDPOINT` (external HTTPS R2) is reachable from here. Therefore:

- **R2 / storage leg** was executed **from here** (results in §3).
- **Postgres/PostGIS, Dragonfly, Typesense** are **BLOCKED — MUST RUN
  IN-NETWORK** (harness ready; invocation in `DEPLOYMENT.md`). Not simulated,
  not estimated, not substituted. The mandatory user-data safety check likewise
  stays **unrun** from here — hence **no Postgres mutation, no migration, no
  PostGIS install** was performed.

---

## 3. Per-dependency results

### 3.1 R2 / object storage — **PASS** (after owner corrected the variables)

> **Update:** initially BLOCKED — the harness surfaced three layered variable
> misconfigs (`S3_ACCESS_KEY_ID` held a 64-char secret; `S3_BUCKET` held a wrong
> 32-char value, then the name with trailing whitespace). Owner corrected all
> three (ID → 32 chars, `S3_BUCKET` → `spot-media-staging`). Re-run result:
> **PASS** — presigned PUT `200` (~1.93 s) → GET `200` (~0.56 s), byte-integrity
> sha256 in==out, EXIF sentinel survived (pass-through, expected), DELETE
> confirmed (~0.25 s, post-delete GET `404`). Test object cleaned up.

Executed from here via the **real storage port** (`S3StorageAdapter`, the class
the app injects as `STORAGE_ADAPTER`).

| Check | Result |
|---|---|
| `STORAGE_PROVIDER=s3` actually in effect (no silent local fallback) | ✅ **verified** — factory selects `s3` (`STORAGE_PROVIDER=s3` and `S3_BUCKET` set) |
| `S3_ENDPOINT` reachable (external HTTPS R2) | ✅ |
| Presigned PUT URL generated through the port | ✅ |
| Presigned PUT accepted by R2 | ❌ **HTTP 400** — `InvalidArgument: Credential access key has length 64, should be 32` (~360 ms to rejection) |
| Byte-integrity / EXIF smoke / delete | ⏸ not reached (blocked at upload) |

**Finding.** The port, presigning, and provider selection are all correct. The
blocker is a **variable VALUE**: `S3_ACCESS_KEY_ID` holds a 64-char value, but
R2 **access key IDs are 32 chars** (secrets are 64) — the id and secret look
**swapped/mis-pasted**. This is precisely the class of silent
storage-misconfiguration Wave 0 exists to catch: media upload would fail in the
same way at runtime.

**Owner remedy (variables are owner-only — I did not edit them):** on the `api`
service, set `S3_ACCESS_KEY_ID` to the 32-char R2 access key ID and
`S3_SECRET_ACCESS_KEY` to the 64-char secret, then re-run the storage leg.

**EXIF note (architectural, to confirm post-fix).** The storage port is a
forbidden-to-inspect **pass-through** (`FORBIDDEN_STORAGE_SURFACE` bars
`transcode`/`inspect`/`thumbnail`; adapter never sees plaintext). It therefore
does **not** strip EXIF; a round trip returns bytes identical. EXIF protection
in the product comes from **client-side sealing before upload** (stored bytes
are ciphertext), not the storage layer. Once the credential is fixed, the leg
will confirm byte-integrity (in == out) and report EXIF survival honestly rather
than asserting a strip that this layer neither does nor should.

### 3.2 Postgres / PostGIS — **BLOCKED — MUST RUN IN-NETWORK**

The Phase-1A production-permission gate (can PostGIS be enabled on this Railway
Postgres image?) is **answered in-network**, not from here. The Railway Postgres
service currently runs `ghcr.io/railwayapp-templates/postgres-ssl:18` (no PostGIS
by default), so the in-network run will either enable it or report the exact
remedy (PostGIS-capable image). Harness safeguards: user-data check first
(aggregate counts only), and DDL gated behind BOTH a SAFE verdict AND
`WAVE0_DB_MUTATE=1`. Invocation: `DEPLOYMENT.md §Wave-0 harness`.

### 3.3 Dragonfly (Redis) — **BLOCKED — MUST RUN IN-NETWORK**

Ready: PING + runtime version (INFO), enqueue→process→ack on a dedicated
`wave0` BullMQ queue through the app's own `createRedisConnection`, obliterated
on cleanup. Invocation: `DEPLOYMENT.md`.

### 3.4 Typesense — **BLOCKED — MUST RUN IN-NETWORK**

Harness leg: health + version + a `wave0_smoke` collection round-trip
(create→index→query→drop), dependency-free (fetch). The **mandatory 20k-doc
re-benchmark** vs the recorded **Typesense 27.1** baseline (33,603 docs/s; warm
p50/p95 3.60/5.05 ms) is run by the committed `@spotme/search-bench`
(`node bench.mjs`), which is **not** in the backend image — an in-network owner
run (exact command in `DEPLOYMENT.md`). Not simulated here; the
CONFIRMS/RESERVATIONS/CHALLENGES verdict is produced by that run.

---

## 4. Test-resource namespaces & cleanup

| Leg | Namespace | Cleanup |
|---|---|---|
| Storage | object key `rooms/wave0-<ts>-<rand>/smoke/0` | n/a — no object was created (upload blocked) |
| Redis | BullMQ queue `wave0`, job IDs `wave0-<ts>` | `queue.obliterate({force:true})` in `finally` |
| Typesense | collection `wave0_smoke` | `DELETE /collections/wave0_smoke` in `finally` |
| Postgres | temp/geography smoke is table-free (`ST_Distance` of two literals) | nothing persisted |

No resource outside these namespaces is listed, inspected, or touched. Deletion
is restricted to objects/resources this harness created.

---

## 5. Redacted commands

```bash
# Gate — variable NAMES only (values never expanded to stdout)
railway variables --kv | sed -E 's/=.*//'

# R2 leg from here (env injected by railway run; harness prints metadata only)
railway run npx ts-node src/scripts/wave0/run.ts --legs=storage

# In-network legs (see DEPLOYMENT.md for how to run inside the Railway network)
node dist/scripts/wave0/run.js --legs=postgres,redis,typesense
```

---

## 6. Owner actions (open)

1. **Fix R2 credentials** — `S3_ACCESS_KEY_ID` (must be 32 chars) and
   `S3_SECRET_ACCESS_KEY` (64 chars) on `api`; they appear swapped. Re-run the
   storage leg after.
2. **Resolve `s3_bucket` orphan** — delete or declare parked.
3. **Run the in-network legs** (Postgres/PostGIS, Redis, Typesense) via the
   documented invocation, and the **20k Typesense re-benchmark** via
   `@spotme/search-bench`. Fold results (incl. the PostGIS gate answer) back
   into `docs/reports/wave-0-final.md`.
4. **If PostGIS is unavailable on the image** — switch the Postgres service to a
   PostGIS-capable image (e.g. `ghcr.io/railwayapp-templates/postgres-postgis`
   or an approved build). Do not substitute.
5. **Docs follow-up (non-blocking):** `JWT_REFRESH_SECRET` / `JWT_REFRESH_TTL`
   are in `spotme/backend/.env.example` but read by **no** code (refresh TTL is
   the hardcoded `REFRESH_TTL_DAYS = 30`) — prune the stale `.env.example`
   entries.
