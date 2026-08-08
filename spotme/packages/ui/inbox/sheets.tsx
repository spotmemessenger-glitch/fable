/**
 * Inbox — the New chat sheet and the first-message request sheet (slice 6).
 *
 * Both are plain dialogs over the port: the sheet never fetches or persists.
 * The legacy ghost-click armour is unnecessary here — React's synthetic
 * events do not replay the opening press into the sheet.
 */
import { useRef, useState } from 'react';
import type { InboxPort, UserMatch } from './ports';
import { Disc } from './InboxShell';

const GROUP_NAME_MAX = 40;

export function NewChatSheet({ port, onClose, onArchived, onSearchFocus }: {
  port: InboxPort;
  onClose: () => void;
  onArchived: () => void;
  onSearchFocus: () => void;
}) {
  const [groupForm, setGroupForm] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const createGroup = () => {
    const name = (nameRef.current?.value ?? '').trim();
    if (!name) { port.toast('Give the group a name first'); nameRef.current?.focus(); return; }
    const roomId = port.createGroup(name);
    if (roomId === null) { port.toast('Could not create the group'); return; }
    onClose();
    port.openThread(roomId);
  };

  const item = (label: string, sub: string | null, fn: () => void) => (
    <button type="button" className="i2-ncItem" onClick={fn}>
      <b>{label}</b>
      {sub && <span>{sub}</span>}
    </button>
  );

  return (
    <div className="i2-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="i2-sheet" role="dialog" aria-label="New chat">
        <div className="i2-ncTitle">New chat</div>
        {item('New group', 'A shared room — everyone with the link is in', () => {
          setGroupForm(true);
          queueMicrotask(() => nameRef.current?.focus());
        })}
        {groupForm && (
          <div className="i2-ncGroup">
            <input
              ref={nameRef} type="text" maxLength={GROUP_NAME_MAX} placeholder="Group name"
              autoComplete="off"
              onKeyDown={(e) => { if (e.key === 'Enter') createGroup(); }}
            />
            <button type="button" className="i2-pill" onClick={createGroup}>Create</button>
          </div>
        )}
        {item('Groups', 'Create with roles, or join by @handle', () => { onClose(); port.nav('#/groups'); })}
        {item('Contacts', 'Everyone you have talked to', () => { onClose(); port.nav('#/contacts'); })}
        {item('Find people nearby', null, () => { onClose(); port.nav('#/discovery'); })}
        {item('Search by username', null, () => { onClose(); onSearchFocus(); })}
        {item('Archived chats', null, () => { onClose(); onArchived(); })}
        {item('Mark all as read', null, () => {
          port.markAllRead();
          port.toast('All caught up');
          onClose();
        })}
        <button type="button" className="i2-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Let them write the first line before the chat opens — the same rule the
 * legacy view enforces: looking someone up must never message them by itself.
 */
export function RequestSheet({ match, port, onClose }: {
  match: UserMatch;
  port: InboxPort;
  onClose: () => void;
}) {
  const [text, setText] = useState('Hi!');
  const sending = useRef(false);

  const send = () => {
    if (sending.current) return;
    sending.current = true;
    const roomId = port.startChat(match, text.trim().slice(0, 300) || 'Hi!');
    if (roomId === null) {
      sending.current = false;
      port.toast('Could not start that chat');
      return;
    }
    onClose();
    port.openThread(roomId);
  };

  const who = match.name || match.username;
  return (
    <div className="i2-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="i2-req" role="dialog" aria-label={`Start a chat with ${who}`}>
        <div className="i2-reqHead">
          <Disc name={who} url={null} size={46} />
          <div>
            <b>{who}</b>
            <span className="i2-reqUn">@{match.username}</span>
          </div>
        </div>
        <p className="i2-reqHint">This opens the chat and sends them your first message.</p>
        <input
          type="text" maxLength={300} placeholder="Say something…" value={text} autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
        />
        <div className="i2-reqBtns">
          <button type="button" className="i2-cancel" onClick={onClose}>Cancel</button>
          <button type="button" className="i2-pill" onClick={send}>Start chat</button>
        </div>
      </div>
    </div>
  );
}
