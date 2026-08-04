/**
 * Tile source configuration for the self-hosted map (ADR-030).
 *
 * The ONLY tile source is a PMTiles archive the owner uploads to the existing
 * R2 bucket (see scripts/build-tiles.md). Its URL arrives as the build-time
 * environment name TILES_URL — injected by Vite `define`, never read from a
 * third-party default. With no TILES_URL the map is structurally inert: no
 * style is built, no maplibre Map is constructed, no request leaves the page.
 *
 * No Google / Mapbox / MapTiler tile host may ever appear here — the Google
 * key remains licensed ONLY for AI-Map data (Places, reviews, directions) and
 * is not a tile source. The map-tiles fence test enforces this.
 */

declare const __TILES_URL__: string | undefined;

/** Resolve the PMTiles archive URL: explicit override (tests) → build-time TILES_URL → ''. */
export function resolveTilesUrl(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  return typeof __TILES_URL__ === 'string' ? __TILES_URL__ : '';
}

/** True when a tile source is configured — the map's structural on/off gate. */
export function tilesConfigured(tilesUrl: string): boolean {
  return tilesUrl.trim().length > 0;
}

/**
 * Base URL for self-hosted map assets (glyphs), derived from the archive URL
 * so labels never introduce a second host: everything the map fetches lives
 * next to the archive on R2.
 */
export function assetsBaseFor(tilesUrl: string): string {
  return tilesUrl.replace(/\/[^/]*$/, '');
}
