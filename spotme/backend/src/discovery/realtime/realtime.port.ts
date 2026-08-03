/**
 * Discovery realtime contract (checkpoint 9) — the ADR-026 data-plane boundary
 * WITHOUT deploying Centrifugo.
 *
 * What exists this phase: the port, the event schemas, the channel-naming and
 * token-claim SPECIFICATION, a disabled default adapter, and an in-memory test
 * adapter. No Centrifugo package, no broker connection, no startup activity —
 * Dragonfly/Valkey is documented as the FUTURE broker only (the same
 * REDIS_URL-env rule as the queue).
 *
 * Event payload policy (threat model C-RT-MIN), enforced by a runtime guard on
 * EVERY publish: no precise coordinates, no full profile, no auth token, no
 * message content. Events carry ids, coarse cell ids, and monotonic versions —
 * enough to invalidate, never enough to track.
 */

/** The five discovery events. Payloads are deliberately minimal. */
export type DiscoveryRealtimeEvent =
  | { type: 'presence-updated'; userId: string; coarseCell: string; visibilityVersion: number }
  | { type: 'presence-expired'; userId: string; coarseCell: string; visibilityVersion: number }
  | { type: 'visibility-disabled'; userId: string; visibilityVersion: number }
  | { type: 'profile-projection-updated'; userId: string }
  | { type: 'discovery-result-invalidated'; scope: 'blocks-changed' | 'user-deleted' | 'projection-rebuilt'; userId: string };

/**
 * CHANNEL NAMING SPECIFICATION (Centrifugo, future):
 *  - `discovery:cell:{coarseCell}`   — area presence events; subscribable only
 *    with a claim listing that exact cell (derived from the subscriber's own
 *    coarse origin — never an arbitrary cell list of unbounded size).
 *  - `discovery:self:{userId}`      — MY visibility/projection state; claim
 *    derived from the JWT principal; nobody else can be subscribed to.
 * There is NO per-other-user channel — subscribing to a specific other person
 * is structurally impossible (T-RTABUSE).
 */
export const discoveryCellChannel = (coarseCell: string) => `discovery:cell:${coarseCell}`;
export const discoverySelfChannel = (userId: string) => `discovery:self:${userId}`;

/** Token-claim SPECIFICATION: short-lived, server-minted, channel-scoped. */
export interface DiscoveryChannelClaim {
  sub: string;             // JWT principal
  channels: string[];      // exact channels, derived server-side (≤ maxChannels)
  exp: number;             // unix seconds; ttl ≤ CLAIM_TTL_SECONDS
}
export const CLAIM_TTL_SECONDS = 60;
export const CLAIM_MAX_CHANNELS = 4;

/**
 * Derive the claim a principal may hold: their SELF channel plus the cell
 * channels of their own queried coarse cells (bounded). Arbitrary user
 * subscription is impossible by construction.
 */
export function deriveChannelClaim(principalId: string, queriedCells: string[], nowSec: number): DiscoveryChannelClaim {
  const cells = [...new Set(queriedCells)].slice(0, CLAIM_MAX_CHANNELS - 1);
  return {
    sub: principalId,
    channels: [discoverySelfChannel(principalId), ...cells.map(discoveryCellChannel)],
    exp: nowSec + CLAIM_TTL_SECONDS,
  };
}

/** Forbidden content guard — run on EVERY publish (C-RT-MIN). */
const FORBIDDEN_KEYS = /^(lat|lon|lng|latitude|longitude|coords?|token|jwt|bearer|authorization|password|secret|email|phone|message|body|text|content)$/i;
const CREDENTIALED_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]*@[^\s'"]*/i;

export function assertPublishable(event: DiscoveryRealtimeEvent): void {
  const walk = (v: unknown, path: string): void => {
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (FORBIDDEN_KEYS.test(k)) {
          throw new Error(`realtime event carries forbidden field '${path}${k}' — precise coords/profile/token content may never be published`);
        }
        walk(val, `${path}${k}.`);
      }
    } else if (typeof v === 'string' && CREDENTIALED_URL.test(v)) {
      throw new Error(`realtime event carries a credentialed URL at ${path} — refused`);
    }
  };
  walk(event, '');
}

export interface DiscoveryRealtimePort {
  readonly name: string;
  /** Publish an event to a channel. Guarded by assertPublishable. */
  publish(channel: string, event: DiscoveryRealtimeEvent): Promise<{ ok: boolean }>;
  /** Whether this adapter is live (the default adapter never is). */
  enabled(): boolean;
}

export const DISCOVERY_REALTIME_PORT = Symbol('DISCOVERY_REALTIME_PORT');
