/**
 * Nearby Moments — EXIF/metadata strip boundary (Phase 5B).
 *
 * The ONE place uploaded image bytes are cleaned BEFORE any persistence: a
 * GPS-tagged photo comes out with every metadata segment gone (proven by test
 * and re-proven by the 5E fence). Deterministic byte-level parsing — no image
 * library, no decode, no AI (M7). Unknown formats are REFUSED, never passed
 * through unstripped.
 *
 * JPEG: keeps SOI and APP0 (JFIF); drops APP1–APP15 (Exif/XMP/IPTC/…) and COM;
 * from SOS onward the entropy-coded image data is copied verbatim.
 * PNG: keeps the signature and all chunks except the metadata chunks
 * (tEXt/zTXt/iTXt/eXIf/tIME).
 */

export class UnsupportedImageError extends Error {
  constructor(detail: string) {
    super(`unsupported image for metadata strip: ${detail} — refused (never persisted unstripped)`);
    this.name = 'UnsupportedImageError';
  }
}

const JPEG_SOI = 0xffd8;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_META_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function stripJpeg(buf: Buffer): Buffer {
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) throw new UnsupportedImageError('malformed JPEG segment stream');
    const marker = buf[i + 1];
    if (marker === 0xda) {
      // SOS — entropy-coded data follows; copy the remainder verbatim.
      out.push(buf.subarray(i));
      return Buffer.concat(out);
    }
    if (marker === 0xd9) { out.push(buf.subarray(i, i + 2)); return Buffer.concat(out); }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) throw new UnsupportedImageError('JPEG segment length out of bounds');
    const isApp0 = marker === 0xe0; // JFIF — kept
    const isMeta = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe; // APP1..APP15 + COM — dropped
    if (isApp0 || !isMeta) out.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  throw new UnsupportedImageError('JPEG ended before SOS/EOI');
}

function stripPng(buf: Buffer): Buffer {
  const out: Buffer[] = [PNG_SIG];
  let i = PNG_SIG.length;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const total = 12 + len;
    if (i + total > buf.length) throw new UnsupportedImageError('PNG chunk length out of bounds');
    if (!PNG_META_CHUNKS.has(type)) out.push(buf.subarray(i, i + total));
    i += total;
    if (type === 'IEND') return Buffer.concat(out);
  }
  throw new UnsupportedImageError('PNG ended before IEND');
}

/**
 * Strip all metadata from an image. The ONLY path bytes may take toward
 * persistence. Throws {@link UnsupportedImageError} for anything unrecognized —
 * refusal, never pass-through.
 */
export function stripImageMetadata(bytes: Buffer, mimeType: string): Buffer {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) throw new UnsupportedImageError('too small');
  if (mimeType === 'image/jpeg' && bytes.readUInt16BE(0) === JPEG_SOI) return stripJpeg(bytes);
  if (mimeType === 'image/png' && bytes.subarray(0, 8).equals(PNG_SIG)) return stripPng(bytes);
  throw new UnsupportedImageError(`${mimeType} (or magic-byte mismatch)`);
}

/** True when a buffer contains an EXIF/GPS metadata marker (used by tests + the
 *  5E fence to prove the strip actually removed the payload). */
export function containsMetadataMarkers(bytes: Buffer): boolean {
  const hay = bytes.toString('latin1');
  return /Exif\x00\x00|GPSLatitude|GPSLongitude|<x:xmpmeta|Photoshop 3\.0/.test(hay);
}
