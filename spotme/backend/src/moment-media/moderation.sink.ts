/**
 * `{moderation}` — the durable sink and the alert (owner directive, D7).
 *
 * THE PROBLEM THIS FIXES. The report path was real in every respect except the
 * one that matters: it wrote a row, moved the moderation state, appended an
 * audit event — and then enqueued the job into a FIXTURE recorder that nothing
 * read. A report button whose reports land nowhere is worse than no button,
 * because it tells the person who pressed it that something will happen.
 *
 * DELIBERATELY SMALL. This is not review tooling. It does two things:
 *   1. PERSISTS the report durably, so a queue outage cannot lose it (the row
 *      is written by the service before this is called; this records the
 *      DELIVERY attempt and its outcome, which is the part that was missing);
 *   2. ALERTS the operator — a greppable, PII-free marker on stderr that the
 *      existing 5xx alert path already watches, so a report is visible in the
 *      same place an incident is.
 *
 * WHAT IT DOES NOT DO, and D7 says so out loud: no automated screening, no
 * hash matching, no NCMEC path. Those three are the launch gate for public
 * availability. This makes the private test honest, not the product safe.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** The alert marker. Greppable, and carries NO user content. */
export const MODERATION_ALERT = 'moderation_report';

export interface ModerationSignal {
  reportId: string;
  targetKind: 'moment' | 'comment' | 'story';
  targetId: string;
  reason: string;
}

@Injectable()
export class ModerationSink {
  private readonly log = new Logger(ModerationSink.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record the report's delivery and raise the alert.
   *
   * NO REPORTER ID, NO NOTE TEXT, NO CONTENT in the alert line: an alert is
   * read by whoever is on call and copied into tickets, and a free-text note
   * on a sexual-content report is precisely the thing that must not travel
   * that way. The ids are enough to find the row.
   */
  async accept(signal: ModerationSignal): Promise<{ recorded: boolean; alerted: boolean }> {
    let recorded = false;
    try {
      // Durable delivery marker on the report row itself. If this throws the
      // report still EXISTS (the service wrote it); what is lost is only the
      // knowledge that we alerted — so the catch logs loudly rather than
      // swallowing, and never rethrows into the caller's request path.
      await this.prisma.momentReport.update({
        where: { id: signal.reportId },
        data: { queuedAt: new Date() },
      });
      recorded = true;
    } catch (e) {
      this.log.error(`${MODERATION_ALERT}_record_failed reportId=${signal.reportId} reason=${(e as Error).message.slice(0, 160)}`);
    }

    // The alert. One line, fixed shape, no PII — the same discipline as the
    // discovery_5xx marker the alert path already watches.
    this.log.warn(
      `${MODERATION_ALERT} reportId=${signal.reportId} kind=${signal.targetKind} targetId=${signal.targetId} reason=${JSON.stringify(signal.reason).slice(0, 80)} review=MANUAL_ONLY`,
    );
    return { recorded, alerted: true };
  }
}
