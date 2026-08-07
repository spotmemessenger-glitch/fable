/**
 * Notifications — ports (slice 2).
 *
 * PRIVACY: the nearby row carries a precomputed `awayLabel` ("Active now ·
 * about 300 m away") and NOTHING else about position. Raw coordinates never
 * cross into this package — the adapter formats distance with the same
 * lib/discovery helpers the legacy view uses. The privacy test pins this.
 */

export interface NotifChatRow {
  roomId: string;
  name: string;
  avatarUrl: string | null;
  demo: boolean;
  online: boolean;
  unread: number;
  timeLabel: string;
  preview: string;
}

export interface NotifNearbyRow {
  id: string;
  name: string;
  avatarUrl: string | null;
  /** Approximate, preformatted. No lat/lon in this shape, ever. */
  awayLabel: string;
}

export interface NotificationsSnapshot {
  /** Show the one-tap device-alerts opt-in (permission still 'default'). */
  enablePrompt: boolean;
  chats: NotifChatRow[];
  nearby: NotifNearbyRow[];
}

export interface NotificationsPort {
  subscribe(fn: () => void): () => void;
  snapshot(): NotificationsSnapshot;
  openThread(roomId: string): void;
  sayHi(peerId: string): void;
  /** Permission + push subscription in one step, like the legacy button. */
  enableAlerts(): Promise<void>;
  seeAllChats(): void;
  seeAllNearby(): void;
}

/** Fixture port for tests. */
export function fixtureNotificationsPort(over: Partial<NotificationsSnapshot> = {}): NotificationsPort & { calls: string[] } {
  const snap: NotificationsSnapshot = {
    enablePrompt: true,
    chats: [{
      roomId: 'r1', name: 'Asha', avatarUrl: null, demo: false, online: true,
      unread: 3, timeLabel: 'Tue', preview: 'You: see you there',
    }],
    nearby: [{ id: 'p1', name: 'Ravi', avatarUrl: null, awayLabel: 'Active now · about 300 m away' }],
    ...over,
  };
  const calls: string[] = [];
  return {
    calls,
    subscribe: () => () => {},
    snapshot: () => snap,
    openThread: (id) => calls.push(`thread:${id}`),
    sayHi: (id) => calls.push(`hi:${id}`),
    enableAlerts: async () => { calls.push('enable'); },
    seeAllChats: () => calls.push('all-chats'),
    seeAllNearby: () => calls.push('all-nearby'),
  };
}
