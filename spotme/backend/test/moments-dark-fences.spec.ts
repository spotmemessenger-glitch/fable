/**
 * Phase 5E — DARK INTEGRATION FENCES + the M9 verification battery for Nearby
 * Moments. Load-bearing, non-vacuous: every claim of darkness is an assertion
 * over the actual source tree, schema, manifests, and build artifacts.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  liveWebRoot, liveEntryDarkPackageImports, posix, BACKEND, REPO, read, walk, inDir, requireNonEmpty, clientDomainRoots, appEntries, clientTestExists, clientManifests,
} from './helpers/fence-paths';
import { stripImageMetadata, containsMetadataMarkers } from '../src/moment-media/exif-strip';
import { createMomentQueues } from '../src/moment-media/media.queues';
import { toMomentSearchProjection, PrivateInProjectionError } from '../src/moments/moments.search';
import { scoreBreakdown, FORBIDDEN_RANKING_SIGNALS, MomentRankingRegistryError } from '../src/moments/moments.ranking';
import type { MomentRow } from '../src/moments/moments.ports';

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
const MOMENTS_REACH = /['"][^'"]*\/(moments|moment-media)[\/.'"-]/;

const momentRow = (over: Partial<MomentRow> = {}): MomentRow => ({
  id: 'p1', authorId: 'u1', kind: 'text', text: 'x', mediaIds: [], visibility: 'public',
  coarseLat: null, coarseLon: null, coarseCell: null, cityCell: 'c13.0:77.6',
  moderationState: 'visible', versionSeq: 1, createdAtUTC: 1, ...over,
});

/** The GPS-tagged JPEG fixture, rebuilt at fence level. */
function gpsJpeg(): Buffer {
  const seg = (marker: number, body: Buffer) => {
    const b = Buffer.alloc(4);
    b[0] = 0xff; b[1] = marker; b.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([b, body]);
  };
  const app1 = seg(0xe1, Buffer.from('Exif\0\0MM\0*GPSLatitude=12.9716;GPSLongitude=77.5946', 'latin1'));
  const sos = Buffer.concat([Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x00]), Buffer.from([0x12, 0x34])]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sos, Buffer.from([0xff, 0xd9])]);
}

describe('Moments — dark integration fences', () => {
  /* WAVE 1D (M1) CHANGED THIS INVARIANT, DELIBERATELY.
   *
   * Moments is now MOUNTED. "Dark" no longer means "absent from the DI graph";
   * it means every route answers 404 unless the `moments` domain is enabled
   * for the caller. The fence therefore asserts the GATE rather than the
   * absence — an unmounted module and a gated one are indistinguishable from
   * outside, which is the property that actually matters, and the runtime
   * proof lives in moments-gate-runtime.spec.ts. Asserting absence here would
   * now forbid the activation the owner authorised. */
  it('AppModule mounts MomentsModule (activation) — and nothing else changed', () => {
    const src = read(join(BACKEND, 'src/app.module.ts'));
    expect(src).toContain('MomentsModule');
    // The dark domains stay OUT of the graph entirely.
    for (const banned of ['ExchangeModule', 'EventsModule', 'AssistantModule']) {
      expect(src).not.toContain(banned);
    }
  });

  it('EVERY moments controller sits behind DomainGate(\'moments\') + requireAdult', () => {
    const controllers = walk(join(BACKEND, 'src/moments'), ['.ts']).filter((f) => f.endsWith('.controller.ts'));
    expect(controllers.length).toBeGreaterThan(0);
    for (const file of controllers) {
      const src = read(file);
      expect(src).toMatch(/DomainGate\('moments'/);
      expect(src).toMatch(/requireAdult:\s*true/);
    }
  });

  it('no backend module OUTSIDE the moments subtrees reaches into them, except the mount', () => {
    const files = walk(join(BACKEND, 'src'), ['.ts'])
      .filter((f) => !inDir(f, 'moments') && !inDir(f, 'moment-media'))
      .filter((f) => !f.endsWith('app.module.ts'))   // the mount itself
      .filter((f) => !f.endsWith('main.ts'));        // the upload body-parser path
    expect(files.filter((f) => MOMENTS_REACH.test(read(f)))).toEqual([]);
  });

  it('main.ts names the upload ROUTE only — it never imports the moments subtree', () => {
    /* The raw-body parser has to know the path (Express runs middleware in
     * registration order, so a later parser never sees the request). Knowing a
     * URL string is not reaching into the module: an import would put moments
     * code on the boot path even with the gate closed. */
    const src = read(join(BACKEND, 'src/main.ts'));
    expect(src).toContain('/api/v1/moments/media');
    expect(src).not.toMatch(/from\s+['"]\.\/moments/);
    expect(src).not.toMatch(/from\s+['"]\.\/moment-media/);
  });

  it('the web-next entry (App/main) mounts NEITHER MomentsShell NOR the moments subtree', () => {
    expect(liveEntryDarkPackageImports()).toEqual([]);
    for (const entry of appEntries()) {
      const s = read(entry);
      expect(s).not.toMatch(/MomentsShell/);
      expect(MOMENTS_REACH.test(s)).toBe(false);
    }
  });

  it('the media queue factory is INERT without env (behavioral)', () => {
    expect(createMomentQueues({})).toBeNull();
    const d = createMomentQueues({ REDIS_URL: 'redis://x:1' });
    expect(d?.connected).toBe(false); // even with env: descriptors only
  });

  it('EXIF-STRIP re-proven at fence level: the GPS fixture comes out clean', () => {
    const dirty = gpsJpeg();
    expect(containsMetadataMarkers(dirty)).toBe(true);
    const clean = stripImageMetadata(dirty, 'image/jpeg');
    expect(containsMetadataMarkers(clean)).toBe(false);
    expect(clean.toString('latin1')).not.toContain('12.9716');
  });

  it('PRIVATE (and friends) never enter the projection — building one THROWS (behavioral)', () => {
    expect(() => toMomentSearchProjection(momentRow({ visibility: 'private' as never }))).toThrow(PrivateInProjectionError);
    expect(() => toMomentSearchProjection(momentRow({ visibility: 'friends' }))).toThrow(PrivateInProjectionError);
    const doc = toMomentSearchProjection(momentRow({ visibility: 'public', text: 'at 12.9716,77.5946 tonight' }));
    expect(JSON.stringify(doc)).not.toContain('12.9716'); // coordinate tokens stripped
    expect('coarseCell' in doc).toBe(false); // city cell only, never the coarse cell
  });

  it('RANKING INVARIANT (M9): every forbidden signal throws, at fence level', () => {
    for (const bad of FORBIDDEN_RANKING_SIGNALS) {
      expect(() => scoreBreakdown({ id: 'x', createdAtUTC: 1, evidence: { [bad]: 1 } as never }))
        .toThrow(MomentRankingRegistryError);
    }
  });

  it('IMPORT-GRAPH (M9): no moments/media file imports a camera branch, bullmq, or an S3 SDK directly', () => {
    const files = [
      ...walk(join(BACKEND, 'src/moments'), ['.ts']),
      ...walk(join(BACKEND, 'src/moment-media'), ['.ts']),
      ...requireNonEmpty(clientDomainRoots('moments').flatMap((d) => walk(d, ['.ts', '.tsx'])), 'moments client surface'),
    ];
    expect(files.length).toBeGreaterThan(10); // non-vacuous
    /* M3 NARROWED THE BULLMQ RULE, IT DID NOT DROP IT.
     *
     * The dark phase forbade bullmq everywhere because nothing was allowed to
     * connect. The authorised activation gives the transcode worker a real
     * queue — so exactly ONE file may import bullmq, and the prohibition still
     * holds for every other file. That keeps the property the fence was
     * protecting: the media SERVICE must not quietly become a queue client,
     * and a controller must never reach a queue at all. The camera-branch and
     * S3-SDK prohibitions are unchanged. */
    const QUEUE_OWNER = 'moment-media/transcode.worker.ts';
    for (const f of files) {
      const s = stripComments(read(f));
      expect(s).not.toMatch(/lib\/camera|camera-engine|createCameraEngine/);
      // posix(): on Windows the path is ...\moment-media	ranscode.worker.ts,
      // so a raw endsWith on a slashed literal never matched and the ONE file
      // authorised to own the queue tripped its own exemption.
      if (!posix(f).endsWith(QUEUE_OWNER)) expect(s).not.toMatch(/from\s+['"]bullmq['"]/);
      expect(s).not.toMatch(/@aws-sdk|aws-sdk/); // storage ONLY via the seam
    }
    // …and the one owner really is the worker, so the exemption cannot rot
    // into "whichever file happens to import it".
    expect(files.filter((f) => /from\s+['"]bullmq['"]/.test(stripComments(read(f))))
      .map((f) => posix(f).split('/').slice(-2).join('/'))).toEqual(['moment-media/transcode.worker.ts']);
    // The storage seam is the ONLY storage import in the media pipeline.
    const media = walk(join(BACKEND, 'src/moment-media'), ['.ts']).map(read).join('\n');
    expect(media).toContain("from '../storage/storage.interface'");
  });

  it('DEPENDENCY SCAN (M9): no media/AI binary dependency was added', () => {
    for (const pkgPath of [join(BACKEND, 'package.json'), ...clientManifests()]) {
      const pkg = JSON.parse(read(pkgPath)) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const all = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const banned of ['ffmpeg', 'fluent-ffmpeg', 'sharp', 'libvips', 'jimp', '@tensorflow', 'onnxruntime', 'openai', 'langchain']) {
        expect(Object.keys(all).some((d) => d.includes(banned))).toBe(false);
      }
    }
  });

  it('NO age/gender/payment/engagement-counter field exists in the moments subtrees', () => {
    const files = [
      ...walk(join(BACKEND, 'src/moments'), ['.ts']),
      ...walk(join(BACKEND, 'src/moment-media'), ['.ts']),
      ...requireNonEmpty(clientDomainRoots('moments').flatMap((d) => walk(d, ['.ts', '.tsx'])), 'moments client surface'),
    ];
    for (const f of files) {
      const s = stripComments(read(f));
      expect(s).not.toMatch(/\b(age|gender)\s*[:?]\s*(number|string)/i);
      expect(s).not.toMatch(/\b(viewCount|likeCount|shareCount|watchTimeMs|priceAmount|escrow)\s*[:?]/);
    }
    // The schema carries no viewer-origin column on any moments table.
    const schema = read(join(BACKEND, 'prisma/schema.prisma'));
    const momentsBlock = schema.slice(schema.indexOf('model Moment {'));
    expect(momentsBlock).not.toMatch(/origin ?lat|origin ?lon|viewer ?lat|viewer ?lon/i);
  });

  it('no moments feature flag is true; crypto flags remain dark; no secret-shaped literal', () => {
    const files = [
      ...walk(join(BACKEND, 'src/moments'), ['.ts']),
      ...walk(join(BACKEND, 'src/moment-media'), ['.ts']),
      ...requireNonEmpty(clientDomainRoots('moments').flatMap((d) => walk(d, ['.ts', '.tsx'])), 'moments client surface'),
    ];
    const SECRET = /\b(sk|pk|key|token|bearer)[-_][A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{28,}|[a-z][a-z0-9+.-]*:\/\/[^\s'"]*:[^\s'"]*@/;
    for (const f of files) {
      expect(read(f)).not.toMatch(/MOMENTS[_A-Z]*ENABLED\s*=\s*true/);
      expect(SECRET.test(read(f))).toBe(false);
    }
    const signing = read(join(liveWebRoot(), 'src/lib/crypto/signing-key-publication.js'));
    expect(signing).toContain('SIGNING_PUBLICATION_ENABLED = false');
  });

  it('BUILD ARTIFACTS (M9): compiled moments output carries no secret or storage endpoint', () => {
    const dist = join(BACKEND, 'dist');
    expect(existsSync(dist)).toBe(true);
    const files = walk(dist, ['.js']).filter((f) => inDir(f, 'moments') || inDir(f, 'moment-media'));
    expect(files.length).toBeGreaterThan(0); // moments DID compile (non-vacuous)
    const SECRET = /eyJ[A-Za-z0-9_-]{28,}|[a-z][a-z0-9+.-]*:\/\/[^\s'"]*:[^\s'"]*@/;
    for (const f of files) {
      const s = read(f);
      expect(s).not.toMatch(/https?:\/\/[^'"\s]*(amazonaws|r2\.cloudflarestorage|storage\.googleapis)/i);
      expect(SECRET.test(s)).toBe(false);
    }
  });

  it('NON-VACUOUS: every moments source cluster is exercised by a test', () => {
    const clusters: Record<string, string> = {
      'src/moments/moments.policy.ts': 'test/moments-policy.spec.ts',
      'src/moments/moments.ranking.ts': 'test/moments-ranking.spec.ts',
      'src/moments/moments.prisma.repository.ts': 'test/moments-lifecycle.e2e-spec.ts',
      'src/moments/moments.observability.ts': 'test/moments-observability.spec.ts',
      'src/moment-media/exif-strip.ts': 'test/moment-media.spec.ts',
      'src/moment-media/media.queues.ts': 'test/moment-media.spec.ts',
    };
    for (const [src, spec] of Object.entries(clusters)) {
      expect(existsSync(join(BACKEND, src))).toBe(true);
      expect(existsSync(join(BACKEND, spec))).toBe(true);
    }
    for (const t of ['moments-controller.test.ts', 'moments-ui.test.tsx', 'moments-privacy-mutation.test.ts']) {
      expect(clientTestExists(t)).toBe(true);
    }
  });
});
