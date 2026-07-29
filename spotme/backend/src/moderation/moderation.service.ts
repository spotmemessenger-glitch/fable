import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReportReason, ReportStatus } from '@prisma/client';
import { NcmecService } from './ncmec.service';
import { AuditService } from '../audit/audit.service';

const PRESERVE_DAYS_DEFAULT = 90;
const PRESERVE_DAYS_LE_REQUEST = 180;

@Injectable()
export class ModerationService {
  constructor(
    private prisma: PrismaService,
    private ncmec: NcmecService,
    private audit: AuditService,
  ) {}

  /**
   * The reporter's own client attaches the plaintext of what they're reporting —
   * this is the ONLY path content ever reaches a human in readable form. The
   * server never decrypts anything on its own. See blueprint §08.
   */
  async fileReport(
    reporterId: string,
    reportedUserId: string,
    reason: ReportReason,
    reportedContent: string,
    contextNote?: string,
  ) {
    return this.prisma.report.create({
      data: {
        reporterId,
        reportedUserId,
        reason,
        reportedContent,
        contextNote,
        retainUntil: new Date(Date.now() + PRESERVE_DAYS_DEFAULT * 86_400_000),
      },
    });
  }

  queue(status: ReportStatus = ReportStatus.OPEN) {
    return this.prisma.report.findMany({
      where: { status },
      include: { reporter: { select: { username: true } }, reportedUser: { select: { username: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async action(reportId: string, employeeId: string, resolution: 'ACTIONED' | 'DISMISSED') {
    await this.audit.log(employeeId, 'report.action', 'Report', reportId, { resolution });
    return this.prisma.report.update({
      where: { id: reportId },
      data: { status: resolution, resolvedAt: new Date(), resolvedByEmployeeId: employeeId },
    });
  }

  /** Confirmed CSAM: files the CyberTipline report and extends the preservation hold. */
  async escalateCsam(reportId: string, employeeId: string) {
    const report = await this.prisma.report.findUniqueOrThrow({ where: { id: reportId } });
    await this.audit.log(employeeId, 'report.escalate_csam', 'Report', reportId);
    const ncmecReportId = await this.ncmec.fileReport(reportId, report.reportedUserId, report.reportedContent);
    return this.prisma.report.update({
      where: { id: reportId },
      data: {
        status: 'ESCALATED_NCMEC',
        ncmecReportedAt: new Date(),
        ncmecReportId,
        retainUntil: new Date(Date.now() + PRESERVE_DAYS_LE_REQUEST * 86_400_000),
        resolvedByEmployeeId: employeeId,
      },
    });
  }

  async block(blockerId: string, blockedId: string) {
    return this.prisma.block.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      create: { blockerId, blockedId },
      update: {},
    });
  }

  async unblock(blockerId: string, blockedId: string) {
    return this.prisma.block.deleteMany({ where: { blockerId, blockedId } });
  }

  blockedByUser(userId: string) {
    return this.prisma.block.findMany({ where: { blockerId: userId }, include: { blocked: true } });
  }

  /** Reports past their retention window with no open legal hold get purged. */
  async purgeExpired() {
    return this.prisma.report.deleteMany({
      where: { retainUntil: { lte: new Date() }, status: { in: [ReportStatus.ACTIONED, ReportStatus.DISMISSED] } },
    });
  }
}
