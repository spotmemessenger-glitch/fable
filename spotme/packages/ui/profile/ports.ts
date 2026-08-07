/**
 * Profile & Settings — ports (slice 4).
 *
 * Display-ready by construction: the app-side adapter precomputes labels and
 * booleans, so this package never sees the db, the network, or a media API.
 * Media operations (photo upload, crop, AI avatars, voice cloning) and every
 * confirm that uses the legacy action sheet stay in the adapter behind plain
 * callbacks — raw canvas/file/mic APIs never enter the package.
 */

export type EditableFieldKey = 'name' | 'about' | 'phone';

/** Toggle keys mirror the exact legacy settings/profile keys they flip. */
export type ToggleKey =
  | 'showOnMap' | 'appBlur'
  | 'sound' | 'vibrate'
  | 'autoTranslate' | 'translit' | 'readAloud'
  | 'demoMode';

export interface BlockedPersonView {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface LangOptionView {
  code: string;
  native: string;
  name: string;
}

export interface ProfileSnapshot {
  me: { name: string; avatarUrl: string | null };
  /** Raw editable values, for the field sheets. */
  raw: { name: string; about: string; phone: string; username: string };
  hasRecovery: boolean;
  voice: { hasVoice: boolean; createdLabel: string };
  langLabel: string;
  lastSeenLabel: string;
  notifLabel: string;
  toggles: Record<ToggleKey, boolean>;
  blocked: BlockedPersonView[];
  langs: LangOptionView[];
  selectedLang: string;
}

export type UsernameCheck = 'ok' | 'taken' | 'error';

export interface ProfilePort {
  subscribe(fn: () => void): () => void;
  /** MUST return a cached object, invalidated on notify (useSyncExternalStore). */
  snapshot(): ProfileSnapshot;

  /** Save an edited field. Returns false when rejected (e.g. empty name). */
  saveField(key: EditableFieldKey, next: string): boolean;
  copyRecovery(): void;
  copyUsername(): void;
  checkUsername(handle: string): Promise<UsernameCheck>;
  claimUsername(handle: string): Promise<UsernameCheck>;

  /** Adapter-owned flows (media / mic / legacy action sheets). */
  changePhoto(): void;
  createVoice(): void;
  deleteVoice(): void;
  openLastSeen(): void;
  askNotify(): void;
  invite(): void;
  clearAll(): void;

  setToggle(key: ToggleKey, on: boolean): void;
  setLang(code: string): void;
  unblock(id: string): void;
}

/** Fixture port for tests. */
export function fixtureProfilePort(over: Partial<ProfileSnapshot> = {}): ProfilePort & { calls: string[] } {
  const snap: ProfileSnapshot = {
    me: { name: 'Asha', avatarUrl: null },
    raw: { name: 'Asha', about: 'Hello there', phone: '', username: 'asha' },
    hasRecovery: true,
    voice: { hasVoice: false, createdLabel: '' },
    langLabel: 'हिन्दी · Hindi',
    lastSeenLabel: 'Everyone',
    notifLabel: 'Tap to allow',
    toggles: {
      showOnMap: true, appBlur: true, sound: true, vibrate: true,
      autoTranslate: false, translit: false, readAloud: false, demoMode: false,
    },
    blocked: [],
    langs: [
      { code: 'en', native: 'English', name: 'English' },
      { code: 'hi', native: 'हिन्दी', name: 'Hindi' },
    ],
    selectedLang: 'hi',
    ...over,
  };
  const calls: string[] = [];
  return {
    calls,
    subscribe: () => () => {},
    snapshot: () => snap,
    saveField: (key, next) => { calls.push(`save:${key}:${next}`); return next !== ''; },
    copyRecovery: () => calls.push('copyRecovery'),
    copyUsername: () => calls.push('copyUsername'),
    checkUsername: async (h) => { calls.push(`check:${h}`); return h === 'taken' ? 'taken' : 'ok'; },
    claimUsername: async (h) => { calls.push(`claim:${h}`); return 'ok'; },
    changePhoto: () => calls.push('changePhoto'),
    createVoice: () => calls.push('createVoice'),
    deleteVoice: () => calls.push('deleteVoice'),
    openLastSeen: () => calls.push('openLastSeen'),
    askNotify: () => calls.push('askNotify'),
    invite: () => calls.push('invite'),
    clearAll: () => calls.push('clearAll'),
    setToggle: (key, on) => calls.push(`toggle:${key}:${on}`),
    setLang: (code) => calls.push(`lang:${code}`),
    unblock: (id) => calls.push(`unblock:${id}`),
  };
}
