# 03 — State Diagrams & Lifecycle

> Reconstruction pending A5 ratification. States/transitions `[PROPOSED]`,
> chosen to mirror the Live Events lifecycle where possible `[REUSE]`.

## 3.1 Need lifecycle

```
 DRAFT ──submit──▶ ACTIVE ──matches proposed──▶ MATCHED ──user opens chat──▶ IN_CONVERSATION
   │                 │  │                          │                              │
   │                 │  │◀───no match accepted─────┘                              │
   │                 │  ▼                                                         ▼
   └──discard──▶ (deleted)  EXPIRED ◀──ttl/withdraw──┘                       RESOLVED / CLOSED
                                                                                  │
                                                                            ▶ CLOSED (archived)
```

- **DRAFT** → **ACTIVE** on submit (passes safety pre-checks §06).
- **ACTIVE** → **MATCHED** when ≥1 match is proposed (still open to more).
- **MATCHED** → **IN_CONVERSATION** when the seeker opens a chat with a matched
  counterpart (handoff, §03.4).
- **IN_CONVERSATION** → **RESOLVED** when the seeker marks it resolved (or
  **CLOSED** without resolution).
- **ACTIVE/MATCHED** → **EXPIRED** on TTL (`[PROPOSED]` 24h, extendable) or
  **withdraw**.
- Any state → **REMOVED** by moderation (§06).

## 3.2 Offer lifecycle

```
 DRAFT ──submit──▶ ACTIVE ──(responds to Needs / gets responses)──▶ ENGAGED ──▶ FULFILLED
   │                 │                                                 │            │
   │                 ▼                                                 ▼            ▼
   └──discard──▶ (deleted)   PAUSED ◀──owner pause──▶ ACTIVE      EXPIRED       CLOSED
```

- Offers may be **recurring**: on FULFILLED/EXPIRED a recurring Offer can
  auto-return to ACTIVE per its schedule `[PROPOSED]`.
- **PAUSED** hides the Offer from matching without deleting it.
- Business Offers add a **verification** gate before ACTIVE (§10).

## 3.3 Match lifecycle

```
 PROPOSED ──seeker views──▶ VIEWED ──seeker acts──▶ ACCEPTED ──▶ (handoff)
    │                          │                         │
    │                          ▼                         ▼
    └──superseded/expired──▶ DISMISSED              DECLINED (by either side)
```

- A **Match** is ephemeral matching state between one Need and one Offer.
- **PROPOSED** matches are recomputed as inputs change; a stale match is
  **superseded** (epoch guard `[REUSE]` the Discovery supersede pattern).
- **ACCEPTED** triggers the Handoff; **DECLINED/DISMISSED** feed negative signal
  to ranking (non-sensitive only).

## 3.4 Conversation handoff

```
 Match ACCEPTED
   │
   ▼
 CONSENT GATE ──(what each side reveals; location precision choice)──▶ KNOCK sent
   │  decline                                                            │
   ▼                                                                     ▼
 back to Match Detail                                        Chat opened (Communication)
                                                                         │
                                                         ▼ conversation drives Need/Offer state
```

- The **consent gate** is mandatory: neither side's exact location or private
  profile is revealed by the act of matching; sharing more is an explicit choice
  at handoff (§07).
- Handoff reuses the existing **knock → chat** mechanism (`reach.js`) `[REUSE]`;
  Exchange attaches a structured context card (the Need/Offer summary) to the
  knock.

## 3.5 Invariants (tested deterministically)

- A Match cannot reach ACCEPTED without both objects ACTIVE/valid at accept time.
- Expiry/withdrawal of either object immediately invalidates open matches.
- No state transition exposes exact location or identity beyond what the consent
  gate permitted (mutation-tested, §07).
- Recompute is idempotent and supersede-safe: a newer matching run never renders
  behind an older one.
