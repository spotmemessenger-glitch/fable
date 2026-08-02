import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationFlags } from '../notifications.config';
import { NotificationCatalog } from '../catalog/notification-catalog';
import { PreferenceEvaluator } from './preference-evaluator';
import {
  AccountPreference,
  ClassTraits,
  ConversationPreference,
  DEFAULT_ACCOUNT_PREFERENCE,
  PreferenceDecision,
} from './preference.types';
import { NotificationClass, PreferenceLevel } from '../catalog/notification-class';

/**
 * Prisma-backed preference read/evaluation (design §5.5, §9). The store is
 * additive (`NotificationPreference`, `ConversationNotifPref`); reads are
 * flag-gated so an un-applied migration or a disabled platform degrades to the
 * safe default (deliver-as-today) rather than erroring.
 *
 * Preferences are per-user rows keyed by the JWT subject and per-room checked
 * against `RoomMember`; a user can only read/write their own, and only for rooms
 * they belong to (the caller enforces membership). No content, no secrets — this
 * is routing policy, safe to hold server-side (§9.4).
 */
@Injectable()
export class PreferenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: NotificationFlags,
    private readonly catalog: NotificationCatalog,
    private readonly evaluator: PreferenceEvaluator,
  ) {}

  /** Derive the evaluator traits for a class from the catalog. */
  traitsFor(cls: NotificationClass): ClassTraits {
    const p = this.catalog.policy(cls);
    return {
      class: cls,
      minLevel: p.minLevel,
      priority: p.priority,
      canPierceDnd: p.canPierceDnd,
      critical: p.channel === 'security',
    };
  }

  async accountPref(userId: string): Promise<AccountPreference> {
    const row = await this.prisma.notificationPreference.findUnique({
      where: { userId },
    });
    if (!row) return DEFAULT_ACCOUNT_PREFERENCE;
    return {
      dndEnabled: row.dndEnabled,
      dndStart: row.dndStart,
      dndEnd: row.dndEnd,
      dndTz: row.dndTz,
      allowCallsInDnd: row.allowCallsInDnd,
      defaultLevel: coerceLevel(row.defaultLevel, 'all'),
    };
  }

  async conversationPref(
    userId: string,
    roomId: string,
  ): Promise<ConversationPreference | undefined> {
    const row = await this.prisma.conversationNotifPref.findUnique({
      where: { userId_roomId: { userId, roomId } },
    });
    if (!row) return undefined;
    return {
      level: coerceConvLevel(row.level),
      muteUntil: row.muteUntil ? row.muteUntil.getTime() : undefined,
    };
  }

  /**
   * The authoritative server-side decision for one (recipient, class, room). The
   * outbox path calls this; the flag-off case defaults to "deliver" so nothing
   * changes until the platform is switched on.
   */
  async decide(
    userId: string,
    cls: NotificationClass,
    roomId: string | undefined,
    now: Date = new Date(),
  ): Promise<PreferenceDecision> {
    if (!this.flags.enabled) return { deliver: true };
    const [account, conversation] = await Promise.all([
      this.accountPref(userId),
      roomId ? this.conversationPref(userId, roomId) : Promise.resolve(undefined),
    ]);
    return this.evaluator.evaluate({
      account,
      conversation,
      traits: this.traitsFor(cls),
      now,
    });
  }

  /** Full-resource account preference write (idempotent PUT). */
  async putAccountPref(userId: string, pref: AccountPreference): Promise<void> {
    const data = {
      dndEnabled: pref.dndEnabled,
      dndStart: pref.dndStart ?? null,
      dndEnd: pref.dndEnd ?? null,
      dndTz: pref.dndTz ?? null,
      allowCallsInDnd: pref.allowCallsInDnd,
      defaultLevel: pref.defaultLevel,
    };
    await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  /** Per-conversation level/mute write (idempotent PUT). */
  async putConversationPref(
    userId: string,
    roomId: string,
    pref: ConversationPreference,
  ): Promise<void> {
    const data = {
      level: pref.level,
      muteUntil: pref.muteUntil != null ? new Date(pref.muteUntil) : null,
    };
    await this.prisma.conversationNotifPref.upsert({
      where: { userId_roomId: { userId, roomId } },
      create: { userId, roomId, ...data },
      update: data,
    });
  }
}

function coerceLevel(v: string, fallback: PreferenceLevel): PreferenceLevel {
  return v === 'all' || v === 'mentions' || v === 'none' ? v : fallback;
}

function coerceConvLevel(v: string): PreferenceLevel | 'default' {
  return v === 'all' || v === 'mentions' || v === 'none' || v === 'default'
    ? v
    : 'default';
}
