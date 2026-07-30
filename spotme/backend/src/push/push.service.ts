import { Injectable, Logger } from '@nestjs/common';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Web Push, sent by the server that already saw the message.
 *
 * The web app's original design had the SENDER poke the recipient's device,
 * because there was no server to do it. That is worse in three ways now: it is
 * spoofable by anyone who can call the endpoint, it silently does nothing if
 * the sender's tab dies between "sent" and "poked", and it needs a separate
 * Redis to hold subscriptions. The server persists every event anyway, so the
 * append IS the trigger, and Postgres already holds the data.
 *
 * WHAT A PUSH IS ALLOWED TO CONTAIN
 *
 * Nothing about the message. Payloads pass through Apple's and Google's push
 * services, so putting text in one would hand them exactly what the end-to-end
 * encryption exists to withhold. A push says "something arrived, from whom";
 * the app fetches the content itself, over the encrypted channel.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger(PushService.name);
  private readonly publicKey = process.env.VAPID_PUBLIC_KEY || '';
  private readonly privateKey = process.env.VAPID_PRIVATE_KEY || '';
  private readonly subject = process.env.VAPID_SUBJECT || 'mailto:spotmemessenger@gmail.com';

  constructor(private prisma: PrismaService) {
    if (this.enabled) {
      webpush.setVapidDetails(this.subject, this.publicKey, this.privateKey);
    }
  }

  /** Dormant without keys — the client asks first and never offers push. */
  get enabled(): boolean {
    return Boolean(this.publicKey && this.privateKey);
  }

  config() {
    return { enabled: this.enabled, publicKey: this.enabled ? this.publicKey : null };
  }

  async subscribe(
    userId: string,
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  ) {
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      throw new Error('incomplete subscription');
    }
    // Upsert on endpoint: a reinstall hands us a new endpoint, but a repeated
    // subscribe from the same device must not accumulate duplicate rows and
    // send the same notification twice.
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: {
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
      },
      update: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
    return { ok: true };
  }

  async unsubscribe(endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint } });
    return { ok: true };
  }

  /** Turn push off across every device for this identity. */
  async unsubscribeUser(userId: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { userId } });
    return { ok: true };
  }

  /**
   * Notify these users.
   *
   * Callers exclude anyone currently connected: a device with the app open
   * already received the event over its socket, and pushing as well produces a
   * notification for something the user is looking at — which is how people
   * learn to ignore notifications.
   */
  async notify(userIds: string[], payload: { title: string; body: string; tag?: string }) {
    if (!this.enabled || userIds.length === 0) return { sent: 0 };
    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId: { in: userIds } },
    });
    if (subs.length === 0) return { sent: 0 };

    const body = JSON.stringify(payload);
    let sent = 0;
    const dead: string[] = [];
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
          );
          sent += 1;
        } catch (err: unknown) {
          const status = (err as { statusCode?: number })?.statusCode;
          // 404/410 mean the browser threw this subscription away for good.
          // Retrying it forever is how a push table fills with corpses.
          if (status === 404 || status === 410) dead.push(s.endpoint);
          else this.log.warn(`push failed (${status ?? 'no status'}) for ${s.userId}`);
        }
      }),
    );
    if (dead.length) {
      await this.prisma.pushSubscription.deleteMany({ where: { endpoint: { in: dead } } });
    }
    if (sent) {
      await this.prisma.pushSubscription.updateMany({
        where: { userId: { in: userIds } },
        data: { lastUsedAt: new Date() },
      });
    }
    return { sent, pruned: dead.length };
  }

  /** Remember that this user belongs to this room, so we know whom to notify. */
  async remember(roomId: string, userId: string) {
    await this.prisma.roomMember.upsert({
      where: { roomId_userId: { roomId, userId } },
      create: { roomId, userId },
      update: { lastSeen: new Date() },
    });
  }

  /** Everyone known to be in a room, except the person who caused the event. */
  async membersToNotify(roomId: string, exceptUserId: string): Promise<string[]> {
    const rows = await this.prisma.roomMember.findMany({
      where: { roomId, userId: { not: exceptUserId } },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }
}
