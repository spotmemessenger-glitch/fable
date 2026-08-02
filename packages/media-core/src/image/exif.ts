/**
 * Pure EXIF orientation parsing.
 *
 * A clean TypeScript reimplementation (NOT a copy) of the byte-parser proven in
 * the Creative Studio branch: read the JPEG APP1/Exif segment, walk the TIFF
 * IFD0, return the orientation tag (0x0112) as 1..8. Hostile/truncated input
 * answers ORIENTATION_NORMAL rather than throwing — a malformed file must never
 * crash the caller (it is quarantined elsewhere, not decoded here).
 *
 * Pure and dependency-free: operates on a Uint8Array, uses only DataView.
 */

/** EXIF orientation values 1..8. 1 = normal; 5..8 imply a 90° transpose. */
export const ORIENTATION_NORMAL = 1
export const ORIENTATION_MIN = 1
export const ORIENTATION_MAX = 8

const TAG_ORIENTATION = 0x0112
const TYPE_SHORT = 3

/**
 * Returns the EXIF orientation (1..8) for JPEG bytes, or ORIENTATION_NORMAL
 * when there is no Exif block or it cannot be parsed.
 */
export function readExifOrientation(bytes: Uint8Array): number {
  // JPEG SOI.
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return ORIENTATION_NORMAL

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 2

  // Scan segment markers for APP1 (0xFFE1).
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return ORIENTATION_NORMAL
    const marker = bytes[offset + 1]!
    const segLength = view.getUint16(offset + 2, false)
    if (segLength < 2) return ORIENTATION_NORMAL

    if (marker === 0xe1) {
      const app1Start = offset + 4
      // "Exif\0\0"
      if (
        app1Start + 6 <= bytes.length &&
        bytes[app1Start] === 0x45 &&
        bytes[app1Start + 1] === 0x78 &&
        bytes[app1Start + 2] === 0x69 &&
        bytes[app1Start + 3] === 0x66 &&
        bytes[app1Start + 4] === 0x00 &&
        bytes[app1Start + 5] === 0x00
      ) {
        return parseTiffOrientation(view, app1Start + 6, bytes.length)
      }
      return ORIENTATION_NORMAL
    }

    offset += 2 + segLength
  }
  return ORIENTATION_NORMAL
}

function parseTiffOrientation(view: DataView, tiffStart: number, byteLength: number): number {
  if (tiffStart + 8 > byteLength) return ORIENTATION_NORMAL
  const byteOrder = view.getUint16(tiffStart, false)
  let little: boolean
  if (byteOrder === 0x4949) little = true // "II"
  else if (byteOrder === 0x4d4d) little = false // "MM"
  else return ORIENTATION_NORMAL

  const ifdOffset = view.getUint32(tiffStart + 4, little)
  const ifd0 = tiffStart + ifdOffset
  if (ifd0 + 2 > byteLength) return ORIENTATION_NORMAL

  const entryCount = view.getUint16(ifd0, little)
  let entry = ifd0 + 2
  for (let i = 0; i < entryCount; i++) {
    if (entry + 12 > byteLength) return ORIENTATION_NORMAL
    const tag = view.getUint16(entry, little)
    if (tag === TAG_ORIENTATION) {
      const type = view.getUint16(entry + 2, little)
      if (type !== TYPE_SHORT) return ORIENTATION_NORMAL
      const value = view.getUint16(entry + 8, little)
      return value >= ORIENTATION_MIN && value <= ORIENTATION_MAX ? value : ORIENTATION_NORMAL
    }
    entry += 12
  }
  return ORIENTATION_NORMAL
}

/** True when the orientation implies a 90°/270° transpose (width↔height swap). */
export function orientationSwapsAxes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8
}

/** Apply an orientation to raw pixel dimensions (swap axes for 5..8). */
export function applyOrientationToDims(
  width: number,
  height: number,
  orientation: number,
): { width: number; height: number } {
  return orientationSwapsAxes(orientation) ? { width: height, height: width } : { width, height }
}
