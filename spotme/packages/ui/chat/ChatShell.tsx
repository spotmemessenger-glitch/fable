/**
 * Chat — React message list + composer (final slice, behind spotme.ui.chat,
 * default OFF).
 *
 * Session 1: list + composer core (day dividers, ticks, typing, retry).
 * Session 2: media bubbles (photo / view-once / voice / file / location),
 * attach sheet, long-press message sheet (reply / edit / delete / react /
 * copy), reaction chips, reply composition. Prop-driven off a ChatPort;
 * nothing here fetches, stores, or routes.
 *
 * "Virtualized-enough": long threads render only the newest WINDOW rows with
 * a "Show earlier messages" reveal — the legacy view renders everything, so
 * this is strictly cheaper.
 */
import './chat.css';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatPort, MessageRowView } from './ports';
import { MediaBubble, ReactionChips } from './MediaRow';
import { AttachSheet, MessageSheet, EditSheet } from './sheets';

const WINDOW = 80;
const WINDOW_STEP = 80;
const LONG_PRESS_MS = 420;

function Ticks({ status }: { status: MessageRowView['status'] }) {
  if (status === 'failed') return null;
  const read = status === 'read';
  return (
    <span className={`ch-ticks${read ? ' ch-read' : ''}`} aria-hidden="true">
      {read ? '✓✓' : '✓'}
    </span>
  );
}

/** Swipe right past this many px to compose a reply (legacy gesture). */
const SWIPE_REPLY_PX = 56;
const SWIPE_MAX_PX = 72;

function Row({ row, port, onSheet, onReply }: {
  row: MessageRowView; port: ChatPort;
  onSheet: (row: MessageRowView) => void;
  onReply: (row: MessageRowView) => void;
}) {
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const swipe = useRef({ x: 0, y: 0, dx: 0 });
  if (row.kind === 'system') {
    return <div className="ch-sys" role="note">{row.text}</div>;
  }
  const cancelPress = () => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
  };
  const endSwipe = () => {
    const { dx } = swipe.current;
    if (bubbleRef.current) bubbleRef.current.style.transform = '';
    swipe.current = { x: 0, y: 0, dx: 0 };
    if (dx >= SWIPE_REPLY_PX) onReply(row);
  };
  return (
    <div className={`ch-row${row.mine ? ' ch-mine' : ''}`}>
      <div
        ref={bubbleRef}
        className="ch-bubble"
        onContextMenu={(e) => { e.preventDefault(); onSheet(row); }}
        onDoubleClick={() => port.react(row.id, '❤️')}
        onTouchStart={(e) => {
          swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0 };
          pressTimer.current = setTimeout(() => onSheet(row), LONG_PRESS_MS);
        }}
        onTouchEnd={() => { cancelPress(); endSwipe(); }}
        onTouchMove={(e) => {
          cancelPress();
          const dx = e.touches[0].clientX - swipe.current.x;
          const dy = Math.abs(e.touches[0].clientY - swipe.current.y);
          swipe.current.dx = dy > 40 ? 0 : Math.max(0, Math.min(dx, SWIPE_MAX_PX));
          if (bubbleRef.current) {
            bubbleRef.current.style.transform =
              swipe.current.dx > 0 ? `translateX(${swipe.current.dx}px)` : '';
          }
        }}
        onTouchCancel={() => { cancelPress(); endSwipe(); }}
      >
        {row.showName && !row.mine && <b className="ch-name">{row.name}</b>}
        {row.replyPreview && (
          <div className="ch-quote">
            <b>{row.replyPreview.name}</b>
            <span>{row.replyPreview.text}</span>
          </div>
        )}
        {row.kind === 'media' && row.media
          ? <MediaBubble row={row} media={row.media} port={port} />
          : <span className={row.kind === 'stub' ? 'ch-stub' : 'ch-text'}>{row.text}</span>}
        {row.translation && (
          <div className={`ch-trline${row.translation.pending ? ' ch-pend' : ''}`}>
            <i className="ch-trtag">{row.translation.tag}</i>
            <span className="ch-trtxt">{row.translation.text}</span>
          </div>
        )}
        <span className="ch-meta">
          {row.edited && <i className="ch-edited">edited</i>}
          <time>{row.timeLabel}</time>
          {row.mine && <Ticks status={row.status} />}
        </span>
      </div>
      <ReactionChips chips={row.reactions} />
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
  const [reply, setReply] = useState<MessageRowView | null>(null);
  const [sheetRow, setSheetRow] = useState<MessageRowView | null>(null);
  const [editRow, setEditRow] = useState<MessageRowView | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const typingRef = useRef(false);

  const rows = snap.rows;
  const comp = snap.composer;
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
    port.sendText(text, reply?.id);
    setDraft('');
    setReply(null);
    setTyping(false);
  };

  /** Quote-bar snippet — the media label for media rows, the text otherwise
   *  (legacy kindLabel grammar arrives pre-rendered in row.text). */
  const replySnippet = (r: MessageRowView) => r.text || (r.media ? 'Message' : '');

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
        {comp && (
          <div className="ch-langbar">
            <button type="button" className="ch-langsw" data-on={String(comp.translitOn)}
              aria-pressed={comp.translitOn}
              aria-label={comp.translitOn ? 'Transliteration · on' : 'Transliteration'}
              title={comp.translitOn ? 'Transliteration · on' : 'Transliteration'}
              onClick={() => port.toggleTranslit?.()}>文A</button>
            {comp.translitOn && (
              <button type="button" className="ch-langchip" aria-label="Language you type in"
                onClick={() => port.pickTranslitLang?.()}>{comp.translitLangLabel} ▾</button>
            )}
            <button type="button" className="ch-langsw" data-on={String(comp.translateOn)}
              aria-pressed={comp.translateOn}
              aria-label={comp.translateOn ? `Translation · ${comp.translateLangLabel}` : 'Translation'}
              title={comp.translateOn ? `Translation · ${comp.translateLangLabel}` : 'Translation'}
              onClick={() => port.toggleTranslate?.()}>🌐</button>
            {comp.translateOn && (
              <button type="button" className="ch-langchip" aria-label="Translate their messages into"
                onClick={() => port.pickTranslateLang?.()}>{comp.translateLangLabel} ▾</button>
            )}
          </div>
        )}
      </header>

      <div className="ch-log" ref={logRef} role="log" aria-label="Messages">
        {snap.security && (
          <>
            <div className="ch-sys ch-sec" role="note">
              {snap.security.sysText}
              {snap.security.canVerify && (
                <button type="button" className="ch-verify" onClick={() => port.openVerify?.()}>
                  Verify
                </button>
              )}
            </div>
            {snap.security.warnText && (
              <div className="ch-sys ch-warn" role="alert">{snap.security.warnText}</div>
            )}
          </>
        )}
        {hidden > 0 && (
          <button type="button" className="ch-earlier" onClick={() => setShown((n) => n + WINDOW_STEP)}>
            Show earlier messages ({hidden})
          </button>
        )}
        {groups.map((g) => (
          <section key={g.key}>
            <div className="ch-day"><span>{g.label}</span></div>
            {g.rows.map((row) => (
              <Row key={row.id} row={row} port={port} onSheet={setSheetRow} onReply={setReply} />
            ))}
          </section>
        ))}
        {snap.typingLabel && <div className="ch-typing" aria-live="polite">{snap.typingLabel}</div>}
      </div>

      {reply && (
        <div className="ch-replybar">
          <div className="ch-replybar-body">
            <b>{reply.mine ? 'You' : reply.name}</b>
            <span>{replySnippet(reply)}</span>
          </div>
          <button type="button" className="ch-replybar-x" aria-label="Cancel reply"
            onClick={() => setReply(null)}>×</button>
        </div>
      )}

      {comp?.preview && (
        <div className="ch-tlprev">
          <div className="ch-tltag">{comp.preview.tag}</div>
          <div className="ch-tlmain">{comp.preview.main}</div>
          {comp.preview.sub && <div className="ch-tlsub">{comp.preview.sub}</div>}
        </div>
      )}

      <footer className="ch-compose">
        <button type="button" className="ch-attach" aria-label="Attach"
          onClick={() => setAttachOpen(true)}>＋</button>
        {snap.recordingLabel ? (
          <button type="button" className="ch-rec" aria-label="Stop recording"
            onClick={() => port.toggleVoiceRecord()}>
            ● {snap.recordingLabel} — tap to send
          </button>
        ) : (
          <input
            type="text"
            className="ch-input"
            placeholder="Message"
            aria-label="Message"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setTyping(Boolean(e.target.value.trim()));
              port.draftChanged?.(e.target.value.trim());
            }}
            onBlur={() => setTyping(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
        )}
        <button type="button" className="ch-send" aria-label="Send"
          disabled={!draft.trim() || Boolean(snap.recordingLabel)} onClick={send}>
          ➤
        </button>
      </footer>

      {attachOpen && <AttachSheet port={port} onClose={() => setAttachOpen(false)} />}
      {sheetRow && (
        <MessageSheet
          row={sheetRow}
          port={port}
          onReply={setReply}
          onEdit={setEditRow}
          onClose={() => setSheetRow(null)}
        />
      )}
      {editRow && <EditSheet row={editRow} port={port} onClose={() => setEditRow(null)} />}
    </div>
  );
}
