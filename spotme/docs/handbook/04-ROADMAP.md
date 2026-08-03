# 04 — Roadmap (Named Phases)

The roadmap uses **five descriptive phase names**, consistently, to give every
session one vocabulary. These phases are a higher-level grouping over the
detailed **Priority 1–13** work in the controlling document
`spotme/docs/MASTER-ENGINEERING-ROADMAP-V2.md` — they do **not** renumber or
replace it. Avoid inventing new numbered/lettered labels; use these names.

## The five phases

| # | Phase | What it covers | Roadmap V2 mapping |
|---|---|---|---|
| 1 | **Engineering Handbook** | Canonical project memory in the repo; six-state status; ADR backfill; bootstrap protocol. | This mission (governance for all priorities). |
| 2–3 | **AI Discovery & Social Platform** *(current active programme)* | Privacy-first local discovery + the social surfaces, delivered by the **fixed Discovery execution order** below: Smart Nearby Discovery Map → Live Nearby Events → Nearby Moments → AI Assistant & Personalization. Plus communities/channels and completing the merged messaging core. | P1, P7, P8. |
| 4 | **Integration & Activation** | Wiring the dark foundations in, staged flag activation, production hardening, launch safety. | P2 (production hardening), G8 activation milestone. |
| 5 | **Media Platform Evolution** | Media platform, camera/creative surfaces, voice/video, AI communication (interface-first). | P4 (media), P5 (voice/video), P6 (AI communication). |

> The phases are **not** strictly sequential across all work — foundations for
> phases 3 and 5 already exist as dark draft PRs (see
> [03-IMPLEMENTATION-STATUS](03-IMPLEMENTATION-STATUS.md)). The **build order**
> and gating remain governed by Roadmap V2's Owner Amendment (execution order)
> and by [09-OWNER-DECISIONS](09-OWNER-DECISIONS.md).

## Current active programme

**SpotMe AI Discovery & Social Platform** (see
[product/DISCOVERY-PROGRAMME](product/DISCOVERY-PROGRAMME.md)). Fixed execution
order — do not reorder or skip:

| # | Step | State |
|---|---|---|
| 1 | Smart Nearby Discovery Map | Implemented (Draft PR), dark — PR #60 |
| 2 | Live Nearby Events | Implemented (Draft PR), dark — PR #61 |
| 3 | **Nearby Moments** | **Next approved mission** (after handbook merge) |
| 4 | AI Assistant & Personalization | Planned, consent-based, interface-first |

## Current milestone

**Phase 1 — Engineering Handbook v1.0.** This documentation-only change. Until it
is merged, it is *In Progress / Implemented (Draft PR)*.

## Next approved mission

**Nearby Moments** — step 3 of the fixed Discovery execution order (steps 1–2 are
built dark). The owner has stated **Nearby Moments must not begin until this
handbook is merged**. After merge:

> "Continue [AI Discovery & Social Platform] according to the Engineering
> Handbook. Read CLAUDE.md. Follow the bootstrap protocol. Verify repository
> state. Implement the approved milestone only. Create a draft PR. Do not merge.
> Stop for owner review."

Nearby Moments is the nearby social feed (scope §8): approximate/coarse location
by default, never a poster's precise live location, connected to the map. A
**Nearby Moments data/privacy-model ADR is required before any code**.

## Standing gates that shape the roadmap

- **ADR-008 §12 hard stop** blocks the signing-key/crypto-ratchet stack (Phase 2
  messaging completion) until rollback-after-publication is executable or
  separately authorised.
- **AI is interface-only** across all phases — no LLM calls, no conversational
  assistant — until the owner authorises otherwise.
- **Dark by default:** new platform foundations ship flag-gated and fenced;
  activation is a separate, owner-authorised change (G8).

See [09-OWNER-DECISIONS](09-OWNER-DECISIONS.md) for the full standing-directive
list and the open decisions each phase is waiting on.
