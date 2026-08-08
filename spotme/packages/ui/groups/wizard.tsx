/**
 * Three-step group creation, in WhatsApp's order — people first, then the
 * name, then visibility (the one choice that decides whether the server can
 * read the group). Mirrors views/group-new.js; the server rules it restates
 * (min members, handle regex) are copied from there, not invented.
 */
import { useEffect, useRef, useState } from 'react';
import { Avatar } from './list';
import type { CreateGroupInput, PeoplePort, PersonView } from './ports';

const NAME_MAX = 40;
/** The server refuses fewer (CreateGroupDto @ArrayMinSize(2)). */
export const MIN_MEMBERS = 2;
const CHECK_DEBOUNCE_MS = 400;
const USERNAME_RE = /^[a-z0-9_]{3,16}$/;

export interface WizardProps {
  people: PeoplePort;
  checkUsername(u: string): Promise<{ available: boolean; reason?: string }>;
  busy: boolean;
  onCreate(input: CreateGroupInput): void;
  onClose(): void;
}

/** Contacts-or-search picker, the React sibling of views/member-picker.js. */
function MemberPicker({ people, selected, exclude, onToggle }: {
  people: PeoplePort;
  selected: Map<string, PersonView>;
  exclude?: Set<string>;
  onToggle(p: PersonView): void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PersonView[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    clearTimeout(timer.current);
    const needle = q.trim();
    if (!needle) { setResults([]); return; }
    timer.current = setTimeout(() => {
      people.search(needle).then((r) => setResults(r)).catch(() => setResults([]));
    }, CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer.current);
  }, [q, people]);

  const shown = results.filter((r) => !exclude?.has(r.id));
  return (
    <div className="g-picker">
      <input
        type="text"
        className="g-input"
        placeholder="Find people by name or @username"
        aria-label="Find people"
        autoComplete="off"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {selected.size > 0 && (
        <div className="g-chips">
          {[...selected.values()].map((p) => (
            <button key={p.id} type="button" className="g-chip" onClick={() => onToggle(p)}>
              {p.name || `@${p.username}`} ×
            </button>
          ))}
        </div>
      )}
      <div className="g-picker-list">
        {shown.map((p) => (
          <button
            key={p.id}
            type="button"
            className={'g-person' + (selected.has(p.id) ? ' on' : '')}
            onClick={() => onToggle(p)}
          >
            <Avatar name={p.name || p.username || '?'} size={36} />
            <span className="g-nm">{p.name || `@${p.username}`}</span>
            {p.username ? <span className="g-pv">@{p.username}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Toggle({ label, note, on, onFlip }: {
  label: string; note?: string; on: boolean; onFlip(): void;
}) {
  return (
    <button type="button" role="switch" aria-checked={on} className={'g-toggle' + (on ? ' on' : '')} onClick={onFlip}>
      <span className="g-toggle-text">
        <span className="g-toggle-nm">{label}</span>
        {note ? <span className="g-toggle-note">{note}</span> : null}
      </span>
      <span className="g-switch" aria-hidden="true" />
    </button>
  );
}

export function GroupWizard({ people, checkUsername, busy, onCreate, onClose }: WizardProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [members, setMembers] = useState<Map<string, PersonView>>(new Map());
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'PRIVATE' | 'PUBLIC'>('PRIVATE');
  const [username, setUsername] = useState('');
  const [usernameOk, setUsernameOk] = useState(false);
  const [status, setStatus] = useState('');
  const [toggles, setToggles] = useState({ membersCanAdd: true, membersCanMessage: true, membersCanMedia: true });
  const [nameError, setNameError] = useState('');
  const checkTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const toggleMember = (p: PersonView) => {
    const next = new Map(members);
    if (next.has(p.id)) next.delete(p.id); else next.set(p.id, p);
    setMembers(next);
  };

  const onHandle = (raw: string) => {
    const value = raw.trim().toLowerCase();
    setUsername(value);
    setUsernameOk(false);
    clearTimeout(checkTimer.current);
    if (!USERNAME_RE.test(value)) { setStatus(value ? '3-16 characters: a-z, 0-9, _' : ''); return; }
    setStatus('Checking…');
    checkTimer.current = setTimeout(async () => {
      try {
        const { available, reason } = await checkUsername(value);
        setUsernameOk(Boolean(available));
        setStatus(available ? `@${value} is free` : reason || `@${value} is taken`);
      } catch {
        setStatus('Could not check that handle');
      }
    }, CHECK_DEBOUNCE_MS);
  };

  const create = () => {
    if (busy) return;
    if (visibility === 'PUBLIC' && !usernameOk) { setStatus('Pick an available @username first'); return; }
    onCreate({
      name: name.trim(),
      memberIds: [...members.keys()],
      visibility,
      ...(visibility === 'PUBLIC' ? { username } : {}),
      ...toggles,
    });
  };

  const isPublic = visibility === 'PUBLIC';
  const who = [...members.values()].map((p) => p.name || `@${p.username}`).join(', ');

  return (
    <div className="g-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="g-sheet" role="dialog" aria-label="New group">
        {step === 1 && (
          <div className="g-step">
            <div className="g-title">Add members</div>
            <p className="g-hint">Step 1 of 3 — pick at least {MIN_MEMBERS} people.</p>
            <MemberPicker people={people} selected={members} onToggle={toggleMember} />
            <div className="g-actions">
              <button type="button" className="g-cancel" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="g-pill g-ok"
                disabled={members.size < MIN_MEMBERS}
                onClick={() => setStep(2)}
              >
                {members.size < MIN_MEMBERS ? `Add ${MIN_MEMBERS - members.size} more` : `Next · ${members.size}`}
              </button>
            </div>
          </div>
        )}
        {step === 2 && (
          <div className="g-step">
            <div className="g-title">Name this group</div>
            <p className="g-hint">Step 2 of 3 — {members.size} members: {who}</p>
            <input
              type="text"
              className="g-input"
              maxLength={NAME_MAX}
              placeholder="Group name"
              aria-label="Group name"
              autoComplete="off"
              value={name}
              onChange={(e) => { setName(e.target.value); setNameError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) setStep(3); }}
            />
            {nameError ? <p className="g-hint g-err">{nameError}</p> : null}
            <div className="g-actions">
              <button type="button" className="g-cancel" onClick={() => setStep(1)}>Back</button>
              <button
                type="button"
                className="g-pill g-ok"
                onClick={() => (name.trim() ? setStep(3) : setNameError('Give the group a name first'))}
              >Next</button>
            </div>
          </div>
        )}
        {step === 3 && (
          <div className="g-step">
            <div className="g-title">{name}</div>
            <p className="g-hint">Step 3 of 3 — who can get in?</p>
            <div className="g-seg" role="radiogroup" aria-label="Visibility">
              <button type="button" role="radio" aria-checked={!isPublic} className={'g-seg-b' + (isPublic ? '' : ' on')} onClick={() => setVisibility('PRIVATE')}>Private</button>
              <button type="button" role="radio" aria-checked={isPublic} className={'g-seg-b' + (isPublic ? ' on' : '')} onClick={() => setVisibility('PUBLIC')}>Public</button>
            </div>
            <p className="g-note">
              {isPublic
                ? 'Anyone can find and join with the @handle. The server holds the key, so it can read this group.'
                : 'Invite-link only. The key never leaves your devices — the server cannot read this group.'}
            </p>
            {isPublic && (
              <>
                <input
                  type="text"
                  className="g-input"
                  maxLength={16}
                  placeholder="group_handle"
                  aria-label="Group handle"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={username}
                  onChange={(e) => onHandle(e.target.value)}
                />
                <p className="g-hint" aria-live="polite">{status}</p>
              </>
            )}
            <div className="g-sec">Members can</div>
            <Toggle label="Add people" on={toggles.membersCanAdd} onFlip={() => setToggles({ ...toggles, membersCanAdd: !toggles.membersCanAdd })} />
            <Toggle label="Send messages" note="Off makes it announce-only" on={toggles.membersCanMessage} onFlip={() => setToggles({ ...toggles, membersCanMessage: !toggles.membersCanMessage })} />
            <Toggle label="Send photos and video" on={toggles.membersCanMedia} onFlip={() => setToggles({ ...toggles, membersCanMedia: !toggles.membersCanMedia })} />
            <div className="g-actions">
              <button type="button" className="g-cancel" onClick={() => setStep(2)}>Back</button>
              <button type="button" className="g-pill g-ok" disabled={busy} onClick={create}>
                {busy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export { MemberPicker };
