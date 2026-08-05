import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { LiveKitService } from './livekit.service';

/**
 * Call media endpoints. ADR-003.
 *
 * THE WHOLE CLASS IS BEHIND `JwtAuthGuard`. A LiveKit token is a bearer
 * credential for someone else's media room; an unauthenticated caller must not
 * be able to obtain one, and the guard is what makes that structural rather
 * than something each handler remembers.
 *
 * Nothing here touches identity keys, device keys, E2EE sessions, the messaging
 * socket or Centrifugo. It reads ONE table — RoomMember — to answer "may this
 * user join the media room for this conversation", which is the same question
 * `realtime.controller.ts` asks before publishing, and the same row the
 * Socket.IO join handshake writes.
 */
@UseGuards(JwtAuthGuard)
@Controller('v2/calls')
export class CallsController {
  constructor(
    private prisma: PrismaService,
    private livekit: LiveKitService,
  ) {}

  /**
   * Is LiveKit available on this deployment?
   *
   * The client asks before offering a LiveKit call so it can fall back to the
   * existing Trystero/WebRTC path SILENTLY AND IN ADVANCE, rather than by
   * failing a call the user has already started. Deliberately returns no
   * credentials — only whether the feature exists here.
   */
  @Get('config')
  config() {
    return { available: this.livekit.isConfigured(), url: this.livekit.url() };
  }

  /**
   * Mint a join token for the calling user, in the media room belonging to one
   * conversation.
   *
   * Three things make this safe, and all three are load-bearing:
   *
   *  1. IDENTITY IS THE PRINCIPAL. `sub` comes from the verified JWT, never
   *     from the body. Taking it from the body would let any signed-in user
   *     join a call as anyone else — the same mistake the key-upload endpoint
   *     avoids by keying off the principal.
   *  2. THE ROOM NAME IS DERIVED, NOT ACCEPTED. The body names a Spot Me
   *     `roomId`; `LiveKitService.roomName()` turns it into the media room.
   *     A caller cannot name a LiveKit room directly, so membership is always
   *     checked against the same identifier the token is issued for.
   *  3. MEMBERSHIP IS CHECKED FIRST. No RoomMember row, no token.
   *
   * The token is short-lived and scoped to that one room: it grants join,
   * publish and subscribe there and nothing anywhere else.
   */
  @Post('token')
  @HttpCode(200)
  async token(@CurrentUser() principal: AuthenticatedPrincipal, @Body() body: { roomId?: string }) {
    if (!this.livekit.isConfigured()) {
      // Absent config is "calls do not run on LiveKit here", not a 500. The
      // client keeps using Trystero and says nothing to the user.
      throw new ServiceUnavailableException('livekit is not configured on this deployment');
    }

    const roomId = String(body?.roomId ?? '');
    if (!roomId || roomId.length > 128) throw new BadRequestException('roomId required');

    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId: principal.id } },
    });
    if (!member) throw new ForbiddenException('not a member of this room');

    const roomName = LiveKitService.roomName(roomId);
    return { ...this.livekit.mintToken({ identity: principal.id, roomName }), roomName };
  }

  /**
   * End the call for everyone in a conversation's media room.
   *
   * NOT needed for a 1:1 hang-up — both sides disconnect themselves and LiveKit
   * reaps the empty room. It exists for the cases a client cannot serve: a
   * participant whose phone died still shows as present until the SFU times it
   * out, and group calls will need "end for all".
   *
   * Membership is checked the same way as minting. A non-member ending someone
   * else's call would be a denial-of-service with a one-line request.
   */
  @Post('end')
  @HttpCode(200)
  async end(@CurrentUser() principal: AuthenticatedPrincipal, @Body() body: { roomId?: string }) {
    const roomId = String(body?.roomId ?? '');
    if (!roomId || roomId.length > 128) throw new BadRequestException('roomId required');

    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId: principal.id } },
    });
    if (!member) throw new ForbiddenException('not a member of this room');

    return { ended: await this.livekit.endRoom(LiveKitService.roomName(roomId)) };
  }
}
