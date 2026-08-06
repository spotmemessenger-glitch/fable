# ADR-029 — The 18+ Age Gate (owner decision D6)

**Status:** Accepted (owner-decided, Wave 1B mission, 2026-08-05)
**Decides:** open policy item D6 (previously retained in `handbook/DECISIONS.md`)

## Decision

Spot Me is **18+ at launch, enforced at the account level**. No minor holds an
account; therefore no minor can ever be discoverable, matchable, or messageable.
The gate is policy, not a feature — it ships **before** any Discovery
activation and has no kill-switch.

## What is stored, and why only this

A self-declared **birth year-month** (`YYYY-MM`), the declaration **timestamp**,
and the **version of the policy text** shown at declaration. Never a full date
of birth.

- An attestation checkbox alone is unverifiable server-side — there is no age
  math to run, and "I am 18: true" from a client is precisely the tampered
  payload the gate must ignore.
- A full DOB is more precision than the decision needs; the day component is
  what turns a demographic into an identifier (birthday-based social
  engineering, cross-dataset linkage).
- Year-month is the minimum viable input for a **server-computed** decision.

## The decision rule

**Conservative UTC month rule:** a declarant is eligible only when the month of
their 18th birthday has *fully passed* in UTC. Someone born 2008-08 is refused
throughout 2026-08 and accepted from 2026-09-01 UTC.

- "Turns 18 today" → refused, by design, deterministically.
- Timezone edges → absorbed by a whole month of margin.
- Leap-day → cannot exist; no day is stored.
- Once eligible, always eligible (age is monotonic) — `ageVerified` never
  needs re-checking against the clock.

## Enforcement points (defence in depth)

1. **Account creation** (`/auth/signup`, `/auth/guest` create branch): the age
   decision runs server-side BEFORE any DB query; refusal creates **no row**
   and returns the same 400 shape as any validation failure (non-enumerable),
   with clear, non-punitive copy.
2. **Existing accounts** (predating the gate): `ageVerificationRequired`
   surfaces on login; the one-time declaration lands via re-auth payload or
   `POST /api/users/me/age`. Existing chat keeps working — the gate never
   locks a person out of their own messages.
3. **Discovery's door**: `DomainGate('discovery', { requireAdult: true })`
   re-reads the CURRENT row inside the gate — flag off → 404 (dark); flag on +
   unverified → 403 `age_requirement`. A replayed pre-gate token proves
   nothing; an activation mistake cannot expose an ungated account.

## Immutability and the support path

The first declaration sticks — verified **or refused** — and the API can never
rewrite it (409). An under-18 declaration is recorded before refusal so it
cannot be retried with a different year. Corrections are a **support path**:
an operator, on a verified support request, updates `birthYearMonth` /
`ageVerified` directly (in-network SQL or a future admin tool), leaving
`ageVerifiedAt`/`agePolicyVersion` restamped. No support UI is built now.

## Privacy of the declaration

`birthYearMonth`, `agePolicyVersion`, `ageVerifyRef`, and `ageVerifiedAt` never
appear in any API response, log line, or analytics event. The only age fact a
client ever sees is the **`ageVerified` boolean**, and only about the account's
own profile — public lookups carry no age facts at all. (Hardening done in the
same change: `PATCH /users/me`, `/auth/signup`, uninstall and delete responses
no longer return raw rows.)

## Consequences

- Wave 1C mounts Discovery behind `DomainGate('discovery', { requireAdult:
  true })` — both checks, always.
- Clients must collect the year-month at onboarding and handle
  `ageVerificationRequired` on login (legacy app: on its next update).
- A one-month worst-case refusal delay at the boundary is accepted in exchange
  for zero under-age admissions at the boundary.
