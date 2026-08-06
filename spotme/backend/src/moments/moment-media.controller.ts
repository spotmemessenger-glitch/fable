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
  @Get(':mediaId/url')
  async url(@CurrentUser() _u: Principal, @Param('mediaId') mediaId: string) {
    const asset = await this.prisma.momentMediaAsset.findUnique({ where: { id: mediaId } });
    if (!asset || asset.refCount < 1) throw new NotFoundException();
    const url = await this.media.downloadUrl(asset.storageKey);
    if (!url) throw new NotFoundException();
    return { url, kind: asset.kind, mimeType: asset.mimeType };
  }
}
