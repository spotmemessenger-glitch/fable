# 2026-08-07 — Backend deploy drive (service `api`)

**Outcome: FAILED — master `772a92a` is NOT deployed.** The production `api`
service is still serving the previous build. No migrations were applied.

Environment variables are referenced by **name only** throughout; no value is
reproduced in this report.

---

## 1. Target (confirmed)

| Field | Value |
| --- | --- |
| Project | `spotme-backend` — `b25e2c6e-5a0f-420c-841b-202249b78cd0` |
| Environment | `production` — `dd56fc53-aba8-4a73-b2b4-131e1ec1079c` |
| Service | `api` — `57d3af65-541f-47cd-ab1c-f9e04fc31ea5` |
| Public domain | `api-production-0a4ca.up.railway.app` (port 4000) |
| Builder | RAILPACK / Dockerfile, `rootDirectory = spotme/backend` |
| Intended SHA | `772a92ab035b42e468fcbd330a5e9521f7ba38b0` (`origin/master` HEAD) |

`772a92a` was verified as the tip of `origin/master` and as an ancestor of it.
The working tree was clean at that SHA at upload time. No branch was deployed;
`claude/vercel-token-connection-bj4d21` was never checked out or uploaded.

### Credential scope (correction to an earlier session note)

The environment variable `RAILWAY_TOKEN` is a **project token**, not an account
token. Verified against the Railway GraphQL API:

- `Project-Access-Token` → resolves to exactly this project + `production`.
- `Authorization: Bearer` → `Not Authorized` on `me`.

Consequently `railway whoami` fails by design (project tokens have no account
identity), while `railway status`, `run`, and `up` work. The Railway MCP
server authenticates separately and does **not** use this variable.

---

## 2. Deployment attempts

| # | Deployment ID | Context uploaded from | Result |
| --- | --- | --- | --- |
| 1 | `e6d21da6-f7f5-486e-9155-3386c6069bbb` | `spotme/backend` | **FAILED** (build, 12 s) |
| 2 | — (never created) | staged root w/ `spotme/backend` prefix | **BLOCKED** before dispatch |
| 3 | — (never created) | repo root `/home/user/fable` | **BLOCKED** before dispatch |

### Attempt 1 — build failure, log excerpt

```
scheduling build on Metal builder "builder-gcykae"
fetched snapshot sha256:6fc916d26c9b074ff77db1e3f1feeb0000eaa097d1f240750fec6a03accb2e86 (637 kB bytes)
unpacking archive
Build Failed: fsutil.NewFS(/var/lib/builder/build-sessions/
  e6d21da6-f7f5-486e-9155-3386c6069bbb/snapshot-target-unpack/spotme/backend):
  resolve : lstat /var/lib/builder/build-sessions/
  e6d21da6-f7f5-486e-9155-3386c6069bbb/snapshot-target-unpack/spotme:
  no such file or directory
```

**Root cause.** The service sets `source.rootDirectory = spotme/backend`, and
Railway applies that path *inside the uploaded snapshot* for CLI uploads, not
only for GitHub-sourced builds. The upload was made from `spotme/backend`, so
the snapshot root already *was* the backend directory and contained no
`spotme/` entry. The builder then tried to descend into
`<snapshot>/spotme/backend` and found nothing.

This means `npm run deploy` in `spotme/backend/package.json`
(`predeploy` + `railway up --detach`) cannot work as written while
`rootDirectory` is set to `spotme/backend` — it always uploads the wrong root.
Either the upload must originate from the repository root, or `rootDirectory`
must be cleared for CLI uploads. **Not changed in this session** — altering
service config was outside the mission scope.

The build never reached the Dockerfile, so the `deploy-api/translate.js`
assertion was never evaluated. Staging was nevertheless performed and verified
locally beforehand: `npm run predeploy` copied all 8 handlers
(`_auth.js`, `knock.js`, `presence.js`, `push.js`, `translate.js`, `turn.js`,
`username.js`, `voice.js`) into `deploy-api/`.

### Attempts 2 and 3 — blocked by tooling policy, not by Railway

Both corrected-context uploads were refused by the session's permission
classifier before any request reached Railway. No deployment record exists for
either. The corrected context was validated locally first (Dockerfile,
`deploy-api/translate.js`, `prisma/schema.prisma`, `src/` all present; no
`node_modules` or `dist` leaked; 3.1 MB).

Deploying master therefore requires an operator with permission to run
`railway up` from the repository root, or a re-run of this mission with that
Bash permission granted.

---

## 3. Migrations

**None applied. `prisma migrate deploy` never ran against production.**

The instructed step — `railway run npx prisma migrate deploy` — **cannot work
from outside Railway**, independently of the deploy failure. `DATABASE_URL`
resolves to a host on Railway's private network:

```
Datasource "db": PostgreSQL database "railway", schema "public"
  at "postgis.railway.internal:5432"
Error: P1001: Can't reach database server at `postgis.railway.internal:5432`
```

`railway run` injects the production environment but executes the process
**locally**, and `*.railway.internal` resolves only inside Railway. The
`DATABASE_URL` value was never printed; only its hostname suffix, port, and
protocol were inspected.

Two findings follow:

1. **A separate migrate step is redundant here.** The image already runs
   migrations in-network at container boot:
   `CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]`.
   A successful deploy applies pending migrations by itself.
2. **The live database is the `postgis` service, not `Postgres`.**
   `DATABASE_URL` points at `postgis.railway.internal`. The `Postgres` service
   (last deployed 2026-07-30) appears to be an unused leftover. Flagged only —
   neither service was touched.

23 migration directories exist in `spotme/backend/prisma/migrations/`, the
newest being `20260806180000_moment_media_composer_edits`. Which of these are
already applied could not be determined: it needs an in-network query, and
`railway ssh` requires registering an SSH key on the Railway account, which was
not done because it mutates account state that nobody authorised.

---

## 4. Verification

The post-deploy checks are **not satisfied**, because there is no new
deployment to verify. The endpoint checks below were still run, and they pass —
but they exercise the **previous** build, so they are evidence that the failed
deploy did no harm, not evidence that master works.

| Check | Required | Observed | Verdict |
| --- | --- | --- | --- |
| New deployment ID + SUCCESS | new ID, `SUCCESS` | `e6d21da6` → `FAILED` | **FAIL** |
| SHA `772a92a` live | deployed | not deployed | **FAIL** |
| Migrations applied | recorded list | none ran | **FAIL** |
| `GET /health` | 200 | 200 `{"status":"ok"}` | PASS *(old build)* |
| `GET /ready` db up | 200, db up | 200, `"db":"up"` | PASS *(old build)* |
| `GET /ready` redis up | 200, redis up | 200, `"redis":"up"` | PASS *(old build)* |
| Socket.IO handshake | 200 | 200, sid issued, `upgrades:["websocket"]` | PASS *(old build)* |

`/ready` response: `{"status":"ready","checks":{"db":"up","redis":"up"}}`

Socket.IO remains on Socket.IO; no transport was cut over to Centrifugo.

### Live deployment state

`650bbd4d` — named in the mission as the current live deployment — is now
`REMOVED` (superseded 09:06 UTC). The live deployment is
`22072780-c2f9-4e52-8033-ffb638e46f58` (`SUCCESS`, created 09:05:01 UTC,
`reason: redeploy`).

**This redeploy was not initiated by this session** and appeared between the
baseline check and the upload. Its source snapshot is unknown, and Railway
snapshot deployments carry no git SHA, so **the SHA currently serving
production cannot be determined from the API.** Worth confirming with whoever
or whatever triggered it before the next attempt.

---

## 5. Constraints honoured

- Lowercase orphan variables (`google r2`, `livekit`, `metered`, `redis`,
  `s3_bucket`, `typesense`) and the malformed names (`GITHUB_TOKEN\n`,
  `GOOGLE_MAPS API`) were **not** renamed, deleted, or modified.
- `Postgres`, `postgis`, `valkey`, `centrifugo` were **not** touched — read-only
  status queries only.
- Chat transport left on Socket.IO.
- No branch deployed; no moments work from
  `claude/vercel-token-connection-bj4d21` included.
- No environment variable value printed, logged, or committed.

## 6. Report-location note

The mission specified appending to this file as one that "already carries the
BLOCKER section this closes." No such file existed — not in the working tree,
not on `origin/master`, and not anywhere in git history — and no report under
`spotme/docs/reports/` contains a BLOCKER section. This file was therefore
created rather than appended to, and it closes nothing.

## 7. Next actions

1. Re-run the deploy with permission to run `railway up` from the repository
   root, so the snapshot contains the `spotme/backend/` prefix that
   `rootDirectory` requires.
2. Decide the durable fix for the context mismatch: either clear
   `rootDirectory` on the `api` service and keep uploading from
   `spotme/backend`, or change `package.json`'s `deploy` script to upload from
   the repository root. As it stands, the documented `npm run deploy` path is
   broken.
3. Confirm the provenance of redeploy `22072780`.
4. Let the boot-time `prisma migrate deploy` apply migrations, and read the
   applied names from the deploy logs — a local `railway run` cannot reach the
   private-network database.
