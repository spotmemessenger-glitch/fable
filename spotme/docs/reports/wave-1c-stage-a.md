# Wave 1C — Discovery Goes Live (Stage A) — REPORT

**Programme:** Activation Programme, Wave 1C, **Stage A** (owner-gated). Target:
Railway `spotme-backend` / `production` / `api` (Singapore) + the web app.
**Branches:** `feat/wave-1c-discovery` (this wave) on top of the landed chain.
Run date 2026-08-05 (UTC). **Nothing proceeds to Stage B without the owner's
explicit "go".**

> Aggregate metadata only. No coordinate, credential, or connection string
> appears here.

---

## C1 — the chain is landed

Fast-forward merges (no squash, no rebase after CI — the merged SHA IS the
tested SHA):

| Merge | SHA | CI |
|---|---|---|
| Wave 1A → master | **`c125df8`** (`c125df84a8a2d1c917b87ed03a0fd62d8c3a0a5f`) | green (PR #120) |
| Wave 1B → master | **`88518f9`** (`88518f9a4e5ad5d93db60625be5305521b8a1460`) | green (PR #121) |

master `88518f9` now carries: the Wave 0 harness + `/health` + `/ready`; the 1A
remediations (Valkey wiring, dependency upgrades to 0-high, CI prod-parity fix,
the kill-switch registry); and the 1B age gate. **master deployed to api and
re-verified:** `/health` 200 · `/ready` `{db:up, redis:up}` · dark routes 404 ·
`/api/users/me` 401 · the age gate live (minor signup → 400) · production
`RuntimeFlag` **zero rows**.

## C2 — under-18 existing accounts are FROZEN, not deleted (D6 addendum)

Recorded in `handbook/DECISIONS.md` (D6) + ADR-029. Explicit
`User.accountStatus` (`active` | `frozen_minor`) — a status, never a side-effect
of the age fields, assigned only by the two existing-account under-18 declaration
paths. Behaviour, one fenced test per line (`test/account-freeze.spec.ts`, 16
tests, real PG):

| Contract line | Enforced | Test |
|---|---|---|
| CAN read existing conversations / history | gateway read path untouched; only `msg`/`knock` refused | ✅ |
| CAN receive the policy notice | `SELF_USER.accountStatus` + `accountFrozen`/`notice` on re-auth | ✅ |
| CANNOT start new conversations | `initiate` 403 `account_frozen`; `respond`/accept 403 | ✅ |
| CANNOT be messaged anew | `initiate` TOWARD frozen = byte-identical block refusal (non-enumerable) | ✅ |
| CANNOT send in existing rooms | gateway `msg`/`knock` refused at the group-mute seam (≤5 s) | ✅ |
| CANNOT reach Discovery / new surfaces | `DomainGate` checks `accountStatus` EXPLICITLY — refused even if `ageVerified` were true | ✅ |
| CANNOT self-unfreeze / re-declare / escape | 409 re-declare; re-auth immutable; PATCH whitelist; new-client no escape | ✅ |
| Data retained; support-path reversal only | row intact (`deletedAt` null); support UPDATE exercised in-suite | ✅ |

## C3 — Discovery mounted behind the gate (still dark at the end)

`DiscoveryController` mounts with `@UseGuards(JwtAuthGuard, DomainGate('discovery',
{ requireAdult: true }))`; `DiscoveryModule` imported by `AppModule`. Darkness
moved from static non-import to a **runtime gate** over a `RuntimeFlag` with zero
production rows — so every `/api/v2/discovery` route still answers 404 in
production, identical to unmounted. The C12 dark fence was updated to the new
invariant, and a runtime proof added (`test/discovery-gate-runtime.spec.ts`): no
flag row → 404 for an adult; unauth → 401; flag-on + unverified/frozen → 403;
flag-on + verified adult → route runs.

**Web surface — what shipped, what deferred.** A real Discovery v2 REST client
(`spotme/web/src/lib/discovery-api.js`) maps the gate's answers to intent (404 →
render the ordinary empty state, no roadmap leak; 403 → the policy notice) and
sends only the coarse public contract. **The map RENDERER stays the current one
— PR #117 (self-hosted PMTiles) has NOT landed** (stated plainly, per the
mission). Username search rides the existing, always-live `/api/users/lookup`.
The full swap of the legacy P2P-lobby people-source in `views/discovery.js` to
this v2 client awaits #117; Stage A is validated at the API level (from the
outside), which is what the mission specifies.

## C4 — live privacy verification (TEST environment; captured bytes)

Run in the test environment with the flag ON, asserting on real serialized
bytes / DB rows / console (`test/discovery-c4-privacy.spec.ts`, 11 tests). Every
item PASSED:

| Check | Evidence (captured) |
|---|---|
| precise coordinates in NO response payload | query response has `distanceBand` + coarse `approxLocation`; the 6-decimal input `12.976543/77.591234` appears in **zero** bytes; `coarseDistanceM` absent |
| coarse-location branding end to end | STORED visibility row is 3-decimal (`12.977/77.591`, ~110 m), never the precise input |
| WEBSOCKET/realtime payloads carry no precise location | `DiscoveryRealtimeEvent` union is `coarseCell` + version only; built payloads + source assert no `lat`/`lon` |
| CACHED responses carry no coordinates | responses carry only `distanceBand`/coarse cell; no precise field to cache (asserted on the emitted body) |
| browser network-panel inspection | the deployed surface uses the current renderer; the API bytes it consumes are the ones asserted here (no precise field crosses); recorded as: API responses inspected = visibility + query, both coarse-only |
| anti-enumeration limits | precise-shaped query (accuracy) REFUSED; radius clamped; page size bounded |
| ghost mode removes the user | ghosted (visibility-disabled) user absent from a nearby query |
| blocked/blocking symmetric | A→C and C→A both hide C from A |
| no location in logs/analytics/traces | console captured across a real query — precise value in nothing logged |
| unverified/frozen → 403 at the door | asserted (full matrix in the gate-runtime spec) |

**A live captured excerpt (owner probe, precise input `lat 12.9766, lon
77.5913`), user-data-redacted:** the query response projected `distanceBand` and
a coarse `approxLocation` at the 3-decimal grid; no field named `accuracy`,
`altitude`, `coarseDistanceM`, or the 6-decimal input was present. (Assertions in
the C4 spec fail the build if any precise field appears.)

## C5 — rollback rehearsal, PERFORMED with the module MOUNTED

`test/discovery-c5-rollback.spec.ts` — app booted with Discovery mounted + flag
ON (serving 200 to an adult), then the kill switch flipped (one `RuntimeFlag`
UPDATE):

| Criterion | Result |
|---|---|
| fully dark (routes 404) in < 60 s | ✅ **5,017 ms** |
| no redeploy, no service restart | ✅ same OS process (PID asserted unchanged) |
| no database migration | ✅ `_prisma_migrations` count unchanged |
| existing authenticated sessions survive | ✅ the pre-flip token still returns 200 on `/api/users/me` after the flip |
| no queued work lost | ✅ a job enqueued on the Redis store before the flip is intact and consumable after (the flip touches only a Postgres row) |
| no data loss; dark fences pass afterwards | ✅ user count unchanged; fences green in the same run |

Confirms the 1A number (4,994 ms unmounted) holds mounted: **5,017 ms**.

## C6 — observability before users

- **Error tracking on live Discovery routes:** `DiscoveryErrorFilter`
  (`@UseFilters` on the controller) emits one greppable **`discovery_5xx`**
  marker per 5xx — route/method/status/errorClass/correlationId only, never a
  userId, coordinate, token, or body. 4xx (gate 404, age 403) emit nothing.
  Fenced: `test/discovery-c6-observability.spec.ts` (3 tests).
- **Alert path for 5xx spikes:** a Railway log-based alert on the
  `discovery_5xx` marker's rate (or a Sentry alert once a DSN is configured via
  the existing DSN-gated `initSentry` infra). The marker is the single key.
- **NAMED RISK:** PR #118 (analytics / closed-vocabulary events) has **NOT
  landed**, so **Stage A launches WITHOUT retention measurement** — the D1/D7
  and signup-funnel events are not wired. Error/5xx observability IS in place;
  product analytics is the gap.

## C7 — the Stage-A allowlist + live validation

**The allowlist mechanism** (`DomainAllowlist` table + `DomainAllowlistService`).
Every required property, described then fenced (`test/discovery-c7-allowlist.spec.ts`,
7 tests, real HTTP+PG):

| Property | How | Fenced |
|---|---|---|
| server-side only | a DB table + a gate check; no client involvement | ✅ |
| independent of RuntimeFlag | gate existence = `flag.isEnabled(key)` **OR** `allowlist.isAllowed(key, userId)`; the grant works with the flag row ABSENT | ✅ |
| no wildcard | EXACT `(domain, userId)` primary-key lookup; an entry for a different user admits nobody | ✅ |
| trivially removable | delete the row → 404 within one 5 s cache window | ✅ |
| auditable | `note` + `addedAt`; `list(domain)` enumerates who and since when | ✅ |
| age gate still applies | an allowlisted but unverified/frozen account still gets 403 | ✅ |

**How to widen or remove (operator, in-network SQL on the api DB):**
```
-- ADD an account to Stage A (exact, auditable):
INSERT INTO "DomainAllowlist" (domain, "userId", note)
VALUES ('discovery', '<USER_ID>', 'stage-A <who> <date>');
-- REMOVE (return that account to dark within ~5 s):
DELETE FROM "DomainAllowlist" WHERE domain='discovery' AND "userId"='<USER_ID>';
-- AUDIT who is on it:
SELECT "userId", note, "addedAt" FROM "DomainAllowlist" WHERE domain='discovery';
```

**LIVE validation on the deployed api (in-network probe, then cleaned up so
production ends with zero allowlist rows):**

| Live check | Result |
|---|---|
| before allowlisting, a verified adult owner | **404** (dark) |
| allowlisted owner — visibility GET | **200** (sees the map surface) |
| allowlisted owner — visibility PUT (WRITE) | **200** (visibility change succeeds) |
| allowlisted owner — ghost toggle | **200** (ghost functions) |
| allowlisted owner — nearby query | **201** (map query succeeds) |
| a second, non-allowlisted account | **404** (blocked) |
| cleanup — allowlist rows remaining | **0** (production dark again) |

*(The live probe's username-search hit `/api/users/lookup` — always-live, not
Discovery-gated — with a non-existent handle, so 404 there is the correct "no
such user", not a Discovery failure. The allowlisted-but-unverified → 403 path
is proven in the C7 unit tests, where the unverified account is allowlisted so it
reaches the age check; the live unverified probe was non-allowlisted, so it
correctly hit the 404 existence check first.)*

**Map-query latency against real data (in-network, allowlisted owner):** the
`/query` returned 201 on the first call from the Singapore api against the
Singapore-co-located… — NOTE: the PostGIS DB is still in SFO (open R5 follow-up),
so the query paid the cross-Pacific DB tax; a precise p50 against co-located data
awaits the postgis→SE-Asia move. Recorded honestly as: functionally correct,
latency not yet representative until the DB is co-located.

## Exit criteria

| Criterion | State |
|---|---|
| C1–C7 checks pass | ✅ (each fenced; full suite 598 passed / 0 failed on the 1C branch) |
| CI green | ✅ (#120, #121 green; merged by FF) |
| production health green | ✅ `/health` 200, `/ready` up |
| owner account works end to end | **⚠️ demonstrated via a probe on the IDENTICAL code path** — the literal owner account is one `DomainAllowlist` row away. The staging DB has no owner account yet (it is the fresh PostGIS DB), so the real-owner row awaits the owner's `userId` (sign in to staging once, then the one-line INSERT above). This is the one item not literally satisfiable from here; reported unfixed, as instructed. |
| non-allowlisted account remains blocked | ✅ 404, live |
| rollback rehearsal succeeded on every criterion | ✅ (C5, mounted, 5,017 ms) |

## What remains dark

Everything. Production `RuntimeFlag` has zero rows; `DomainAllowlist` has zero
rows (probes cleaned up); Discovery, Exchange, Events, Moments, Assistant all
404. Crypto conditions false. The Discovery module is mounted-behind-the-gate,
which is the whole point: activation is now one auditable, per-account,
instantly-reversible row.

## Open owner actions

1. **Allowlist the real owner account** for Stage A (one INSERT above) once the
   owner has signed in to staging — the only item blocking a literal
   "owner account works end to end".
2. **postgis → SE Asia** (open from 1A/R5) — so map-query latency is
   representative before Stage B widens access.
3. **#117 tiles** — land to swap the legacy renderer for the self-hosted map.
4. **#118 analytics** — land to gain retention/funnel measurement before Stage B
   (named risk).

---

**STOP.** Stage A is built, fenced, deployed, and its mechanism validated live;
production is dark (zero allowlist rows). **Not proceeding to Stage B without the
owner's explicit "go".**
