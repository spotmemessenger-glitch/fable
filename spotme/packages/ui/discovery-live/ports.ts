/**
 * Discovery LIVE — ports (slice 5, ADR-035).
 *
 * NOT the dark Phase-2 surface: `packages/ui/discovery/` is built against the
 * Phase-2 people-search contract (`@spotme/contracts` DiscoveryQuery /
 * DiscoveryApiPort) and stays dark and unexported. This port is pinned to
 * TODAY'S live surface — the lobby broadcast in apps/web/src/lib/discovery.js
 * — and is display-ready by construction.
 *
 * PRIVACY (ADR-024): no coordinate of any kind crosses this boundary. The
 * adapter converts positions to (a) a formatted approximate distance label,
 * (b) an approximate distance in metres for range filtering, and (c) a
 * RELATIVE offset in metres from the viewer for radar placement. All three
 * derive from the already-coarsened broadcast values (~110 m + jitter); no
 * absolute latitude or longitude exists in this package, precise or coarse.
 */

export interface DiscoveryPeerView {
  id: string;
  name: string;
  avatarUrl: string | null;
  /** Their language, human-readable — "Hindi". */
  langLabel: string;
  /** "~24 m" / "~1.2 km"; null when they withhold position. */
  distLabel: string | null;
  /** Approximate metres for the range filter; null when withheld. */
  distM: number | null;
  /** Announced age; most peers announce none. */
  age: number | null;
  tags: string[];
  /** An existing conversation — the card offers "Open chat", never Wave. */
  hasChat: boolean;
  /** Radar offset from the viewer in metres, x east+, y north+.
   *  Derived from the coarse broadcast; null when position is withheld. */
  offsetM: { x: number; y: number } | null;
}

export interface DiscoverySnapshot {
  me: { name: string; avatarUrl: string | null };
  /** My language, human-readable — the "Hindi → English" right-hand side. */
  myLangLabel: string;
  /** settings.showOnMap — the Visible/Hidden toggle state. */
  visible: boolean;
  /** False until geolocation produced a fix — shows the "Location off" chip. */
  located: boolean;
  /** Persisted range in metres (settings.rangeM). */
  rangeM: number;
  peers: DiscoveryPeerView[];
}

export interface DiscoveryLivePort {
  subscribe(fn: () => void): () => void;
  /** MUST return a cached object, invalidated on notify (useSyncExternalStore). */
  snapshot(): DiscoverySnapshot;
  /** Persist a new range (legacy key settings.rangeM, same shape). */
  setRange(m: number): void;
  /** Flip settings.showOnMap and re-announce. */
  setVisible(on: boolean): void;
  /** Re-acquire the device fix (stays device-local, ADR-024). */
  locate(): void;
  /** Open the existing conversation with this peer. */
  openChat(id: string): void;
  /** Send the wave greeting and open the new chat. */
  wave(id: string): void;
  /** Send a chat request with a first message. */
  sendRequest(id: string, text: string): void;
}

/** Fixture port for tests. */
export function fixtureDiscoveryPort(
  over: Partial<DiscoverySnapshot> = {},
): DiscoveryLivePort & { calls: string[]; notify(): void } {
  let snap: DiscoverySnapshot = {
    me: { name: 'Me', avatarUrl: null },
    myLangLabel: 'English',
    visible: true,
    located: true,
    rangeM: 100,
    peers: [
      {
        id: 'p1', name: 'Asha', avatarUrl: null, langLabel: 'Hindi',
        distLabel: '~24 m', distM: 24, age: null, tags: ['music'],
        hasChat: false, offsetM: { x: 20, y: -12 },
      },
      {
        id: 'p2', name: 'Ben', avatarUrl: null, langLabel: 'French',
        distLabel: '~80 m', distM: 80, age: 27, tags: [],
        hasChat: true, offsetM: { x: -50, y: 60 },
      },
      {
        id: 'p3', name: 'Chi', avatarUrl: null, langLabel: 'Mandarin',
        distLabel: null, distM: null, age: null, tags: [],
        hasChat: false, offsetM: null,
      },
    ],
    ...over,
  };
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  return {
    calls,
    notify() { listeners.forEach((fn) => fn()); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    snapshot: () => snap,
    setRange(m) { calls.push(`range:${m}`); snap = { ...snap, rangeM: m }; listeners.forEach((fn) => fn()); },
    setVisible(on) { calls.push(`visible:${on}`); snap = { ...snap, visible: on }; listeners.forEach((fn) => fn()); },
    locate: () => calls.push('locate'),
    openChat: (id) => calls.push(`open:${id}`),
    wave: (id) => calls.push(`wave:${id}`),
    sendRequest: (id, text) => calls.push(`request:${id}:${text}`),
  };
}
