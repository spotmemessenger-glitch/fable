/**
 * Nearby Moments — format normalisation at the ingest boundary (iPhone media).
 *
 * WHY THIS EXISTS. iPhones shoot HEIC photos and QuickTime `.mov` video. The
 * EXIF stripper in `exif-strip.ts` is a deterministic byte-parser that only
 * understands JPEG and PNG, so both formats were refused outright — correctly,
 * because the alternative was persisting bytes nothing had cleaned.
 *
 * Widening `ALLOWED_MIME` on its own would have been the wrong fix for exactly
 * that reason. So instead each new format is CONVERTED into one the existing
 * boundary already knows how to clean, *before* anything is persisted:
 *
 *   HEIC/HEIF → JPEG (libheif) → stripImageMetadata()   ← the existing boundary
 *   .mov      → mp4, `-map_metadata -1`                 ← container tags dropped
 *
 * THE HEIC RE-STRIP IS NOT BELT-AND-BRACES. `heif-convert` copies the source
 * EXIF — GPS IFD and all — into the JPEG it writes. Measured, not assumed: a
 * converted-but-unstripped JPEG still contains the `Exif\0\0` marker and tag
 * 0x8825. Converting without re-stripping would have shipped the precise leak
 * this module exists to close, which is why the strip runs on the *output*.
 *
 * Video is normalised here too, not just on the worker. The worker's ladder
 * already carries `-map_metadata -1`, but that only cleans the DERIVED
 * variants — `ingest()` stored the uploaded original verbatim, so a GPS-tagged
 * upload sat in the bucket with its tags intact and reachable by presigned GET.
 * Normalising at the boundary closes that for `.mov` and for the `video/mp4`
 * path that was already accepted.
 *
 * RUNTIME DEPENDENCIES: `heif-convert` (libheif-examples) with a HEVC decoder
 * plugin (libde265), and `ffmpeg`. Absent tooling is a typed refusal, never a
 * pass-through of unstripped bytes.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnsupportedImageError } from './exif-strip';

const run = promisify(execFile);

/** Formats an iPhone produces that the byte-level stripper cannot parse. */
export const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif']);
export const QUICKTIME_MIME_TYPES = new Set(['video/quicktime']);

export const isHeic = (mimeType: string): boolean => HEIC_MIME_TYPES.has(mimeType);
export const isQuickTime = (mimeType: string): boolean => QUICKTIME_MIME_TYPES.has(mimeType);

/** Run a converter in a scratch dir that is always removed. */
async function inScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'spotme-norm-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * HEIC/HEIF → JPEG bytes. The caller MUST still run the result through
 * {@link stripImageMetadata} — see the file header for why that is load-bearing
 * rather than defensive.
 */
export async function heicToJpeg(bytes: Buffer): Promise<Buffer> {
  return inScratch(async (dir) => {
    const input = join(dir, 'in.heic');
    const output = join(dir, 'out.jpg');
    await writeFile(input, bytes);
    try {
      await run('heif-convert', ['-q', '88', input, output]);
    } catch (e) {
      throw new UnsupportedImageError(`HEIC decode failed: ${(e as Error).message?.slice(0, 120)}`);
    }
    const jpeg = await readFile(output).catch(() => null);
    if (!jpeg || jpeg.length < 8 || jpeg.readUInt16BE(0) !== 0xffd8) {
      throw new UnsupportedImageError('HEIC decode produced no JPEG');
    }
    return jpeg;
  });
}

/** ffmpeg args to move a video into mp4 with every container tag dropped. */
export function normaliseVideoArgs(input: string, output: string, copy: boolean): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    // The whole point: GPS and every other container tag, gone — before the
    // bytes are persisted, not just on the derived variants.
    '-map_metadata', '-1',
    // A stream copy is a remux: no re-encode, so it is fast and lossless. An
    // iPhone's H.264/HEVC + AAC is already mp4-legal, so this is the normal
    // path; the re-encode below is only for containers that refuse to copy.
    ...(copy ? ['-c', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac']),
    '-movflags', '+faststart',
    output,
  ];
}

/**
 * Any accepted video container → mp4 with container metadata stripped.
 * Tries a stream copy first and falls back to a re-encode, so an odd codec
 * combination degrades to "slower" rather than "refused".
 */
export async function normaliseVideoToMp4(bytes: Buffer): Promise<Buffer> {
  return inScratch(async (dir) => {
    const input = join(dir, 'in');
    const output = join(dir, 'out.mp4');
    await writeFile(input, bytes);
    try {
      await run('ffmpeg', normaliseVideoArgs(input, output, true));
    } catch {
      try {
        await run('ffmpeg', normaliseVideoArgs(input, output, false));
      } catch (e) {
        throw new UnsupportedImageError(`video normalise failed: ${(e as Error).message?.slice(0, 120)}`);
      }
    }
    const mp4 = await readFile(output).catch(() => null);
    if (!mp4 || mp4.length === 0) throw new UnsupportedImageError('video normalise produced no output');
    return mp4;
  });
}
