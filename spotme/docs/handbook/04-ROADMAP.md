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
| 2 | **Social Platform Foundation** | The social surfaces on top of secure messaging: communities/channels, and **Nearby Moments** (owner: not before this handbook merges). Plus completing the merged messaging core. | P1 (complete secure messaging), P7 (communities/channels/social). |
| 3 | **AI Discovery** | Privacy-safe nearby discovery: Discovery V2 map + Live Nearby Events, provider-neutral, dark. | P8 (discovery & nearby). |
| 4 | **Integration & Activation** | Wiring the dark foundations in, staged flag activation, production hardening, launch safety. | P2 (production hardening), G8 activation milestone. |
| 5 | **Media Platform Evolution** | Media platform, camera/creative surfaces, voice/video, AI communication (interface-first). | P4 (media), P5 (voice/video), P6 (AI communication). |

> The phases are **not** strictly sequential across all work — foundations for
> phases 3 and 5 already exist as dark draft PRs (see
> [03-IMPLEMENTATION-STATUS](03-IMPLEMENTATION-STATUS.md)). The **build order**
> and gating remain governed by Roadmap V2's Owner Amendment (execution order)
> and by [09-OWNER-DECISIONS](09-OWNER-DECISIONS.md).

## Current milestone

**Phase 1 — Engineering Handbook v1.0.** This documentation-only change. Until it
is merged, it is *In Progress / Implemented (Draft PR)*.

## Next approved mission

**Continue Phase 2 — Social Platform Foundation**, per the owner's directive:

> "Continue Social Platform Foundation according to the Engineering Handbook.
> Read CLAUDE.md. Follow the bootstrap protocol. Verify repository state.
> Implement the approved milestone only. Create a draft PR. Do not merge. Stop
> for owner review."

The owner has stated **Nearby Moments must not begin until this handbook is
merged**. After merge, a Social Platform Foundation mission may proceed — scoped
to the approved milestone only, with an ADR for any new architectural decision
(e.g. a Nearby Moments data/privacy model) **before** code.

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
