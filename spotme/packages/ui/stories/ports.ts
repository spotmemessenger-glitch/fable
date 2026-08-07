/**
 * Stories — ports (slice 2). Display-ready rows; actions wired by the app.
 */

export interface StoryRingView {
  id: string;
  name: string;
  avatarUrl: string | null;
  /** Unseen rings render inked (the first N by design). */
  seen: boolean;
}

export interface StoriesSnapshot {
  me: { name: string; avatarUrl: string | null };
  people: StoryRingView[];
}

export interface StoriesPort {
  subscribe(fn: () => void): () => void;
  snapshot(): StoriesSnapshot;
  openProfile(): void;
  openChats(): void;
  /** Posting is honest about needing the native app — the adapter toasts. */
  myStory(): void;
  openPerson(id: string): void;
}

/** Fixture port for tests. */
export function fixtureStoriesPort(over: Partial<StoriesSnapshot> = {}): StoriesPort & { calls: string[] } {
  const snap: StoriesSnapshot = {
    me: { name: 'Me', avatarUrl: null },
    people: [
      { id: 'c1', name: 'Asha', avatarUrl: null, seen: false },
      { id: 'c2', name: 'Ben', avatarUrl: null, seen: true },
    ],
    ...over,
  };
  const calls: string[] = [];
  return {
    calls,
    subscribe: () => () => {},
    snapshot: () => snap,
    openProfile: () => calls.push('profile'),
    openChats: () => calls.push('chats'),
    myStory: () => calls.push('my-story'),
    openPerson: (id) => calls.push(`person:${id}`),
  };
}
