# ADR-030 — Map tiles: MapLibre GL + self-hosted Protomaps PMTiles on R2

**Status: Accepted — owner decision recorded by the 2026-08-04 launch-integrations
mission (tiles · analytics · bot protection).** · **Date:** 2026-08-04
**Relates to:** ADR-017 (provider-neutral adapters), ADR-019 (discovery privacy
model), the Discovery map seam (`web-next/src/discovery/MapView.tsx` /
`MapPort`), and the AI-Map licensed-data boundary.

> Ships dark: the renderer exists behind the existing map component seam and
> nothing mounts it. Activation (swapping it into `DiscoveryShell`) is a
> separate, owner-authorised change (G8).

## Context

The Discovery map currently renders on a deterministic SVG placeholder — fine
for fences, useless for launch. Serving real base tiles from Google, Mapbox, or
MapTiler couples a core surface to a metered third party (per-load pricing,
key management, ToS constraints on caching) and leaks every viewport request to
that party. The product already pays for a Cloudflare R2 bucket, and the
PMTiles format serves a whole basemap as HTTP range reads from one static
file — no tile server to run.

## Decision

- **Renderer: MapLibre GL JS** (BSD, no key, no vendor account) in `web-next`,
  behind the existing map component seam — `TileMapView` is prop-compatible
  with `MapView`.
- **Tiles: a Protomaps-schema PMTiles archive (OpenStreetMap data) self-hosted
  on the existing R2 bucket.** One archive for the India launch footprint,
  produced by the owner per `spotme/web-next/scripts/build-tiles.md`.
- **Configuration: the single env name `TILES_URL`** (build-time, no secret).
  Unset ⇒ the map is structurally inert — no maplibre map is constructed, no
  request leaves the page. Glyphs resolve under the same URL base, so labels
  add no second host.
- **The Google key remains licensed ONLY for AI-Map data** (Places, reviews,
  directions) — never tiles. Fences enforce that no third-party tile host
  (mapbox/google/maptiler/…) appears in web-next source or its built artifact.
- **Attribution:** OpenStreetMap contributors + Protomaps, always visible via
  MapLibre's non-compact attribution control.

## Consequences

- Tile serving cost is ~pennies/month (R2 storage; zero egress fees) and does
  not scale with map views; the trade is owner-run extract refreshes
  (runbook, ~monthly) instead of a managed tile API.
- MapLibre + pmtiles enter `web-next` dependencies; the isolation fence
  allow-list admits them **only** from `src/map/`. While dark they are
  tree-shaken: the production bundle is byte-identical to the pre-change build
  (verified by `scripts/check-map-artifact.mjs`, which fails the suite if
  maplibre/pmtiles or any third-party tile host reaches `dist/`).
- Offline/mesh futures keep working: a PMTiles archive can later ship on-device.

## Evidence

- `web-next/src/map/` (`TileMapView.tsx`, `style.ts`, `tiles-config.ts`,
  `map.css`) — renderer + light/dark base style, teal-accent-compatible.
- `web-next/test/{map-style,map-fixture,tile-map-view,map-not-shipped}.test.*`
  — style, real-reader fixture parse, mount/a11y behavior, dark fence.
- `web-next/test/fixtures/sample.pmtiles` (344 bytes, deterministic; generator
  `scripts/make-sample-pmtiles.mjs`) — tests never download real extracts.
- `web-next/scripts/build-tiles.md` — owner runbook (produce India extract,
  upload to R2, size/cost).
- Env name `TILES_URL` in `backend/.env.example` (build-time section).
