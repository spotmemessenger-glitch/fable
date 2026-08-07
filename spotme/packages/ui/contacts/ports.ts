/**
 * Contacts — ports (slice 2).
 *
 * Display-ready by construction: the app-side adapter precomputes labels and
 * booleans, so this package never sees coordinates, room secrets, or the db.
 * Actions are callbacks the adapter wires to the same lib code the legacy
 * view uses — behaviour parity comes from sharing the logic, not copying it.
 */

export interface ContactRowView {
  id: string;
  name: string;
  /** Data-URL or http avatar; null renders the initial disc. */
  avatarUrl: string | null;
  online: boolean;
  langLabel: string;
}

export interface ContactsSnapshot {
  contacts: ContactRowView[];
  /** The signed-in profile, for the header avatar. */
  me: { name: string; avatarUrl: string | null };
}

export interface ContactsPort {
  subscribe(fn: () => void): () => void;
  /** MUST return a cached object, invalidated on notify (useSyncExternalStore). */
  snapshot(): ContactsSnapshot;
  openContact(id: string): void;
  block(id: string): void;
  remove(id: string): void;
  invite(): void;
  openDiscovery(): void;
}

/** Fixture port for tests. */
export function fixtureContactsPort(over: Partial<ContactsSnapshot> = {}): ContactsPort & { calls: string[] } {
  const snap: ContactsSnapshot = {
    me: { name: 'Me', avatarUrl: null },
    contacts: [
      { id: 'c1', name: 'Asha', avatarUrl: null, online: true, langLabel: 'Hindi' },
      { id: 'c2', name: 'Ben', avatarUrl: null, online: false, langLabel: 'English' },
    ],
    ...over,
  };
  const calls: string[] = [];
  return {
    calls,
    subscribe: () => () => {},
    snapshot: () => snap,
    openContact: (id) => calls.push(`open:${id}`),
    block: (id) => calls.push(`block:${id}`),
    remove: (id) => calls.push(`remove:${id}`),
    invite: () => calls.push('invite'),
    openDiscovery: () => calls.push('discovery'),
  };
}
