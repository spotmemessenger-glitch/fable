# 14 — Privacy & Abuse Threat Model (Smart Nearby Discovery Map)

> Part of the [Discovery Platform Architecture Specification](README.md).
> **Formal threat model for Platform Phase 2** (checkpoint 4). Binding on every
> Phase 2 checkpoint; each control names its enforcement point. Status:
> Implemented (Draft PR — DARK); nothing here is activated.

A proximity product's threat model is the product. Discovery tells strangers
that a person is *near* — every design decision below exists so that is ALL it
ever tells them. Controls are **fence-enforced or type-enforced wherever
possible** (ADR-016 discipline): a control that lives only in prose is treated
as absent.

## 14.1 Assets

A1 precise device location (the crown jewel — never leaves the device, ADR-019)
· A2 coarse public position (bounded disclosure, ADR-018) · A3 identity ↔
presence linkage · A4 the opt-in handle namespace (D10) · A5 social graph
(friend requests, blocks) · A6 visibility preference state · A7 the search
index content · A8 service availability.

## 14.2 Threats and controls

| ID | Threat | Controls (→ enforcement point) |
|---|---|---|
| T-EXACT | **Exact-location leakage** — precise GPS reaches server/index/provider/log/queue/event | C-BRAND: branded `CoarsePublicLocation` — raw `{lat,lon}` is a compile error in any public payload (→ contracts negative tests, C1). C-BOUNDARY: device-local coarsening is the single outbound path (→ client GeolocationPort, C11 mutation tests). C-REDACT: coordinate-shaped fields redacted in logs/metrics (→ observability redaction fences, Phase 1G + C14). C-SCAN: boundary scan in dark fences (→ C12) |
| T-TRIANG | **Repeated-observation triangulation** — many queries/bands reconstruct a position | C-BAND: person distance is a BAND, never a number (→ type level, C1). C-CELL: public position snaps to a ~500 m cell with bounded rotating offset — averaging converges on the cell, not the person (ADR-018; live `coarse()` interim per ADR-024). C-RATE: per-principal query rate limits + suspicious-pattern throttling (→ policy layer, C2) |
| T-HOME | **Home/work inference** — long-term observation of one person | C-CELL (above). C-EXPIRE: presence rows expire (`expiresAt`) and expired rows are unqueryable (→ repository predicates, C3/C5). C-FRESH: freshness metadata caps how long any observation is served (→ C1/C5) |
| T-STALK | **Stalking / targeted following** | C-OPTIN: visibility is opt-in, reversible, one-tap pause (P3 → `VisibilityPreference`, C1/C3; UI, C10). C-BLOCK: blocks filter BOTH directions before ranking (→ query predicates, C3/C5). C-ACCEPT: D9 accept gate — no chat without explicit acceptance (P7 → `FriendRequestCapability`, C1) |
| T-SCRAPE | **Mass scraping of nearby people** | C-RATE. C-PAGE: pagination ceilings + bounded radius (→ C2/C5). C-NOCOUNT: no public total-result counts (→ `DiscoveryResultPage` has no count field, C1) |
| T-ENUM | **Enumeration** — walking the user/handle space | C-NOCOUNT. C-CURSOR: opaque deterministic cursors, not offsets (→ C1/C5). C-ANTIENUM: uniform not-found behavior; no existence oracle for hidden users (→ C2 policy) |
| T-HARVEST | **Username harvesting** | C-OPTIN-HANDLE: handles are opt-in and carry no other profile data into the index (D10). C-INDEX-MIN: index holds ONLY approved public projections (→ C6 adapter allow-list; index-schema fence) |
| T-FAKELOC | **Fake-location attacks** — lying about position to appear elsewhere | C-COARSE-IN: server validates the coarse-contract SHAPE and bounds; precise-shaped input is refused (→ C2 validation). C-PLAUS: rate-of-change plausibility checks are a documented future control (needs owner-approved thresholds; not silently invented) |
| T-REPLAY | **Location replay** — re-announcing an old position | C-EXPIRE + C-FRESH; `visibilityVersion` is monotonic and realtime consumers drop stale versions (→ C1/C9) |
| T-SYBIL | **Sybil accounts** amplifying scraping/harassment | C-RATE per account AND per principal-cluster where evidence exists; new-account discovery limits are a documented future control (owner policy needed — not invented here) |
| T-COERCE | **Visibility coercion** — pressuring someone to enable visibility | C-UX-HONEST: privacy explanation shown BEFORE enabling; one obvious off switch; auto-expiry means visibility decays without explicit renewal (→ C10 UI + `expiresAt`, C3) |
| T-BLOCKBYPASS | **Block bypass** via second surface (search, realtime) | C-BLOCK-EVERYWHERE: block predicates apply in people queries (C5), search-result composition (C2), and realtime invalidation (block change invalidates cached/streamed state, C9) |
| T-ATO | **Account takeover** → visibility/handle abuse | Inherits platform auth controls (JWT principal keying — out of Phase 2 scope but load-bearing); every discovery write is principal-keyed, body user-ids ignored (→ C2, same discipline as prekeys/signing endpoints) |
| T-BADPROVIDER | **Malicious provider payloads** | C-NORMALIZE: every provider result passes a normalizer that drops raw payloads, requires attribution, rejects secret-shaped data, and leaves unknown fields null (→ C7 ports). C-NONET: no production provider, key, or network activation this phase (→ C12 fence) |
| T-POISON | **Result poisoning** (index or ranking manipulation) | C-INDEX-MIN + C-EXPLAIN: every ranked result carries a `RankingBreakdown`; unexplained score paths do not exist (→ C1 type, C8 engine). C-NOSPONSOR: no sponsored/paid signal exists in the ranking registry (→ C8 tests) |
| T-LOGLEAK | **Log/trace leakage** of location, queries, identities | C-REDACT (coordinates, message content, tokens, URLs — Phase 1G redaction fences extended to discovery fields, C14). C-METRIC-LABELS: metrics never labeled by userId/exact coords/raw query text (→ C14) |
| T-QUEUELEAK | **Queue leakage** — sensitive payloads in jobs/DLQ | Phase 1C discipline: sanitized DLQ envelope, no raw payloads (→ existing queue fences); discovery jobs (future) carry ids + coarse cells only (→ C14 doc) |
| T-RTABUSE | **Realtime subscription abuse** — subscribing to arbitrary users | C-CHANNEL: scoped channel naming + short-lived server-minted claims; no arbitrary-user subscription; block changes invalidate (→ C9 contract + tests). C-RT-MIN: events carry no precise coords, no full profile, no tokens (→ C9 schema tests) |

## 14.3 Cross-cutting control decisions

- **Distance policy:** people → bands only, everywhere (type-enforced). Places
  → numeric distance permitted ONLY as a device-local computation from the
  device's own fix or an approved coarse origin; the server never asserts a
  person-relative distance.
- **No public totals:** result pages structurally lack a total count.
- **Anti-enumeration:** hidden/non-existent users are indistinguishable in
  discovery responses; error shapes are uniform.
- **Audit events** (C14): schema carries actor id (internal), action, coarse
  cell id, timestamps — never precise coordinates, query text, or message
  content.
- **Rate limits / ceilings** are configuration values with documented defaults
  (C2), not hardcoded magic; defaults are deliberately conservative.

## 14.4 Explicit exclusions this phase (A3)

No gender or age field exists in any schema, index, contract, or UI; there is
no filter for either. D6/D7 (age policy; gender/age filters) are OPEN and
owner-retained. Adding such a field is out of scope for any Phase 2 change and
fails the contracts negative tests.

## 14.5 Residual risks (honest)

- Coarse cells still reveal *presence in an area*; that is the product's
  irreducible disclosure and is bounded by ADR-018 parameters.
- Plausibility (T-FAKELOC) and new-account limits (T-SYBIL) need owner-approved
  thresholds before enforcement; recorded as future controls, not invented.
- Provider-side logging of place queries is governed by provider agreements —
  ports send coarse origins only (C7), which bounds but does not eliminate it.
