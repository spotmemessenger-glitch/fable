# Deploy + drive — 2026-08-07

Mission: deploy `api` (Railway) and `spotme-web-v2` (Vercel) from `master`,
then drive the full surface with two fresh accounts. No flags enabled.

**Outcome: web deployed and fully driven (13/13 PASS). Backend deploy BLOCKED —
no Railway credential in this environment.**

---

## What was deployed

| Piece | Target | SHA | Result |
|---|---|---|---|
| Web (`spotme/web`) | Vercel project `spotme-web-v2`, production | `772a92ab035b42e468fcbd330a5e9521f7ba38b0` | **Deployed** |
| Backend (`spotme/backend`) | Railway `spotme-backend` / production / `api` | — | **BLOCKED — not deployed** |

- Production web URL: `https://spotme-web-v2.vercel.app`
- Deployment URL: `https://spotme-web-v2-8rp0atjd9-ysnap.vercel.app`
- API in use (already-running instance): `https://api-production-0a4ca.up.railway.app`

`web-next` did not ship: the project's root directory is `spotme/web`, and the
deployed output was verified to contain zero references to `web-next`.

---

## BLOCKER — backend not deployed, migrations not run

`RAILWAY_TOKEN` is **not present** in this environment. Also absent: the
`railway` CLI, any `~/.railway` / `~/.config/railway` credential, and the
Railway MCP tooling (the server disconnected mid-session). `DATABASE_URL` is
likewise unavailable, so `prisma migrate deploy` could not be run either.

| Item | Status |
|---|---|
| Backend deploy of `772a92a` | **FAIL (blocked)** — no credential |
| `prisma migrate deploy` | **FAIL (blocked)** — no `DATABASE_URL` |

Nothing was changed on Railway. Per the mission constraints, no lowercase
orphan variables were touched and the chat transport was left on Socket.IO —
both remain exactly as they were, because no Railway operation was performed at
all.

The API currently serving production is the instance that was already running
(deployed 06:50 UTC today, before this mission). Every check and drive below
ran against **that** instance, not against a newly deployed `772a92a` backend.
Whether `772a92a`'s backend changes are live is therefore **unverified**.

### A second, unrelated blocker worth recording

`vercel build` for `spotme-web-v2` fails on this project with
`vite: command not found` (exit 127). The project carries `NODE_ENV` as a
Vercel environment variable, so `npm install` omits devDependencies — vite
among them — and the build dies. Measured: with `NODE_ENV=production`, a plain
install yields 28 packages and no vite; `--include=dev` yields 223 with vite
present.

This was worked around for this deploy by building `master`'s source locally
(with the API origin baked in) and shipping the result through the Build Output
API, so the deployed bytes are `772a92a`'s. A durable fix —
`"installCommand": "npm install --include=dev"` in `spotme/web/vercel.json` —
is on branch `claude/vercel-token-connection-bj4d21` (PR #136), not on master.

---

## Health checks

| Check | Result |
|---|---|
| `GET /health` | **PASS** — `200 {"status":"ok"}` |
| `GET /ready` | **PASS** — `200 {"status":"ready","checks":{"db":"up","redis":"up"}}` |
| Socket.IO handshake | **PASS** — `200`, `upgrades:["websocket"]` |
| Websocket upgrade (real, in-browser) | **PASS** — live `ws://…/socket.io/?EIO=4&transport=websocket` |
| Web app loads, points at prod API | **PASS** — `200`, API origin present in the served bundle |

---

## Browser drive

Two fresh accounts, iPhone-12 viewport (390×844), touch, mobile UA,
geolocation granted. No flags enabled at any point.

| # | Item | Result | Note |
|---|---|---|---|
| 1 | Fresh signup — account A | **PASS** | registry claim + guest auth |
| 2 | Fresh signup — account B | **PASS** | |
| 3 | Websocket connect | **PASS** | real upgrade, not just polling |
| 4 | Username search | **PASS** | A found B by `@username` |
| 5 | DM send (A→B) | **PASS** | |
| 6 | DM receive (B) | **PASS** | delivered and visible on B's device |
| 7 | Group create | **PASS** | |
| 8 | Media upload | **PASS** | photo through the editor, sent into a thread |
| 9 | Voice note | **PASS** | recorder starts and shows its UI |
| 10 | Translation / language surface | **PASS** | present in settings |
| 11 | Nearby map | **PASS** | |
| 12 | Ghost mode toggle | **PASS** | |
| 13 | Dark features stay dark | **PASS** | Posts/Moments gated; no flag enabled |

No uncaught page errors and no 5xx responses were observed on either device
during the drive.

### Accounts created

- `@drvuxorf7` (Ada Lovelace) and `@drvc6u6vh` (Grace Hopper) — main drive
- `@drveb0jio` and `@drv0n7znx` — media/voice/websocket confirmation pass

Earlier partial runs, before selector and timing fixes, also created
`@drvmilqgh`, `@drvf32d8f`, `@drvc9h83g`, `@drvpulone`, `@drv1fu70r`,
`@drvnd8zwp`. All are ordinary guest accounts on production.

### How the browser reached production

Worth recording, because it qualifies the drive. Chromium in this environment
has **no outbound network egress** — `example.com` resets with or without the
agent proxy, while `curl` and Node reach the same hosts normally. The public
`spotme-web-v2.vercel.app` URL therefore could not be loaded in a browser here.

The drive instead ran `master`'s web build, served locally, against the
**real production API** relayed through `127.0.0.1:4100`. So every result above
is genuine end-to-end behaviour against production data and the production
backend, exercising the same application code that was deployed — but the page
itself was served locally rather than fetched from the Vercel edge. The
deployed URL was verified separately over HTTP (`200`, correct bundle, correct
API origin baked in).

---

## Notes

- No secret values appear in this report; environment variables are named only.
- No feature flags were enabled. Moments/Posts remains dark for new accounts
  (404 at the domain gate), which is the expected state and is recorded as PASS.
