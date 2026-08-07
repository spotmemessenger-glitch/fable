/**
 * ChatShell — the thread view, wired to a ChatController. Same shape as
 * DiscoveryShell/ExchangeShell: the host (apps/web) constructs the controller
 * with real ports and mounts this; tests mount it over fixtures.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ChatController } from './controller';
import {
  Composer,
  IdentityBanner,
  MessageBubble,
  TypingStatus,
  fmtDay,
} from './components';

export interface ChatShellProps {
  controller: ChatController;
  header: { name: string; isGroup?: boolean };
  onBack?: () => void;
}

export function ChatShell({ controller, header, onBack }: ChatShellProps) {
  // Controller state is external; a version counter keeps renders in sync.
  const [, setTick] = useState(0);
  useEffect(() => {
    controller.open();
    const unsub = controller.subscribe(() => setTick((t) => t + 1));
    return () => {
      unsub();
      controller.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

  const [draft, setDraft] = useState('');
  const now = useMemo(() => () => Date.now(), []);

  const send = () => {
    if (controller.sendText(draft)) {
      setDraft('');
      controller.updateDraft('');
    }
  };

  // Day dividers: same grouping the legacy renderList does.
  let lastDayKey: string | null = null;

  return (
    <div className="view chatview">
      <div className="top">
        {onBack ? (
          <button className="hbtn" type="button" aria-label="Back" onClick={onBack}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        ) : null}
        <div className="who">
          <b>{header.name}</b>
          <TypingStatus typing={controller.typing} peers={controller.peers} />
        </div>
      </div>

      <div className="threadwrap">
        <div className="thread">
          <IdentityBanner
            identity={controller.identity}
            undecryptable={controller.undecryptable}
            peerName={header.name}
          />
          {controller.messages.map((m) => {
            const dayKey = new Date(m.ts).toDateString();
            const divider =
              dayKey !== lastDayKey ? (
                <div className="day" key={`day-${dayKey}`}>
                  {fmtDay(m.ts)}
                </div>
              ) : null;
            lastDayKey = dayKey;
            return (
              <span key={m.id}>
                {divider}
                <MessageBubble
                  m={m}
                  mine={controller.isMine(m)}
                  status={controller.statusOf(m)}
                  translation={controller.translationFor(m)}
                  isGroup={header.isGroup}
                  now={now}
                  onRetry={(msg) => controller.retry(msg)}
                />
              </span>
            );
          })}
        </div>
      </div>

      <Composer
        draft={draft}
        hint={controller.draftHint}
        onDraft={(v) => {
          setDraft(v);
          controller.updateDraft(v);
        }}
        onSend={send}
      />
    </div>
  );
}
