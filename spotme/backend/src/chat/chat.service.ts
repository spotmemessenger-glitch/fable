import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ChatService {
  constructor(private prisma: PrismaService) {}

  private async assertParticipant(conversationId: string, userId: string) {
    const membership = await this.prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!membership) throw new ForbiddenException('not a participant in this conversation');
    return membership;
  }

  async listConversations(userId: string) {
    return this.prisma.conversationParticipant.findMany({
      where: { userId },
      include: { conversation: { include: { participants: { include: { user: true } } } } },
      orderBy: { conversation: { createdAt: 'desc' } },
    });
  }

  /** Single conversation with participants' public keys — the mobile client
   * needs the other side's key before it can encrypt/decrypt anything. */
  async getConversation(conversationId: string, userId: string) {
    await this.assertParticipant(conversationId, userId);
    return this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      include: {
        participants: {
          include: { user: { select: { id: true, username: true, name: true, publicKey: true } } },
        },
      },
    });
  }

  async history(conversationId: string, userId: string, take = 100) {
    await this.assertParticipant(conversationId, userId);
    return this.prisma.message.findMany({
      where: { conversationId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { sentAt: 'desc' },
      take,
    });
  }

  /**
   * Server never sees plaintext — `cipherText` is opaque base64 produced by the
   * sender's client. TTL mirrors the current app's disappearing-message feature.
   */
  async sendMessage(
    conversationId: string,
    senderId: string,
    cipherText: string,
    kind: string,
    nonce?: string,
    mediaKey?: string,
    ttlSeconds?: number,
  ) {
    await this.assertParticipant(conversationId, senderId);
    const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null;
    return this.prisma.message.create({
      data: { conversationId, senderId, cipherText, nonce, kind, mediaKey, ttlSeconds, expiresAt },
    });
  }

  async markRead(conversationId: string, userId: string) {
    await this.assertParticipant(conversationId, userId);
    return this.prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: new Date() },
    });
  }
}
