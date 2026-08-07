/**
 * Deterministic doubles for the Chat ports — the only implementations the
 * package's own tests use. No sockets, no timers, no randomness: tests drive
 * the conn by emitting events by hand.
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

export class FixedClock implements ClockPort {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export class FixtureConn implements ChatConn {
  messages: ChatMessage[] = [];
  private read = 0;
  private peerCount_ = 0;
  private typing_: { name?: string; kind?: string } | null = null;
  private listeners = new Set<(e: ChatConnEvent) => void>();

  on(cb: (e: ChatConnEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  list(): ChatMessage[] {
    return [...this.messages].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  }
  readUpTo(): number {
    return this.read;
  }
  peerCount(): number {
    return this.peerCount_;
  }
  typing(): { name?: string; kind?: string } | null {
    return this.typing_;
  }

  /* -------------------------------------------------- test drivers */
  emit(e: ChatConnEvent): void {
    for (const cb of this.listeners) cb(e);
  }
  /** Peer message arrives: add to store then emit, like onMessage does. */
  receive(m: ChatMessage): void {
    this.messages.push(m);
    this.emit({ type: 'message', message: m });
  }
  markReadUpTo(ts: number): void {
    this.read = ts;
    this.emit({ type: 'read' });
  }
  setTyping(t: { name?: string; kind?: string } | null): void {
    this.typing_ = t;
    this.emit({ type: 'typing' });
  }
  failSend(id: string): void {
    const m = this.messages.find((x) => x.id === id);
    if (m) {
      m.failed = true;
      m.delivered = false;
    }
    this.emit({ type: 'sendfailed', id });
  }
}

export class FixtureChatEngine implements ChatEnginePort {
  readonly conns = new Map<string, FixtureConn>();
  identity: IdentityState = 'ok';
  selfId = 'me';
  private seq = 0;
  constructor(private clock: ClockPort = new FixedClock(1_700_000_000_000)) {}

  ensure(roomId: string): FixtureConn {
    let c = this.conns.get(roomId);
    if (!c) {
      c = new FixtureConn();
      this.conns.set(roomId, c);
    }
    return c;
  }
  get(roomId: string): FixtureConn | null {
    return this.conns.get(roomId) || null;
  }
  connectAll(): void {
    /* nothing to connect in a fixture */
  }
  injectLocal(roomId: string, message: ChatMessage): boolean {
    const c = this.ensure(roomId);
    if (c.messages.some((m) => m.id === message.id)) return false;
    c.messages.push(message);
    c.emit({ type: 'message', message });
    return true;
  }
  sendMessage(roomId: string, partial: Partial<ChatMessage>): ChatMessage {
    const c = this.ensure(roomId);
    const m: ChatMessage = {
      id: `fx${++this.seq}`,
      from: this.selfId,
      ts: this.clock.now(),
      kind: 'text',
      text: '',
      ...partial,
    };
    c.messages.push(m);
    return m;
  }
  sendAttachment(
    roomId: string,
    partial: Partial<ChatMessage>,
    onProgress?: (p: number) => void,
  ): ChatMessage | null {
    if (!partial?.data) return null;
    const m = this.sendMessage(roomId, partial);
    onProgress?.(1);
    return m;
  }
  retryMessage(roomId: string, id: string): boolean {
    const c = this.ensure(roomId);
    const m = c.messages.find((x) => x.id === id);
    if (!m || (m.kind && m.kind !== 'text')) return false;
    m.failed = false;
    return true;
  }
  retryAttachment(roomId: string, id: string): boolean {
    const c = this.ensure(roomId);
    const m = c.messages.find((x) => x.id === id);
    if (!m?.data || !m.kind || m.kind === 'text') return false;
    m.failed = false;
    return true;
  }
  identityStatus(): IdentityState {
    return this.identity;
  }
}

/** Deterministic translator: "hello" -> "[to] hello". Records calls. */
export class FixtureTranslate implements TranslatePort {
  calls: { text: string; to: string }[] = [];
  async translate(text: string, _from: string | null, to: string) {
    this.calls.push({ text, to });
    return { text: `[${to}] ${text}`, engine: 'fixture', detected: 'xx' };
  }
}

/** Deterministic transliterator: upper-cases as the "other script". */
export class FixtureTranslit implements TranslitPort {
  hint(raw: string): TranslitHint | null {
    if (!raw) return null;
    return { tag: '文A Transliterated', text: raw.toUpperCase() };
  }
}
