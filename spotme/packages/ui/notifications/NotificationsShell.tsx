/**
 * Notifications — React screen (slice 2, behind spotme.ui.notifications).
 *
 * Renders what the port reports: fresh-unread chats and active people nearby,
 * each section with a live count and a "See all" jump. The notifSeenTs
 * acknowledgement stays in the app-side adapter's teardown — this package
 * never writes storage (§(g) tier 3).
 */
import './notifications.css';
import { useSyncExternalStore } from 'react';
import { Disc } from '../contacts/ContactsShell';
import type { NotificationsPort } from './ports';

const BELL = 'M18.2 8.9a6.2 6.2 0 00-12.4 0c0 5.7-2.2 7.3-2.2 7.3h16.8s-2.2-1.6-2.2-7.3M13.9 19.7a2.2 2.2 0 01-3.8 0';

const cap = (n: number) => (n > 99 ? '99+' : String(n));

function SectionHead({ label, count, onSeeAll }: { label: string; count: number; onSeeAll(): void }) {
  return (
    <div className="n2-head">
      <span className="n2-chip">
        {label}
        <span className="n2-ct">{cap(count)}</span>
      </span>
      <button type="button" className="n2-all" onClick={onSeeAll}>See all ›</button>
    </div>
  );
}

export function NotificationsShell({ port }: { port: NotificationsPort }) {
  const snap = useSyncExternalStore(port.subscribe, port.snapshot, port.snapshot);
  const empty = snap.chats.length === 0 && snap.nearby.length === 0;

  return (
    <div className="n2-screen">
      <h1 className="n2-h1">Notifications</h1>
      <div className="n2-body">
        {snap.enablePrompt && (
          <button type="button" className="n2-enable" onClick={() => { void port.enableAlerts(); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={BELL} /></svg>
            <span className="n2-ew">
              <b>Turn on device notifications</b>
              <span>New messages and people nearby — alerted even from a background tab.</span>
            </span>
          </button>
        )}

        {empty ? (
          <div className="n2-empty">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={BELL} /></svg>
            <b>You are all caught up</b>
            <span>Fresh messages and active people nearby land here the moment they arrive.</span>
          </div>
        ) : (
          <>
            {snap.chats.length > 0 && (
              <section className="n2-sec" aria-label="New chats">
                <SectionHead label="New chats" count={snap.chats.length} onSeeAll={port.seeAllChats} />
                {snap.chats.map((chat) => (
                  <button key={chat.roomId} type="button" className="n2-chat"
                    onClick={() => port.openThread(chat.roomId)}>
                    <Disc name={chat.name} url={chat.avatarUrl} size={46} online={chat.online} />
                    <span className="n2-w">
                      <span className="n2-l1">
                        <b>{chat.name}</b>
                        {chat.demo && <span className="n2-demo">demo</span>}
                        <span className="n2-tm">{chat.timeLabel}</span>
                      </span>
                      <span className="n2-pv">{chat.preview}</span>
                    </span>
                    <span className="n2-bdg">{cap(chat.unread)}</span>
                  </button>
                ))}
              </section>
            )}

            {snap.nearby.length > 0 && (
              <section className="n2-sec" aria-label="Active nearby">
                <SectionHead label="Active nearby" count={snap.nearby.length} onSeeAll={port.seeAllNearby} />
                {snap.nearby.map((peer) => (
                  <div key={peer.id} className="n2-near">
                    <Disc name={peer.name} url={peer.avatarUrl} size={46} online />
                    <span className="n2-w">
                      <b>{peer.name}</b>
                      <span>{peer.awayLabel}</span>
                    </span>
                    <button type="button" className="n2-pill" onClick={() => port.sayHi(peer.id)}>
                      Say hi
                    </button>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
