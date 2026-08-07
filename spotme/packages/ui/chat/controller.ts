/**
 * Chat application layer — a framework-free state machine behind ports, the
 * same shape as ExchangeController. Components render its state and call its
 * methods; NOTHING here touches the network or storage directly.
 *
 * The legacy view (views/chat.js) is one 4,732-line render() that mutates DOM
 * nodes in place. Every one of those mutations is a piece of state lifted
 * here: messages come from `conn.list()` re-snapshotted on events, read ticks
 * from `conn.readUpTo()`, typing from `conn.typing()`, the banner from
 * `identityStatus()` + the room's undecryptable flag, translations from a
 * per-message cache that mirrors applyTranslation()'s instant/async paths.
 */

import type {
  ChatConn,
  ChatConnEvent,
  ChatEnginePort,
  ChatMessage,
  ClockPort,
  IdentityState,
  TranslatePort,
  TranslitHint,
  TranslitPort,
} from './ports';

export type MessageStatus = 'failed' | 'read' | 'sent';

export type Translation =
  | 'pending'
  | { text: string | null; engine: string | null; detected?: string | null };

export interface ChatControllerDeps {
  engine: ChatEnginePort;
  roomId: string;
  selfId: string;
  clock: ClockPort;
  translate?: TranslatePort;
  translit?: TranslitPort;
  /** The language I read this chat in (convo.myLang → profile), or null. */
  readLang?: string | null;
  /** Profile autoTranslate AND the chat's translate mode — the adapter
   *  resolves both; translation only runs when this is true (parity with
   *  applyTranslation's `want`). */
  translateWanted?: boolean;
}

/** Same whitespace/punctuation flattening chat.js uses to suppress a
 *  translation that only repeats the original. */
const flatten = (t: string | null | undefined) =>
  String(t || '').replace(/[\s\p{P}]+/gu, ' ').trim().toLowerCase();

export class ChatController {
  private conn: ChatConn | null = null;
  private unsub: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private disposed = false;

  messages: ChatMessage[] = [];
  readUpTo = 0;
  peers = 0;
  typing: { name?: string; kind?: string } | null = null;
  identity: IdentityState = 'unknown';
  /** Room-level "frames won't open" flag — screen-lifetime only, exactly like
   *  the legacy view's roomUndecryptable. */
  undecryptable: 'wrong-key' | 'no-key' | null = null;

  /** message id -> translation state (mirror of trCache). */
  private trCache = new Map<string, Translation>();
  /** Composer transliteration hint for the current draft. */
  draftHint: TranslitHint | null = null;
  private draftSeq = 0;

  constructor(private readonly deps: ChatControllerDeps) {}

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  private notify() {
    for (const cb of this.listeners) cb();
  }

  open(): void {
    this.conn = this.deps.engine.ensure(this.deps.roomId);
    this.identity = this.deps.engine.identityStatus();
    if (!this.conn) return;
    this.snapshot();
    this.unsub = this.conn.on((e) => this.onEvent(e));
    this.notify();
  }

  dispose(): void {
    this.disposed = true;
    this.unsub?.();
    this.unsub = null;
    this.listeners.clear();
  }

  private snapshot() {
    if (!this.conn) return;
    this.messages = this.conn.list();
    this.readUpTo = this.conn.readUpTo();
    this.peers = this.conn.peerCount();
    this.typing = this.conn.typing();
  }

  private onEvent(e: ChatConnEvent) {
    switch (e.type) {
      case 'message':
        // A frame that opened proves the room decrypts again (legacy clears
        // roomUndecryptable on the first good message).
        this.undecryptable = null;
        this.snapshot();
        break;
      case 'undecryptable':
        this.undecryptable = e.reason === 'wrong-key' ? 'wrong-key' : 'no-key';
        break;
      case 'history':
      case 'read':
      case 'sendfailed':
      case 'edited':
      case 'deleted':
      case 'expired':
      case 'reaction':
      case 'typing':
      case 'peers':
        this.snapshot();
        break;
      default:
        return; // events Phase A does not render (calls, rx progress…)
    }
    this.notify();
  }

  /* ------------------------------------------------------------ actions */

  sendText(text: string, extra: Partial<ChatMessage> = {}): ChatMessage | null {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const m = this.deps.engine.sendMessage(this.deps.roomId, { text: raw, ...extra });
    if (m) {
      this.snapshot();
      this.notify();
    }
    return m;
  }

  /** Retry a failed send — text via retryMessage, bytes via retryAttachment,
   *  the same split buildReadRow's Retry button makes. */
  retry(m: ChatMessage): boolean {
    const ok =
      !m.kind || m.kind === 'text'
        ? this.deps.engine.retryMessage(this.deps.roomId, m.id)
        : this.deps.engine.retryAttachment(this.deps.roomId, m.id);
    if (ok) {
      this.snapshot();
      this.notify();
    }
    return ok;
  }

  /* ------------------------------------------------------------ derived */

  /** Sent + Read ONLY — no invented "Delivered" tier the transport cannot
   *  prove (design system §8, and openInfoSheet says so in the legacy view). */
  statusOf(m: ChatMessage): MessageStatus {
    if (m.failed) return 'failed';
    return this.readUpTo >= m.ts ? 'read' : 'sent';
  }

  isMine = (m: ChatMessage) => m.from === this.deps.selfId;

  /**
   * Translation for an incoming text bubble — the split-bubble's `.tr`
   * section. Mirrors applyTranslation(): instant path when the sender
   * pre-translated into my language; otherwise one async detect+translate,
   * cached per message id. Returns null when no section should render.
   */
  translationFor(m: ChatMessage): Translation | null {
    const readLang = this.deps.readLang;
    const want =
      !this.isMine(m) &&
      (!m.kind || m.kind === 'text') &&
      Boolean(m.text) &&
      Boolean(readLang) &&
      this.deps.translateWanted === true;
    if (!want) return null;

    if (!this.trCache.has(m.id)) {
      const pre = m.tr;
      if (pre && pre.lang === readLang && pre.text) {
        this.trCache.set(m.id, { text: pre.text, engine: 'instant' });
      } else if (this.deps.translate) {
        this.trCache.set(m.id, 'pending');
        this.deps.translate
          .translate(m.text!, null, readLang!)
          .then((res) => this.trCache.set(m.id, res))
          .catch(() => this.trCache.set(m.id, { text: null, engine: null }))
          .then(() => {
            if (!this.disposed) this.notify();
          });
      } else {
        return null;
      }
    }

    const cur = this.trCache.get(m.id)!;
    if (cur !== 'pending' && cur.engine === null) return null;
    // Suppress when translation only repeats the original — same rule as legacy.
    if (cur !== 'pending' && cur.text && flatten(cur.text) === flatten(m.text)) return null;
    return cur;
  }

  /** Composer hint: instant local stage now, optional remote upgrade later.
   *  A stale async answer never overwrites a newer draft (seq guard — the
   *  `input.value.trim() === raw` check, lifted to state). */
  updateDraft(raw: string): void {
    const seq = ++this.draftSeq;
    const trimmed = String(raw || '').trim();
    if (!trimmed || !this.deps.translit) {
      this.draftHint = null;
      this.notify();
      return;
    }
    this.draftHint = this.deps.translit.hint(trimmed);
    this.notify();
    this.deps.translit
      .hintRemote?.(trimmed)
      .then((better) => {
        if (this.disposed || seq !== this.draftSeq || !better) return;
        this.draftHint = better;
        this.notify();
      })
      .catch(() => {});
  }
}
