/**
 * Client-side ports for the Chat surface (React migration, Phase A).
 *
 * THE PORT IS THE `rooms` FACADE, NOT A NEW PROTOCOL. `apps/web/lib/rooms.js`
 * is the working messaging engine; this file wraps exactly the nine calls
 * `views/chat.js` reaches it through — ensure, get, connectAll, injectLocal,
 * sendMessage, sendAttachment, retryMessage, retryAttachment, plus
 * identityStatus() for the banner — and nothing else. Components never touch
 * a socket, storage, or crypto: the adapter in apps/web supplies the real
 * engine; tests supply the deterministic double in fixtures.ts.
 */

/** The message envelope exactly as the engine stores it (fields referenced by
 *  views/chat.js — nothing invented, nothing renamed). */
export interface ChatMessage {
  id: string;
  from: string;
  ts: number;
  /** Absent means text (legacy envelopes). */
  kind?: 'text' | 'image' | 'voice' | 'video' | 'file' | 'location' | 'system';
  text?: string;
  name?: string;
  lang?: string;
  /** Sender-side pre-translation: { lang, text } — the instant path. */
  tr?: { lang: string; text: string } | null;
  replyTo?: string;
  reactions?: { emoji: string; from: string }[];
  starred?: boolean;
  editedAt?: number;
  /** Disappearing-message timer, seconds. */
  ttl?: number;
  viewOnce?: boolean;
  burst?: number;
  data?: string | null;
  mime?: string;
  dur?: number;
  fileName?: string;
  fileSize?: number;
  lat?: number;
  lon?: number;
  live?: boolean;
  until?: number;
  detached?: boolean;
  memoryOnly?: boolean;
  delivered?: boolean;
  failed?: boolean;
  sys?: string;
  secs?: number;
}

/** Connection events as `conn.on` emits them (the subset Phase A consumes). */
export type ChatConnEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'history' }
  | { type: 'read' }
  | { type: 'sendfailed'; id: string }
  | { type: 'edited'; id: string }
  | { type: 'deleted'; id: string }
  | { type: 'expired'; id: string }
  | { type: 'reaction'; payload: { target: string } }
  | { type: 'typing' }
  | { type: 'peers'; count: number }
  | { type: 'undecryptable'; reason?: 'wrong-key' | 'no-key' };

/** The connection handle `ensure`/`get` return — a read surface plus events.
 *  (The engine's conn also carries net/store internals; the UI never sees
 *  them.) */
export interface ChatConn {
  on(cb: (e: ChatConnEvent) => void): () => void;
  list(): ChatMessage[];
  readUpTo(): number;
  peerCount(): number;
  /** Peer's typing indicator: payload while active, null when idle. */
  typing(): { name?: string; kind?: string } | null;
}

export type IdentityState = 'ok' | 'ephemeral' | 'unavailable' | 'unknown';

/** THE nine wrapped calls. Nothing else reaches the engine. */
export interface ChatEnginePort {
  ensure(roomId: string): ChatConn | null;
  get(roomId: string): ChatConn | null;
  connectAll(): void;
  injectLocal(roomId: string, message: ChatMessage): boolean;
  sendMessage(roomId: string, partial: Partial<ChatMessage>): ChatMessage | null;
  sendAttachment(
    roomId: string,
    partial: Partial<ChatMessage>,
    onProgress?: (p: number) => void,
  ): ChatMessage | null;
  retryMessage(roomId: string, id: string): boolean;
  retryAttachment(roomId: string, id: string, onProgress?: (p: number) => void): boolean;
  identityStatus(): IdentityState;
}

/** Translation behind a port — the adapter wires lib/translate.js. */
export interface TranslatePort {
  translate(
    text: string,
    from: string | null,
    to: string,
  ): Promise<{ text: string | null; engine: string | null; detected?: string | null }>;
}

/** The composer's transliteration hint. The PIPELINE lives in the adapter
 *  (spotme-core/core/translit.js + the remote upgrade) — imported there, never
 *  reimplemented here. The component renders whatever the port answers. */
export interface TranslitHint {
  tag: string;
  text: string;
}
export interface TranslitPort {
  /** Instant local stage — must be synchronous and cheap. Null = no hint. */
  hint(raw: string): TranslitHint | null;
  /** Optional async upgrade (remote). Resolves null to keep the local hint. */
  hintRemote?(raw: string): Promise<TranslitHint | null>;
}

export interface ClockPort {
  now(): number;
}

export class SystemClock implements ClockPort {
  now(): number {
    return Date.now();
  }
}
