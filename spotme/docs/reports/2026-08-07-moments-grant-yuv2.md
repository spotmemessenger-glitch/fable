# Moments grant — @yuv2 — 2026-08-07

Mission: open Moments for `@yuv2` alone, via `DomainAllowlist` on production.
One allowlist row, `domain='moments'`. No RuntimeFlag, no flag flip, no change
to the `discovery` allowlist.

**Outcome: script prepared and committed. NOT YET EXECUTED — execution needs a
backend deploy, which is a decision outside this mission's stated scope.**

---

## 1. Does `@yuv2` exist in production? — YES

Confirmed without database access, via the public username registry the app's
own search uses:

```
GET /api/username?q=yuv2  →  1 result: username=yuv2, name="yuv"
GET /api/username?q=yuv   →  2 results: yuv2, yuvs11
```

So the mission's STOP condition (account absent after the region move) does not
apply. Note `yuvs11` also exists; the script's selector is an exact
`username` match, so it cannot reach that account.

What this check does **not** establish, because it needs the database:
`ageVerified` and `accountStatus`. The gate requires both
(`requireAdult: true`), and the script reports an ineligible invitee as
`invitees_not_eligible` rather than granting. If `@yuv2` has not made the 18+
declaration, the run will say so and add no row.

## 2. Script change — `src/scripts/wave1c/owner-grant.ts`

| | before | after |
|---|---|---|
| `DOMAIN` | `'discovery'` | `'moments'` |
| `INVITED` | owner by email | `[{ username: 'yuv2' }]` |
| probe surface | `/v2/discovery/visibility` + `POST /query` | `/v1/moments/feed?mode=friends` + `GET /stories/rail` |
| flag assertion | `runtimeflag_discovery_rows` | `runtimeflag_rows_for_domain` |

**The `discovery` rows cannot be touched by this run.** `DOMAIN` scopes every
`domainAllowlist` read and write in the file — verified, all seven call sites
carry `domain: DOMAIN`. `discovery` rows live under a different
`(domain, userId)` key and are never queried.

The second probe is `GET /stories/rail`, deliberately read-only: it proves the
whole domain opened rather than one handler, without creating any Moments
content.

`npx tsc --noEmit` → exit 0.

## 3. Pre-op allowlist count — NOT OBTAINED

Requires the database. See the blocker.

## 4. Verification — NOT RUN

The script's four checks are unchanged and will run when it does:
`@yuv2 → 200`, non-allowlisted adult → 404, allowlisted-but-unverified → 403,
`RuntimeFlag` rows for `moments` → 0, final row count == located invitees.

One check is already independently true right now: a **freshly created,
non-allowlisted account gets 404** on `/api/v1/moments/feed` and
`/api/v1/moments/stories/rail` — re-confirmed against production during this
mission. That is the "still dark for everyone else" half of the assertion,
holding before the change.

## 5. No RuntimeFlag created, no flag flipped

Nothing was executed against production, so this holds trivially. It is also
enforced in the script: it asserts zero `RuntimeFlag` rows for the domain and
never creates one.

---

## BLOCKER — execution needs the deployed image

The script runs **inside** the deployed container by design (its own header:
"Runs INSIDE the deployed image (needs the private DB + a loopback HTTP call),
wired transiently into `main.ts` for one deploy and reverted after capture").

Both halves of that are hard requirements here:

- **Private database.** The `api` service's `DATABASE_URL` resolves to a
  `*.railway.internal` host. From outside Railway's private network it does not
  resolve at all (`gaierror`), so no external process can reach it. The
  internet-reachable `Postgres` service is the unused leftover, not the
  application database.
- **Loopback HTTP.** Verification mints an internal token and calls
  `http://127.0.0.1:<port>/api`, which only exists in-process.

Paths considered and why each is closed:

| Path | Result |
|---|---|
| Run from CI container against prod DB | Private hostname, unreachable |
| `railway run` | Injects env locally; the private host still does not resolve |
| `railway ssh` into the running container | CLI installed and authenticated (project token, `railway status` OK), but SSH needs a registered key; key generation was blocked by this environment's command classifier. Not worked around |
| Public `Postgres` TCP proxy | Wrong database — unused leftover |

**The remaining path is a deploy** (`railway up` from the repo root, with the
script wired transiently into `main.ts`, captured, then reverted). That is not
"one allowlist row": a deploy of current `master` also ships every backend
change merged since the running image was built. That is a sequencing decision
for the owner, not something this mission authorises, so it was not done.

Everything up to that point is ready: the script is committed and typechecks,
and the target account is confirmed to exist.

---

## Revocation

`DELETE FROM "DomainAllowlist" WHERE domain='moments' AND "userId"=<yuv2>;`
Dark again for that account within one 5-second cache window. Every row carries
`note` and `addedAt`.

## Notes

- Environment variables referenced by name only; no values appear here.
- No user id is recorded; the script masks selectors and never logs an id.
