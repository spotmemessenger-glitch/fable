/**
 * M3 — the transcode contract and the moderation sink.
 *
 * The ffmpeg ARGUMENTS are asserted rather than described, because the three
 * flags that make a feed playable are invisible in a screenshot and easy to
 * drop in a refactor: `+faststart` (moov at the front — the difference between
 * "plays now" and "downloads 40 MB first"), `-map_metadata -1` (GPS out of the
 * container, the video counterpart of EXIF stripping), and H.264/AAC (the only
 * pair every phone browser decodes).
 */

import { transcodeArgs, posterArgs, VARIANTS, NEEDS_HLS_SECONDS, TranscodeQueue } from '../src/moment-media/transcode.worker';
import { MODERATION_ALERT, ModerationSink } from '../src/moment-media/moderation.sink';

describe('M3 — transcode arguments', () => {
  const args = transcodeArgs('/tmp/in', '/tmp/out.mp4', VARIANTS[0]);
  const joined = args.join(' ');

  it('THE FLAG THIS EXISTS FOR: +faststart puts moov at the front', () => {
    expect(args).toContain('-movflags');
    expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart');
  });

  it('strips container metadata — GPS never survives into a served video', () => {
    expect(args).toContain('-map_metadata');
    expect(args[args.indexOf('-map_metadata') + 1]).toBe('-1');
  });

  it('encodes H.264 + AAC — the pair every phone browser can decode', () => {
    expect(joined).toContain('-c:v libx264');
    expect(joined).toContain('-c:a aac');
    // HEVC is exactly what phones RECORD and Android Chrome often cannot play.
    expect(joined).not.toMatch(/libx265|hevc/i);
  });

  it('forces even dimensions — an odd width is a hard H.264 failure', () => {
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf).toContain('scale=-2:');   // -2 keeps aspect AND rounds to even
  });

  /* H.264 High profile is 8-bit 4:2:0 only, and libx264 REFUSES anything else
   * rather than degrading — the job dies before a byte is written and the
   * person who shot the clip just sees that it never posted.
   *
   * Measured against real ffmpeg, both of these fail without the guard:
   *   yuv444p      -> "high profile doesn't support 4:4:4"
   *   yuv420p10le  -> "high profile doesn't support a bit depth of 10"
   * The second is not exotic: it is what an iPhone 12 or newer records by
   * default with Dolby Vision HDR on. */
  it('pins the pixel format — 10-bit HDR and 4:4:4 sources must not fail the encoder', () => {
    expect(args).toContain('-pix_fmt');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
    for (const v of VARIANTS) {
      expect(transcodeArgs('i', 'o', v).join(' ')).toContain('-pix_fmt yuv420p');
    }
  });

  it('never upscales: the ladder caps at the source height', () => {
    for (const v of VARIANTS) {
      expect(transcodeArgs('i', 'o', v).join(' ')).toContain(`min(${v.height},ih)`);
    }
  });

  describe('composer edits — the server does the cut, not the phone', () => {
    it('an unedited asset is byte-identical to before edits existed', () => {
      expect(transcodeArgs('/tmp/in', '/tmp/out.mp4', VARIANTS[0], {})).toEqual(args);
      expect(transcodeArgs('/tmp/in', '/tmp/out.mp4', VARIANTS[0], {
        trimStartMs: null, trimEndMs: null, coverAtMs: null,
      })).toEqual(args);
    });

    it('trim start fast-seeks BEFORE -i — cheaper, and it re-bases to zero', () => {
      const a = transcodeArgs('in', 'out', VARIANTS[0], { trimStartMs: 2500 });
      expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'));
      expect(a[a.indexOf('-ss') + 1]).toBe('2.500');
    });

    /* `-to` alongside an input `-ss` has meant different things across ffmpeg
     * versions. A DURATION is the same everywhere, so the end point is always
     * expressed that way — and it is measured from the cut, not from zero. */
    it('the end is a duration measured from the cut, never an absolute -to', () => {
      const a = transcodeArgs('in', 'out', VARIANTS[0], { trimStartMs: 2000, trimEndMs: 6500 });
      expect(a).not.toContain('-to');
      expect(a[a.indexOf('-t') + 1]).toBe('4.500');       // 6.5s - 2.0s
    });

    it('an end with no start is a duration from zero', () => {
      const a = transcodeArgs('in', 'out', VARIANTS[0], { trimEndMs: 3000 });
      expect(a[a.indexOf('-t') + 1]).toBe('3.000');
    });

    it('a nonsensical range is ignored rather than encoded as a negative length', () => {
      const a = transcodeArgs('in', 'out', VARIANTS[0], { trimStartMs: 5000, trimEndMs: 1000 });
      expect(a).not.toContain('-t');
    });

    it('the cover frame is the one chosen, offset back onto the untrimmed original', () => {
      // Chosen 3s into a clip that was trimmed to start at 2s -> 5s in the
      // original file. Without the offset every cover lands early.
      const p = posterArgs('in', 'out.jpg', { coverAtMs: 3000, trimStartMs: 2000 });
      expect(p[p.indexOf('-ss') + 1]).toBe('5.000');
      expect(p.indexOf('-ss')).toBeLessThan(p.indexOf('-i'));
    });

    it('no cover chosen keeps the 1s default that misses a black opening frame', () => {
      expect(posterArgs('in', 'out.jpg')[posterArgs('in', 'out.jpg').indexOf('-ss') + 1]).toBe('1.000');
    });
  });

  it('caps bitrate — an unbounded encode is what stutters on a mid-range phone', () => {
    expect(args).toContain('-maxrate');
    expect(args).toContain('-bufsize');
  });

  it('ships two rungs, 720p and 480p, largest first', () => {
    expect(VARIANTS.map((v) => v.name)).toEqual(['720p', '480p']);
    expect(VARIANTS[0].height).toBeGreaterThan(VARIANTS[1].height);
  });

  /* Asserts the SECOND, not the spelling. The timestamp moved from
   * `00:00:01` to `1.000` when cover-frame selection arrived — the same
   * position, in the format the chosen-frame path already had to produce —
   * and the seek moved ahead of `-i` so ffmpeg jumps to the frame instead of
   * decoding up to it. Pinning the literal string made a faster, identical
   * poster look like a regression. */
  it('takes the poster a second in, not at frame zero (which is often black)', () => {
    const p = posterArgs('i', 'o');
    expect(Number(p[p.indexOf('-ss') + 1])).toBe(1);
    expect(p.indexOf('-ss')).toBeLessThan(p.indexOf('-i'));
  });

  it('marks the HLS boundary at 30s rather than guessing per clip', () => {
    expect(NEEDS_HLS_SECONDS).toBe(30);
  });
});

describe('M3 — the queue is inert without Redis, never pretending', () => {
  const original = process.env.REDIS_URL;
  afterEach(() => { if (original === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = original; });

  it('start() reports false and enqueue() says it did nothing', async () => {
    delete process.env.REDIS_URL;
    const q = new TranscodeQueue();
    expect(q.start({} as never)).toBe(false);
    await expect(q.enqueue('mm-x')).resolves.toEqual({ enqueued: false });
  });
});

describe('D7 — the moderation sink actually records and alerts', () => {
  it('marks the report delivered AND raises a PII-free alert', async () => {
    const updates: unknown[] = [];
    const prisma = { momentReport: { update: async (a: unknown) => { updates.push(a); return {}; } } };
    const sink = new ModerationSink(prisma as never);
    const warn = jest.spyOn(sink['log'], 'warn').mockImplementation(() => undefined);

    const out = await sink.accept({ reportId: 'rep-1', targetKind: 'moment', targetId: 'mo-1', reason: 'Nudity' });

    expect(out).toEqual({ recorded: true, alerted: true });
    expect(updates).toHaveLength(1);           // durable delivery marker written
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain(MODERATION_ALERT);
    expect(line).toContain('rep-1');
    // THE POINT: ids and a reason, never reporter identity or note text.
    expect(line).not.toMatch(/reporter|note=/i);
    warn.mockRestore();
  });

  it('a record failure still alerts — a lost row must not silence the report', async () => {
    const prisma = { momentReport: { update: async () => { throw new Error('db down'); } } };
    const sink = new ModerationSink(prisma as never);
    const warn = jest.spyOn(sink['log'], 'warn').mockImplementation(() => undefined);
    const err = jest.spyOn(sink['log'], 'error').mockImplementation(() => undefined);

    const out = await sink.accept({ reportId: 'rep-2', targetKind: 'comment', targetId: 'c-1', reason: 'Spam' });

    expect(out).toEqual({ recorded: false, alerted: true });
    expect(err).toHaveBeenCalled();            // loud, not swallowed
    expect(String(warn.mock.calls[0][0])).toContain('rep-2');
    warn.mockRestore(); err.mockRestore();
  });
});
