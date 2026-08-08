/**
 * Chat (final slice, session 4) — the crypto-facing system lines: encryption
 * claim, Verify entry point, undecryptable / device-key warning banner. All
 * strings arrive finished through the port; this suite pins that the shell
 * renders them and routes Verify — and that a snapshot WITHOUT `security`
 * (sessions 1–3 adapters) renders no crypto line at all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ChatShell } from '../chat/ChatShell';
import { fixtureChatPort } from '../chat/ports';

afterEach(cleanup);

const SYS_V2 = 'Messages are encrypted with keys made on your devices. Translation runs on-device when possible.';
const SYS_V1 = 'Older chat — its key came from both account IDs, so the server could read it.';

function withSecurity(security: { sysText: string; canVerify: boolean; warnText: string | null }) {
  const port = fixtureChatPort();
  port.setSnapshot({ ...port.snapshot(), security });
  return port;
}

describe('chat shell — crypto-facing lines', () => {
  it('no security in the snapshot → no crypto line (old adapters untouched)', () => {
    render(<ChatShell port={fixtureChatPort()} />);
    expect(document.querySelector('.ch-sec')).toBeNull();
    expect(document.querySelector('.ch-warn')).toBeNull();
  });

  it('a v2 room renders the encryption claim with the Verify entry point', () => {
    const port = withSecurity({ sysText: SYS_V2, canVerify: true, warnText: null });
    render(<ChatShell port={port} />);
    expect(screen.getByText(new RegExp('encrypted with keys made on your devices'))).toBeTruthy();
    fireEvent.click(screen.getByText('Verify'));
    expect(port.calls).toContain('openVerify');
  });

  it('a v1 room renders the honest older-chat line and NO Verify link', () => {
    render(<ChatShell port={withSecurity({ sysText: SYS_V1, canVerify: false, warnText: null })} />);
    expect(screen.getByText(/server could read it/)).toBeTruthy();
    expect(screen.queryByText('Verify')).toBeNull();
  });

  it('an undecryptable room renders the warning banner as an alert', () => {
    const warn = 'Asha’s security key changed — reconnecting automatically. New messages will open in a moment; you can check the connection under Verify.';
    render(<ChatShell port={withSecurity({ sysText: SYS_V2, canVerify: true, warnText: warn })} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('security key changed');
    // F2: the copy never tells the user to delete anything.
    expect(alert.textContent!.toLowerCase()).not.toContain('delete');
  });

  it('the warning clears when the snapshot clears it', () => {
    const port = withSecurity({ sysText: SYS_V2, canVerify: true, warnText: 'Messages are arriving but this device can’t unlock them yet. Check your connection and reopen the chat — it often clears on its own.' });
    render(<ChatShell port={port} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    act(() => {
      port.setSnapshot({ ...port.snapshot(), security: { sysText: SYS_V2, canVerify: true, warnText: null } });
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
