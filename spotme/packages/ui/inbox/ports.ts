/**
 * Inbox — ports (slice 6, behind spotme.ui.inbox).
 *
 * Display-ready by construction: the app-side adapter (views/inbox-island.js)
 * pre-shapes every row — names resolved, previews composed, timestamps
 * formatted — so this package never sees the convo store, room secrets, the
 * chat engine, or the network. Realtime arrives as a subscription notify;
 * username search crosses the port as an async callback the adapter wires to
 * the registry. The package writes nothing: every mutation is a callback into
 * the same lib code the legacy view uses (rooms/db/reach), which is what keeps
 * the §(g) no-persisted-shape rule trivially true here.
 */

export type InboxTab = 'chats' | 'nearby' | 'bt';

export interface ConvoRowView {
  /** The roomId — opaque routing handle, never displayed. */
  id: string;
  name: string;
  /** Data-URL or http avatar; null renders the initial disc. */
  avatarUrl: string | null;
  /** Composed by the adapter: "You: …", "[photo]", "No messages yet". */
  preview: string;
  /** Already formatted (legacy fmtDay). */
  timeLabel: string;
  unread: number;
  online: boolean;
  archived: boolean;
  tab: InboxTab;
  /** True for group rooms — shows the group chip. */
  group: boolean;
  /** True when Block is offered (the peer has a registry id). */
  blockable: boolean;
}

export interface UserMatch {
  id: string;
  username: string;
  name: string;
  online: boolean;
}

export interface InboxSnapshot {
  rows: ConvoRowView[];
  me: { name: string; avatarUrl: string | null };
}

export interface InboxPort {
  subscribe(fn: () => void): () => void;
  /** MUST return a cached object, invalidated on notify (useSyncExternalStore). */
  snapshot(): InboxSnapshot;

  openThread(id: string): void;
  nav(path: string): void;
  toast(msg: string): void;

  setArchived(id: string, archived: boolean): void;
  deleteConvo(id: string): void;
  blockPeer(id: string): void;
  exportChat(id: string): void;
  markAllRead(): void;
  /** Creates the room and returns its id, or null on failure. */
  createGroup(name: string): string | null;

  /** Registry lookup; resolves [] on any failure — never throws. */
  searchUsers(username: string): Promise<UserMatch[]>;
  /** Existing DM with this registry id, if any. */
  existingDm(userId: string): string | null;
  /** Start a chat with the first message; returns the roomId or null. */
  startChat(match: UserMatch, text: string): string | null;
}

/** Fixture port for tests. */
export function fixtureInboxPort(rows?: ConvoRowView[]): InboxPort & { calls: string[] } {
  const row = (over: Partial<ConvoRowView>): ConvoRowView => ({
    id: 'r1', name: 'Asha', avatarUrl: null, preview: 'You: hi', timeLabel: 'Mon',
    unread: 0, online: false, archived: false, tab: 'chats', group: false,
    blockable: true, ...over,
  });
  const snap: InboxSnapshot = {
    me: { name: 'Me', avatarUrl: null },
    rows: rows ?? [
      row({ id: 'r1', name: 'Asha', unread: 2, online: true }),
      row({ id: 'r2', name: 'Ben', tab: 'nearby', preview: 'See you there' }),
      row({ id: 'r3', name: 'Old chat', archived: true, preview: 'bye' }),
      row({ id: 'r4', name: 'Hiking club', group: true, blockable: false, preview: 'Trail this weekend?' }),
    ],
  };
  const calls: string[] = [];
  return {
    calls,
    subscribe: () => () => {},
    snapshot: () => snap,
    openThread: (id) => calls.push(`open:${id}`),
    nav: (path) => calls.push(`nav:${path}`),
    toast: (msg) => calls.push(`toast:${msg}`),
    setArchived: (id, on) => calls.push(`arch:${id}:${on}`),
    deleteConvo: (id) => calls.push(`del:${id}`),
    blockPeer: (id) => calls.push(`block:${id}`),
    exportChat: (id) => calls.push(`export:${id}`),
    markAllRead: () => calls.push('markAllRead'),
    createGroup: (name) => { calls.push(`group:${name}`); return 'g-new'; },
    searchUsers: async (q) => {
      calls.push(`search:${q}`);
      return q === 'asha'
        ? [{ id: 'u1', username: 'asha', name: 'Asha', online: true }]
        : [];
    },
    existingDm: (userId) => (userId === 'u-existing' ? 'r1' : null),
    startChat: (match, text) => { calls.push(`start:${match.username}:${text}`); return 'r-new'; },
  };
}
