/**
 * Realtime adapters (checkpoint 9). The DEFAULT is disabled: publishes go
 * nowhere, no broker is contacted, nothing connects at startup. The in-memory
 * adapter exists for tests. A Centrifugo adapter is FUTURE work behind the
 * same port (ADR-026), with Valkey (dev) / Dragonfly Cloud (prod, REDIS_URL
 * env only) as its broker — none of that is wired or deployed this phase.
 */

import { Injectable } from '@nestjs/common';
import {
  assertPublishable,
  DiscoveryRealtimeEvent,
  DiscoveryRealtimePort,
} from './realtime.port';

@Injectable()
export class DisabledDiscoveryRealtimeAdapter implements DiscoveryRealtimePort {
  readonly name = 'disabled';
  enabled(): boolean {
    return false;
  }
  /** Validates routing + content (so a bad payload fails EVEN while dark), drops. */
  async publish(channel: string, event: DiscoveryRealtimeEvent): Promise<{ ok: boolean }> {
    assertPublishable(channel, event);
    return { ok: false };
  }
}

/** Monotonic-version gate shared by live adapters: a replayed or out-of-order
 *  event (stale visibilityVersion for a channel) is dropped at publish, so
 *  C-REPLAY is enforced by the server, not merely assumed of consumers (6.3). */
function versionKey(channel: string, event: DiscoveryRealtimeEvent): string | null {
  return 'visibilityVersion' in event ? channel : null;
}

export interface CapturedEvent {
  channel: string;
  event: DiscoveryRealtimeEvent;
}

@Injectable()
export class InMemoryDiscoveryRealtimeAdapter implements DiscoveryRealtimePort {
  readonly name = 'in-memory';
  readonly published: CapturedEvent[] = [];
  private lastVersion = new Map<string, number>();
  enabled(): boolean {
    return true;
  }
  async publish(channel: string, event: DiscoveryRealtimeEvent): Promise<{ ok: boolean }> {
    assertPublishable(channel, event);
    // C-REPLAY (6.3): drop a stale/replayed version for this channel.
    const key = versionKey(channel, event);
    if (key && 'visibilityVersion' in event) {
      const seen = this.lastVersion.get(key) ?? -1;
      if (event.visibilityVersion <= seen) return { ok: false };
      this.lastVersion.set(key, event.visibilityVersion);
    }
    this.published.push({ channel, event });
    return { ok: true };
  }
  /** Test helper: latest visibilityVersion published on a channel. */
  latestVersion(channel: string): number {
    return this.lastVersion.get(channel) ?? -1;
  }
}
