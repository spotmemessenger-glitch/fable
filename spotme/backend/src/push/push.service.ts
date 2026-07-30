import { Injectable, Logger } from '@nestjs/common';
import * as webpush from 'web-push';
import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
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
    this.initFirebase();
  }

  /**
   * FCM is the ONLY way to wake an idle Android device. A background socket
   * does not survive Doze, and the packaged app cannot use Web Push at all
   * (Capacitor's WebView has no PushManager). Credentials arrive as a
   * service-account JSON, either inline or as a path, so the same code works
   * on Railway (env var) and locally (file).
   */
  private initFirebase(): void {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
    if (!raw) return;
    try {
      // Accept a JSON blob or a path to one. Railway env vars cannot hold
      // newlines comfortably, so base64 is accepted too.
      let json = raw.trim();
      if (!json.startsWith('{')) {
        const decoded = Buffer.from(json, 'base64').toString('utf8').trim();
        json = decoded.startsWith('{')
          ? decoded
          : // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('fs').readFileSync(raw, 'utf8');
      }
      const creds = JSON.parse(json);
      if (!getApps().length) initializeApp({ credential: cert(creds) });
      this.fcmReady = true;
      this.log.log(`FCM ready (project ${creds.project_id})`);
    } catch (err) {
      // Never throw: a malformed key must not stop the server from booting and
      // delivering messages over the socket, which is the primary path.
      this.log.warn(`FCM disabled — could not read FIREBASE_SERVICE_ACCOUNT: ${(err as Error).message}`);
    }
  }

  private fcmReady = false;

  /** Dormant without keys — the client asks first and never offers push. */
  get enabled(): boolean {
    return Boolean(this.publicKey && this.privateKey);
  }

  config() {
    return {
      enabled: this.enabled,
      publicKey: this.enabled ? this.publicKey : null,
      // Lets the client decide whether to bother registering natively.
      native: this.fcmReady,
    };
  }

  // ── native device tokens (FCM / APNs) ─────────────────────────────────

  async registerDevice(userId: string, token: string, platform: string) {
    if (!token) throw new Error('token required');
    const plat = platform === 'ios' ? 'ios' : 'android';
    await this.prisma.deviceToken.upsert({
      where: { token },
      // A token can migrate between identities on a shared device, so userId
      // is updated rather than left pointing at whoever registered it first.
      create: { userId, token, platform: plat },
      update: { userId, platform: plat, lastUsedAt: new Date() },
    });
    return { ok: true };
  }

  async unregisterDevice(token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { token } });
    return { ok: true };
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
    if (userIds.length === 0) return { sent: 0 };
    // Both transports run: one identity can have a phone (FCM) and a desktop
    // browser (Web Push) at once, and both should light up.
    const [web, native] = await Promise.all([
      this.notifyWeb(userIds, payload),
      this.notifyNative(userIds, payload),
    ]);
    return { sent: web.sent + native.sent, web, native };
  }

  /**
   * FCM, sent with BOTH a notification block and a data block, at high
   * priority.
   *
   * Data-only was tried first, on the theory that letting Android render the
   * notification itself would hand Google the content. It does not: the
   * payload deliberately carries no message text — only "New message" and a
   * room tag — so there is nothing to leak, and the privacy argument buys
   * nothing while costing everything. Measured on-device: a data-only push
   * reached a backgrounded app but displayed NOTHING, because Android never
   * auto-renders data-only, and it is dropped entirely once the process dies.
   *
   * With a notification block the system tray shows it whether or not our
   * process is alive, which is the whole point of waking a sleeping phone.
   * The data block rides along so the app can route the tap when it IS alive.
   *
   * Note: FCM is not delivered at all to a FORCE-STOPPED app — that is an
   * Android rule, not a bug here. Normal background and swiped-away both work.
   */
  private async notifyNative(
    userIds: string[],
    payload: { title: string; body: string; tag?: string },
  ) {
    if (!this.fcmReady) return { sent: 0, skipped: 'fcm not configured' };
    const rows = await this.prisma.deviceToken.findMany({ where: { userId: { in: userIds } } });
    if (!rows.length) return { sent: 0 };

    const res = await getMessaging().sendEachForMulticast({
      tokens: rows.map((r) => r.token),
      notification: { title: payload.title, body: payload.body },
      data: { title: payload.title, body: payload.body, tag: payload.tag ?? '' },
      android: {
        priority: 'high',
        notification: {
          // Collapse repeats from one room into a single tray entry instead of
          // stacking a buzz per message.
          tag: payload.tag || 'spotme',
          defaultSound: true,
          // HIGH, not MAX: this should light the screen, not bypass Do Not
          // Disturb for a chat message.
          priority: 'high',
        },
      },
      apns: {
        headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
        // content-available also wakes the app so it can fetch the real message.
        payload: { aps: { 'content-available': 1, sound: 'default', 'thread-id': payload.tag ?? '' } },
      },
    });

    // Drop tokens Google says are gone for good, or the table fills with
    // corpses that fail on every future send.
    const dead: string[] = [];
    res.responses.forEach((r, i) => {
      const code = (r.error as { code?: string } | undefined)?.code ?? '';
      if (!r.success && /registration-token-not-registered|invalid-argument/.test(code)) {
        dead.push(rows[i].token);
      } else if (!r.success) {
        this.log.warn(`FCM send failed (${code || 'unknown'}) for ${rows[i].userId}`);
      }
    });
    if (dead.length) {
      await this.prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
    }
    if (res.successCount) {
      await this.prisma.deviceToken.updateMany({
        where: { token: { in: rows.map((r) => r.token) } },
        data: { lastUsedAt: new Date() },
      });
    }
    return { sent: res.successCount, pruned: dead.length };
  }

  private async notifyWeb(
    userIds: string[],
    payload: { title: string; body: string; tag?: string },
  ) {
    if (!this.enabled) return { sent: 0, skipped: 'vapid not configured' };
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
