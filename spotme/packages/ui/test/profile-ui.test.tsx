/**
 * Slice 4 — Profile UI: rendering, field sheets, username claim flow through
 * the port, toggles, and the adapter-owned callbacks (media/voice/danger).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProfileShell } from '../profile/ProfileShell';
import { fixtureProfilePort } from '../profile/ports';

afterEach(cleanup);

describe('profile shell', () => {
  it('renders identity, field card, and section order', () => {
    render(<ProfileShell port={fixtureProfilePort()} />);
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByText('@asha')).toBeTruthy();
    for (const sec of ['My voice', 'Safety & visibility', 'Notifications',
      'Language & translation', 'Practice', 'Blocked people', 'Invite', 'Danger zone']) {
      expect(screen.getByText(sec)).toBeTruthy();
    }
  });

  it('flipping a toggle goes through the port with the legacy settings key', () => {
    const port = fixtureProfilePort();
    render(<ProfileShell port={port} />);
    fireEvent.click(screen.getByRole('switch', { name: /Show me on the map/ }));
    expect(port.calls).toContain('toggle:showOnMap:false');
    fireEvent.click(screen.getByRole('switch', { name: /Transliteration/ }));
    expect(port.calls).toContain('toggle:translit:true');
  });

  it('toggles expose their state via aria-checked', () => {
    render(<ProfileShell port={fixtureProfilePort()} />);
    expect(screen.getByRole('switch', { name: /Show me on the map/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: /Demo people/ }).getAttribute('aria-checked')).toBe('false');
  });

  it('editing a field opens the sheet and saves trimmed text through the port', () => {
    const port = fixtureProfilePort();
    render(<ProfileShell port={port} />);
    fireEvent.click(screen.getByText('About'));
    const input = screen.getByPlaceholderText('The magic you are looking for…');
    fireEvent.change(input, { target: { value: '  new line  ' } });
    fireEvent.click(screen.getByText('Save'));
    expect(port.calls).toContain('save:about:new line');
    expect(screen.queryByPlaceholderText('The magic you are looking for…')).toBeNull();
  });

  it('a rejected save keeps the sheet open', () => {
    const port = fixtureProfilePort();
    render(<ProfileShell port={port} />);
    fireEvent.click(screen.getByText('Name'));
    fireEvent.change(screen.getByPlaceholderText('Your name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Save'));
    expect(port.calls).toContain('save:name:');
    expect(screen.getByPlaceholderText('Your name')).toBeTruthy();
  });

  it('username sheet debounces the check and enables Claim only when free', async () => {
    vi.useFakeTimers();
    const port = fixtureProfilePort();
    render(<ProfileShell port={port} />);
    fireEvent.click(screen.getByText('Username'));
    const input = screen.getByPlaceholderText('username');
    fireEvent.change(input, { target: { value: 'newname' } });
    expect(port.calls.filter((c) => c.startsWith('check:'))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByText('@newname is available')).toBeTruthy());
    const claim = screen.getByRole('button', { name: 'Change' }) as HTMLButtonElement;
    expect(claim.disabled).toBe(false);
    fireEvent.click(claim);
    await waitFor(() => expect(port.calls).toContain('claim:newname'));
  });

  it('a taken handle disables Claim', async () => {
    vi.useFakeTimers();
    render(<ProfileShell port={fixtureProfilePort()} />);
    fireEvent.click(screen.getByText('Username'));
    fireEvent.change(screen.getByPlaceholderText('username'), { target: { value: 'taken' } });
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByText('@taken is taken')).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Change' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('language sheet picks through the port and closes', () => {
    const port = fixtureProfilePort();
    render(<ProfileShell port={port} />);
    fireEvent.click(screen.getByText('Your language'));
    fireEvent.click(screen.getAllByText('English')[0]);
    expect(port.calls).toContain('lang:en');
  });

  it('media and danger flows are pure callbacks into the adapter', () => {
    const port = fixtureProfilePort();
    render(<ProfileShell port={port} />);
    fireEvent.click(screen.getByLabelText('Change photo'));
    fireEvent.click(screen.getByText('Create my voice'));
    fireEvent.click(screen.getByText('Clear all data'));
    fireEvent.click(screen.getByText('Create invite link'));
    expect(port.calls).toEqual(expect.arrayContaining(['changePhoto', 'createVoice', 'clearAll', 'invite']));
  });

  it('blocked people render with an Unblock action', () => {
    const port = fixtureProfilePort({ blocked: [{ id: 'b1', name: 'Rude', avatarUrl: null }] });
    render(<ProfileShell port={port} />);
    fireEvent.click(screen.getByText('Unblock'));
    expect(port.calls).toContain('unblock:b1');
  });

  it('voice row shows delete when a clone exists', () => {
    const port = fixtureProfilePort({ voice: { hasVoice: true, createdLabel: '1 Aug 2026' } });
    render(<ProfileShell port={port} />);
    fireEvent.click(screen.getByText('Delete voice'));
    expect(port.calls).toContain('deleteVoice');
  });
});
