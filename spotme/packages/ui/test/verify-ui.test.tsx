/**
 * Verify (final slice, session 4) — the verify screen as pure rendering.
 * Asserts every phase of the legacy views/verify.js contract: loading before
 * derivation, honest v1 copy, digits + QR + scan on ready, the CHANGED-key
 * accept/keep decision, and that every action crosses the port.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { VerifyShell } from '../verify/VerifyShell';
import { fixtureVerifyPort } from '../verify/ports';

afterEach(cleanup);

describe('verify shell — phases', () => {
  it('loading shows the spinner line, never digits', () => {
    render(<VerifyShell port={fixtureVerifyPort({ phase: 'loading', digits: '' })} />);
    expect(screen.getByText(/Working out this chat’s safety number/)).toBeTruthy();
    expect(document.querySelector('.vf-number')).toBeNull();
  });

  it('an e2e_v1 room gets the honest "nothing to verify" copy, never a blank', () => {
    render(<VerifyShell port={fixtureVerifyPort({
      phase: 'unverifiable',
      message: 'There is nothing to verify for this chat. Start a new chat with Asha to get one that can be verified.',
    })} />);
    expect(screen.getByText(/nothing to verify for this chat/)).toBeTruthy();
    expect(document.querySelector('.vf-number')).toBeNull();
    expect(document.querySelector('.vf-scan')).toBeNull();
  });

  it('ready renders the formatted digits, the compare copy, the QR and the footer', () => {
    render(<VerifyShell port={fixtureVerifyPort()} />);
    expect(screen.getByText(/Compare these 60 digits with Asha/)).toBeTruthy();
    expect(document.querySelector('.vf-number')!.textContent).toMatch(/^12345 67890/);
    const qr = document.querySelector('.vf-qr') as HTMLImageElement;
    expect(qr.src.startsWith('data:image/svg+xml')).toBe(true);
    expect(screen.getByText(/remembers a successful check/)).toBeTruthy();
  });

  it('error renders the app-shaped message', () => {
    render(<VerifyShell port={fixtureVerifyPort({ phase: 'error', message: 'Could not work out a safety number on this device.' })} />);
    expect(screen.getByText(/Could not work out a safety number/)).toBeTruthy();
  });
});

describe('verify shell — trust record and the CHANGED decision', () => {
  it('renders the stored trust verdict banner', () => {
    render(<VerifyShell port={fixtureVerifyPort({
      banner: { warn: false, text: 'You have verified this contact’s key on this device.' },
    })} />);
    expect(screen.getByText(/You have verified this contact’s key/)).toBeTruthy();
  });

  it('a CHANGED key shows Accept/Keep (no dismiss) and routes both through the port', () => {
    const port = fixtureVerifyPort({
      banner: { warn: true, text: 'This contact is now publishing a DIFFERENT key…' },
      changed: { note: 'Messages to this contact are not being sent until you choose.' },
    });
    render(<VerifyShell port={port} />);
    fireEvent.click(screen.getByText('Accept the new key'));
    fireEvent.click(screen.getByText('Keep the old one'));
    expect(port.calls).toEqual(['accept', 'reject']);
    // Deliberately no third button: a dismissable warning is one users learn to dismiss.
    expect(document.querySelectorAll('.vf-row .vf-btn').length).toBe(2);
  });

  it('no CHANGED record → no decision buttons', () => {
    render(<VerifyShell port={fixtureVerifyPort()} />);
    expect(screen.queryByText('Accept the new key')).toBeNull();
  });
});

describe('verify shell — scanning', () => {
  it('Scan their code crosses the port; unavailable disables it with the reason', () => {
    const port = fixtureVerifyPort();
    render(<VerifyShell port={port} />);
    fireEvent.click(screen.getByText('Scan their code'));
    expect(port.calls).toEqual(['scan']);
    cleanup();
    render(<VerifyShell port={fixtureVerifyPort({
      scan: { available: false, status: 'This device has no camera Spot Me can use.', scanning: false },
    })} />);
    const btn = screen.getByText('Scan their code') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/no camera/)).toBeTruthy();
  });

  it('scan verdicts render from the snapshot and update on notify', () => {
    const port = fixtureVerifyPort();
    render(<VerifyShell port={port} />);
    act(() => {
      port.setSnapshot({
        ...port.snapshot(),
        scan: { available: true, status: 'Verified. Spot Me will remember this, and will tell you if Asha’s key changes.', scanning: false },
      });
    });
    expect(screen.getByText(/Verified\. Spot Me will remember this/)).toBeTruthy();
  });

  it('back crosses the port', () => {
    const port = fixtureVerifyPort();
    render(<VerifyShell port={port} />);
    fireEvent.click(screen.getByLabelText('Back'));
    expect(port.calls).toEqual(['back']);
  });
});
