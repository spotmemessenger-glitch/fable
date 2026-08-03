# 01 — Concept, Scope & Personas

> Reconstruction pending A5 ratification (see [README](README.md)).

## 1.1 What SpotMe Exchange is

SpotMe Exchange is a **local, privacy-safe, AI-matched marketplace of needs and
offers**. A person (or a participating business) posts a **Need** ("need a
plumber this evening", "looking for a used road bike", "study partner for
calculus") or an **Offer** ("offering guitar lessons", "selling a sofa", "table
for two open at 8pm"). Exchange matches Needs to Offers by **intent** — not
keywords — and surfaces matches through the same privacy-safe local Discovery
surfaces (map + list) as places and events. Connection happens over the existing
Communication pillar (knock → chat).

Exchange is the **real-world problem-solving layer**: the place people go to get
everyday things done locally. It is a flagship capability, not a classifieds
bolt-on, and it is Spot Me's biggest differentiator.

## 1.2 Where it sits

- **Discovery Programme step 2** (Smart Nearby Discovery Map → **Exchange** →
  Live Nearby Events → Nearby Moments → AI Assistant). Owner-controlled sequence.
- **Rails:** Discovery (surfacing/search/map), Communication (handoff to chat),
  and — for businesses — the Business Platform. Exchange is the *matcher* on top.
- **Reuse:** the Discovery V2 primitives (provider-neutral contracts, adaptive
  radius, transparent ranking, map single-source-of-truth, `geo-approx`
  privacy) — `[REUSE]`.

## 1.3 Core objects

| Object | Definition |
|---|---|
| **Need** | A time-bounded request to be fulfilled. Structured intent + free text + approximate location + optional budget/urgency. |
| **Offer** | A capability or item on offer, from a person or business. Same structure; may be recurring. |
| **Match** | An AI-proposed pairing of a Need and an Offer, with an explicit, explainable rationale and a score. |
| **Handoff** | The transition from a Match to a real conversation (knock → chat) in the Communication pillar. |

## 1.4 Goals

1. Let a person express a real-world need or offer in seconds, safely.
2. Surface the **most relevant, trustworthy, nearby** counterpart — proximity
   outranks popularity.
3. Explain every match (why these two) — no opaque "AI".
4. Preserve privacy: approximate location by default; exact position never
   exposed without explicit, per-interaction consent.
5. Hand off to conversation frictionlessly and safely.
6. Resist fraud, spam and abuse from day one.

## 1.5 Non-goals (explicit)

- **Not** a payments/escrow system in v1 (payments are Future Scope; see §10 and
  roadmap v2.0 §19/§20). Exchange connects people; it does not process money in
  v1. `[PROPOSED]`
- **Not** a global classifieds board — it is **local** and proximity-first.
- **Not** an anonymous-stranger free-for-all — identity, reputation, and safety
  gates apply.
- **No** LLM/assistant activation without owner authorisation — matching is
  interface-first (§04).
- **No** sensitive-trait inference; **no** personalization beyond opt-in prefs.

## 1.6 Personas

- **Seeker** — posts a Need, wants a fast, trustworthy, nearby fulfilment.
- **Provider (individual)** — posts Offers or responds to Needs; casual/side.
- **Business Provider** — a verified business posting Offers / responding to
  Needs (§10); paid placement is labeled and never overrides relevance/safety.
- **Responder** — someone who sees a match and initiates the conversation.
- **Moderator** — reviews reports, handles abuse/fraud (§06).

## 1.7 Success metrics `[PROPOSED]`

Measured with privacy-preserving analytics (no exact location, no sensitive
inference):

- **Time-to-first-relevant-match** (post → first proposed match).
- **Match acceptance rate** (proposed → conversation started).
- **Resolution rate** (Need marked resolved) and time-to-resolution.
- **Report/abuse rate** (kept low by §06 controls).
- **Local density** (active Needs/Offers per area) — the flywheel signal.

Engagement is optimised for **usefulness**, not compulsive use (constitution).

## 1.8 Exchange is a platform service — the universal Intent Graph

> Owner directive (2026-08-03), incorporated from the PR #64 review.

Exchange must **not** become a module. It is a **platform service**: over time,
every Spot Me surface publishes into Exchange, making it a universal **Intent
Graph** — the common registry of local needs and offers, whatever surface they
originate from.

| Publisher | Example | Flows into Exchange as |
|---|---|---|
| Discovery Map | Nearby business | Business Offer |
| Nearby Events | Tickets | Offer (time-bound) |
| Nearby Moments | "I have camping gear" | Offer |
| Business Platform | Inventory | Offers at scale |
| Communities | "Volunteer needed" | Need |
| Messaging | Friend needs a charger | Need (consented share) |

Consequences for architecture:

- Exchange exposes **publish/consume intent contracts** (a service boundary),
  not just its own compose UI. New sources integrate via the contract — the core
  architecture does not change as sources grow.
- **Unified search organizes by intent, not by type.** "I need a turbocharger"
  searches businesses, individuals, mechanics, marketplace items, nearby
  requests, groups, friends' consented shares, inventory, events and AI
  recommendations — and returns *the nearest solution*, not a type-siloed list.
- Every published intent inherits the privacy invariants (§07) regardless of its
  source surface: approximate location, consent gates, no sensitive inference.

The intent-routing service that realises this is specified in the Discovery
Platform Architecture Specification (ch. 03 — separate stacked PR).

## 1.9 Scope of this PRD

Covers: UX/screens (§02), lifecycle state machines (§03), matching/AI-search/
ranking (§04), notifications (§05), moderation/fraud (§06), privacy (§07), API
contracts (§08), database (§09), business/reputation (§10), edge cases/offline
(§11), scalability (§12), acceptance/open questions (§13). All `[PROPOSED]`
detail is pending A5 ratification.
