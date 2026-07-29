import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  log(employeeId: string, action: string, targetType?: string, targetId?: string, metadata?: object) {
    return this.prisma.auditLog.create({
      data: { employeeId, action, targetType, targetId, metadata: metadata as any },
    });
  }

  recent(take = 200) {
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take,
      include: { employee: { select: { name: true, email: true, role: true } } },
    });
  }
}
