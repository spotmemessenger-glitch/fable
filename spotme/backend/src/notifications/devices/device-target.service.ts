import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TransportName, TransportTarget } from '../transport/notification-transport';

/**
 * Resolves a recipient's addressable device targets from the EXISTING tables
 * (`DeviceToken` for native, `PushSubscription` for web) and prunes dead ones.
 *
 * Additive and read-mostly: it does not alter those tables' shape (no new
 * columns were added in this branch), it only reads them and deletes rows a
 * provider has declared permanently gone — the exact prune the shipped
 * `push.service.ts` already performs, centralised here for the worker.
 */
@Injectable()
export class DeviceTargetService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every device we could reach this recipient on. */
  async targetsFor(recipientId: string): Promise<TransportTarget[]> {
    const [tokens, subs] = await Promise.all([
      this.prisma.deviceToken.findMany({ where: { userId: recipientId } }),
      this.prisma.pushSubscription.findMany({ where: { userId: recipientId } }),
    ]);
    const native: TransportTarget[] = tokens.map((t) => ({
      deviceId: t.id,
      token: t.token,
      platform: t.platform === 'ios' ? 'ios' : 'android',
    }));
    const web: TransportTarget[] = subs.map((s) => ({
      deviceId: s.id,
      subscription: { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      platform: 'web',
    }));
    return [...native, ...web];
  }

  /** Remove a registration a provider says is gone for good (404/410/etc). */
  async prune(deviceId: string, transport: TransportName): Promise<void> {
    if (transport === 'webpush') {
      await this.prisma.pushSubscription.deleteMany({ where: { id: deviceId } });
    } else {
      await this.prisma.deviceToken.deleteMany({ where: { id: deviceId } });
    }
  }
}
