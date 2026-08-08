/**
 * Chat — sheets (session 2, behind spotme.ui.chat).
 *
 * The attach sheet and the long-press message sheet (reply / edit / delete /
 * react / copy), plus the reaction picker the message sheet embeds. Every
 * item is a port callback; nothing here touches pickers, geolocation,
 * recording, clipboard or the store — that is all adapter-side.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ChatPort, MessageRowView } from './ports';

/** Same emoji sets the legacy sheet offers. */
const REACT_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🥰'];
const EMOJI_GRID = [
  '😀', '😅', '🤣', '😊', '😍', '😘',
  '🤗', '🤔', '😴', '😷', '🥳', '😎',
  '😭', '😱', '😡', '🤯', '👏', '🙌',
  '🤝', '💪', '🔥', '💯', '🎉', '✨',
];

function Backdrop({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="ch-sheet-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ch-sheet" role="dialog">{children}</div>
    </div>
  );
}

export function AttachSheet({ port, onClose }: { port: ChatPort; onClose: () => void }) {
  const tile = (label: string, icon: string, fn: () => void) => (
    <button type="button" className="ch-at-tile" aria-label={label}
      onClick={() => { onClose(); fn(); }}>
      <span className="ch-at-circ" aria-hidden="true">{icon}</span>
      <span className="ch-at-label">{label}</span>
    </button>
  );
  return (
    <Backdrop onClose={onClose}>
      <div className="ch-at-grid">
        {tile('Photos', '🖼', () => port.attachPhoto(false))}
        {tile('Private photo', '🔥', () => port.attachPhoto(true))}
        {tile('Document', '📄', () => port.attachFile())}
        {tile('Voice note', '🎙', () => port.toggleVoiceRecord())}
        {tile('Location', '📍', () => port.attachLocation())}
      </div>
    </Backdrop>
  );
}

export function MessageSheet({ row, port, onReply, onEdit, onClose }: {
  row: MessageRowView;
  port: ChatPort;
  onReply: (row: MessageRowView) => void;
  onEdit: (row: MessageRowView) => void;
  onClose: () => void;
}) {
  const [gridOpen, setGridOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const sendReact = (emoji: string) => { port.react(row.id, emoji); onClose(); };
  const item = (label: string, fn: () => void, cls = '') => (
    <button type="button" className={`ch-ms-item${cls}`} onClick={fn}>{label}</button>
  );

  if (confirmDelete) {
    return (
      <Backdrop onClose={onClose}>
        <div className="ch-ms-title">Delete message?</div>
        {item('Delete for me', () => { port.deleteMessage(row.id, false); onClose(); }, ' danger')}
        {row.mine &&
          item('Delete for everyone', () => { port.deleteMessage(row.id, true); onClose(); }, ' danger')}
        {item('Cancel', onClose, ' cancel')}
      </Backdrop>
    );
  }

  return (
    <Backdrop onClose={onClose}>
      <div className="ch-ms-emojis">
        {REACT_EMOJI.map((e) => (
          <button key={e} type="button" aria-label={`React ${e}`} onClick={() => sendReact(e)}>{e}</button>
        ))}
        <button type="button" className="ch-plus" aria-label="More reactions"
          onClick={() => setGridOpen((v) => !v)}>+</button>
      </div>
      {gridOpen && (
        <div className="ch-ms-grid">
          {EMOJI_GRID.map((e) => (
            <button key={e} type="button" aria-label={`React ${e}`} onClick={() => sendReact(e)}>{e}</button>
          ))}
        </div>
      )}
      {item('Reply', () => { onClose(); onReply(row); })}
      {/* Session 3 — Forward stays inside Spot Me; Share hands it to the OS
          sheet. Both are adapter callbacks, gated exactly as legacy: never
          view-once/burst (canForward arrives pre-decided). */}
      {row.canForward === true && port.forward &&
        item('Forward', () => { onClose(); port.forward?.(row.id); })}
      {row.canForward === true && port.share &&
        item('Share…', () => { onClose(); port.share?.(row.id); })}
      {row.canEdit && item('Edit', () => { onClose(); onEdit(row); })}
      {row.copyText !== null &&
        item('Copy', () => { onClose(); port.copy(row.copyText as string); })}
      {item('Delete', () => setConfirmDelete(true), ' danger')}
      {item('Cancel', onClose, ' cancel')}
    </Backdrop>
  );
}

export function EditSheet({ row, port, onClose }: {
  row: MessageRowView; port: ChatPort; onClose: () => void;
}) {
  const [text, setText] = useState(row.text);
  const save = () => {
    const t = text.trim();
    if (t && t !== row.text) port.editText(row.id, t);
    onClose();
  };
  return (
    <Backdrop onClose={onClose}>
      <div className="ch-ms-title">Edit message</div>
      <textarea className="ch-edit-in" rows={3} maxLength={2000} aria-label="Edit message"
        value={text} onChange={(e) => setText(e.target.value)} />
      <button type="button" className="ch-ms-item" onClick={save}>Save</button>
      <button type="button" className="ch-ms-item cancel" onClick={onClose}>Cancel</button>
    </Backdrop>
  );
}
