import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const STORY_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class StoriesService {
  constructor(private prisma: PrismaService) {}

  async create(authorId: string, kind: 'text', textContent: string) {
    return this.prisma.story.create({
      data: { authorId, kind, textContent, expiresAt: new Date(Date.now() + STORY_TTL_MS) },
    });
  }

  /**
   * Shown to "contacts" only — anyone who shares a conversation with the
   * viewer, same audience a DM/group already implies, not a public feed.
   * No location is ever attached to a story (matches the no-location-history
   * constraint on the rest of this backend).
   */
  async feed(userId: string) {
    const conversations = await this.prisma.conversationParticipant.findMany({
      where: { userId },
      select: { conversationId: true },
    });
    const contactIds = await this.prisma.conversationParticipant.findMany({
      where: { conversationId: { in: conversations.map((c) => c.conversationId) }, userId: { not: userId } },
      select: { userId: true },
      distinct: ['userId'],
    });
    const authorIds = Array.from(new Set([userId, ...contactIds.map((c) => c.userId)]));

    return this.prisma.story.findMany({
      where: { authorId: { in: authorIds }, expiresAt: { gt: new Date() } },
      include: { author: { select: { id: true, username: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async recordView(storyId: string, viewerId: string) {
    const story = await this.prisma.story.findUnique({ where: { id: storyId } });
    if (!story || story.expiresAt < new Date()) throw new NotFoundException('story not found or expired');
    return this.prisma.storyView.upsert({
      where: { storyId_viewerId: { storyId, viewerId } },
      create: { storyId, viewerId },
      update: {},
    });
  }

  async listViews(storyId: string, requesterId: string) {
    const story = await this.prisma.story.findUnique({ where: { id: storyId } });
    if (!story) throw new NotFoundException('story not found');
    if (story.authorId !== requesterId) throw new ForbiddenException('only the author can see who viewed this story');
    return this.prisma.storyView.findMany({
      where: { storyId },
      include: { viewer: { select: { id: true, username: true, name: true } } },
      orderBy: { viewedAt: 'desc' },
    });
  }

  async remove(storyId: string, requesterId: string) {
    const story = await this.prisma.story.findUnique({ where: { id: storyId } });
    if (!story) throw new NotFoundException('story not found');
    if (story.authorId !== requesterId) throw new ForbiddenException('only the author can delete this story');
    await this.prisma.story.delete({ where: { id: storyId } });
    return { deleted: true };
  }
}
