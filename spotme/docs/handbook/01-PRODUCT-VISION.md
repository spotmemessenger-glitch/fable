# 01 — Product Vision & Three-Pillar Architecture

> Source of truth for this page: `spotme/docs/01-PRD.md` (§1–§2) and the shipped
> code it cites. Nothing here is invented; each pillar is quoted from the PRD and
> anchored to code.

## What Spot Me is

Spot Me is a **proximity-first messenger with no account, no password, and no
phone number**. A user opens the app, receives a device-generated identity, and
can start a chat three ways:

| Mode | How a chat starts | Code |
|---|---|---|
| **Meet** | Username or invite link | `spotme/web/src/views/inbox.js`, `spotme/web/api/username.js` |
| **Nearby** | Map + radar discovery of people around you | `spotme/web/src/views/discovery.js`, `spotme/web/src/lib/discovery.js` |
| **Bluetooth** | Local mesh preview | `spotme/web/src/views/bluetooth.js` |

There is **no accept gate**: a "knock" opens the chat on both sides immediately
(`spotme/web/src/lib/reach.js`, durable relay in `spotme/web/api/knock.js`).

## The three pillars (PRD §1)

1. **Proximity.** Identity is device-generated; connection is spontaneous and
   location-aware (Meet / Nearby / Bluetooth). No phone number is required or
   collected.
2. **Language.** Translation and transliteration are first-class messaging
   features, Indian languages first: split-bubble translation (original and
   translation both always visible, never a toggle) and type-in-English →
   send-in-your-script transliteration for 10 Indian languages
   (`spotme/web/src/lib/translate.js`, `spotme/core/translit.js`).
3. **Honesty.** The product never claims more privacy, precision, or delivery
   certainty than it can prove. This is product law — it is why positions are
   shown as approximate ("~24 m", never an exact figure), why distances carry a
   tilde, and why unproven capabilities ship dark rather than pretending to work.

The honesty pillar is also the engineering culture: features are **built dark**
and **fence-tested** so that "not shipped" cannot quietly become "shipped", and
status is recorded with evidence, not assertion (see
[05-GOVERNANCE](05-GOVERNANCE.md)).

## The three flagship pillars & the product loop

Alongside the PRD's *design* pillars above, Spot Me's *product structure* is
three flagship pillars, formalised in
**[ADR-021](../adr/021-spotme-unified-product-ecosystem.md)** and detailed in the
**[product authority](product/README.md)**:

1. **Communication** — the core (messaging, calls, translation, identity).
2. **Discovery** — the intelligence layer (privacy-first local discovery).
3. **Creation** — the content engine (camera, studio, vision, photos/videos,
   stories/reels), whose output feeds Discovery via Nearby Moments.

The lifecycle is a loop: **`Create → Discover → Communicate → Create`**. These
three flagship pillars (product structure) and the PRD's proximity/language/
honesty pillars (design law) are complementary — every flagship surface is held
to the design law.

## Where the product is going

Spot Me is evolving from a secure proximity messenger into a broader
**communication + nearby-discovery platform**. The controlling roadmap is
`spotme/docs/MASTER-ENGINEERING-ROADMAP-V2.md` (owner-approved). The near-term
build order and the named phases are in [04-ROADMAP](04-ROADMAP.md); the honest
current state of every surface is in
[03-IMPLEMENTATION-STATUS](03-IMPLEMENTATION-STATUS.md).

**The three pillars do not change as the surface grows.** New surfaces
(Discovery V2, Live Nearby Events, Camera, Media, AI) are held to the same law:
proximity without surveillance, language as a first-class citizen, and honesty
about what is real.
