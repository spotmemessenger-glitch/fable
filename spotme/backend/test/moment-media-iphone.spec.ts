/**
 * iPhone media — the proof obligations for HEIC photos and QuickTime `.mov`.
 *
 * WHAT THIS FILE HAS TO PROVE, and why the obvious version of it is worthless:
 * that GPS is gone from THE BYTES THAT GET STORED. Not from a tool's output,
 * not from a buffer somewhere in the middle of the pipeline — from the exact
 * buffer handed to `storage.putObject`. So the tests below run the real
 * `ingest()` against a storage adapter that CAPTURES what it is asked to
 * write, then assert on that capture.
 *
 * A WARNING FOR ANYONE EXTENDING THIS. `strings file | grep 12.9716` prints
 * nothing on the GPS-tagged fixtures in `test/fixtures/media/` even though
 * both are full of coordinates: EXIF stores them as binary rationals and
 * QuickTime packs them into an ISO-6709 atom. A grep-based assertion here
 * would pass on completely unstripped bytes. The assertions therefore look for
 * the STRUCTURES — the Exif APP1 marker, the QuickTime location atom — via
 * `containsMetadataMarkers` / `containsContainerLocationTags`, and the
 * fixtures are proven dirty first so a broken assertion cannot pass vacuously.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MomentMediaService } from '../src/moment-media/media.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { containsMetadataMarkers } from '../src/moment-media/exif-strip';
import {
  normalizeForStorage, containsContainerLocationTags, magicMatches, remuxArgs,
} from '../src/moment-media/normalize';

const FIX = join(__dirname, 'fixtures', 'media');
const HEIC = readFileSync(join(FIX, 'gps-iphone.heic'));
const MOV = readFileSync(join(FIX, 'gps-iphone.mov'));

/** Present in the runtime image (see Dockerfile). Absent locally ⇒ the tests
 *  that need them FAIL rather than skip: a silent skip on the one suite that
 *  proves GPS removal is exactly the failure mode this file exists to stop. */
function toolPresent(bin: string): boolean {
  try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; }
}

/* ------------------------------------------------------- capturing fakes */

/** Records every byte the pipeline tries to persist. */
class CapturingStorage {
  readonly writes: Array<{ key: string; bytes: Buffer; contentType: string }> = [];
  async putObject(key: string, bytes: Buffer, contentType: string) {
    this.writes.push({ key, bytes, contentType }); return true;
  }
  async getUploadUrl(key: string) { return `fixture://up/${key}`; }
  async getDownloadUrl(key: string) { return `fixture://down/${key}`; }
  async deleteObject() { return true; }
}

/** Just enough Prisma for `ingest()`: no row ever pre-exists, creates are kept. */
function fakePrisma() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    momentMediaAsset: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { rows.push(data); return data; },
      updateMany: async () => ({ count: 0 }),
    },
  };
}

function serviceWith(storage: CapturingStorage) {
  const prisma = fakePrisma();
  const svc = new MomentMediaService(
    prisma as unknown as PrismaService,
    storage as unknown as never,
  );
  return { svc, prisma };
}

describe('iPhone media — fixtures are genuinely GPS-bearing (guards the assertions below)', () => {
  it('the HEIC fixture really does carry an Exif block', () => {
    expect(containsMetadataMarkers(HEIC)).toBe(true);
  });

  it('the .mov fixture really does carry a QuickTime location atom', () => {
    expect(containsContainerLocationTags(MOV)).toBe(true);
  });

  it('the two formats hide their coordinates DIFFERENTLY — which is why grep is not a proof', () => {
    // The HEIC encodes 12.9716 as EXIF binary rationals: searching the bytes
    // for the number finds nothing at all, on a file that is fully GPS-tagged.
    // A grep-based test would pass here without stripping anything.
    expect(HEIC.toString('latin1')).not.toContain('12.9716');
    // The .mov is the opposite: QuickTime's `©xyz` atom holds ISO-6709 as
    // plain ASCII, so the coordinates ARE readable in the raw bytes.
    expect(MOV.toString('latin1')).toContain('+12.9716+077.5946/');
    // Structural detection catches both; that is what the assertions use.
    expect(containsMetadataMarkers(HEIC)).toBe(true);
    expect(containsContainerLocationTags(MOV)).toBe(true);
  });
});

describe('HEIC → JPEG: the transcode alone is NOT enough', () => {
  it('heif-convert COPIES the Exif into its JPEG — normalisation on its own leaks GPS', async () => {
    if (!toolPresent('heif-convert')) throw new Error('heif-convert missing — install libheif-examples');
    const normalized = await normalizeForStorage(HEIC, 'image/heic');
    expect(normalized.mimeType).toBe('image/jpeg');
    expect(normalized.transcodedFrom).toBe('image/heic');
    // THE POINT: still dirty at this stage. The stripper is what cleans it.
    expect(containsMetadataMarkers(normalized.bytes)).toBe(true);
  });
});

describe('the STORED bytes — the only assertion that matters', () => {
  it('a GPS-tagged HEIC is stored as a JPEG with no Exif at all', async () => {
    if (!toolPresent('heif-convert')) throw new Error('heif-convert missing — install libheif-examples');
    const storage = new CapturingStorage();
    const { svc, prisma } = serviceWith(storage);

    const result = await svc.ingest('mm-heic-1', HEIC, 'image/heic', 'owner-1');
    expect(result.state).toBe('stored');

    expect(storage.writes).toHaveLength(1);
    const written = storage.writes[0];
    // The bytes that reached storage carry no Exif/GPS structure...
    expect(containsMetadataMarkers(written.bytes)).toBe(false);
    // ...and they are a JPEG, not the HEIC that was uploaded.
    expect(written.bytes.readUInt16BE(0)).toBe(0xffd8);
    expect(written.contentType).toBe('image/jpeg');
    // The ORIGINAL never reached storage under any key.
    expect(storage.writes.some((w) => w.bytes.equals(HEIC))).toBe(false);
    // The row agrees with the bytes — serving `image/heic` here would hand the
    // browser a content-type that contradicts the object.
    expect(prisma.rows[0]).toMatchObject({ kind: 'image', mimeType: 'image/jpeg', exifStripped: true });
  });

  it('a GPS-tagged .mov is stored as an MP4 with no location atom', async () => {
    if (!toolPresent('ffmpeg')) throw new Error('ffmpeg missing — install ffmpeg');
    const storage = new CapturingStorage();
    const { svc, prisma } = serviceWith(storage);

    const result = await svc.ingest('mm-mov-1', MOV, 'video/quicktime', 'owner-1');
    expect(result.state).toBe('stored');

    expect(storage.writes).toHaveLength(1);
    const written = storage.writes[0];
    expect(containsContainerLocationTags(written.bytes)).toBe(false);
    // QuickTime keeps ISO-6709 as ASCII, so for this format the plainest
    // possible check is also available: the coordinates are simply not there.
    expect(written.bytes.toString('latin1')).not.toContain('12.9716');
    expect(written.bytes.toString('latin1')).not.toContain('77.5946');
    expect(written.contentType).toBe('video/mp4');
    expect(storage.writes.some((w) => w.bytes.equals(MOV))).toBe(false);
    expect(prisma.rows[0]).toMatchObject({ kind: 'video', mimeType: 'video/mp4' });
  });

  it('the stored MP4 is faststart — moov ahead of mdat, which the .mov was not', async () => {
    if (!toolPresent('ffmpeg')) throw new Error('ffmpeg missing — install ffmpeg');
    const storage = new CapturingStorage();
    const { svc } = serviceWith(storage);
    await svc.ingest('mm-mov-2', MOV, 'video/quicktime', 'owner-1');

    const out = storage.writes[0].bytes;
    const moov = out.indexOf(Buffer.from('moov'));
    const mdat = out.indexOf(Buffer.from('mdat'));
    expect(moov).toBeGreaterThanOrEqual(0);
    expect(moov).toBeLessThan(mdat);
    // The source really did have the trailing moov this fixes.
    expect(MOV.indexOf(Buffer.from('moov'))).toBeGreaterThan(MOV.indexOf(Buffer.from('mdat')));
  });

  it('REGRESSION: a plain mp4 upload is stripped too — video used to be stored verbatim', async () => {
    if (!toolPresent('ffmpeg')) throw new Error('ffmpeg missing — install ffmpeg');
    // The .mov fixture's bytes declared as video/mp4: the old code path took
    // `clean = bytes` for anything non-image, so the GPS atom went straight to
    // the bucket and `GET :mediaId/url` served it.
    const storage = new CapturingStorage();
    const { svc } = serviceWith(storage);
    const result = await svc.ingest('mm-mp4-1', MOV, 'video/mp4', 'owner-1');
    expect(result.state).toBe('stored');
    expect(containsContainerLocationTags(storage.writes[0].bytes)).toBe(false);
  });
});

describe('refusals — a widened accept-list must not become a pass-through', () => {
  it('a JPEG that CLAIMS to be HEIC is refused on the magic bytes, not transcoded', async () => {
    const storage = new CapturingStorage();
    const { svc } = serviceWith(storage);
    const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(64)]);
    const result = await svc.ingest('mm-lie-1', jpegBytes, 'image/heic', 'owner-1');
    expect(result).toEqual({ state: 'refused', reason: 'unsupported-format' });
    expect(storage.writes).toHaveLength(0);
  });

  it('garbage claiming to be .mov never reaches storage', async () => {
    const storage = new CapturingStorage();
    const { svc } = serviceWith(storage);
    const result = await svc.ingest('mm-lie-2', Buffer.alloc(4096, 7), 'video/quicktime', 'owner-1');
    expect(result.state).toBe('refused');
    expect(storage.writes).toHaveLength(0);
  });

  it('an unaccepted mime is still refused outright (HEIC did not widen the door for everything)', async () => {
    const storage = new CapturingStorage();
    const { svc } = serviceWith(storage);
    expect(await svc.ingest('mm-x', HEIC, 'image/gif', 'owner-1')).toEqual({ state: 'refused', reason: 'bad-mime' });
    expect(await svc.ingest('mm-y', HEIC, 'application/pdf', 'owner-1')).toEqual({ state: 'refused', reason: 'bad-mime' });
    expect(storage.writes).toHaveLength(0);
  });

  it('magicMatches accepts a real HEIC and a real .mov, and rejects the swap', () => {
    expect(magicMatches(HEIC, 'image/heic')).toBe(true);
    expect(magicMatches(MOV, 'video/quicktime')).toBe(true);
    expect(magicMatches(HEIC, 'video/quicktime')).toBe(false);
    expect(magicMatches(MOV, 'image/heic')).toBe(false);
  });
});

describe('the ffmpeg arguments carry the flags the privacy claim rests on', () => {
  it('global AND per-stream metadata are dropped, and mp4 gets faststart', () => {
    const args = remuxArgs('in.mov', 'out.mp4', 'mp4').join(' ');
    expect(args).toContain('-map_metadata -1');
    // `-map_metadata -1` alone does not reach stream-scoped tags.
    expect(args).toContain('-map_metadata:s:v -1');
    expect(args).toContain('-map_metadata:s:a -1');
    expect(args).toContain('-movflags +faststart');
  });
});
