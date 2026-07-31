import { BadRequestException, Body, Controller, Get, HttpCode, Logger, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { PushService } from './push.service';

/**
 * Same wire contract the web client already speaks (spotme/web/src/lib/push.js),
 * so nothing on the client changes:
 *
 *   GET  /api/push                                    -> { enabled, publicKey }
 *   POST { action:'subscribe', userId, subscription }  -> { ok:true }
 *   POST { action:'unsubscribe', userId }              -> { ok:true }
 *   POST { action:'notify', toUserId }                 -> accepted, ignored
 *
 * `notify` is deliberately a no-op. It exists because older clients still send
 * it after each message, and a 400 there would surface as an error for
 * something that is no longer the client's job. The server now decides who to
 * notify from the event log — a sender-supplied "please notify X" is both
 * unnecessary and trivially forgeable.
 */
@Controller('push')
export class PushController {
  private readonly log = new Logger(PushController.name);

  constructor(private push: PushService) {}

  /**
   * Deliberately unauthenticated: it returns the VAPID PUBLIC key and nothing
   * else, and the client needs it before it has a token to ask with.
   */
  @Get()
  config() {
    return this.push.config();
  }

  /**
   * WHOSE SUBSCRIPTION THIS IS COMES FROM THE TOKEN, NEVER FROM THE BODY.
   *
   * This route had no guard at all and took `userId` as a free-text field
   * (`PushSubscription` has no foreign key to `User`, so nothing downstream
   * questioned it either). Three one-line attacks followed from that:
   *
   *   - unsubscribe someone else's `userId` and every push registration they
   *     have is deleted — they simply stop being told about messages, and a
   *     loop keeps it that way;
   *   - subscribe an attacker-controlled endpoint under a victim's `userId` and
   *     every "New message" fans out to it too. The payload carries no text,
   *     but it carries `tag: roomId` — a live feed of which of their rooms are
   *     active and when, which is exactly the traffic analysis end-to-end
   *     encryption exists to withhold;
   *   - register-device upserts on the token and REASSIGNS its owner, so a
   *     known token can be moved onto another account.
   *
   * Victim ids were free: username search returns them, unauthenticated.
   */
  @UseGuards(JwtAuthGuard)
  @Post()
  @HttpCode(200)
  async handle(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body()
    body: {
      action?: string;
      endpoint?: string;
      token?: string;
      platform?: string;
      subscription?: { endpoint: string; keys: { p256dh: string; auth: string } };
    },
  ) {
    const userId = principal.id;
    switch (body.action) {
      case 'subscribe': {
        if (!body.subscription) throw new BadRequestException('subscription required');
        try {
          return await this.push.subscribe(userId, body.subscription);
        } catch (err) {
          // The raw message names models, fields and sometimes the query. It
          // told an anonymous caller about our schema; it tells an authenticated
          // one just as much.
          this.log.warn(`push subscribe failed: ${(err as Error).message}`);
          throw new BadRequestException('could not register for push');
        }
      }
      case 'unsubscribe': {
        // An endpoint is a bearer-ish secret of its own, but only ever remove
        // one that belongs to the caller — otherwise the body picks the victim
        // again by another name.
        const endpoint = body.endpoint || body.subscription?.endpoint;
        if (endpoint) return this.push.unsubscribeOwned(userId, endpoint);
        return this.push.unsubscribeUser(userId);
      }
      // Native (FCM/APNs) registration — the only path that can wake the
      // packaged app, since its WebView has no Push API at all.
      case 'register-device': {
        if (!body.token) throw new BadRequestException('token required');
        try {
          return await this.push.registerDevice(userId, body.token, body.platform ?? 'android');
        } catch (err) {
          this.log.warn(`push register-device failed: ${(err as Error).message}`);
          throw new BadRequestException('could not register this device');
        }
      }
      case 'unregister-device': {
        if (!body.token) throw new BadRequestException('token required');
        return this.push.unregisterDeviceOwned(userId, body.token);
      }
      case 'notify':
        return { ok: true, ignored: 'the server decides who to notify' };
      default:
        throw new BadRequestException(`unknown action: ${body.action}`);
    }
  }
}
