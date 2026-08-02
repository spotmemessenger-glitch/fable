import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import {
  AuthenticatedPrincipal,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { PreferenceService } from './preferences/preference.service';
import { ReceiptService, ReceiptItem } from './receipts/receipt.service';
import { AccountPreference, ConversationPreference } from './preferences/preference.types';
import {
  NOTIFICATION_CLASSES,
  NotificationClass,
  PreferenceLevel,
} from './catalog/notification-class';
import { TransportName } from './transport/notification-transport';

/**
 * `/api/notifications` — receipts + preferences (design §5.4, §5.5).
 *
 * ALL mutating routes require `JwtAuthGuard`; THE ACTING USER IS ALWAYS THE JWT
 * SUBJECT, NEVER A BODY FIELD — the hard-won rule from the push controller. No
 * route carries or returns message content.
 *
 * NOT MOUNTED IN THIS BRANCH: only `NotificationModule` registers this
 * controller, and that module is deliberately not imported by `AppModule`, so
 * none of these routes exist in the running app until the platform is wired in.
 */
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly prefs: PreferenceService,
    private readonly receipts: ReceiptService,
  ) {}

  @Post('receipts')
  @HttpCode(200)
  async postReceipts(
    @Body()
    body: { deviceId?: string; transport?: TransportName; items?: ReceiptItem[] },
  ): Promise<{ accepted: number; rejected: number }> {
    if (!body.deviceId || !Array.isArray(body.items)) {
      throw new BadRequestException('deviceId and items required');
    }
    const transport: TransportName = body.transport ?? 'fcm';
    return this.receipts.record(body.deviceId, transport, body.items);
  }

  /**
   * A user ACTION on a delivered notification (reply/read/mute/archive/accept/
   * decline/…). Content-free: the body is an opaque notif handle + an action
   * name; the server records the RESULT, never the content. Rate-limit per
   * device before mounting (noted in the threat model).
   */
  @Post('actions')
  @HttpCode(200)
  async postAction(
    @Body()
    body: { deviceId?: string; transport?: TransportName; notifId?: string; action?: string },
  ): Promise<{ accepted: number; rejected: number }> {
    if (!body.deviceId || !body.notifId || !body.action) {
      throw new BadRequestException('deviceId, notifId and action required');
    }
    const transport: TransportName = body.transport ?? 'fcm';
    return this.receipts.recordAction(body.deviceId, transport, body.notifId, body.action);
  }

  @Get('preferences')
  async getPreferences(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<{ account: AccountPreference }> {
    const account = await this.prefs.accountPref(principal.id);
    return { account };
  }

  @Put('preferences')
  @HttpCode(200)
  async putPreferences(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() body: Partial<AccountPreference>,
  ): Promise<{ ok: true }> {
    const level = coerceLevel(body.defaultLevel);
    await this.prefs.putAccountPref(principal.id, {
      dndEnabled: Boolean(body.dndEnabled),
      dndStart: numOrNull(body.dndStart),
      dndEnd: numOrNull(body.dndEnd),
      dndTz: typeof body.dndTz === 'string' ? body.dndTz : null,
      allowCallsInDnd: body.allowCallsInDnd !== false, // default true
      defaultLevel: level,
      focusMode: Boolean(body.focusMode),
      focusAllow: coerceClasses(body.focusAllow),
    });
    return { ok: true };
  }

  @Put('preferences/conversations/:roomId')
  @HttpCode(200)
  async putConversationPref(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('roomId') roomId: string,
    @Body() body: { level?: string; muteUntil?: number | null },
  ): Promise<{ ok: true }> {
    // NOTE: production must also assert RoomMember(principal.id, roomId) before
    // storing (design §5.5) — the membership check is the caller's gate and is
    // wired when the module is mounted.
    const pref: ConversationPreference = {
      level: coerceConvLevel(body.level),
      muteUntil: body.muteUntil === undefined ? undefined : body.muteUntil,
    };
    await this.prefs.putConversationPref(principal.id, roomId, pref);
    return { ok: true };
  }
}

function coerceLevel(v: unknown): PreferenceLevel {
  return v === 'mentions' || v === 'none' ? v : 'all';
}

const KNOWN_CLASSES = new Set<string>(NOTIFICATION_CLASSES);
function coerceClasses(v: unknown): NotificationClass[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is NotificationClass => typeof x === 'string' && KNOWN_CLASSES.has(x));
}

function coerceConvLevel(v: unknown): PreferenceLevel | 'default' {
  return v === 'all' || v === 'mentions' || v === 'none' ? v : 'default';
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
