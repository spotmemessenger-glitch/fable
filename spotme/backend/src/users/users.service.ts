import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Sex } from '@prisma/client';
import { SELF_USER } from '../common/prisma/public-user';
import { AGE_POLICY_VERSION, AGE_REFUSAL_MESSAGE, isAdultYearMonth } from '../policy/age';

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

  /**
   * Wave 1B (D6), B2: record the one-time age declaration for an account that
   * predates the gate. FIRST DECLARATION STICKS: once `birthYearMonth` is set —
   * verified or refused — the API can never rewrite it (409); corrections are
   * the documented support path only. An under-18 declaration is RECORDED
   * before the refusal so it cannot be retried with a different year, and the
   * account keeps its existing chat (B2) while every new surface stays behind
   * the B3 gate.
   */
  async declareAge(id: string, birthYearMonth: string) {
    const row = await this.prisma.user.findUniqueOrThrow({
      where: { id },
      select: { birthYearMonth: true, ageVerified: true },
    });
    if (row.birthYearMonth) {
      throw new ConflictException('age declaration already recorded — contact support to correct it');
    }
    const adult = isAdultYearMonth(birthYearMonth);
    await this.prisma.user.update({
      where: { id },
      data: {
        birthYearMonth,
        agePolicyVersion: AGE_POLICY_VERSION,
        ...(adult ? { ageVerified: true, ageVerifiedAt: new Date() } : {}),
      },
    });
    if (!adult) {
      throw new ForbiddenException({ error: 'age_requirement', message: AGE_REFUSAL_MESSAGE });
    }
    return { ageVerified: true };
  }

  updateProfile(id: string, input: UpdateProfileInput) {
    // All demographic fields are optional and self-reported — never derived
    // from tracked location. See the compliance memo, retention table §08.
    //
    // Wave 1B, B5: SELF_USER select, same as GET /users/me. The raw row would
    // ship `birthYearMonth` and both credential hashes — the exact fields the
    // GET path carefully excludes; a PATCH must not be the leak.
    return this.prisma.user.update({ where: { id }, data: input, select: SELF_USER });
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
    // B5: acknowledgement only — never the row.
    await this.prisma.user.update({ where: { id: userId }, data: { uninstalledAt: new Date() } });
    return { ok: true };
  }

  async softDeleteAccount(userId: string) {
    // B5: a minimal safe shape (admin audit reads these three) — never the row.
    return this.prisma.user.update({
      where: { id: userId },
      data: { deletedAt: new Date(), email: null, phone: null },
      select: { id: true, username: true, deletedAt: true },
    });
  }
}
