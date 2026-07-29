import { Injectable, Logger } from '@nestjs/common';

/**
 * 18 U.S.C. §2258A: apparent CSAM must be reported to NCMEC's CyberTipline "as
 * soon as reasonably possible" after actual knowledge, with 90-day preservation
 * (180 on LE request). This is a thin client around NCMEC's CyberTipline API —
 * a real integration requires an approved ESP account with NCMEC; until that's
 * provisioned, this logs the obligation loudly instead of silently no-op'ing.
 */
@Injectable()
export class NcmecService {
  private readonly logger = new Logger(NcmecService.name);

  async fileReport(reportId: string, reportedUserId: string, evidenceSummary: string): Promise<string> {
    if (!process.env.NCMEC_API_KEY) {
      this.logger.error(
        `NCMEC_API_KEY not configured — CyberTipline report for case ${reportId} was NOT filed. ` +
          `This is a legal reporting obligation (18 U.S.C. §2258A), not optional — provision an ESP ` +
          `account with NCMEC before this pipeline is used in production.`,
      );
      return `unfiled:${reportId}`;
    }
    // TODO: POST to NCMEC's CyberTipline API once an ESP account exists.
    // Deliberately not stubbed with a fake success response — a silent no-op
    // here is worse than a loud failure given the statute above.
    throw new Error('NCMEC CyberTipline integration not yet provisioned — see NCMEC_API_KEY.');
  }
}
