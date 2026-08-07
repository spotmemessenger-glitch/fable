import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RoomsAuthService } from '../rooms/rooms-auth.service';
import { RoomsService } from '../rooms/rooms.service';
import { LocalStorageAdapter } from './local-storage.adapter';
import {
  IStorageAdapter,
  PRESIGN_TTL_SECONDS,
  STORAGE_ADAPTER,
  buildObjectKey,
  parseObjectKey,
  safeServeType,
} from './storage.interface';

/**
 * Presigned media URLs. Phase 4 §3.
 *
 * The backend never carries the bytes — it decides WHO may be handed a URL and
 * hands one over. Ciphertext goes client -> bucket and bucket -> client.
 *
 * ---------------------------------------------------------------------------
 * THE ROOM ID COMES FROM THE KEY, NOT FROM THE CALLER
 *
 * The dangerous shape here is `{objectKey, roomId}` in one request: the server
 * checks membership of `roomId` and then serves `objectKey`, and nothing forces
 * those to be the same room. Anyone in any room could then read any attachment
 * whose key they could guess or observe. So the download route PARSES the key
 * and checks membership of the room named inside it. There is exactly one
 * roomId in play and it is the one attached to the bytes.
 *
 * Upload is the mirror image: the caller names a room, we check membership, and
 * WE build the key. A client never chooses its own object key, so it cannot
 * write into someone else's room by asking nicely.
 */
@UseGuards(JwtAuthGuard)
@Controller('v2/media')
export class MediaController {
  constructor(
    @Inject(STORAGE_ADAPTER) private storage: IStorageAdapter,
    private prisma: PrismaService,
    private auth: RoomsAuthService,
    private rooms: RoomsService,
  ) {}

  /** Membership is the RoomMember row `join` writes — HTTP has no handshake. */
  private async assertMember(roomId: string, userId: string): Promise<void> {
    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!member) throw new ForbiddenException('not a member of this room');
  }

  /**
   * A URL to PUT one encrypted slice to.
   *
   * `bin` is passed to the group policy deliberately: sending media is a
   * permission (`canMedia`), and a member who is muted or barred from posting
   * media must not be able to obtain an upload URL just because this is a
   * different door from the socket.
   */
  @Post('presign')
  @HttpCode(200)
  async presign(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() body: { roomId?: string; attachId?: string; seq?: number; contentType?: string },
  ) {
    const roomId = String(body?.roomId ?? '');
    const attachId = String(body?.attachId ?? '');
    const seq = Number(body?.seq ?? 0);
    if (!roomId || !attachId) throw new BadRequestException('roomId and attachId are required');

    await this.assertMember(roomId, principal.id);
    const refusal = await this.auth.authorizeAction(roomId, principal.id, 'bin', undefined);
    if (refusal) throw new ForbiddenException(refusal);

    let objectKey: string;
    try {
      objectKey = buildObjectKey(roomId, attachId, seq);
    } catch (err) {
      // buildObjectKey throws on anything that could become a path or a
      // wildcard. The caller supplied it, so this is a 400, not a 500.
      throw new BadRequestException((err as Error).message);
    }

    // Content type is not trusted for anything except being pinned into the
    // signature — the bytes are ciphertext regardless of what it claims.
    const contentType = typeof body?.contentType === 'string' && body.contentType.length < 128
      ? body.contentType
      : 'application/octet-stream';

    return {
      objectKey,
      uploadUrl: await this.storage.getUploadUrl(objectKey, contentType),
      expiresIn: PRESIGN_TTL_SECONDS,
      provider: this.storage.name,
    };
  }

  /**
   * A URL to GET one encrypted slice from.
   *
   * The key is a path parameter and therefore attacker-controlled; everything
   * downstream of `parseObjectKey` is validated, and an unparseable key is
   * refused as forbidden rather than described.
   */
  /*
   * The key is ONE percent-encoded path segment, not a wildcard.
   *
   * `download-url/*objectKey` is Express 5 syntax and this app runs Express
   * 4.22 — it registered, logged as mapped, and then matched nothing, so every
   * request 404'd while the route list looked correct. A named parameter works
   * on both, and Express decodes %2F for us, so the client sends
   * `encodeURIComponent(objectKey)` and this receives `rooms/<room>/<att>/<seq>`.
   */
  @Get('download-url/:objectKey')
  @HttpCode(200)
  async downloadUrl(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('objectKey') raw: string,
  ) {
    const objectKey = String(raw ?? '');
    const parts = parseObjectKey(objectKey);
    if (!parts) throw new ForbiddenException('unknown object');

    await this.assertMember(parts.roomId, principal.id);
    const refusal = await this.auth.authorizeJoin(parts.roomId, principal.id);
    if (refusal) throw new ForbiddenException(refusal);

    /* VIEW-ONCE IS ENFORCED HERE TOO, and it has to be.
     *
     * `RoomsService.fetchSlice` calls itself "the only place it can be" —
     * true while the server held the bytes. A presigned URL bypasses it
     * completely, so without this the first migration of media to object
     * storage would have quietly removed view-once enforcement: the burst
     * animation would still play and the photo would still be downloadable.
     * Same claim logic, same table, same atomic first-viewer-wins insert. */
    const verdict = await this.rooms.authorizeAttachmentRead(
      parts.roomId, parts.attachId, principal.id,
    );
    if (verdict === 'gone') {
      // Said out loud rather than disguised as "missing": the caller is a
      // legitimate room member, and a client that cannot tell the two apart
      // retries forever.
      throw new NotFoundException('that private photo has been opened and destroyed');
    }
    if (verdict === 'denied') {
      throw new ForbiddenException('that private photo was not sent to you');
    }

    return {
      objectKey,
      downloadUrl: await this.storage.getDownloadUrl(objectKey),
      expiresIn: PRESIGN_TTL_SECONDS,
      provider: this.storage.name,
    };
  }
}

/**
 * The local storage backend's data plane — the stand-in for a bucket.
 *
 * NO JwtAuthGuard, on purpose and not by omission. These URLs are the local
 * equivalent of a presigned S3 URL: the HMAC in the query string IS the
 * credential, exactly as the signature in an S3 URL is, and S3 does not ask for
 * your app session either. `verify()` covers the object key, the expiry and the
 * HTTP method, so a download URL cannot be replayed as an upload.
 *
 * Only reachable when the local adapter is the active provider; with S3 selected
 * these answer 404 rather than quietly offering a second way in.
 */
@Controller('v2/media/local')
export class LocalMediaController {
  constructor(
    @Inject(STORAGE_ADAPTER) private storage: IStorageAdapter,
    private local: LocalStorageAdapter,
  ) {}

  private assertLocalActive(): void {
    if (this.storage.name !== 'local') throw new NotFoundException();
  }

  /* PUT, matching what S3/R2 presign. The local adapter is a stand-in for a
   * bucket, so it has to speak the same verb — when it answered @Post() the
   * client sent POST, passed every local test, and would have been rejected by
   * the first real presigned URL it ever touched. */
  @Put()
  @HttpCode(200)
  async upload(
    @Query('key') key: string,
    @Query('expires') expires: string,
    @Query('sig') sig: string,
    @Req() req: Request,
  ) {
    this.assertLocalActive();
    if (!this.local.verify(String(key), Number(expires), 'PUT', String(sig))) {
      throw new ForbiddenException('invalid or expired upload url');
    }
    const body = req.body as unknown;
    const bytes = Buffer.isBuffer(body)
      ? body
      : typeof body === 'string'
        ? Buffer.from(body, 'base64')
        : null;
    if (!bytes?.length) throw new BadRequestException('empty body');
    const ok = await this.local.write(String(key), bytes);
    if (!ok) throw new BadRequestException('invalid object key');
    return { stored: bytes.length };
  }

  @Get()
  async download(
    @Query('key') key: string,
    @Query('expires') expires: string,
    @Query('sig') sig: string,
    @Query('ct') ct: string,
    @Res() res: Response,
  ) {
    this.assertLocalActive();
    // `ct` is part of the signed material, so a tampered type fails here
    // rather than reaching the allow-list at all.
    const asked = ct ? String(ct) : '';
    if (!this.local.verify(String(key), Number(expires), 'GET', String(sig), asked)) {
      throw new ForbiddenException('invalid or expired download url');
    }
    const bytes = await this.local.read(String(key));
    if (!bytes) throw new NotFoundException();
    /* Chat attachments are ciphertext and stay opaque — no `ct`, so this
     * resolves to octet-stream exactly as before.
     *
     * Moments objects are plaintext media that a browser has to DECODE, and
     * `octet-stream` + `nosniff` is the one combination that guarantees it
     * cannot: every moment video failed MEDIA_ERR_SRC_NOT_SUPPORTED and every
     * photo came out blank. They carry a signed `ct`, clamped again here to
     * the renderable allow-list, so real media renders while `text/html` and
     * `image/svg+xml` remain unservable however the value got here.
     *
     * `nosniff` STAYS in both cases: the header is now accurate, so there is
     * never a reason for a browser to guess past it. */
    res.setHeader('Content-Type', safeServeType(asked));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(bytes);
  }
}
