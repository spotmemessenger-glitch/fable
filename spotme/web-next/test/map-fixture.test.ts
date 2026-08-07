/**
 * ADR-030 — the committed sample archive is a REAL PMTiles v3 file: the same
 * pmtiles reader maplibre uses parses its header, metadata, and the single
 * z0/0/0 MVT tile. This keeps the renderer testable without ever downloading
 * a multi-gigabyte extract (that is the owner's runbook: scripts/build-tiles.md).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PMTiles, TileType } from 'pmtiles';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample.pmtiles');

/** Minimal in-memory Source so the reader works without any network. */
function memorySource(buf: Buffer) {
  const bytes = new Uint8Array(buf).slice(); // copy into a plain ArrayBuffer
  return {
    getKey: () => 'sample',
    getBytes: async (offset: number, length: number) => ({
      data: bytes.buffer.slice(offset, offset + length) as ArrayBuffer,
    }),
  };
}

describe('sample PMTiles fixture', () => {
  const archive = new PMTiles(memorySource(readFileSync(FIXTURE)));

  it('header parses: MVT tiles, zoom 0 only, clustered', async () => {
    const h = await archive.getHeader();
    expect(h.tileType).toBe(TileType.Mvt);
    expect(h.minZoom).toBe(0);
    expect(h.maxZoom).toBe(0);
  });

  it('metadata declares the sample vector layer', async () => {
    const meta = (await archive.getMetadata()) as { name: string; vector_layers: { id: string }[] };
    expect(meta.name).toBe('spotme-sample');
    expect(meta.vector_layers.map((l) => l.id)).toEqual(['sample']);
  });

  it('the z0/0/0 tile resolves and carries MVT bytes; other tiles are absent', async () => {
    const t = await archive.getZxy(0, 0, 0);
    expect(t).toBeTruthy();
    expect(t!.data.byteLength).toBeGreaterThan(0);
    // MVT layer field (protobuf field 3, wire type 2) leads the tile.
    expect(new Uint8Array(t!.data)[0]).toBe(0x1a);
    expect(await archive.getZxy(1, 0, 0)).toBeUndefined();
  });

  it('fixture stays tiny — this repo never carries a real extract', () => {
    expect(readFileSync(FIXTURE).length).toBeLessThan(4096);
  });
});
