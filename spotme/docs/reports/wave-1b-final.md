# Wave 1B — Safety Layer: the 18+ Gate — FINAL REPORT

**Programme:** Activation Programme, Wave 1B. Server-enforced age gate; ships
**before** any Discovery activation. **No activation occurred; ends at a STOP.**
**Branch:** `feat/wave-1b-age-gate` (based on `feat/activation-wave-1a`, which
carries Wave 1A on top of master `ac7f8816`; 1A is not yet merged — landing
both is an owner call). Run date 2026-08-05 (UTC).

**D6 is RECORDED as DECIDED:** `handbook/DECISIONS.md` (new D6 section) +
**ADR-029** (`docs/adr/029-eighteen-plus-age-gate.md`).

---

## 1. Schema decision + minimization rationale

**Stored:** `User.birthYearMonth` (`'YYYY-MM'`), `User.agePolicyVersion`, and
the pre-existing `ageVerified` / `ageVerifiedAt`. Additive migration
`20260805150000_age_gate` (two nullable TEXT columns; NULL = declaration owed).

**Why year-month, not an attestation and not a full DOB:**

| Option | Verdict |
|---|---|
| Attestation checkbox only | ✗ unverifiable server-side — no age math to run; "adult: true" from a client is exactly the tampered payload B4 rejects |
| Full DOB | ✗ more than the decision needs; day precision is what turns a demographic into an identifier (birthday social-engineering, linkage) |
| **Year-month** | ✓ the minimum input for a **server-computed** decision; with the conservative rule below it also erases every day-level edge case |

**Decision rule — the conservative UTC month rule** (`src/policy/age.ts`, the
single place age math lives): eligible only when the 18th-birthday **month has
fully passed in UTC**. "Turns 18 today" is refused by design; a whole month of
margin absorbs every timezone; leap-day cannot exist because no day is stored.
Once eligible always eligible (age is monotonic). Worst case: an eligible
person waits out the remainder of their birthday month — accepted in exchange
for zero under-age admissions at the boundary.

## 2. Gate placement (three doors, defence in depth)

```
                       ┌────────────────────────────────────────────┐
 NEW ACCOUNT           │ B1  /auth/signup · /auth/guest (create)    │
 ───────────────────►  │  server-side decision BEFORE any DB query  │
                       │  under-18 → 400 (validation shape), NO row │
                       └────────────────────────────────────────────┘
                       ┌────────────────────────────────────────────┐
 EXISTING ACCOUNT      │ B2  login/re-auth → ageVerificationRequired│
 (predates the gate)   │  declare via re-auth payload or            │
 ───────────────────►  │  POST /users/me/age (one-time, immutable)  │
                       │  chat keeps working; refusal recorded      │
                       └────────────────────────────────────────────┘
                       ┌────────────────────────────────────────────┐
 DISCOVERY (dark)      │ B3  DomainGate('discovery',                │
 ───────────────────►  │       { requireAdult: true })              │
                       │  flag OFF → 404 (dark, unchanged)          │
                       │  flag ON + unverified/anon → 403           │
                       │  reads the CURRENT row, not the token      │
                       └────────────────────────────────────────────┘
```

Wave 1C's activation contract: Discovery mounts behind **both** checks; a flag
flipped by mistake still cannot expose an unverified account (proven in §3).

**Immutability / support path:** first declaration sticks — verified or
refused — and the API can never rewrite it (409 on any second declaration; a
refused minor cannot re-declare with a different year, on any path). The
correction path is support-operated (documented in ADR-029); no support UI is
built now.

## 3. Bypass-test table (all server-side, all green — `test/age-gate.spec.ts`, 32 tests, real Postgres)

| # | Attack / edge | Result |
|---|---|---|
| 1 | Crafted signup request skipping the DOB field | ✅ 400 at the real ValidationPipe config (`whitelist` + `forbidNonWhitelisted` + required field) |
| 2 | Tampered payload: `ageVerified: true` forced into signup body | ✅ 400 — non-whitelisted property rejected, never read |
| 3 | Tampered payload: `ageVerified` / `ageVerifiedAt` / `attestedAdult` forced into guest body | ✅ 400 each |
| 4 | Tampered payload: `birthYearMonth` / `ageVerified` smuggled into `PATCH /users/me` | ✅ 400 — profile updates can never touch the declaration |
| 5 | Under-18 DOB with an 18+ attestation flag forced true | ✅ refused — the server recomputes from the declaration; client flags are never read |
| 6 | Replayed pre-gate token → session continues (chat, B2) but account stays UNVERIFIED and flagged | ✅ `ageVerificationRequired: true`; row unverified |
| 7 | Replayed pre-gate token / anonymous principal → direct Discovery route hit, **flag ON** | ✅ 403 `age_requirement` (fail closed; test-DB flag only — production `RuntimeFlag` has zero rows) |
| 8 | Gateless account → direct Discovery route hit, flag ON | ✅ 403 `age_requirement` |
| 9 | Token minted while verified, row later un-verified (support correction) | ✅ 403 — the gate reads the CURRENT row, not the token |
| 10 | Birthday edge: turns 18 **this month** (incl. "today") | ✅ refused by design (conservative month rule) |
| 11 | Birthday edge: 18th-birthday month fully passed | ✅ accepted |
| 12 | Timezone edges | ✅ absorbed — one month of margin dwarfs any UTC offset |
| 13 | Leap-day (Feb 29 birth) | ✅ moot — no day stored; February year-months decide by month math |
| 14 | Structural garbage (future month, month 13, pre-1900, wrong format) | ✅ invalid at both DTO and policy layers |
| 15 | Under-18 guest CREATE → row existence probe | ✅ **no row created** (count asserted) |
| 16 | Under-18 signup with an already-taken username (enumeration probe) | ✅ age 400 wins — the decision runs BEFORE any uniqueness lookup, so refusal timing/shape matches ordinary validation |
| 17 | Immutability: second declaration via API (any path, any payload) | ✅ 409 / ignored — first declaration sticks, including a refused one |

**Non-enumerable refusal:** under-18 → HTTP 400 with the exact
`{statusCode, message[], error}` shape the global ValidationPipe emits, thrown
before any DB work, with clear non-punitive copy ("Spot Me is for people 18 and
over…").

## 4. Privacy fence evidence (B5)

- **Only `ageVerified` (boolean) is exposed, and only to the account itself**
  (`SELF_USER`). Public lookup (`findByUsername` / `PUBLIC_USER`) carries **no
  age facts at all** — not even the boolean.
- Fenced by test: `GET /users/me`-shape, public-lookup-shape, and
  `PATCH /users/me`-shape responses are serialized and asserted to contain
  neither the declared value nor any of `birthYearMonth`, `agePolicyVersion`,
  `ageVerifyRef`, `ageVerifiedAt`, `passwordHash`, `claimSecretHash`.
- **Hardening done in the same change (pre-existing raw-row leaks):**
  `PATCH /users/me` returned the raw Prisma row (including both credential
  hashes — the exact fields `SELF_USER` exists to withhold); `/auth/signup`,
  uninstall and delete responses did too. All four now return safe selected
  shapes.
- **Logs/analytics:** no logging statement in the auth/users path serializes a
  DTO or user row (`grep` over `src/auth`, `src/users`: the only `console.*`
  in scope is the web-api bridge error logger, which logs errors, not
  payloads); install telemetry (`trackDevice`) stores platform/appVersion
  only; the DLQ envelope sanitizer (Wave 1A) already strips payloads.
  `ValidationPipe` error messages name the FIELD, never echo the value.

## 5. Existing-user migration behaviour (B2)

- On **guest re-auth** and **OTP login**, the response now carries
  `ageVerificationRequired: !ageVerified`. Tokens are still issued — existing
  chat keeps working; nobody is locked out of their messages.
- The declaration lands once, either inline on re-auth (`birthYearMonth` in
  the guest payload — accounts predating the gate only) or via
  `POST /api/users/me/age`. Stored with `ageVerifiedAt` (timestamp) and
  `agePolicyVersion` (`18plus-v1`).
- An under-18 declaration by an existing account is **recorded** (so it cannot
  be retried with a different year), never verifies, answers 403
  `age_requirement` on the endpoint — and the account keeps its existing chat
  (B2). Follow-up handling of that cohort (owner policy: closure vs. hold) is
  a documented owner decision, not built here.
- **New surfaces:** every one of them (all currently dark) sits behind the B3
  gate, so "proceeds to no new surface until declared" is enforced
  structurally, not by client goodwill.

## 6. Rollback proof (B6) — deploying the gate changes nothing else

| Check | Before (Wave 1A close) | After (gate in place) |
|---|---|---|
| Full backend suite | 523 passed / 0 failed | **555 passed / 0 failed** (+32 age-gate fences) |
| Dark fences by filename | 5 suites / 63 tests ✅ | 5 suites / 63 tests ✅ (unchanged) |
| Kill-switch fences | 6 ✅ | 6 ✅ (plain `DomainGate` behaviour byte-identical: flag off → 404) |
| Dark routes on deployed api | 404 | 404 (verified live post-deploy) |
| Live route class | `/api/users/me` 401 | 401 |
| `/health` `/ready` | 200 / `{db:up, redis:up}` | 200 / `{db:up, redis:up}` |
| Crypto conditions | false | false (no crypto file touched) |
| `RuntimeFlag` rows in production | 0 | 0 (the B3 flag-on test runs in the TEST database only) |
| Migration | — | additive only (two nullable columns); applied at boot |

The gate itself has **no kill-switch, deliberately**: it is policy, not a
feature. Rolling back the deploy restores the prior build; the two nullable
columns are inert under old code.

## 7. What remains dark

Everything. Discovery, Exchange, Events, Moments, Assistant: unmounted, 404,
zero `RuntimeFlag` rows in production, crypto conditions false. Wave 1B added
policy enforcement to the *account layer* and to Discovery's future door — no
user-facing surface changed for a verified adult account beyond the new
(required) declaration at signup and the `ageVerificationRequired` login flag.

## 8. Open owner items

1. **Land the branch chain** (`feat/activation-wave-1a` → `feat/wave-1b-age-gate`)
   into master when ready — Wave 1A was never merged; 1B builds on it.
2. **Legacy client update** (Wave 1C scope): collect year-month at onboarding;
   handle `ageVerificationRequired`; the legacy production app is unaffected
   until it targets this backend.
3. **Under-18-declared existing accounts:** decide closure vs. hold policy
   (the cohort is identifiable server-side: `birthYearMonth` set,
   `ageVerified` false).
4. Housekeeping carried forward from 1A (Dragonfly decommission timing,
   Firebase key restriction, NestJS 11, postgis co-location).

---

**STOP.** Wave 1B ends here. The 18+ gate is built, fenced, adversarially
tested, deployed to staging, and recorded (D6 + ADR-029). **Wave 1C is not
begun; nothing was activated.**
