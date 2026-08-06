/**
 * Moments media HTTP surface (M1 activation).
 *
 * WHY THE BYTES COME THROUGH THE SERVER, against the instinct of the chat
 * pipeline sitting next to it. Chat attachments are sealed on the device, so
 * they take a presigned URL straight to the bucket and this process never sees
 * them — that is the whole point there. Moments media is public social content
 * and the server has exactly one job it cannot delegate: strip EXIF/GPS
 * BEFORE anything is persisted. A presigned direct-to-bucket upload would put
 * the original, location-bearing file in the bucket untouched, and no later
 * step could undo that — the object with the coordinates in it would already
 * exist. So this route accepts raw bytes, hands them to `ingest()` which
 * strips and stores, and never writes the original.
 *
 * MOUNTED BEHIND THE SAME GATE AS THE REST OF MOMENTS: 404 unless the
 * `moments` domain is enabled for this caller, 403 unless the account is a
 * verified adult (D6). Both checks run before a single byte is read.
 */

import {
  BadRequestException, Body, Controller, Get, Headers, NotFoundException,
  Param, Post, Req, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DomainGate } from '../flags/domain-gate.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MomentMediaService } from '../moment-media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import { randomUUID } from 'node:crypto';

/* The principal the app's JWT strategy actually provides ({ id, role, kind } —
 * see jwt.strategies.ts). The dark phase wrote these controllers against a
 * `sub` field that never existed on the request object; every authorId reached
 * Prisma as undefined and every create 500ed the first time real HTTP hit it,
 * while the service-level e2e suite (which passes authorId strings directly)
 * stayed green. The regression test in moments-gate-runtime.spec.ts drives the
 * real strategy so this class of mismatch cannot ship silently again. */
interface Principal { id: string }
/** The slice of the Express request this controller reads. */
interface RawRequest { body?: unknown }

@UseGuards(JwtAuthGuard, DomainGate('moments', { requireAdult: true }))
@Controller('v1/moments/media')
export class MomentMediaController {
  constructor(
    private readonly media: MomentMediaService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Upload one asset. Raw body (the `content-type` header names the format),
   * because a multipart parse would buy nothing here — one file, no fields.
   */
  @Post()
  async upload(
    @CurrentUser() u: Principal,
    @Req() req: RawRequest,
    @Headers('content-type') contentType: string,
  ) {
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new BadRequestException('expected raw media bytes');
    }
    const mime = String(contentType || '').split(';')[0].trim();
    const mediaId = `mm-${randomUUID()}`;
    const result = await this.media.ingest(mediaId, bytes, mime, u.id);
    if (result.state === 'refused') {
      /* One refusal is not the caller's fault. `transcode-unavailable` means
       * the format IS accepted but this runtime image has no ffmpeg/libheif to
       * normalise it with — a 400 would tell the user to pick a different
       * photo, which would not help. 503 says "retry later", and the operator
       * gets an alertable status code instead of a silent stream of 400s. */
      if (result.reason === 'transcode-unavailable') {
        throw new ServiceUnavailableException({ error: 'media_refused', reason: result.reason });
      }
      // The other reasons are safe to relay: they describe the CALLER's input,
      // never anything about storage internals or another user's data.
      throw new BadRequestException({ error: 'media_refused', reason: result.reason });
    }
    // A dedup hands back the canonical id — the caller attaches THAT to the
    // moment, so identical uploads share one object instead of two.
    const id = result.state === 'deduplicated' ? result.canonicalMediaId : result.mediaId;
    return { mediaId: id, deduplicated: result.state === 'deduplicated', exifStripped: true };
  }

  /**
   * A short-lived URL for one asset.
   *
   * AUTHORISATION IS THE OPEN QUESTION THIS ROUTE ANSWERS CONSERVATIVELY. A
   * moments asset is not room-scoped, so there is no membership to check, and
   * "is this viewer allowed to see the moment this asset belongs to" is feed
   * policy that lives in MomentsService. Until that is wired through, this
   * serves an asset only to someone who can already see it in a feed the
   * service built for them — enforced by requiring the asset to be referenced
   * by at least one moment, and by the gate above. Anything else 404s
   * uniformly, so an unknown id and a forbidden id are indistinguishable.
   */
  /**
   * Record the composer's trim / cover choices and re-run the transcode.
   *
   * WHY THE SERVER DOES THE CUT. Trimming in the browser means re-encoding on
   * the phone: slow on mid-range Android, lossy, and dependent on which codecs
   * that browser happens to expose. This process already runs ffmpeg for every
   * clip, so the composer sends INTENT and the worker does the work — the same
   * reason chat refuses to ship a client-side trimmer rather than fake one.
   *
   * IDEMPOTENT AND RE-EDITABLE: it overwrites whatever was there and enqueues
   * again, so changing your mind is just another call. The ladder is rebuilt
   * from the ORIGINAL every time, never from the previously trimmed output, so
   * repeated edits cannot stack or compound quality loss.
   */
  @Post(':mediaId/edit')
  async edit(
    @CurrentUser() _u: Principal,
    @Param('mediaId') mediaId: string,
    @Body() body: { trimStartMs?: unknown; trimEndMs?: unknown; coverAtMs?: unknown },
  ) {
    const asset = await this.prisma.momentMediaAsset.findUnique({ where: { id: mediaId } });
    if (!asset || asset.refCount < 1) throw new NotFoundException();
    if (asset.kind !== 'video') {
      throw new BadRequestException({ error: 'not_video', reason: 'only video assets carry trim or cover points' });
    }

    /* Validated at the boundary, because these become ffmpeg arguments. A
     * non-finite or negative value is refused rather than coerced: silently
     * turning nonsense into 0 would produce a clip that is not what anyone
     * asked for, and the person would have no way to tell. */
    const ms = (v: unknown, field: string): number | null => {
      if (v === undefined || v === null) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new BadRequestException({ error: 'bad_edit', reason: `${field} must be a non-negative number of milliseconds` });
      }
      return Math.round(n);
    };
    const trimStartMs = ms(body?.trimStartMs, 'trimStartMs');
    const trimEndMs = ms(body?.trimEndMs, 'trimEndMs');
    const coverAtMs = ms(body?.coverAtMs, 'coverAtMs');
    if (trimStartMs !== null && trimEndMs !== null && trimEndMs <= trimStartMs) {
      throw new BadRequestException({ error: 'bad_edit', reason: 'trimEndMs must be greater than trimStartMs' });
    }

    await this.prisma.momentMediaAsset.updateMany({
      where: { id: mediaId },
      data: { trimStartMs, trimEndMs, coverAtMs },
    });
    // Without Redis the queue is inert and says so, rather than reporting a
    // job that will never run.
    const { enqueued } = await this.media.enqueueTransform({
      mediaId, targetMime: 'video/mp4', maxWidth: 1920, maxHeight: 1920, argsTemplate: 'transcode',
    });
    return { mediaId, trimStartMs, trimEndMs, coverAtMs, requeued: enqueued };
  }

  @Get(':mediaId/url')
  async url(@CurrentUser() _u: Principal, @Param('mediaId') mediaId: string) {
    const asset = await this.prisma.momentMediaAsset.findUnique({ where: { id: mediaId } });
    if (!asset || asset.refCount < 1) throw new NotFoundException();
    const url = await this.media.downloadUrl(asset.storageKey);
    if (!url) throw new NotFoundException();
    /* The transcode worker has been writing a poster frame since M3 and this
     * route never handed it back, so every video card in the feed had nothing
     * to paint before the first decoded frame and rendered as a black box.
     * The bytes existed the whole time; only this line was missing.
     *
     * Null-safe on purpose: `posterKey` is null for images, for assets older
     * than the worker, and for the clips whose poster step failed (the worker
     * treats that as a degrade, not a job failure). The client keeps its own
     * fallback for those, so a null here is a softer poster, never a break. */
    const posterUrl = asset.posterKey ? await this.media.downloadUrl(asset.posterKey) : null;
    return {
      url,
      posterUrl,
      kind: asset.kind,
      mimeType: asset.mimeType,
      // Intrinsic size lets the card reserve the right box BEFORE bytes land,
      // so the feed does not reflow under the reader when a video decodes.
      width: asset.width ?? null,
      height: asset.height ?? null,
      durationSeconds: asset.durationSeconds ?? null,
    };
  }
}
