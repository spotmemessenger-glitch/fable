/**
 * Verify — IDENTITY/PRIVACY MUTATION battery (session 4).
 *
 * A HOSTILE port tries to smuggle raw key material through the render path:
 * base64 key blobs, payload strings and identity objects riding as extra
 * snapshot fields, inside display fields, and via prototype tricks. The
 * contract under test: the shell renders EXACTLY the declared display
 * surfaces (digits, sentences, the QR data URL) — undeclared fields never
 * reach the DOM, and nothing key-shaped appears anywhere unless the adapter
 * deliberately placed it in a declared display string.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { VerifyShell } from '../verify/VerifyShell';
import { fixtureVerifyPort, type VerifySnapshot } from '../verify/ports';

afterEach(cleanup);

const RAW_KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEsmuggledRawPublicKeyMaterial==';
const RAW_PAYLOAD = 'smv2|room-1|1723100000000|smuggledPayloadBody';

function hostileSnapshot(): VerifySnapshot {
  const snap = fixtureVerifyPort().snapshot();
  // Undeclared fields a hostile adapter might attach.
  return Object.assign({}, snap, {
    publicKeyB64: RAW_KEY,
    peerKey: RAW_KEY,
    identity: { privateKey: RAW_KEY, publicKey: RAW_KEY },
    payload: RAW_PAYLOAD,
    proposedKey: RAW_KEY,
  }) as VerifySnapshot;
}

describe('verify: raw key material cannot cross the render path', () => {
  it('undeclared snapshot fields never reach the DOM', () => {
    const port = fixtureVerifyPort();
    port.setSnapshot(hostileSnapshot());
    render(<VerifyShell port={port} />);
    const html = document.body.innerHTML;
    expect(html).not.toContain(RAW_KEY);
    expect(html).not.toContain(RAW_PAYLOAD);
    expect(html).not.toContain('smuggled');
  });

  it('the DOM carries only declared display surfaces: digits, sentences, the QR URL', () => {
    const port = fixtureVerifyPort();
    render(<VerifyShell port={port} />);
    const snap = port.snapshot();
    // Digits appear verbatim, as text, nowhere else encoded.
    expect(document.querySelector('.vf-number')!.textContent).toBe(snap.digits);
    // The QR arrives ONLY as the img src, exactly the port-provided URL.
    const imgs = [...document.querySelectorAll('img')];
    expect(imgs.length).toBe(1);
    expect(imgs[0].getAttribute('src')).toBe(snap.qrUrl);
    // No hidden inputs, no data-* attributes carrying values.
    expect(document.querySelector('input')).toBeNull();
    for (const el of document.body.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames()) {
        expect(attr.startsWith('data-'), `unexpected data attribute ${attr}`).toBe(false);
      }
    }
  });

  it('a key blob hidden inside a declared string is rendered as inert TEXT, never markup', () => {
    const port = fixtureVerifyPort({
      banner: { warn: true, text: `<img src=x onerror=steal('${RAW_KEY}')>` },
    });
    render(<VerifyShell port={port} />);
    // React escapes it: exactly one img on the page — the QR — and no new nodes.
    expect(document.querySelectorAll('img').length).toBe(1);
    expect(document.querySelector('.vf-banner')!.textContent).toContain('onerror');
  });

  it('a non-data: qrUrl is still only ever an image src (no navigation surface)', () => {
    const port = fixtureVerifyPort({ qrUrl: 'javascript:alert(1)' });
    render(<VerifyShell port={port} />);
    // The shell renders no anchors at all — a poisoned URL has no click path.
    expect(document.querySelector('a')).toBeNull();
  });

  it('the shell never persists or transmits: no storage/network globals touched', () => {
    const touched: string[] = [];
    const gt = globalThis as Record<string, unknown>;
    const origFetch = gt.fetch;
    gt.fetch = () => { touched.push('fetch'); return Promise.reject(new Error('no')); };
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (...args) { touched.push('localStorage'); return setItem.apply(this, args as [string, string]); };
    try {
      const port = fixtureVerifyPort();
      port.setSnapshot(hostileSnapshot());
      render(<VerifyShell port={port} />);
    } finally {
      gt.fetch = origFetch;
      Storage.prototype.setItem = setItem;
    }
    expect(touched).toEqual([]);
  });
});
