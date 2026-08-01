import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RequestSource, RequestStatus } from '@prisma/client';
import { PUBLIC_USER } from '../common/prisma/public-user';

const REQUEST_TTL_DAYS = 7;

@Injectable()
export class ChatRequestsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Only NEARBY-sourced requests are gated behind accept/reject — username
   * search, invite links, and existing contacts open a conversation immediately,
   * matching the current spotme/web behavior. See the blueprint's §05 diagram.
   */
  async initiate(fromUserId: string, toUserId: string, source: RequestSource, greeting?: string) {
    if (fromUserId === toUserId) throw new BadRequestException('cannot message yourself');

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
