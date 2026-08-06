/**
 * iPhone media at the ingest boundary — HEIC photos and QuickTime `.mov`.
 *
 * The obligation these tests exist to discharge is narrow and specific: for
 * every newly-accepted format, the bytes that reach the OBJECT STORE carry no
 * location metadata. Not the derived variants — the stored object itself.
 *
 * The fixtures are real files, not synthetic look-alikes: `iphone-gps.heic` is
 * a genuine HEIC (libheif-encoded, `heic` brand) carrying a structurally valid
 * EXIF GPS IFD, and `iphone-gps.mov` is a genuine QuickTime file carrying a
 * container location tag. Every leg asserts the SOURCE still carries its
 * metadata before claiming the pipeline removed it, so a fixture that quietly
 * stopped being tagged fails the test instead of passing it vacuously.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { MomentMediaService } from '../src/moment-media/media.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { IStorageAdapter } from '../src/storage/storage.interface';
import { containsMetadataMarkers } from '../src/moment-media/exif-strip';
import { heicToJpeg, normaliseVideoArgs } from '../src/moment-media/normalize';

const FIXTURES = join(__dirname, 'fixtures');
const HEIC = readFileSync(join(FIXTURES, 'iphone-gps.heic'));
const MOV = readFileSync(join(FIXTURES, 'iphone-gps.mov'));

/** The EXIF APP1 marker and the GPSInfo IFD pointer tag (0x8825). */
const EXIF_MARKER = Buffer.from('Exif\0\0', 'latin1');
const GPS_IFD_TAG = Buffer.from([0x88, 0x25]);
/** The literal coordinate written into the .mov container tag. */
const MOV_COORDS = Buffer.from('+37.7749', 'latin1');

/**
 * The marker segments a JPEG carries before SOS.
 *
 * SCANNING FOR 0x8825 IS NOT A SOUND TEST ON ITS OWN. It is two bytes, so it
 * turns up by chance inside entropy-coded pixel data — measured on a real
 * drive, a correctly stripped 16 KB JPEG contained 0x8825 once at offset
 * 15175, well past SOS at 329. Asserting its absence over whole-file bytes
 * therefore fails at random depending on how the fixture happens to compress.
 * What actually proves the strip is structural: no APP1..APP15 and no COM
 * segment survived. That is the guarantee `stripJpeg` makes, so that is what
 * these tests assert.
 */
function jpegMetadataSegments(d: Buffer): string[] {
  const meta: string[] = [];
  let i = 2;
  while (i + 4 <= d.length && d[i] === 0xff) {
    const m = d[i + 1];
    if (m === 0xd9 || m === 0xda) break; // EOI / SOS — entropy data follows
    if ((m >= 0xe1 && m <= 0xef) || m === 0xfe) meta.push(`0x${m.toString(16)}`);
    i += 2 + d.readUInt16BE(i + 2);
  }
  return meta;
}

const has = (tool: string): boolean => {
  try { execFileSync('which', [tool], { stdio: 'ignore' }); return true; } catch { return false; }
};

/**
 * Container tags as ffprobe PARSES them, for a buffer.
 *
 * Scanning bytes for a coordinate string is not a sound test for mp4 and would
 * pass vacuously: QuickTime keeps the location in an ASCII `©xyz` atom, but mp4
 * writes a `loci` atom holding 16.16 FIXED-POINT binary — ffprobe reports
 * `location=+37.7749-122.4194/` for a file in which that text does not appear
 * anywhere. So the video legs assert against the parser, not against bytes.
 */
function probeFormatTags(bytes: Buffer, suffix: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'spotme-probe-'));
  const file = join(dir, `probe${suffix}`);
  try {
    writeFileSync(file, bytes);
    return execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format_tags', '-of', 'default=noprint_wrappers=1', file,
    ]).toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const HAS_HEIF = has('heif-convert');
const HAS_FFMPEG = has('ffmpeg');

/**
 * Captures exactly what the pipeline hands to the bucket. `putObject` is the
 * only way bytes become an object, so what lands here IS the stored object.
 */
class CapturingStorage implements IStorageAdapter {
  readonly name = 'capture';
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  async getUploadUrl(k: string): Promise<string> { return `capture://up/${k}`; }
  async getDownloadUrl(k: string): Promise<string> { return `capture://down/${k}`; }
  async putObject(k: string, bytes: Buffer, contentType: string): Promise<boolean> {
    this.objects.set(k, { bytes, contentType }); return true;
  }
  async deleteObject(k: string): Promise<boolean> { this.objects.delete(k); return true; }
  async deleteRoomObjects(roomId: string): Promise<number> {
    let n = 0;
    for (const k of [...this.objects.keys()]) if (k.includes(roomId)) { this.objects.delete(k); n++; }
    return n;
  }
}

const prisma = new PrismaClient();
const RUN = `nm${Date.now().toString(36)}`;

describe('iPhone media — HEIC and .mov are normalised before anything is stored', () => {
  afterAll(async () => {
    await prisma.momentMediaAsset.deleteMany({ where: { id: { startsWith: `mm-${RUN}` } } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('the fixtures really do carry location metadata (guards against a vacuous pass)', () => {
    expect(HEIC.subarray(8, 12).toString('latin1')).toBe('heic');
    expect(HEIC.includes(EXIF_MARKER)).toBe(true);
    expect(HEIC.includes(GPS_IFD_TAG)).toBe(true);
    expect(MOV.subarray(8, 12).toString('latin1')).toBe('qt  ');
    expect(MOV.includes(MOV_COORDS)).toBe(true);
  });

  it('the ffmpeg normalise args always drop container metadata', () => {
    for (const copy of [true, false]) {
      const args = normaliseVideoArgs('in', 'out.mp4', copy);
      const i = args.indexOf('-map_metadata');
      expect(i).toBeGreaterThan(-1);
      expect(args[i + 1]).toBe('-1');
      expect(args).toContain('+faststart');
    }
  });

  it('the newly accepted MIME types get an upload slot; unsupported ones still do not', async () => {
    const s = new MomentMediaService(prisma as unknown as PrismaService, null);
    for (const mimeType of ['image/heic', 'image/heif', 'video/quicktime']) {
      const slot = await s.createUploadSlot({ ownerId: 'u1', kind: 'image', mimeType, sizeBytes: 1000 });
      expect(slot.headers['content-type']).toBe(mimeType);
    }
    await expect(s.createUploadSlot({ ownerId: 'u1', kind: 'image', mimeType: 'image/gif', sizeBytes: 1 }))
      .rejects.toThrow(/unsupported/);
  });

  /* THE LOAD-BEARING ONE. If heif-convert ever stopped copying EXIF into its
   * output this would fail, and the re-strip in normaliseForStorage could be
   * called redundant. Today it is not: the converted JPEG still carries the
   * GPS IFD, which is exactly why the strip runs on the conversion's output. */
  (HAS_HEIF ? it : it.skip)('HEIC→JPEG conversion ALONE still leaks GPS — the re-strip is not decorative', async () => {
    const converted = await heicToJpeg(HEIC);
    expect(converted.readUInt16BE(0)).toBe(0xffd8);       // it really is a JPEG
    expect(converted.includes(EXIF_MARKER)).toBe(true);   // …and it really still leaks
    expect(converted.includes(GPS_IFD_TAG)).toBe(true);
  });

  (HAS_HEIF ? it : it.skip)('a HEIC upload is STORED as a JPEG with no EXIF and no GPS', async () => {
    const storage = new CapturingStorage();
    const s = new MomentMediaService(prisma as unknown as PrismaService, storage);
    const id = `mm-${RUN}-heic`;
    const r = await s.ingest(id, HEIC, 'image/heic', 'assets');
    expect(r.state).toBe('stored');

    const [stored] = [...storage.objects.values()];
    expect(stored).toBeDefined();
    // The bytes in the bucket are a JPEG, and they are clean.
    expect(stored.contentType).toBe('image/jpeg');
    expect(stored.bytes.readUInt16BE(0)).toBe(0xffd8);
    expect(stored.bytes.includes(EXIF_MARKER)).toBe(false);
    // Structural, not a byte scan — see jpegMetadataSegments for why.
    expect(jpegMetadataSegments(stored.bytes)).toEqual([]);
    expect(containsMetadataMarkers(stored.bytes)).toBe(false);
    // No HEIC byte ever reached the store.
    expect(stored.bytes.includes(Buffer.from('ftyp', 'latin1'))).toBe(false);

    // The row describes the format actually stored, not the one uploaded.
    const row = await prisma.momentMediaAsset.findUnique({ where: { id } });
    expect(row!.mimeType).toBe('image/jpeg');
    expect(row!.kind).toBe('image');
    expect(row!.exifStripped).toBe(true);
  });

  (HAS_FFMPEG ? it : it.skip)('a .mov upload is STORED as an mp4 with the location tag gone', async () => {
    const storage = new CapturingStorage();
    const s = new MomentMediaService(prisma as unknown as PrismaService, storage);
    const id = `mm-${RUN}-mov`;
    const r = await s.ingest(id, MOV, 'video/quicktime', 'assets');
    expect(r.state).toBe('stored');

    const [stored] = [...storage.objects.values()];
    expect(stored).toBeDefined();
    expect(stored.contentType).toBe('video/mp4');
    // The SOURCE's location really is parseable (non-vacuous), and the stored
    // ORIGINAL — not a derived variant — has none.
    expect(probeFormatTags(MOV, '.mov')).toContain('location');
    const storedTags = probeFormatTags(stored.bytes, '.mp4');
    expect(storedTags).not.toContain('location');
    expect(storedTags).toContain('major_brand'); // ffprobe really did parse it
    expect(stored.bytes.includes(MOV_COORDS)).toBe(false);

    const row = await prisma.momentMediaAsset.findUnique({ where: { id } });
    expect(row!.mimeType).toBe('video/mp4');
    expect(row!.kind).toBe('video');
  }, 60_000);

  /* The regression this closes: video used to be persisted EXACTLY as
   * uploaded, on the reasoning that the transcode worker would handle
   * metadata. The worker only cleans the derived variants, so the stored
   * original kept its tags. An already-accepted mp4 goes through the same
   * normalise now, so this holds for the pre-existing path too. */
  (HAS_FFMPEG ? it : it.skip)('an mp4 upload is normalised too — the stored original is not the uploaded bytes', async () => {
    const storage = new CapturingStorage();
    const s = new MomentMediaService(prisma as unknown as PrismaService, storage);
    const id = `mm-${RUN}-mp4`;
    // Same content, remuxed into mp4 while KEEPING the location tag. Via a
    // temp file, not a pipe: the mp4 muxer needs seekable output.
    const scratch = mkdtempSync(join(tmpdir(), 'spotme-spec-'));
    const mp4Path = join(scratch, 'gps.mp4');
    // Trimmed, so the CLEANED bytes differ from the .mov leg's. Without this
    // the two legs normalise to byte-identical output and the second ingest
    // correctly reports `deduplicated` — dedup hashes the cleaned bytes.
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', join(FIXTURES, 'iphone-gps.mov'),
      '-t', '0.5', '-c', 'copy', '-metadata', 'location=+37.7749-122.4194/', mp4Path,
    ]);
    const mp4WithGps = readFileSync(mp4Path);
    rmSync(scratch, { recursive: true, force: true });
    // Non-vacuous, and the reason this must be a parser check: the coordinate
    // is in a binary `loci` atom, so the ASCII never appears in these bytes.
    expect(probeFormatTags(mp4WithGps, '.mp4')).toContain('location');
    expect(mp4WithGps.includes(MOV_COORDS)).toBe(false);

    expect((await s.ingest(id, mp4WithGps, 'video/mp4', 'assets')).state).toBe('stored');
    const [stored] = [...storage.objects.values()];
    expect(probeFormatTags(stored.bytes, '.mp4')).not.toContain('location');
  }, 60_000); // a remux plus three probes; well past jest's 5s default

  it('a mislabelled upload is refused and nothing is persisted', async () => {
    const storage = new CapturingStorage();
    const s = new MomentMediaService(prisma as unknown as PrismaService, storage);
    const id = `mm-${RUN}-bad`;
    // Declared HEIC, is not HEIC — the converter fails and ingest REFUSES
    // rather than falling back to storing the bytes.
    const r = await s.ingest(id, Buffer.from('this is definitely not a heic file'), 'image/heic', 'assets');
    expect(r.state).toBe('refused');
    expect(storage.objects.size).toBe(0);
    expect(await prisma.momentMediaAsset.findUnique({ where: { id } })).toBeNull();
  });
});
