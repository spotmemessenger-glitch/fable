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
  /** Validates (so a bad payload fails EVEN while dark), then drops. */
  async publish(_channel: string, event: DiscoveryRealtimeEvent): Promise<{ ok: boolean }> {
    assertPublishable(event);
    return { ok: false };
  }
}

export interface CapturedEvent {
  channel: string;
  event: DiscoveryRealtimeEvent;
}

@Injectable()
export class InMemoryDiscoveryRealtimeAdapter implements DiscoveryRealtimePort {
  readonly name = 'in-memory';
  readonly published: CapturedEvent[] = [];
  enabled(): boolean {
    return true;
  }
  async publish(channel: string, event: DiscoveryRealtimeEvent): Promise<{ ok: boolean }> {
    assertPublishable(event);
    this.published.push({ channel, event });
    return { ok: true };
  }
  /** Test helper: latest visibilityVersion seen per user, for staleness rules. */
  latestVersion(userId: string): number {
    let v = -1;
    for (const p of this.published) {
      const e = p.event;
      if ('userId' in e && e.userId === userId && 'visibilityVersion' in e) {
        v = Math.max(v, e.visibilityVersion);
      }
    }
    return v;
  }
}
