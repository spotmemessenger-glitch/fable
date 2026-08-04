#!/usr/bin/env node
/**
 * Deterministic generator for test/fixtures/sample.pmtiles — a tiny, valid
 * PMTiles v3 archive holding one hand-encoded MVT tile at z0/0/0 (layer
 * "sample", a single square polygon). No timestamps, no randomness: running
 * this script always produces byte-identical output, so the committed fixture
 * can be re-derived and diffed.
 *
 * Why hand-written: the real India extract is multi-gigabyte and owner-produced
 * (see build-tiles.md); tests only need an archive the pmtiles reader accepts.
 * Everything below follows the PMTiles v3 spec:
 * https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 *
 *   node scripts/make-sample-pmtiles.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'sample.pmtiles');

/* ---------------- varint / protobuf helpers ---------------- */

const varint = (n) => {
  const out = [];
  let v = typeof n === 'bigint' ? n : BigInt(n);
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
};
const zigzag = (n) => (n << 1) ^ (n >> 31);
const tag = (field, wire) => varint((field << 3) | wire);
const lenDelim = (field, bytes) => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const str = (field, s) => lenDelim(field, [...new TextEncoder().encode(s)]);

/* ---------------- one MVT tile: layer "sample", one square ---------------- */

// Feature: type=POLYGON(3), geometry = MoveTo(256,256) LineTo ×3 ClosePath.
// CommandInteger = (id & 0x7) | (count << 3)
const geometry = [];
geometry.push(...varint((1 & 0x7) | (1 << 3)), ...varint(zigzag(256)), ...varint(zigzag(256))); // MoveTo(256,256)
geometry.push(...varint((2 & 0x7) | (3 << 3))); // LineTo, count 3
geometry.push(...varint(zigzag(3584)), ...varint(zigzag(0)));   // → (3840,256)
geometry.push(...varint(zigzag(0)), ...varint(zigzag(3584)));   // → (3840,3840)
geometry.push(...varint(zigzag(-3584)), ...varint(zigzag(0)));  // → (256,3840)
geometry.push(...varint((7 & 0x7) | (1 << 3))); // ClosePath

const feature = [
  ...tag(1, 0), ...varint(1),       // id = 1
  ...tag(3, 0), ...varint(3),       // type = POLYGON
  ...lenDelim(4, geometry),         // geometry (packed)
];

const layer = [
  ...str(1, 'sample'),              // name
  ...lenDelim(2, feature),          // one feature
  ...tag(5, 0), ...varint(4096),    // extent
  ...tag(15, 0), ...varint(2),      // version = 2
];

const tile = Uint8Array.from(lenDelim(3, layer)); // Tile.layers (field 3)

/* ---------------- PMTiles v3 archive ---------------- */

// Root directory: one entry — tileId 0 (z0/0/0), offset 0, length, runLength 1.
const rootDir = Uint8Array.from([
  ...varint(1),           // number of entries
  ...varint(0),           // tileId delta
  ...varint(1),           // runLength
  ...varint(tile.length), // length
  ...varint(1),           // offset + 1 (0 would mean "follows previous")
]);

const metadata = new TextEncoder().encode(JSON.stringify({
  name: 'spotme-sample',
  description: 'Tiny deterministic fixture for map tests — not real map data',
  vector_layers: [{ id: 'sample', fields: {}, minzoom: 0, maxzoom: 0 }],
}));

const HEADER = 127;
const rootOffset = HEADER;
const metaOffset = rootOffset + rootDir.length;
const tileOffset = metaOffset + metadata.length;

const buf = new Uint8Array(tileOffset + tile.length);
const dv = new DataView(buf.buffer);
buf.set(new TextEncoder().encode('PMTiles'), 0);
buf[7] = 3;                                   // spec version
dv.setBigUint64(8, BigInt(rootOffset), true); // root dir offset
dv.setBigUint64(16, BigInt(rootDir.length), true);
dv.setBigUint64(24, BigInt(metaOffset), true); // metadata offset
dv.setBigUint64(32, BigInt(metadata.length), true);
dv.setBigUint64(40, 0n, true);                // leaf dirs offset
dv.setBigUint64(48, 0n, true);                // leaf dirs length
dv.setBigUint64(56, BigInt(tileOffset), true); // tile data offset
dv.setBigUint64(64, BigInt(tile.length), true);
dv.setBigUint64(72, 1n, true);                // addressed tiles
dv.setBigUint64(80, 1n, true);                // tile entries
dv.setBigUint64(88, 1n, true);                // tile contents
buf[96] = 1;                                  // clustered
buf[97] = 1;                                  // internal compression: none
buf[98] = 1;                                  // tile compression: none
buf[99] = 1;                                  // tile type: MVT
buf[100] = 0;                                 // min zoom
buf[101] = 0;                                 // max zoom
dv.setInt32(102, -180 * 1e7, true);           // min lon (e7)
dv.setInt32(106, -85 * 1e7, true);            // min lat
dv.setInt32(110, 180 * 1e7, true);            // max lon
dv.setInt32(114, 85 * 1e7, true);             // max lat
buf[118] = 0;                                 // center zoom
dv.setInt32(119, 0, true);                    // center lon
dv.setInt32(123, 0, true);                    // center lat
buf.set(rootDir, rootOffset);
buf.set(metadata, metaOffset);
buf.set(tile, tileOffset);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, buf);
console.log(`wrote ${OUT} (${buf.length} bytes)`);
