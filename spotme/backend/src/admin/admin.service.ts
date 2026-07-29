import { Injectable, ConflictException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '../common/enums/role.enum';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  // ── Growth / demographics — aggregate only, never per-user location ──
  async installsOverTime(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.installEvent.findMany({
      where: { ts: { gte: since } },
      select: { ts: true, kind: true },
    });
    const byDay = new Map<string, { installs: number; uninstalls: number }>();
    for (const row of rows) {
      const day = row.ts.toISOString().slice(0, 10);
      const bucket = byDay.get(day) ?? { installs: 0, uninstalls: 0 };
      if (row.kind === 'uninstall') bucket.uninstalls++;
      else bucket.installs++;
      byDay.set(day, bucket);
    }
    return Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, counts]) => ({ date, ...counts }));
  }

  async dauMau() {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
    const [dau, mau, totalUsers] = await Promise.all([
      this.prisma.device.count({ where: { lastSeenAt: { gte: dayAgo } } }),
      this.prisma.device.count({ where: { lastSeenAt: { gte: monthAgo } } }),
      this.prisma.user.count({ where: { deletedAt: null } }),
    ]);
    return { dau, mau, totalUsers };
  }

  /** Bucketed bar-chart data — never a per-user record, per the retention design. */
  async demographics() {
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null },
      select: { city: true, age: true, sex: true },
    });
    const byCity = new Map<string, number>();
    const byAgeBand = new Map<string, number>();
    const bySex = new Map<string, number>();
    for (const u of users) {
      const city = u.city || 'Unknown';
      byCity.set(city, (byCity.get(city) ?? 0) + 1);
      const band = ageBand(u.age);
      byAgeBand.set(band, (byAgeBand.get(band) ?? 0) + 1);
      bySex.set(u.sex, (bySex.get(u.sex) ?? 0) + 1);
    }
    return {
      byCity: [...byCity.entries()].map(([city, count]) => ({ city, count })),
      byAgeBand: [...byAgeBand.entries()].map(([band, count]) => ({ band, count })),
      bySex: [...bySex.entries()].map(([sex, count]) => ({ sex, count })),
    };
  }

  // ── Server health ──
  async recordHealthSample(uptimeOk: boolean, errorCount: number, p95LatencyMs?: number, note?: string) {
    return this.prisma.healthSample.create({ data: { uptimeOk, errorCount, p95LatencyMs, note } });
  }

  async healthSummary(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const samples = await this.prisma.healthSample.findMany({
      where: { ts: { gte: since } },
      orderBy: { ts: 'asc' },
    });
    const okCount = samples.filter((s) => s.uptimeOk).length;
    const uptimePct = samples.length ? (okCount / samples.length) * 100 : 100;
    return { uptimePct, samples };
  }

  async recordCrash(platform: string, message: string, signature: string, appVersion?: string, stackTrace?: string, userId?: string) {
    return this.prisma.crashReport.create({
      data: { platform, message, signature, appVersion, stackTrace, userId },
    });
  }

  async crashesGrouped(take = 50) {
    const grouped = await this.prisma.crashReport.groupBy({
      by: ['signature'],
      _count: { signature: true },
      orderBy: { _count: { signature: 'desc' } },
      take,
    });
    return grouped.map((g) => ({ signature: g.signature, count: g._count.signature }));
  }

  async recordInstallEvent(userId: string | undefined, kind: string, platform: string, city?: string) {
    return this.prisma.installEvent.create({ data: { userId, kind, platform, city } });
  }

  // ── Employee / RBAC management (Admin role only, enforced at the controller) ──
  async listEmployees() {
    return this.prisma.employee.findMany({
      select: { id: true, email: true, name: true, role: true, active: true, lastLoginAt: true, createdAt: true },
    });
  }

  async createEmployee(email: string, name: string, password: string, role: Role) {
    const existing = await this.prisma.employee.findUnique({ where: { email } });
    if (existing) throw new ConflictException('employee already exists');
    const passwordHash = await argon2.hash(password);
    return this.prisma.employee.create({ data: { email, name, passwordHash, role } });
  }

  async setEmployeeActive(id: string, active: boolean) {
    return this.prisma.employee.update({ where: { id }, data: { active } });
  }
}

function ageBand(age: number | null): string {
  if (age == null) return 'Unknown';
  if (age < 18) return '<18';
  if (age <= 24) return '18-24';
  if (age <= 34) return '25-34';
  if (age <= 44) return '35-44';
  return '45+';
}
