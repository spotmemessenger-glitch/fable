# ADR-027 — Mobile-native boundary: React Native target, Capacitor transitional

**Status: ACCEPTED — owner decision recorded 2026-08-03 (delegated engineering approval, Platform Phase 1 landing mission).** · **Date:** 2026-08-03
**Relates to:** the camera suite (PRs #55/#56/#58/#59), calls (`rooms.js`,
Trystero/WebRTC), Discovery/Nearby (background location, Bluetooth), and the
platform-migration Phase 1 foundations (`feat/platform-phase-1`).

> Accepted 2026-08-03 under delegated engineering approval. Nothing is built or
> wired by acceptance. Acceptance sets a direction for
> where native capability work lands; it does not itself start a rewrite.

## Context

Spot Me ships today as a web app wrapped by **Capacitor** (`@capacitor/*` in
`spotme/web`). Capacitor is excellent for reach — one web codebase on iOS and
Android — but the flagship roadmap needs capabilities that live at the edge of,
or beyond, what a WebView plus plugins can deliver well:

- **Camera / AR** (CAM-1…4): real-time capture, computational photography, face
  tracking, AR overlays — GPU- and latency-sensitive, poorly served by a WebView.
- **Calls**: reliable voice/video with ICE restart and background handling.
- **Bluetooth** offline transport (adaptive network, ADR direction) — native BLE.
- **Background location** for Nearby/Discovery — OS-level background execution
  and permission models a WebView cannot fully reach.

Forcing all of this through Capacitor plugins risks death by a thousand native
shims, each a bespoke bridge with its own reliability and review burden.

## Decision (proposed)

Set the **native target as React Native + purpose-built native modules**, with
**Capacitor as the transitional shell**:

- **Target:** a React Native app hosting native modules for the capability-heavy
  surfaces — camera/AR, calls, Bluetooth, background location. React (already the
  direction for `web-next`, item 8) keeps the component model continuous from web
  to native.
- **Transitional:** Capacitor stays the shipping shell now and during migration.
  Screens move to native incrementally (strangler-fig, same pattern as
  `web-next`), capability by capability, not in a big-bang rewrite.
- **Boundary rule:** a feature goes native ONLY when it needs native capability
  or performance the WebView cannot meet. Content/CRUD screens can stay web
  (Capacitor) until there is a reason to move them.
- **Shared contracts:** native and web consume the same `@spotme/contracts`
  types, so the domain model does not fork across surfaces.

## Consequences

- **Positive:** each capability-heavy surface gets a first-class native
  implementation; React continuity from web to native; migration is incremental
  and reversible per screen; one shared domain-type package.
- **Cost / risk:** a second app runtime to build and release; native module
  expertise (Swift/Kotlin) required; CI/release pipelines for React Native;
  temporary duplication during migration. All deferred until accepted.
- **Reversible:** until accepted and started, nothing changes — Capacitor keeps
  shipping. If React Native proves wrong, the boundary rule means only the
  capability surfaces were touched, not the whole app.

## Evidence

- Current shell: `@capacitor/*` in `spotme/web/package.json`; camera work in
  PRs #55/#56/#58/#59 (frozen); calls in `spotme/web/src/lib/rooms.js`.
- React direction: `spotme/web-next` (item 8) + `@spotme/contracts` (item 3).

## Open questions for the owner

1. Accept React Native as the native target, or evaluate alternatives (native
   Swift/Kotlin apps; a heavier Capacitor-plugin investment; Flutter)?
2. Confirm Capacitor remains the shipping shell throughout the migration.
3. Confirm the boundary rule (native only for capability/performance needs) as
   the gate for what moves.
