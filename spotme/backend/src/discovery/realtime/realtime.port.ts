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

/**
 * The discovery events, split into two ROUTING FAMILIES the guard enforces:
 *
 *  - CELL events (`cell-*`) go to a shared `discovery:cell:{cell}` channel and
 *    carry NO userId. Broadcasting a per-user id to a shared channel would leak
 *    "user X is present in cell Y" to everyone nearby — including a party X has
 *    blocked, whom the SQL query path carefully hides (review finding 6.2).
 *    A cell event is an OPAQUE "something in this cell changed — re-query"
 *    trigger; the block-filtered query API resolves who is actually visible.
 *  - SELF events (`self-*`) go to `discovery:self:{userId}` and carry the
 *    principal's OWN userId, which MUST equal the channel's principal (routing
 *    guard). They never reach a cell channel.
 */
export type DiscoveryRealtimeEvent =
  | { type: 'cell-presence-updated'; coarseCell: string; visibilityVersion: number }
  | { type: 'cell-presence-expired'; coarseCell: string; visibilityVersion: number }
  | { type: 'self-visibility-changed'; userId: string; visibilityVersion: number }
  | { type: 'self-projection-updated'; userId: string }
  | { type: 'self-results-invalidated'; userId: string; scope: 'blocks-changed' | 'user-deleted' | 'projection-rebuilt' };

/**
 * CHANNEL NAMING SPECIFICATION (Centrifugo, future):
 *  - `discovery:cell:{coarseCell}`   — area re-query triggers; subscribable only
 *    with a claim listing that exact cell, derived server-side from the
 *    subscriber's OWN authoritative coarse cell — never a client-supplied list.
 *  - `discovery:self:{userId}`      — MY visibility/projection state; claim
 *    derived from the JWT principal; nobody else can be subscribed to.
 * There is NO per-other-user channel — subscribing to a specific other person
 * is structurally impossible (T-RTABUSE).
 */
export const discoveryCellChannel = (coarseCell: string) => `discovery:cell:${coarseCell}`;
export const discoverySelfChannel = (userId: string) => `discovery:self:${userId}`;
const CELL_PREFIX = 'discovery:cell:';
const SELF_PREFIX = 'discovery:self:';

/** Token-claim SPECIFICATION: short-lived, server-minted, channel-scoped. */
export interface DiscoveryChannelClaim {
  sub: string;             // JWT principal
  channels: string[];      // exact channels, derived server-side (≤ maxChannels)
  exp: number;             // unix seconds; ttl ≤ CLAIM_TTL_SECONDS
}
export const CLAIM_TTL_SECONDS = 60;
export const CLAIM_MAX_CHANNELS = 4;

/**
 * Derive the claim a principal may hold: their SELF channel plus cell channels
 * for their OWN authoritative coarse cells (bounded). `authoritativeCells` MUST
 * be derived server-side from the principal's validated coarse origin / stored
 * visibility cell at the (future) mint site — NEVER a client-supplied list
 * (review finding 6.1). The claim can therefore never grant a cell the
 * principal does not legitimately occupy, so subscribing to a victim's cell to
 * watch their presence is impossible by construction.
 */
export function deriveChannelClaim(principalId: string, authoritativeCells: string[], nowSec: number): DiscoveryChannelClaim {
  const cells = [...new Set(authoritativeCells)].filter((c) => c && typeof c === 'string').slice(0, CLAIM_MAX_CHANNELS - 1);
  return {
    sub: principalId,
    channels: [discoverySelfChannel(principalId), ...cells.map(discoveryCellChannel)],
    exp: nowSec + CLAIM_TTL_SECONDS,
  };
}

/** Forbidden content guard — run on EVERY publish (C-RT-MIN). */
const FORBIDDEN_KEYS = /^(lat|lon|lng|latitude|longitude|coords?|token|jwt|bearer|authorization|password|secret|email|phone|message|body|text|content)$/i;
const CREDENTIALED_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]*@[^\s'"]*/i;
/** A coordinate carried as a VALUE under an innocent key (finding 6.4). */
const COORDINATE_VALUE = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}|-?\d{1,3}\.\d{4,}/;

/**
 * Guard EVERY publish (C-RT-MIN): content minimization AND routing (finding
 * 6.2). A self/userId-bearing event may never reach a shared cell channel, and
 * a self event's userId must match its own self channel.
 */
export function assertPublishable(channel: string, event: DiscoveryRealtimeEvent): void {
  const walk = (v: unknown, path: string): void => {
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (FORBIDDEN_KEYS.test(k)) {
          throw new Error(`realtime event carries forbidden field '${path}${k}' — precise coords/profile/token content may never be published`);
        }
        walk(val, `${path}${k}.`);
      }
    } else if (typeof v === 'string') {
      if (CREDENTIALED_URL.test(v)) throw new Error(`realtime event carries a credentialed URL at ${path} — refused`);
      if (COORDINATE_VALUE.test(v)) throw new Error(`realtime event carries a coordinate-shaped value at ${path} — refused (6.4)`);
    }
  };
  walk(event, '');

  const isCell = channel.startsWith(CELL_PREFIX);
  const isSelf = channel.startsWith(SELF_PREFIX);
  if (!isCell && !isSelf) throw new Error(`realtime channel '${channel}' is neither a cell nor a self channel — refused`);
  if (event.type.startsWith('cell-')) {
    if (!isCell) throw new Error(`cell event '${event.type}' may only publish to a cell channel — refused`);
  } else {
    // self-* events carry a userId and must match their own self channel.
    if (!isSelf) throw new Error(`self event '${event.type}' may never publish to a cell channel — it would leak identity (6.2)`);
    const uid = channel.slice(SELF_PREFIX.length);
    if (!('userId' in event) || event.userId !== uid) {
      throw new Error(`self event userId must equal its self channel principal — refused`);
    }
  }
}

export interface DiscoveryRealtimePort {
  readonly name: string;
  /** Publish an event to a channel. Guarded by assertPublishable(channel, event). */
  publish(channel: string, event: DiscoveryRealtimeEvent): Promise<{ ok: boolean }>;
  /** Whether this adapter is live (the default adapter never is). */
  enabled(): boolean;
}

export const DISCOVERY_REALTIME_PORT = Symbol('DISCOVERY_REALTIME_PORT');
