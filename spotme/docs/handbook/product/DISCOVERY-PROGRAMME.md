# Discovery Programme (Product Authority)

> Owner directive, 2026-08-03. This fixes the Discovery build order so future
> sessions do not drift back to older roadmap priorities. Build state (what is
> actually implemented) is in
> [../03-IMPLEMENTATION-STATUS](../03-IMPLEMENTATION-STATUS.md).

## Current active programme

**SpotMe AI Discovery & Social Platform.**

This is the programme currently in flight. It delivers the **Discovery** pillar
and the social surfaces on top of Communication.

## Fixed execution order

Steps run in this order. Do **not** reorder or skip ahead.

| # | Step | Build state | Evidence |
|---|---|---|---|
| 1 | **Smart Nearby Discovery Map** | Implemented (Draft PR), dark | PR #60 (`discovery-v2/`, `geo-approx.js`) |
| 2 | **Live Nearby Events** | Implemented (Draft PR), dark | PR #61 (`live-events/`) |
| 3 | **Nearby Moments** | Planned — **next approved mission** (after the handbook merges) | none yet; needs a data/privacy-model ADR before code |
| 4 | **AI Assistant & Personalization** | Planned (consent-based) | none yet |

Steps 1 and 2 are **built dark** (flag-gated, fenced, not on master). Step 3
(**Nearby Moments**) is the next approved mission once this handbook is merged —
it is the "nearby social feed" of the scope doc (§8): nearby photos/videos,
stories/short-videos, location-tagged posts with **approximate/coarse location
by default**, connecting content to the map **without exposing a poster's
precise live location**. Step 4 adds explainable, **opt-in** personalization and
an assistant — **interface-first, no LLM/assistant activation** without owner
authorisation.

## Discovery principles (non-negotiable)

Every Discovery/Social surface starts from these assumptions:

1. **Precise GPS is always device-local.** Never broadcast, persisted
   unnecessarily, logged, put in analytics/URLs, or sent to a provider except
   where a nearby search technically needs an origin. (ADR-019.)
2. **Public locations are approximate by default.** Coarse cell + rotating
   bounded offset; hidden/ghost transmits nothing. (ADR-018.)
3. **Provider-neutral architecture.** No vendor lock-in; normalise to stable
   Spot Me models; no credential leakage. (ADR-017.)
4. **Compile-time dark shipping.** Flags default off, hard master gate,
   tree-shaken; activation is a separate owner-authorised change. (ADR-015/016.)
5. **Consent-based AI personalization.** Opt-in and editable; **no sensitive**
   (religious/health) inference; medical searches never become an ad profile.
6. **Sponsored content is always labeled** and separated from organic relevance;
   paid placement never silently overrides relevance or safety.
7. **Never fabricate ETAs or directions.** Route/ETA comes from a directions
   provider; a straight-line figure is labeled as such, never as travel time.
8. **Deterministic testing for privacy-sensitive logic.** Inject clock/seed;
   mutation-style tests that fail if precise data leaks.

## Future scope — recorded, NOT activated

Approved strategic direction, captured so it is not lost — **do not implement**
without a separate owner-approved mission and (where architectural) an ADR:

- Nearby **businesses** / place & service search at full breadth (scope §7.2)
- **AI Search** and **Voice Search** (map voice assistant, scope §7.4)
- **AI Review Engine** (authorized-source summaries; "insufficient evidence"
  over invention; no scraping — scope §7.5)
- **Community Contributions** (reviews, photos, local posts — scope §8)
- **AI Travel Companion**
- **Business Platform** (verified pages, promoted events, reservations,
  analytics — scope §10.2/§10.3), all with sponsorship labeling and privacy
  controls.

These are strategic scope, not current implementation. They live behind the
fixed execution order above.
