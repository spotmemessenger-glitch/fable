/**
 * Chat — ports (final slice, session 1, behind spotme.ui.chat).
 *
 * SCOPE OF SESSION 1: message list + composer core only — text send, day
 * dividers, status ticks, typing line, retry of a failed text. Sheets, media,
 * voice, calls, translation UI and every crypto-facing surface are LATER
 * sessions and have no port surface here yet.
 *
 * Display-ready by construction: the app-side adapter (views/chat-island.js)
 * pre-shapes every row — mine/theirs resolved, timestamps formatted, the
 * Read/Sent/Not delivered verdict already decided from conn.readUpTo — so
 * this package never sees the message store, room keys, the transport, or
 * the network. Realtime arrives as a subscription notify. Every mutation is
 * a callback into the same lib/rooms.js the legacy view uses (the engine is
 * REUSED, never rewritten), which is what keeps the ADR-035 §(g)
 * no-persisted-shape rule trivially true here.
 *
 * The contract these rows encode is pinned by
 * apps/web/test/chat-characterization.test.js — status derives from
 * `readUpTo >= ts` (default 'sent'), the day divider says 'Today' for today
 * and fmtDay otherwise, and a failed row reads "Not delivered" with Retry.
 */

export type MessageStatus = 'sent' | 'read' | 'failed';

export interface MessageRowView {
  /** Message id — opaque handle for retry/keying, never displayed. */
  id: string;
  mine: boolean;
  /** Session 1 renders 'text' and 'system'; other kinds arrive as a stub
   *  label ("Photo", "Voice note…") until their session lands. */
  kind: 'text' | 'system' | 'stub';
  text: string;
  /** Sender display name — shown on their rows in groups. */
  name: string;
  showName: boolean;
  /** Already formatted (legacy fmtTime). */
  timeLabel: string;
  /** Groups rows under one divider (legacy: toDateString()). */
  dayKey: string;
  /** 'Today' or the legacy fmtDay label. */
  dayLabel: string;
  /** Only meaningful on mine — the tick line. */
  status: MessageStatus;
  edited: boolean;
  /** Quoted preview when this row replies to another; null otherwise. */
  replyPreview: { name: string; text: string } | null;
}

export interface ChatSnapshot {
  header: { name: string; presenceLabel: string; avatarUrl: string | null };
  rows: MessageRowView[];
  /** "Peer is typing…" line; empty string hides it. */
  typingLabel: string;
}

export interface ChatPort {
  subscribe(fn: () => void): () => void;
  /** MUST return a cached object, invalidated on notify (useSyncExternalStore). */
  snapshot(): ChatSnapshot;

  /** Send a text draft. The adapter routes it through rooms.sendMessage. */
  sendText(text: string): void;
  /** Retry a failed text (rooms.retryMessage). */
  retry(id: string): void;
  /** The thread is visible — clear unread + send the receipt. */
  markRead(): void;
  /** Composer activity for the peer's typing indicator. */
  setTyping(on: boolean): void;

  back(): void;
  toast(msg: string): void;
}

/** Fixture port for tests. */
export function fixtureChatPort(rows?: MessageRowView[]): ChatPort & { calls: string[] } {
  const row = (over: Partial<MessageRowView>): MessageRowView => ({
    id: 'm1', mine: false, kind: 'text', text: 'hello', name: 'Asha', showName: false,
    timeLabel: '10:02', dayKey: 'today', dayLabel: 'Today', status: 'sent',
    edited: false, replyPreview: null, ...over,
  });
  let snap: ChatSnapshot = {
    header: { name: 'Asha', presenceLabel: 'Online', avatarUrl: null },
    rows: rows ?? [
      row({ id: 'm0', text: 'yesterday says hi', dayKey: 'yest', dayLabel: 'Mon' }),
      row({ id: 'm1', text: 'vanakkam' }),
      row({ id: 'm2', mine: true, text: 'hi!', status: 'read', timeLabel: '10:03' }),
      row({ id: 'm3', mine: true, text: 'still there?', status: 'sent', timeLabel: '10:04', edited: true }),
      row({ id: 'm4', mine: true, text: 'this one died', status: 'failed', timeLabel: '10:05' }),
      row({ id: 'm5', kind: 'system', text: '⏱ Timer messages on' }),
      row({
        id: 'm6', text: 'replying to you', timeLabel: '10:06',
        replyPreview: { name: 'Me', text: 'hi!' },
      }),
    ],
    typingLabel: '',
  };
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  const port = {
    calls,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    snapshot: () => snap,
    sendText: (t: string) => {
      calls.push(`send:${t}`);
      snap = {
        ...snap,
        rows: [...snap.rows, row({ id: `s${calls.length}`, mine: true, text: t, dayKey: 'today', dayLabel: 'Today' })],
      };
      for (const fn of listeners) fn();
    },
    retry: (id: string) => calls.push(`retry:${id}`),
    markRead: () => calls.push('markRead'),
    setTyping: (on: boolean) => calls.push(`typing:${on}`),
    back: () => calls.push('back'),
    toast: (m: string) => calls.push(`toast:${m}`),
  };
  return port;
}
