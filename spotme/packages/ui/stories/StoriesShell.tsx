/**
 * Stories — React screen (slice 2, behind spotme.ui.stories).
 *
 * Rings from contacts; posting is honest about needing the native app (the
 * adapter's myStory raises the same toast the legacy view does). Tapping a
 * person opens the existing chat with them, via the port.
 */
import './stories.css';
import { useSyncExternalStore } from 'react';
import { Disc } from '../contacts/ContactsShell';
import type { StoriesPort } from './ports';

const CHAT = 'M21 11.5a8.4 8.4 0 01-9 8.4L3 21l1.1-8.5A8.4 8.4 0 1121 11.5z';
const CAM = 'M3 8.5A1.5 1.5 0 014.5 7h2.2l1.2-2h8.2l1.2 2h2.2A1.5 1.5 0 0121 8.5v9A1.5 1.5 0 0119.5 19h-15A1.5 1.5 0 013 17.5zM12 9.6a3.4 3.4 0 100 6.8 3.4 3.4 0 000-6.8z';

export function StoriesShell({ port }: { port: StoriesPort }) {
  const snap = useSyncExternalStore(port.subscribe, port.snapshot, port.snapshot);

  return (
    <div className="s2-screen">
      <div className="s2-bar">
        <button type="button" className="s2-me" aria-label="My profile" onClick={port.openProfile}>
          <Disc name={snap.me.name} url={snap.me.avatarUrl} size={34} />
        </button>
        <span className="s2-sp" />
        <span className="s2-wm">Spot Me</span>
        <span className="s2-sp" />
        <button type="button" className="s2-chats" aria-label="Chats" onClick={port.openChats}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={CHAT} /></svg>
        </button>
      </div>

      <div className="s2-body">
        <button type="button" className="s2-myst" onClick={port.myStory}>
          <span className="s2-ring s2-add">
            <Disc name={snap.me.name} url={snap.me.avatarUrl} size={54} />
            <span className="s2-plus" aria-hidden="true">+</span>
          </span>
          <span className="s2-mw">
            <b>My story</b>
            <span>Share a photo or video for 24 hours</span>
          </span>
          <svg className="s2-cam" viewBox="0 0 24 24" aria-hidden="true"><path d={CAM} /></svg>
        </button>

        {snap.people.length === 0 ? (
          <div className="s2-empty">
            <b>No stories yet</b>
            <span>People you chat with show up here — their rings light up when they post.</span>
          </div>
        ) : (
          <>
            <div className="s2-head">Recent</div>
            <div className="s2-grid">
              {snap.people.map((person) => (
                <button key={person.id} type="button" className="s2-st"
                  data-seen={person.seen ? '1' : '0'}
                  onClick={() => port.openPerson(person.id)}>
                  <span className="s2-ring">
                    <Disc name={person.name} url={person.avatarUrl} size={62} />
                  </span>
                  <span className="s2-n">{person.name}</span>
                </button>
              ))}
            </div>
            <p className="s2-note">
              Stories are a native-app feature: posting needs background upload and 24-hour
              expiry that a web tab cannot hold. Tapping someone opens your chat with them.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
