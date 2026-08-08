import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RequestSource, RequestStatus } from '@prisma/client';
import { PUBLIC_USER } from '../common/prisma/public-user';
import { ACCOUNT_FROZEN_MINOR, FREEZE_NOTICE } from '../policy/age';

const REQUEST_TTL_DAYS = 7;

@Injectable()
export class ChatRequestsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Only NEARBY-sourced requests are gated behind accept/reject — username
   * search, invite links, and existing contacts open a conversation immediately,
   * matching the current spotme/apps/web behavior. See the blueprint's §05 diagram.
   */
  async initiate(fromUserId: string, toUserId: string, source: RequestSource, greeting?: string) {
    if (fromUserId === toUserId) throw new BadRequestException('cannot message yourself');

    /* Wave 1C (D6 addendum): a FROZEN account can neither start a new
     * conversation nor be the target of one. The frozen sender learns why
     * (they already hold the notice); an INITIATOR TOWARD a frozen target gets
     * the byte-identical refusal a block produces — freezing must not be
     * enumerable by strangers. */
    const [fromRow, toRow] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: fromUserId }, select: { accountStatus: true } }),
      this.prisma.user.findUnique({ where: { id: toUserId }, select: { accountStatus: true } }),
    ]);
    if (fromRow?.accountStatus === ACCOUNT_FROZEN_MINOR) {
      throw new ForbiddenException({ error: 'account_frozen', message: FREEZE_NOTICE });
    }
    if (toRow?.accountStatus === ACCOUNT_FROZEN_MINOR) {
      throw new ForbiddenException('blocked'); // same shape as the block refusal below
    }

    const blocked = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: toUserId, blockedId: fromUserId },
          { blockerId: fromUserId, blockedId: toUserId },
        ],
      },
    });
    if (blocked) throw new ForbiddenException('blocked');

    const existing = await this.prisma.chatRequest.findFirst({
      where: {
        status: RequestStatus.ACCEPTED,
        OR: [
          { fromUserId, toUserId },
          { fromUserId: toUserId, toUserId: fromUserId },
        ],
      },
    });
    if (existing?.conversationId) return { conversationId: existing.conversationId, status: 'existing' };

    if (source !== RequestSource.NEARBY) {
      const conversation = await this.createConversation(fromUserId, toUserId);
      const request = await this.prisma.chatRequest.create({
        data: {
          fromUserId,
          toUserId,
          source,
          status: RequestStatus.ACCEPTED,
          greeting,
          conversationId: conversation.id,
          respondedAt: new Date(),
          expiresAt: new Date(Date.now() + REQUEST_TTL_DAYS * 86_400_000),
        },
      });
      return { conversationId: conversation.id, status: 'opened', requestId: request.id };
    }

    // Nearby: create a pending request only. No conversation exists yet.
    const request = await this.prisma.chatRequest.create({
      data: {
        fromUserId,
        toUserId,
        source,
        status: RequestStatus.PENDING,
        greeting,
        expiresAt: new Date(Date.now() + REQUEST_TTL_DAYS * 86_400_000),
      },
    });
    return { status: 'pending', requestId: request.id };
  }

  async respond(requestId: string, byUserId: string, accept: boolean) {
    /* Wave 1C (D6 addendum): accepting creates a NEW conversation; a frozen
     * account cannot. (Rejecting is also refused — the frozen surface is
     * read-only; pending requests simply expire.) */
    const me = await this.prisma.user.findUnique({ where: { id: byUserId }, select: { accountStatus: true } });
    if (me?.accountStatus === ACCOUNT_FROZEN_MINOR) {
      throw new ForbiddenException({ error: 'account_frozen', message: FREEZE_NOTICE });
    }
    const request = await this.prisma.chatRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (request.toUserId !== byUserId) throw new ForbiddenException('not the recipient of this request');
    if (request.status !== RequestStatus.PENDING) return request;

    if (!accept) {
      return this.prisma.chatRequest.update({
        where: { id: requestId },
        data: { status: RequestStatus.REJECTED, respondedAt: new Date() },
      });
    }

    const conversation = await this.createConversation(request.fromUserId, request.toUserId);
    return this.prisma.chatRequest.update({
      where: { id: requestId },
      data: { status: RequestStatus.ACCEPTED, respondedAt: new Date(), conversationId: conversation.id },
    });
  }

  pendingForUser(userId: string) {
    return this.prisma.chatRequest.findMany({
      where: { toUserId: userId, status: RequestStatus.PENDING, expiresAt: { gt: new Date() } },
      include: { fromUser: { select: PUBLIC_USER } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Run on a schedule (cron/Railway scheduled job) — expires stale nearby requests. */
  async expireStale() {
    return this.prisma.chatRequest.updateMany({
      where: { status: RequestStatus.PENDING, expiresAt: { lte: new Date() } },
      data: { status: RequestStatus.EXPIRED },
    });
  }

  private async createConversation(userA: string, userB: string) {
    return this.prisma.conversation.create({
      data: {
        kind: 'dm',
        participants: { create: [{ userId: userA }, { userId: userB }] },
      },
    });
  }
}
