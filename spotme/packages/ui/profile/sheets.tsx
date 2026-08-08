/**
 * Profile bottom sheets (slice 4): field editor, username claim, language.
 * Pure UI over port callbacks — the network lives behind checkUsername /
 * claimUsername in the app-side adapter.
 */
import { useEffect, useRef, useState } from 'react';
import type { EditableFieldKey, LangOptionView, ProfilePort } from './ports';

/** Same grammar as the legacy field sheets — copy carried over verbatim. */
export const FIELD_SHEETS: Record<EditableFieldKey, {
  title: string; hint: string; max: number; placeholder: string;
  multiline?: boolean; type?: string;
}> = {
  name: {
    title: 'Your name',
    hint: 'People you chat with see this name.',
    max: 32, placeholder: 'Your name',
  },
  about: {
    title: 'About',
    hint: 'A short line shown on your profile in chats.',
    max: 120, multiline: true, placeholder: 'The magic you are looking for…',
  },
  phone: {
    title: 'Phone number',
    hint: 'Optional, and kept on this device only — Spot Me cannot verify numbers and never publishes yours.',
    max: 24, type: 'tel', placeholder: '+91 99999 99999',
  },
};

function Backdrop({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="p4-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="p4-sheet">{children}</div>
    </div>
  );
}

export function FieldSheet({ field, value, port, onClose }: {
  field: EditableFieldKey; value: string; port: ProfilePort; onClose: () => void;
}) {
  const cfg = FIELD_SHEETS[field];
  const [text, setText] = useState(value);
  const commit = () => { if (port.saveField(field, text.trim()) !== false) onClose(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !cfg.multiline) { e.preventDefault(); commit(); }
    if (e.key === 'Escape') onClose();
  };
  return (
    <Backdrop onClose={onClose}>
      <div className="p4-st">{cfg.title}</div>
      <p className="p4-hint">{cfg.hint}</p>
      <div className="p4-fld">
        {cfg.multiline
          ? <textarea className="p4-in area" rows={3} maxLength={cfg.max} placeholder={cfg.placeholder}
              value={text} autoFocus onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
          : <input className="p4-in" type={cfg.type || 'text'} maxLength={cfg.max} placeholder={cfg.placeholder}
              value={text} autoFocus onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />}
        <span className="p4-ct">{text.length}/{cfg.max}</span>
      </div>
      <div className="p4-acts">
        <button type="button" className="p4-pill ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="p4-pill ok" onClick={commit}>Save</button>
      </div>
    </Backdrop>
  );
}

const USERNAME_RE = /^[a-z0-9_]{2,}$/;
const CHECK_DEBOUNCE_MS = 350;

export function UsernameSheet({ current, port, onClose }: {
  current: string; port: ProfilePort; onClose: () => void;
}) {
  const [text, setText] = useState(current);
  const [state, setState] = useState<{ kind: 'idle' | 'wait' | 'ok' | 'bad'; text: string }>({
    kind: 'idle',
    text: current ? 'Pick a new one to change it' : 'Letters, numbers and underscore',
  });
  const seq = useRef(0);
  const handle = text.trim().replace(/^@/, '').toLowerCase();

  useEffect(() => {
    const mine = ++seq.current;
    if (handle === current) return;
    if (!USERNAME_RE.test(handle)) {
      setState({ kind: 'idle', text: 'Letters, numbers and underscore — at least 2 characters' });
      return;
    }
    const timer = setTimeout(async () => {
      setState({ kind: 'wait', text: 'Checking…' });
      const result = await port.checkUsername(handle);
      if (mine !== seq.current) return;
      if (result === 'ok') setState({ kind: 'ok', text: `@${handle} is available` });
      else if (result === 'taken') setState({ kind: 'bad', text: `@${handle} is taken` });
      else setState({ kind: 'bad', text: 'Registry unreachable — try again in a moment' });
    }, CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);

  const claim = async () => {
    if (state.kind !== 'ok') return;
    setState({ kind: 'wait', text: 'Claiming…' });
    const result = await port.claimUsername(handle);
    if (result === 'ok') onClose();
    else if (result === 'taken') setState({ kind: 'bad', text: 'Just taken — try another' });
    else setState({ kind: 'bad', text: 'Registry unreachable — try again in a moment' });
  };

  return (
    <Backdrop onClose={onClose}>
      <div className="p4-st">Username</div>
      <p className="p4-hint">Your public handle: anyone can find you by searching it, anywhere in the world.</p>
      <div className="p4-fld">
        <span className="p4-at">@</span>
        <input className="p4-in" type="text" maxLength={24} placeholder="username" autoFocus
          autoCapitalize="none" autoComplete="off" spellCheck={false}
          value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <p className="p4-state" data-k={state.kind}>{state.text}</p>
      <div className="p4-acts">
        <button type="button" className="p4-pill ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="p4-pill ok" disabled={state.kind !== 'ok'} onClick={claim}>
          {current ? 'Change' : 'Claim'}
        </button>
      </div>
    </Backdrop>
  );
}

export function LangSheet({ langs, selected, onPick, onClose }: {
  langs: LangOptionView[]; selected: string;
  onPick: (code: string) => void; onClose: () => void;
}) {
  return (
    <Backdrop onClose={onClose}>
      <div className="p4-st">Your language</div>
      <p className="p4-hint">Messages from other languages translate into this one.</p>
      <div className="p4-langs">
        {langs.map((l) => (
          <button key={l.code} type="button"
            className={'p4-lang' + (l.code === selected ? ' on' : '')}
            onClick={() => { onPick(l.code); onClose(); }}>
            <strong>{l.native}</strong>
            <span>{l.name}</span>
          </button>
        ))}
      </div>
    </Backdrop>
  );
}
