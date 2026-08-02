import { Injectable } from '@nestjs/common';
import { PreferenceLevel } from '../catalog/notification-class';
import { isDndActive } from './dnd-window';
import {
  AccountPreference,
  ClassTraits,
  ConversationPreference,
  PreferenceDecision,
} from './preference.types';

/**
 * Server-side preference evaluation (design §9.2). The client is UNTRUSTED — a
 * muted conversation must produce no outbox row at all, so no metadata even
 * reaches the provider. The client re-checks on receipt as a belt-and-suspenders
 * final gate, but THIS is the authoritative one.
 *
 * Pure and deterministic given (account, conversation, traits, now) — which is
 * what the preference matrix test pins across level × mute × DND × class.
 */

const LEVEL_RANK: Record<PreferenceLevel, number> = { none: 0, mentions: 1, all: 2 };

export interface EvaluateInput {
  readonly account: AccountPreference;
  /** Absent ⇒ the account defaultLevel applies with no per-convo mute. */
  readonly conversation?: ConversationPreference;
  readonly traits: ClassTraits;
  readonly now: Date;
}

@Injectable()
export class PreferenceEvaluator {
  /** Resolve the effective level (conversation overrides account default). */
  effectiveLevel(
    account: AccountPreference,
    conversation?: ConversationPreference,
  ): PreferenceLevel {
    if (conversation && conversation.level !== 'default') return conversation.level;
    return account.defaultLevel;
  }

  evaluate(input: EvaluateInput): PreferenceDecision {
    const { account, conversation, traits, now } = input;

    // Critical classes (security/login/verification) are never suppressed by a
    // user's level or mute. During DND they still deliver, but quietly.
    if (traits.critical) {
      return isDndActive(account, now)
        ? { deliver: true, downgrade: true, pierced: true }
        : { deliver: true };
    }

    const callException = traits.canPierceDnd && account.allowCallsInDnd;
    const level = this.effectiveLevel(account, conversation);

    // 1. Level gate. A class fires only if the user's level is at least the
    //    class's minimum — with the call exception able to override.
    if (LEVEL_RANK[level] < LEVEL_RANK[traits.minLevel] && !callException) {
      return { deliver: false, reason: 'level' };
    }

    // 2. Temporary/permanent per-conversation mute.
    const muteUntil = conversation?.muteUntil;
    const mutedForever =
      conversation?.level === 'none' && (muteUntil === null || muteUntil === undefined);
    const mutedNow = muteUntil != null && muteUntil > now.getTime();
    if ((mutedNow || mutedForever) && !callException) {
      return { deliver: false, reason: 'mute' };
    }

    // 3. Do-Not-Disturb window.
    if (isDndActive(account, now)) {
      if (callException) return { deliver: true, pierced: true };
      // High-value classes deliver quietly; low-value classes are held for a
      // digest at window end.
      if (traits.priority === 'high' || traits.priority === 'max') {
        return { deliver: true, downgrade: true };
      }
      return { deliver: true, hold: true };
    }

    return { deliver: true };
  }
}
