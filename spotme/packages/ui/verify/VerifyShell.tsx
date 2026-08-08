/**
 * Verify — React screen (session 4, behind spotme.ui.verify, default OFF).
 *
 * Pure rendering of a VerifyPort snapshot. The legacy screen's three rules
 * hold here structurally: (1) nothing is computed on the render path — the
 * adapter derives the safety number after mount and pushes 'loading' →
 * 'ready'; (2) the copy claims exactly what the legacy copy claims; (3) a
 * v1 room gets the honest "nothing to verify" paragraph, never a blank.
 */
import './verify.css';
import { useSyncExternalStore } from 'react';
import type { VerifyPort } from './ports';

export function VerifyShell({ port }: { port: VerifyPort }) {
  const snap = useSyncExternalStore(port.subscribe, port.snapshot, port.snapshot);
  const name = snap.peerName || 'this person';

  return (
    <div className="vf-screen">
      <header className="vf-bar">
        <button type="button" className="vf-back" aria-label="Back" onClick={port.back}>‹</button>
        <span className="vf-sp" />
      </header>
      <h1 className="vf-h1">Verify encryption</h1>
      <div className="vf-scroll">
        {snap.phase === 'loading' && (
          <p className="vf-sub" role="status">Working out this chat’s safety number…</p>
        )}
        {(snap.phase === 'missing' || snap.phase === 'unverifiable' || snap.phase === 'error') && (
          <p className={snap.phase === 'missing' ? 'vf-sub' : undefined}>{snap.message}</p>
        )}

        {snap.phase === 'ready' && (
          <>
            {snap.banner && (
              <div className={snap.banner.warn ? 'vf-banner vf-warn' : 'vf-banner vf-sub'} role="note">
                {snap.banner.text}
              </div>
            )}

            {snap.changed && (
              <>
                <div className="vf-row">
                  <button type="button" className="vf-btn" onClick={port.acceptNewKey}>
                    Accept the new key
                  </button>
                  <button type="button" className="vf-btn" onClick={port.keepOldKey}>
                    Keep the old one
                  </button>
                </div>
                <p className="vf-sub">{snap.changed.note}</p>
              </>
            )}

            <p>
              Compare these 60 digits with {name}, out loud or on another app you already
              trust. If they match on both phones, no one is sitting in the middle of this
              conversation.
            </p>
            <div className="vf-number">{snap.digits}</div>
            <p className="vf-sub">
              If they do not match, stop sending anything private and tell them on a
              different channel. A mismatch means the two phones disagree about each
              other’s keys, which is what an interceptor looks like.
            </p>

            <p className="vf-sub">
              Or scan each other’s codes — faster than reading digits, and it checks the
              same two keys.
            </p>
            {snap.qrUrl
              ? <img className="vf-qr" src={snap.qrUrl} alt="This device’s verification code" />
              : <p className="vf-sub">Could not draw this device’s code.</p>}

            <button
              type="button"
              className="vf-scan"
              disabled={!snap.scan.available || snap.scan.scanning}
              onClick={port.startScan}
            >
              Scan their code
            </button>
            {snap.scan.status && <p className="vf-sub" role="status">{snap.scan.status}</p>}
            {snap.footer && <p className="vf-sub">{snap.footer}</p>}
          </>
        )}
      </div>
    </div>
  );
}
