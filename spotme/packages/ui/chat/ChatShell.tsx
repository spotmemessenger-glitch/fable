/**
 * Chat — React message list + composer core (final slice, session 1,
 * behind spotme.ui.chat, default OFF).
 *
 * Prop-driven off a ChatPort; nothing here fetches, stores, or routes. The
 * behaviours rendered here are the ones chat-characterization.test.js pins on
 * the legacy stack: day dividers ('Today' / fmtDay via row.dayLabel), the
 * tick line (Read / Sent / Not delivered + Retry), typing line, edited mark,
 * reply quotes. Sheets, media, voice, calls and crypto UI are later sessions.
 *
 * "Virtualized-enough": long threads render only the newest WINDOW rows with
 * a "Show earlier messages" reveal — the legacy view renders everything, so
 * this is strictly cheaper, and a real virtualizer can replace it if a
 * profile ever demands one.
 */
import './chat.css';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatPort, MessageRowView } from './ports';

const WINDOW = 80;
const WINDOW_STEP = 80;

function Ticks({ status }: { status: MessageRowView['status'] }) {
  if (status === 'failed') return null;
  const read = status === 'read';
  return (
    <span className={`ch-ticks${read ? ' ch-read' : ''}`} aria-hidden="true">
      {read ? '✓✓' : '✓'}
    </span>
  );
}

function Row({ row, port }: { row: MessageRowView; port: ChatPort }) {
  if (row.kind === 'system') {
    return <div className="ch-sys" role="note">{row.text}</div>;
  }
  return (
    <div className={`ch-row${row.mine ? ' ch-mine' : ''}`}>
      <div className="ch-bubble">
        {row.showName && !row.mine && <b className="ch-name">{row.name}</b>}
        {row.replyPreview && (
          <div className="ch-quote">
            <b>{row.replyPreview.name}</b>
            <span>{row.replyPreview.text}</span>
          </div>
        )}
        <span className={row.kind === 'stub' ? 'ch-stub' : 'ch-text'}>{row.text}</span>
        <span className="ch-meta">
          {row.edited && <i className="ch-edited">edited</i>}
          <time>{row.timeLabel}</time>
          {row.mine && <Ticks status={row.status} />}
        </span>
      </div>
      {row.mine && row.status === 'failed' && (
        <div className="ch-fail">
          Not delivered
          <button type="button" className="ch-retry" onClick={() => port.retry(row.id)}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

export function ChatShell({ port }: { port: ChatPort }) {
  const snap = useSyncExternalStore(port.subscribe, port.snapshot, port.snapshot);
  const [draft, setDraft] = useState('');
  const [shown, setShown] = useState(WINDOW);
  const logRef = useRef<HTMLDivElement>(null);
  const typingRef = useRef(false);

  const rows = snap.rows;
  const hidden = Math.max(0, rows.length - shown);
  const visible = hidden > 0 ? rows.slice(hidden) : rows;

  // The thread is on screen: receipts go out, and again as new rows land.
  useEffect(() => { port.markRead(); }, [port, rows.length]);

  // Stick to the bottom as messages arrive (legacy scrollBottom behaviour).
  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [rows.length]);

  const setTyping = (on: boolean) => {
    if (typingRef.current === on) return;
    typingRef.current = on;
    port.setTyping(on);
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    port.sendText(text);
    setDraft('');
    setTyping(false);
  };

  const groups: { key: string; label: string; rows: MessageRowView[] }[] = [];
  for (const row of visible) {
    const last = groups.at(-1);
    if (last && last.key === row.dayKey) last.rows.push(row);
    else groups.push({ key: row.dayKey, label: row.dayLabel, rows: [row] });
  }

  return (
    <div className="ch-screen">
      <header className="ch-bar">
        <button type="button" className="ch-back" aria-label="Back" onClick={port.back}>‹</button>
        {snap.header.avatarUrl
          ? <img className="ch-ava" src={snap.header.avatarUrl} alt="" />
          : <span className="ch-ava ch-ava-i" aria-hidden="true">{(snap.header.name || '?').slice(0, 1).toUpperCase()}</span>}
        <div className="ch-who">
          <b>{snap.header.name}</b>
          <span className="ch-presence">{snap.typingLabel || snap.header.presenceLabel}</span>
        </div>
      </header>

      <div className="ch-log" ref={logRef} role="log" aria-label="Messages">
        {hidden > 0 && (
          <button type="button" className="ch-earlier" onClick={() => setShown((n) => n + WINDOW_STEP)}>
            Show earlier messages ({hidden})
          </button>
        )}
        {groups.map((g) => (
          <section key={g.key}>
            <div className="ch-day"><span>{g.label}</span></div>
            {g.rows.map((row) => <Row key={row.id} row={row} port={port} />)}
          </section>
        ))}
        {snap.typingLabel && <div className="ch-typing" aria-live="polite">{snap.typingLabel}</div>}
      </div>

      <footer className="ch-compose">
        <input
          type="text"
          className="ch-input"
          placeholder="Message"
          aria-label="Message"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setTyping(Boolean(e.target.value.trim())); }}
          onBlur={() => setTyping(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button type="button" className="ch-send" aria-label="Send" disabled={!draft.trim()} onClick={send}>
          ➤
        </button>
      </footer>
    </div>
  );
}
