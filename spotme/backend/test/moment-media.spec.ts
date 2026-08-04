/**
 * Phase 5B — media pipeline proof obligations: the EXIF/GPS strip boundary (a
 * GPS-tagged fixture image comes out clean, BEFORE any persistence), refusal of
 * unknown formats, content-hash dedup, queue-contract inertness without env,
 * fixture workers, and the refCount deletion cascade (real DB).
 */

import { PrismaClient } from '@prisma/client';
import { stripImageMetadata, containsMetadataMarkers, UnsupportedImageError } from '../src/moment-media/exif-strip';
import { createMomentQueues, FixtureMomentWorkers, MOMENT_QUEUE_NAMES } from '../src/moment-media/media.queues';
import { MomentMediaService } from '../src/moment-media/media.service';
import { PrismaService } from '../src/prisma/prisma.service';

const prisma = new PrismaClient();
const svc = () => new MomentMediaService(prisma as unknown as PrismaService, null);
const RUN = `mm${Date.now().toString(36)}`;

/** Build a GPS-tagged JPEG fixture: SOI + APP0(JFIF) + APP1(Exif w/ GPS) + SOS + data + EOI. */
function gpsJpeg(): Buffer {
  const seg = (marker: number, body: Buffer) => {
    const b = Buffer.alloc(4);
    b[0] = 0xff; b[1] = marker; b.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([b, body]);
  };
  const app0 = seg(0xe0, Buffer.from('JFIF\0\x01\x02\0\0\0\0\0\0', 'latin1'));
  const exifBody = Buffer.from('Exif\0\0MM\0*GPSLatitude=12.9716;GPSLongitude=77.5946', 'latin1');
  const app1 = seg(0xe1, exifBody);
  const com = seg(0xfe, Buffer.from('shot on a phone at GPSLatitude 12.9716', 'latin1'));
  const sos = Buffer.concat([Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x00]), Buffer.from([0x12, 0x34, 0x56, 0x78])]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, com, sos, eoi]);
}

/** Minimal PNG with a tEXt GPS chunk. */
function gpsPng(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); // crc zeroed (parser ignores)
  };
  const ihdr = chunk('IHDR', Buffer.alloc(13));
  const text = chunk('tEXt', Buffer.from('GPS\0GPSLatitude=12.9716', 'latin1'));
  const idat = chunk('IDAT', Buffer.from([1, 2, 3, 4]));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, text, idat, iend]);
}

describe('EXIF/GPS strip boundary (5B)', () => {
  it('a GPS-tagged JPEG comes out CLEAN — Exif + GPS + comments gone, image data intact', () => {
    const dirty = gpsJpeg();
    expect(containsMetadataMarkers(dirty)).toBe(true);
    const clean = stripImageMetadata(dirty, 'image/jpeg');
    expect(containsMetadataMarkers(clean)).toBe(false);
    expect(clean.toString('latin1')).not.toContain('12.9716');
    expect(clean.toString('latin1')).not.toContain('77.5946');
    // Structure preserved: SOI, JFIF APP0 kept, SOS data + EOI intact.
    expect(clean.readUInt16BE(0)).toBe(0xffd8);
    expect(clean.toString('latin1')).toContain('JFIF');
    expect(clean.subarray(clean.length - 2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
  });

  it('a GPS tEXt PNG comes out clean; structure preserved', () => {
    const clean = stripImageMetadata(gpsPng(), 'image/png');
    expect(clean.toString('latin1')).not.toContain('GPSLatitude');
    expect(clean.toString('latin1')).toContain('IDAT');
    expect(clean.toString('latin1')).toContain('IEND');
  });

  it('unknown formats are REFUSED, never passed through unstripped', () => {
    expect(() => stripImageMetadata(Buffer.from('GIF89a-not-supported'), 'image/gif')).toThrow(UnsupportedImageError);
    expect(() => stripImageMetadata(Buffer.from('junk'), 'image/jpeg')).toThrow(UnsupportedImageError);
  });
});

describe('queue contracts (M8) — reserved + inert', () => {
  it('reserves exactly the four names with the 1C hash-tag convention', () => {
    expect([...MOMENT_QUEUE_NAMES]).toEqual(['{moment-media}', '{story-expiry}', '{feed-refresh}', '{moderation}']);
  });
  it('createMomentQueues is INERT without env, and descriptors-only WITH env', () => {
    expect(createMomentQueues({})).toBeNull();
    expect(createMomentQueues({ REDIS_URL: 'not-a-url' })).toBeNull();
    const d = createMomentQueues({ REDIS_URL: 'redis://localhost:6380' });
    expect(d).toEqual({ names: MOMENT_QUEUE_NAMES, connected: false });
  });
  it('fixture workers process every job kind and reject unknown', async () => {
    const w = new FixtureMomentWorkers();
    expect((await w.process({ name: 'story-expiry', sweepBeforeUTC: 1 })).queue).toBe('{story-expiry}');
    expect((await w.process({ name: 'moderation', reportId: 'r1', reason: 'child-safety', priority: 'child-safety' })).queue).toBe('{moderation}');
    await expect(w.process({ name: 'nope' } as never)).rejects.toThrow(/unknown moment job/);
  });
});

describe('ingest → dedup → cascade (real DB)', () => {
  afterAll(async () => {
    await prisma.momentMediaAsset.deleteMany({ where: { storageKey: { contains: RUN } } }).catch(() => {});
    await prisma.momentMediaAsset.deleteMany({ where: { id: { startsWith: `mm-${RUN}` } } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('ingest strips BEFORE hashing/persisting; a byte-identical re-upload deduplicates', async () => {
    const s = svc();
    const a = await s.ingest(`mm-${RUN}-1`, gpsJpeg(), 'image/jpeg');
    expect(a.state).toBe('stored');
    // The stored row's hash is of the STRIPPED bytes: re-ingesting a dirty copy
    // (same image, same metadata) hits the same clean hash → dedup.
    const b = await s.ingest(`mm-${RUN}-2`, gpsJpeg(), 'image/jpeg');
    expect(b.state).toBe('deduplicated');
    if (b.state === 'deduplicated') expect(b.canonicalMediaId).toBe(`mm-${RUN}-1`);
    // The asset row records exifStripped and never a coordinate.
    const row = await prisma.momentMediaAsset.findUnique({ where: { id: `mm-${RUN}-1` } });
    expect(row!.exifStripped).toBe(true);
    expect(JSON.stringify(row)).not.toContain('12.9716');
    // The processing job CONTRACTS were recorded (thumbnail w/ strip flag).
    expect(s.workers.processed.some((j) => j.name === 'thumbnail' && j.argsTemplate.includes('strip'))).toBe(true);
  });

  it('refusals are typed: bad mime and unsupported format never persist anything', async () => {
    const s = svc();
    expect((await s.ingest(`mm-${RUN}-x`, Buffer.from('x'), 'application/octet-stream')).state).toBe('refused');
    expect((await s.ingest(`mm-${RUN}-y`, Buffer.from('GIFdata'), 'image/jpeg')).state).toBe('refused');
    expect(await prisma.momentMediaAsset.findUnique({ where: { id: `mm-${RUN}-x` } })).toBeNull();
  });

  it('refCount deletion cascade: last reference out deletes the asset row', async () => {
    const s = svc();
    const id = `mm-${RUN}-3`;
    // Unique content so it stores (append the id to the comment segment).
    const bytes = Buffer.concat([gpsJpeg(), Buffer.from(id)]);
    // (trailing bytes after EOI are preserved by the stripper's verbatim tail copy)
    const r = await s.ingest(id, bytes, 'image/jpeg');
    expect(r.state).toBe('stored');
    await s.addReference(id);
    await s.addReference(id);
    expect((await s.releaseReference(id)).deleted).toBe(false); // 2 → 1
    expect((await s.releaseReference(id)).deleted).toBe(true);  // 1 → 0 → gone
    expect(await prisma.momentMediaAsset.findUnique({ where: { id } })).toBeNull();
  });

  it('upload slot: allowed mime gets a slot (fixture URL with no storage env); ceilings enforced', async () => {
    const s = svc();
    const slot = await s.createUploadSlot({ ownerId: 'u1', kind: 'image', mimeType: 'image/jpeg', sizeBytes: 1000 });
    expect(slot.uploadUrl.startsWith('fixture://upload/')).toBe(true);
    await expect(s.createUploadSlot({ ownerId: 'u1', kind: 'image', mimeType: 'image/gif', sizeBytes: 1 })).rejects.toThrow(/unsupported/);
    await expect(s.createUploadSlot({ ownerId: 'u1', kind: 'video', mimeType: 'video/mp4', sizeBytes: 999_999_999 })).rejects.toThrow(/too large/);
  });
});
