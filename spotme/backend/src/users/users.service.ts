import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Sex } from '@prisma/client';
import { SELF_USER } from '../common/prisma/public-user';

export interface UpdateProfileInput {
  name?: string;
  avatarUrl?: string;
  publicKey?: string;
  city?: string;
  area?: string;
  age?: number;
  sex?: Sex;
}

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  findById(id: string) {
    // Even your OWN row must not hand back `passwordHash`/`claimSecretHash` —
    // the claim secret is the only credential `guestAuth` checks, so anything
    // that can read this response can work offline on becoming you.
    return this.prisma.user.findUnique({ where: { id }, select: SELF_USER });
  }

  /** Public-safe lookup for starting a chat by username — no email/phone/demographics returned. */
  async findByUsername(username: string) {
    return this.prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' }, deletedAt: null },
      select: { id: true, username: true, name: true, avatarUrl: true, publicKey: true },
    });
  }

  updateProfile(id: string, input: UpdateProfileInput) {
    // All demographic fields are optional and self-reported — never derived
    // from tracked location. See the compliance memo, retention table §08.
    return this.prisma.user.update({ where: { id }, data: input });
  }

  /** Foreground-only, ephemeral — overwritten in place, no history kept. */
  updatePresence(userId: string, lat: number | null, lon: number | null, ghost: boolean) {
    return this.prisma.presence.upsert({
      where: { userId },
      create: { userId, lat, lon, ghost },
      update: { lat, lon, ghost },
    });
  }

  async markUninstalled(userId: string) {
    await this.prisma.installEvent.create({ data: { userId, kind: 'uninstall', platform: 'unknown' } });
    return this.prisma.user.update({ where: { id: userId }, data: { uninstalledAt: new Date() } });
  }

  async softDeleteAccount(userId: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { deletedAt: new Date(), email: null, phone: null },
    });
  }
}
