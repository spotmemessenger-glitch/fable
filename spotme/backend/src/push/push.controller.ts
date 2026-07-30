import { BadRequestException, Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
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
  constructor(private push: PushService) {}

  @Get()
  config() {
    return this.push.config();
  }

  @Post()
  @HttpCode(200)
  async handle(
    @Body()
    body: {
      action?: string;
      userId?: string;
      endpoint?: string;
      token?: string;
      platform?: string;
      subscription?: { endpoint: string; keys: { p256dh: string; auth: string } };
    },
  ) {
    switch (body.action) {
      case 'subscribe': {
        if (!body.userId || !body.subscription) {
          throw new BadRequestException('userId and subscription required');
        }
        try {
          return await this.push.subscribe(body.userId, body.subscription);
        } catch (err) {
          throw new BadRequestException((err as Error).message);
        }
      }
      case 'unsubscribe': {
        const endpoint = body.endpoint || body.subscription?.endpoint;
        if (endpoint) return this.push.unsubscribe(endpoint);
        // Older clients send only userId; clear every device for that user.
        if (!body.userId) throw new BadRequestException('endpoint or userId required');
        return this.push.unsubscribeUser(body.userId);
      }
      // Native (FCM/APNs) registration — the only path that can wake the
      // packaged app, since its WebView has no Push API at all.
      case 'register-device': {
        if (!body.userId || !body.token) {
          throw new BadRequestException('userId and token required');
        }
        try {
          return await this.push.registerDevice(body.userId, body.token, body.platform ?? 'android');
        } catch (err) {
          throw new BadRequestException((err as Error).message);
        }
      }
      case 'unregister-device': {
        if (!body.token) throw new BadRequestException('token required');
        return this.push.unregisterDevice(body.token);
      }
      case 'notify':
        return { ok: true, ignored: 'the server decides who to notify' };
      default:
        throw new BadRequestException(`unknown action: ${body.action}`);
    }
  }
}
