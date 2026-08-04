# Nearby Moments — Media Pipeline, Backend & UI (Phase 5B–5D)

> **Status: Implemented (Draft PR — DARK).** The media pipeline (5B), the
> MomentsModule (5C), and the inert web-next surface (5D). Nothing is imported
> by `AppModule`, mounted by `App`, connected to a queue, or activated.

## 1. Media pipeline (5B)

M1 ports (`MediaUploadPort`/`MediaTransformPort`/`ThumbnailPort`/
`StoryMediaPort` under `MomentMediaPort`) composed on the EXISTING Phase 1
`IStorageAdapter` — no new backend, no credentials; with no storage env the
upload slot is a fixture URL and no network is touched.

- **EXIF/GPS strip** (`exif-strip.ts`): deterministic byte-level JPEG/PNG
  metadata removal (no image library, no AI — M7) run BEFORE hash, dedup, or
  any persistence; a GPS-tagged fixture is proven clean by test and re-proven
  by the 5E fence; unknown formats are REFUSED, never passed through. Video
  metadata removal is encoded in the transcode job contract (`-map_metadata -1`).
- **M8 queues:** `{moment-media}` / `{story-expiry}` / `{feed-refresh}` /
  `{moderation}` reserved as typed job contracts + fixture workers;
  `createMomentQueues()` is null without `REDIS_URL` and descriptors-only with
  it — nothing connects (activation wires the Phase 1C BullMQ foundation).
- **Dedup + cascade:** sha256-of-STRIPPED-bytes dedup (`MomentMediaAsset`
  additive migration, clean + upgraded); refCount cascade deletes the row AND
  the storage object when the last reference goes; story media carries the 24h
  retention stamp.

## 2. Moments backend (5C)

`MomentsModule` (unimported) behind the M1 ports; the controller is THIN.

- **M5 visibility:** four tiers; location opt-in, coarse-only, nearby/public
  only; a 4-decimal fix / accuracy shape / precise cell is REFUSED, not
  rounded; the city cell is server-derived at 1 decimal. PRIVATE is excluded
  at the type level (5A), in EVERY feed SQL, and the projection THROWS on
  non-public rows.
- **Feeds:** nearby (`ST_DWithin` over the coarse point) / friends (explicit
  follow graph) / city (city cell); CHRONOLOGICAL-FIRST default (M2); the
  ranked path uses the closed registry only — forbidden signals throw BY NAME;
  omissions disclosed. Two-way block + moderation exclusions in SQL; signed
  depth-bounded keyset cursor; uniform not-found.
- **M3 stories:** `MomentStory` (legacy E2E `Story` untouched), six-state
  closed lifecycle, 24h [PROPOSED] expiry, `{story-expiry}` sweep contract.
- **M4:** flat `parentId` comments (foreign parent refused); closed 5-reaction
  registry at the service AND a DB CHECK.
- **Moderation:** `visible→reported→limited→removed` closed machine; SANITIZED
  append-only audit (ids + codes, never content); child-safety reports take
  the mandatory priority lane (M6). Thresholds/staffing owner-retained.
- **Realtime:** `MomentRealtimePort` + `DisabledMomentRealtime` only (ADR-026).

## 3. web-next surface (5D)

Framework-free controller behind ports; `coarsenForPublic` is the single
brand-cast site, applied BEFORE any outbound call (mutation battery).

- **M5 attach flow is TWO-step:** the plain-language explanation
  ("approximate area only… never your exact position", with a real decline)
  precedes any attach; only an explicit confirm attaches the coarse
  projection; private/friends refuse; tier downgrade drops the location.
- **M6 untrusted URLs:** inert marked text — no anchor, no fetch/unfurl.
- Closed reaction bar; flat-data comments with render-side nesting; report/
  block/hide on every card; NO engagement counters; A3 clean; honest states;
  windowed virtual feed; stories rail.
- **CameraPort (M1): interface only** — no camera-branch import, no flag; the
  composer picks from the camera-roll FIXTURE. Camera wiring is a separate
  owner-authorized change against the frozen engine.
