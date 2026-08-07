# Producing and hosting the India PMTiles extract (owner runbook, ADR-030)

The self-hosted map (`src/map/`) reads **one file**: a PMTiles archive on the
existing Cloudflare R2 bucket, addressed by the env name **`TILES_URL`**.
This runbook is how the owner produces that file and its font assets, uploads
them, and what it costs. **Never run these steps in a Claude session or CI —
the downloads are multi-gigabyte.** The repo carries only the 344-byte test
fixture (`test/fixtures/sample.pmtiles`, regenerable via
`node scripts/make-sample-pmtiles.mjs`).

## Option A (recommended): clip the Protomaps daily planet build

Requires the `pmtiles` CLI (single Go binary,
<https://github.com/protomaps/go-pmtiles/releases>). The extract streams only
the needed byte ranges — you never download the full ~120 GB planet.

```bash
# 1. Pick the latest daily build name from https://maps.protomaps.com/builds/
# 2. Clip to India's bounding box (west,south,east,north):
pmtiles extract https://build.protomaps.com/20260801.pmtiles india.pmtiles \
  --bbox=68.0,6.5,97.5,35.7
# Result: roughly 1.5–3 GB depending on build date.
```

## Option B: build from an OSM extract with Planetiler

Requires Java 21+ and ~2 GB of downloads (Geofabrik `india-latest.osm.pbf`).

```bash
wget https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar
java -Xmx4g -jar planetiler.jar --download --area=india --output=india.pmtiles
```

## Fonts (labels)

The base style resolves glyphs from `<TILES_URL base>/fonts/…`, so labels add
**no second host**. Fetch the prebuilt Protomaps font PBFs once:

```bash
git clone --depth 1 https://github.com/protomaps/basemaps-assets
# upload basemaps-assets/fonts/ → r2://spotme-media/tiles/fonts/
```

## Upload to R2 (existing bucket, existing account)

`wrangler r2 object put` caps single objects around 300 MiB — use the
S3-compatible endpoint for the archive (multipart is automatic):

```bash
aws s3 cp india.pmtiles s3://spotme-media/tiles/india.pmtiles \
  --endpoint-url "https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
aws s3 cp basemaps-assets/fonts s3://spotme-media/tiles/fonts \
  --recursive \
  --endpoint-url "https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
```

Then, in the Cloudflare dashboard for the bucket:

1. Enable public access on a custom domain (e.g. `tiles.spotmemessenger.app`)
   — R2 serves the HTTP **Range** requests PMTiles needs out of the box.
2. Add a CORS rule allowing `GET` + `Range`/`If-Match` headers from the app
   origin(s).
3. Set the env name **`TILES_URL`** (value = the archive URL, e.g.
   `https://tiles.spotmemessenger.app/tiles/india.pmtiles`) in the web build
   environment — owner-only; no key, no secret, and the map stays structurally
   inert until it is set.

## Size & cost note

| Item | Size | R2 cost |
|---|---|---|
| `india.pmtiles` | ~1.5–3 GB | storage $0.015/GB-mo ⇒ **≈ $0.02–0.05/month** |
| `fonts/` PBFs | ~50–100 MB | ≈ $0.001/month |
| Egress | per map view: a few hundred KB of ranged reads | **$0 — R2 egress is free** |
| Class B ops (reads) | ~10–40 range GETs per view | $0.36 per million ⇒ negligible at launch scale |

Refreshing the extract is a re-run of Option A plus one upload; monthly is
plenty for launch. No Google/Mapbox/MapTiler tile service is involved at any
point — the Google key stays licensed **only** for AI-Map data (Places,
reviews, directions), and the fence tests enforce that separation.
