import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class GroupsService {
  constructor(private prisma: PrismaService) {}

  /**
   * A Group is a metadata row on top of a kind:"group" Conversation.
   * Membership is just ConversationParticipant rows on that conversation —
   * the existing /chat REST endpoints and Socket.IO gateway (which already
   * fan a message out to every participant, not just two) work unchanged.
   */
  async create(ownerId: string, name: string, memberIds: string[]) {
    const uniqueMemberIds = Array.from(new Set([ownerId, ...memberIds]));
    const conversation = await this.prisma.conversation.create({
      data: {
        kind: 'group',
        title: name,
        participants: { create: uniqueMemberIds.map((userId) => ({ userId })) },
      },
    });
    return this.prisma.group.create({
      data: { name, ownerId, conversationId: conversation.id },
      include: { conversation: { include: { participants: { include: { user: true } } } } },
    });
  }

  listMine(userId: string) {
    return this.prisma.group.findMany({
      where: { conversation: { participants: { some: { userId } } } },
      include: { conversation: { include: { participants: { include: { user: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOne(groupId: string, userId: string) {
    const group = await this.findWithMembership(groupId, userId);
    return group;
  }

  async addMember(groupId: string, byUserId: string, newUserId: string) {
    const group = await this.findWithMembership(groupId, byUserId);
    if (group.ownerId !== byUserId) throw new ForbiddenException('only the group owner can add members');
    await this.prisma.conversationParticipant.upsert({
      where: { conversationId_userId: { conversationId: group.conversationId, userId: newUserId } },
      create: { conversationId: group.conversationId, userId: newUserId },
      update: {},
    });
    return this.getOne(groupId, byUserId);
  }

  async removeMember(groupId: string, byUserId: string, targetUserId: string) {
    const group = await this.findWithMembership(groupId, byUserId);
    if (group.ownerId !== byUserId && byUserId !== targetUserId) {
      throw new ForbiddenException('only the group owner can remove other members');
    }
    if (group.ownerId === targetUserId) throw new ForbiddenException('the owner cannot be removed, only leave by deleting the group');
    await this.prisma.conversationParticipant.deleteMany({
      where: { conversationId: group.conversationId, userId: targetUserId },
    });
    return this.getOne(groupId, byUserId);
  }

  /** Throws if the group doesn't exist or the caller isn't a member — same
   * "no peeking into groups you're not in" rule the DM conversations use. */
  private async findWithMembership(groupId: string, userId: string) {
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      include: { conversation: { include: { participants: { include: { user: true } } } } },
    });
    if (!group) throw new NotFoundException('group not found');
    const isMember = group.conversation.participants.some((p) => p.userId === userId);
    if (!isMember) throw new ForbiddenException('not a member of this group');
    return group;
  }
}
