/**
 * Spot Me vision — a dependency-free PNG writer (RGBA-8, zlib STORED
 * blocks).
 *
 * WHY WRITE ONE. Multi-page document assembly must produce real image
 * files, and the module has no canvas in Node and no npm budget (fence:
 * zero new dependencies). PNG's container is trivial; the only "hard"
 * part is zlib, and zlib explicitly allows UNCOMPRESSED (stored) deflate
 * blocks — a 5-byte header per ≤65535-byte block plus an Adler-32. Every
 * PNG reader must accept them. So this writes byte-perfect, universally
 * readable PNGs, deterministically, in ~100 lines — bigger on disk than a
 * compressed encode, which is why the assembler prefers an injected
 * canvas encoder when one exists and uses this as the always-works floor.
 *
 * (WebP/JPEG were rejected for the floor: both require a real codec.
 * BMP was rejected because half the mobile share sheet refuses it.)
 */

/** CRC-32 (IEEE), table built lazily on first use — nothing on import. */
let CRC_TABLE = null
function crc32 (bytes, start = 0, end = bytes.length) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c >>> 0
    }
  }
  let crc = 0xFFFFFFFF
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function adler32 (bytes) {
  let a = 1
  let b = 0
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function chunk (type, payload) {
  const out = new Uint8Array(12 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, payload.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(payload, 8)
  view.setUint32(8 + payload.length, crc32(out, 4, 8 + payload.length))
  return out
}

/** Raw scanlines (filter byte 0 per row) → a zlib stream of stored blocks. */
function zlibStored (raw) {
  const BLOCK = 65535
  const blocks = Math.ceil(raw.length / BLOCK) || 1
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4)
  out[0] = 0x78                              // CMF: deflate, 32K window
  out[1] = 0x01                              // FLG: check bits, no dict
  let o = 2
  for (let b = 0; b < blocks; b++) {
    const start = b * BLOCK
    const len = Math.min(BLOCK, raw.length - start)
    out[o++] = b === blocks - 1 ? 1 : 0      // BFINAL + BTYPE=00 (stored)
    out[o++] = len & 0xFF; out[o++] = len >>> 8
    out[o++] = ~len & 0xFF; out[o++] = (~len >>> 8) & 0xFF
    out.set(raw.subarray(start, start + len), o)
    o += len
  }
  new DataView(out.buffer).setUint32(o, adler32(raw))
  return out
}

/** RGBA {data,width,height} → PNG bytes. Pure, deterministic. */
export function encodePng (image) {
  const { data, width, height } = image
  if (!data || !width || !height || data.length < width * height * 4) {
    throw new Error('encodePng needs RGBA {data,width,height}')
  }
  const ihdr = new Uint8Array(13)
  const iv = new DataView(ihdr.buffer)
  iv.setUint32(0, width)
  iv.setUint32(4, height)
  ihdr[8] = 8                                // bit depth
  ihdr[9] = 6                                // colour type: RGBA
  // compression 0, filter 0, interlace 0 already zero.

  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const o = y * (1 + width * 4)
    raw[o] = 0                               // filter: None
    const row = data.subarray(y * width * 4, (y + 1) * width * 4)
    raw.set(row, o + 1)
  }

  const signature = Uint8Array.of(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
  const parts = [signature, chunk('IHDR', ihdr), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const png = new Uint8Array(total)
  let o = 0
  for (const p of parts) { png.set(p, o); o += p.length }
  return png
}

/** The Blob flavour the assembler hands out. */
export function encodePngBlob (image) {
  return new Blob([encodePng(image)], { type: 'image/png' })
}

/** Read back width/height/depth/colour from PNG bytes — the test's proof
 *  that what was written is a real PNG and not a labeled buffer. */
export function readPngHeader (bytes) {
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
  if (bytes.length < 33 || sig.some((v, i) => bytes[i] !== v)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null
  const ihdrCrc = view.getUint32(29)
  if (ihdrCrc !== crc32(bytes, 12, 29)) return null
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
  }
}
