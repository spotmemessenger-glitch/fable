# Architecture Decision Records (ADRs)

An ADR records one architectural decision: its context, the decision, and its
consequences. **An Accepted ADR is immutable** (Governance **G6**) — a new
direction is a *new* ADR that may supersede an older one by reference, never an
edit to the old one.

## Index

### Merged on `master` (001–008)
| ADR | Title | Status |
|---|---|---|
| [001](001-e2ee-v19-fix.md) | E2EE V-19 fix | Accepted |
| [002](002-realtime-centrifugo-abstraction.md) | Realtime / Centrifugo abstraction | Accepted |
| [003](003-key-authentication-safety-numbers.md) | Key authentication — safety numbers | Accepted |
| [004](004-forward-secrecy-design.md) (+ 004a–004d) | Forward secrecy design + e2e_v3 vectors | Accepted |
| [005](005-identity-pinning-and-trust-state.md) | Identity pinning & trust state | Accepted |
| [006](006-signing-identity-and-key-binding.md) | Signing identity & key binding | Accepted |
| [007](007-send-enforcement.md) | Send enforcement | Accepted |
| [008](008-signing-key-storage.md) | Signing-key storage (§12 hard stop) | Accepted |

### Reserved by in-flight draft PRs (009–013 — NOT on master)
`009–012` platform-pillar ADRs (push, translation, live voice, adaptive network)
are in draft PR **#40**; `013` device layer is in draft PR **#43**. These numbers
are reserved to avoid collision; see
[handbook/10-CONTRADICTIONS-AND-GAPS](../handbook/10-CONTRADICTIONS-AND-GAPS.md).

### Handbook-era (014–021)
Decisions evidenced in the repository (014–020 backfilled by Engineering
Handbook v1.0; 021 added with the Product Authority):

| ADR | Title | Status |
|---|---|---|
| [014](014-repository-over-memory.md) | Repository over memory (canonical handbook) | Accepted |
| [015](015-compile-time-feature-flags.md) | Compile-time feature flags with a hard master gate | Accepted |
| [016](016-dark-shipping.md) | Dark shipping + fence tests | Accepted |
| [017](017-provider-neutral-adapters.md) | Provider-neutral adapter contracts | Accepted |
| [018](018-deterministic-location-grid.md) | Deterministic approximate-location grid | Accepted |
| [019](019-discovery-v2-privacy-model.md) | Discovery V2 privacy model (precise GPS device-local) | Accepted |
| [020](020-stacked-pr-strategy.md) | Stacked draft-PR strategy | Accepted |
| [021](021-spotme-unified-product-ecosystem.md) | SpotMe Unified Product Ecosystem (3 pillars, the loop, fixed Discovery order) | Accepted |

### Ratified 2026-08-03 (022–023)
Drafted with the DPAS and ratified by the owner:

| ADR | Title | Status |
|---|---|---|
| [022](022-discovery-execution-sequence.md) | Discovery execution sequence — five steps (supersedes ADR-021's sequence) | Accepted |
| [023](023-exchange-platform-service-intent-graph.md) | Exchange as a platform service — the universal Intent Graph (boundary & responsibilities only) | Accepted |
| [024](024-discovery-coarse-broadcast-hotfix.md) | Discovery broadcasts coarse coordinates only — P0 hotfix (Accepted by the owner's merge of PR #66, `069905e`; supersedes the 2026-07-25 precise-broadcast decision) | Accepted |
| [025](025-e2ee-implementation-libsignal-vs-custom.md) | E2EE implementation: libsignal vs custom e2e_v3 — governs PRs #39/#41/#42/#43 (Accepted by the owner's merge of PR #68) | Accepted |

### Platform migration Phase 1 (026–027)
Drafted in the staged programme (group 1E); **Accepted 2026-08-03 under the
owner's delegated engineering approval** (Platform Phase 1 landing mission,
recorded in `handbook/DECISIONS.md`). Acceptance wires nothing in.

| ADR | Title | Status |
|---|---|---|
| [026](026-realtime-split-plane.md) | Realtime ownership — split control (Socket.IO) / data (Centrifugo) plane; calls stay on Trystero/WebRTC; broker = Valkey/Dragonfly; pgvector deferred | Accepted |
| [027](027-mobile-native-boundary.md) | Mobile-native boundary — React Native + native modules target (camera/AR, calls, Bluetooth, background location); Capacitor transitional | Accepted |

### Platform migration Phase 5 (028)

| ADR | Title | Status |
|---|---|---|
| [028](028-nearby-moments-data-privacy-model.md) | Nearby Moments — data & privacy model (four-tier visibility, coarse-only opt-in location, EXIF-strip-before-persistence, no engagement telemetry, retention/cascade) | Accepted (2026-08-04, delegated Phase 5 review authority) |

### Age gate, transport, design, and the frontend migration (029, 033-035)

Recorded here to close a gap: this index previously ended at 028 while 029,
033 and 034 existed on disk. Numbers 030-032 were never used.

| ADR | Title | Status |
|---|---|---|
| [029](029-eighteen-plus-age-gate.md) | 18+ at launch, enforced at the ACCOUNT level (D6) | Accepted |
| [033](033-server-only-transport-migration.md) | Server-side-only transport; the P2P (Trystero) path is removed, not frozen | Accepted |
| [034](034-orange-accent-contrast-and-danger-separation.md) | Orange accent text-on-fill; danger separated by lightness | Accepted |
| [035](035-frontend-migration-plan.md) | Frontend migration to React + TypeScript - inventory, slice order, per-slice DoD, rollback (owner decisions P1-P8 recorded 2026-08-07; P4 Tailwind deferred, P7/P8 refused for now) | Accepted |

## Format

Each ADR: **Status**, **Context**, **Decision**, **Consequences**, **Evidence**.
Keep them short. When superseding, add a `Superseded by ADR-NNN` line to the old
one's Status (the only permitted post-Acceptance edit).
