/**
 * Chat components — parity with views/chat.js and chat.css, not a redesign.
 * Class names are the LEGACY ones (.msg/.bubIn/.src/.tr/.readRow/.day/.sys…)
 * so the locked chat.css styles both trees identically. Tokens only — no hex.
 *
 * Split-bubble (design system §7, product signature): the incoming bubble has
 * TWO PERMANENTLY VISIBLE sections — .src (the original, exactly as sent) and
 * .tr (.trTag + .trTxt, the translation). NEVER a toggle: translation is an
 * annotation on the message, not a replacement of it.
 *
 * Status is Sent + Read ONLY (design system §8): no "Delivered" tier the
 * transport cannot prove; a failed transfer is a red warning row with Retry.
 */

import { useEffect, useState } from 'react';
import type { Translation } from './controller';
import type { ChatMessage, IdentityState, TranslitHint } from './ports';

/* ------------------------------------------------------------ time (parity
 * with lib/ui.js fmtTime/fmtDay — pure formatting, not engine logic) */
export const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const fmtDay = (ts: number) => {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

/* ------------------------------------------------------------ icons (the
 * legacy check ticks, verbatim paths from chat.js IC) */
const Check1 = () => (
  <svg viewBox="0 0 20 12" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6.5l3.4 3.4L14 3.3" />
  </svg>
);
const Check2 = () => (
  <svg viewBox="0 0 20 12" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1 6.5l3.4 3.4L11 3" />
    <path d="M7.5 9.9L14 3" />
  </svg>
);

/* ------------------------------------------------------------ read row */
export function ReadRow({
  m,
  status,
  onRetry,
}: {
  m: ChatMessage;
  status: 'failed' | 'read' | 'sent';
  onRetry: (m: ChatMessage) => void;
}) {
  if (status === 'failed') {
    const retryable = !m.kind || m.kind === 'text' || Boolean(m.data);
    return (
      <div className="readRow failed">
        <Check1 />
        Not delivered
        {retryable ? (
          <button
            className="retryTx"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRetry(m);
            }}
          >
            Retry
          </button>
        ) : null}
      </div>
    );
  }
  const read = status === 'read';
  return (
    <div className={read ? 'readRow read' : 'readRow'}>
      {read ? <Check2 /> : <Check1 />}
      {read ? 'Read' : 'Sent'}
    </div>
  );
}

/* ------------------------------------------------------------ countdown */
/** Disappearing-message chip: a live ⏱ m:ss countdown, never raw minutes. */
export function TtlCountdown({ m, now }: { m: ChatMessage; now: () => number }) {
  const deadline = m.ts + (m.ttl || 0) * 1000;
  const left = () => Math.max(0, Math.ceil((deadline - now()) / 1000));
  const [secs, setSecs] = useState(left);
  useEffect(() => {
    const iv = setInterval(() => {
      const l = left();
      setSecs(l);
      if (l <= 0) clearInterval(iv);
    }, 1000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id]);
  return (
    <span className="ttlcount">
      ⏱ {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
    </span>
  );
}

/* ------------------------------------------------------------ bubble */
export function MessageBubble({
  m,
  mine,
  status,
  translation,
  isGroup,
  now,
  onRetry,
}: {
  m: ChatMessage;
  mine: boolean;
  status: 'failed' | 'read' | 'sent';
  translation: Translation | null;
  isGroup?: boolean;
  now: () => number;
  onRetry: (m: ChatMessage) => void;
}) {
  if (m.kind === 'system') {
    return (
      <div className="sys sysline" data-id={m.id}>
        {m.text || ''}
      </div>
    );
  }

  const bubble = mine ? (
    <div className="bubOut">
      {m.text}
      {m.ttl ? <TtlCountdown m={m} now={now} /> : null}
    </div>
  ) : (
    <div className="bubIn">
      {/* THE SPLIT BUBBLE: original always visible on top… */}
      <div className="src">{m.text}</div>
      {/* …translation as a second permanent section beneath it. */}
      {translation ? (
        <div className="tr">
          <div className="trTag">
            {translation === 'pending' ? 'Translating…' : 'Translated'}
          </div>
          <div className="trTxt">{translation === 'pending' ? '…' : translation.text}</div>
        </div>
      ) : null}
      <div className="meta">
        {m.starred ? <span className="starmark">★</span> : null}
        {m.editedAt ? <span className="edited">edited</span> : null}
        {fmtTime(m.ts)}
      </div>
      {m.ttl ? <TtlCountdown m={m} now={now} /> : null}
    </div>
  );

  return (
    <div className={mine ? 'msg mine' : 'msg'} data-id={m.id}>
      {!mine && isGroup ? <div className="sender">{m.name || 'Unknown'}</div> : null}
      {mine ? (
        <div className="rowOut">
          <span className="tOut">
            {m.starred ? <span className="starmark">★</span> : null}
            {m.editedAt ? <span className="edited">edited</span> : null}
            {fmtTime(m.ts)}
          </span>
          {bubble}
        </div>
      ) : (
        <div className="rowIn">{bubble}</div>
      )}
      {mine ? <ReadRow m={m} status={status} onRetry={onRetry} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------ banner */
/** identityStatus()-driven warning. Only 'ephemeral' and 'unavailable' warn
 *  ('unknown' is silent — parity with keyWarning). The room-level
 *  undecryptable state outranks the device-level one. */
export function IdentityBanner({
  identity,
  undecryptable,
  peerName,
}: {
  identity: IdentityState;
  undecryptable: 'wrong-key' | 'no-key' | null;
  peerName?: string;
}) {
  if (undecryptable) {
    return (
      <div className="sys warn" role="status">
        {undecryptable === 'wrong-key'
          ? `${peerName || 'The other person'}’s security key changed — reconnecting automatically. New messages will open in a moment; you can check the connection under Verify.`
          : 'Messages are arriving but this device can’t unlock them yet. Check your connection and reopen the chat — it often clears on its own.'}
      </div>
    );
  }
  if (identity !== 'ephemeral' && identity !== 'unavailable') return null;
  return (
    <div className="sys warn" role="status">
      {identity === 'ephemeral'
        ? 'This device can’t save its encryption key, so the other person can’t read what you send here. Reloading won’t fix it.'
        : 'This device can’t store encryption keys at all — private browsing is the usual cause. Open Spot Me in a normal window.'}
    </div>
  );
}

/* ------------------------------------------------------------ composer */
export function Composer({
  draft,
  hint,
  onDraft,
  onSend,
}: {
  draft: string;
  hint: TranslitHint | null;
  onDraft: (v: string) => void;
  onSend: () => void;
}) {
  return (
    <div className="composer">
      {hint ? (
        <div className="tlprev">
          <div className="tlTag2">{hint.tag}</div>
          <div className="tlMain">{hint.text}</div>
        </div>
      ) : null}
      <div className="bar">
        <div className="field">
          <input
            type="text"
            placeholder="Type a message…"
            autoComplete="off"
            aria-label="Message"
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSend();
            }}
          />
        </div>
        <button className="micB" type="button" aria-label="Send" onClick={onSend} disabled={!draft.trim()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 2L11 13" />
            <path d="M22 2l-7 20-4-9-9-4z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ thread list */
export interface ThreadRowData {
  roomId: string;
  title: string;
  preview?: string;
  ts?: number;
  unread?: number;
}
export function ThreadList({
  threads,
  onOpen,
}: {
  threads: ThreadRowData[];
  onOpen: (roomId: string) => void;
}) {
  return (
    <div className="chatlist">
      {threads.map((t) => (
        <button key={t.roomId} className="chatrow" type="button" aria-label={t.title} onClick={() => onOpen(t.roomId)}>
          <span className="crMain">
            <b>{t.title}</b>
            {t.preview ? <span className="crPrev">{t.preview}</span> : null}
          </span>
          <span className="crSide">
            {t.ts ? <span className="tm">{fmtDay(t.ts)}</span> : null}
            {t.unread ? <span className="bdg">{t.unread}</span> : null}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ status line */
export function TypingStatus({
  typing,
  peers,
}: {
  typing: { name?: string; kind?: string } | null;
  peers: number;
}) {
  if (typing) {
    return (
      <span className="status typing" role="status">
        typing…
      </span>
    );
  }
  return <span className="status">{peers > 0 ? 'online' : ''}</span>;
}
