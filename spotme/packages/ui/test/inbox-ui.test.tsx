/**
 * Slice 6 — Inbox UI: tabs and unread pips, search (local filter + debounced
 * registry lookup through the port), archived mode, the row menu that replaces
 * the legacy swipe/long-press, the New chat sheet, and the first-message rule
 * (looking someone up must never message them by itself).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';
import { InboxShell, usernameQuery } from '../inbox/InboxShell';
import { fixtureInboxPort } from '../inbox/ports';

afterEach(cleanup);
beforeEach(() => vi.useRealTimers());

describe('inbox shell', () => {
  it('lists non-archived chats with preview, time, and unread badge', () => {
    render(<InboxShell port={fixtureInboxPort()} />);
    expect(screen.getByText('Asha')).toBeTruthy();
    expect(screen.getByText('You: hi')).toBeTruthy();
    expect(screen.getAllByText('2').length).toBeGreaterThan(0); // unread badge + tab pip
    expect(screen.queryByText('Old chat')).toBeNull();   // archived hidden
  });

  it('the Chats tab shows everything; Nearby filters by transport family', () => {
    render(<InboxShell port={fixtureInboxPort()} />);
    expect(screen.getByText('Ben')).toBeTruthy();        // nearby row on Chats
    fireEvent.click(screen.getByRole('tab', { name: /Nearby/ }));
    expect(screen.getByText('Ben')).toBeTruthy();
    expect(screen.queryByText('Asha')).toBeNull();
  });

  it('unread pips sum per tab and hide at zero', () => {
    render(<InboxShell port={fixtureInboxPort()} />);
    const chats = screen.getByRole('tab', { name: /Chats/ });
    expect(chats.textContent).toContain('2');
    const nearby = screen.getByRole('tab', { name: /Nearby/ });
    expect(nearby.textContent).not.toContain('2');
  });

  it('tapping a row opens the thread through the port', () => {
    const port = fixtureInboxPort();
    render(<InboxShell port={port} />);
    fireEvent.click(screen.getByText('Asha'));
    expect(port.calls).toContain('open:r1');
  });

  it('search filters rows by name or preview, and a miss says so', () => {
    render(<InboxShell port={fixtureInboxPort()} />);
    const input = screen.getByPlaceholderText('Search users...');
    fireEvent.change(input, { target: { value: 'See you' } });
    expect(screen.getByText('Ben')).toBeTruthy();
    expect(screen.queryByText('Asha')).toBeNull();
    fireEvent.change(input, { target: { value: 'zzznobody99' } });
    expect(screen.getByText('No matches for "zzznobody99"')).toBeTruthy();
  });

  it('a username-shaped query reaches the registry only after the debounce', async () => {
    vi.useFakeTimers();
    const port = fixtureInboxPort();
    render(<InboxShell port={port} />);
    fireEvent.change(screen.getByPlaceholderText('Search users...'), { target: { value: '@asha' } });
    expect(port.calls).not.toContain('search:asha');
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(port.calls).toContain('search:asha');
    expect(screen.getByText('@asha')).toBeTruthy();
  });

  it('picking a result WITHOUT an existing DM opens the request sheet, and only Start chat sends', async () => {
    vi.useFakeTimers();
    const port = fixtureInboxPort();
    render(<InboxShell port={port} />);
    fireEvent.change(screen.getByPlaceholderText('Search users...'), { target: { value: 'asha' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    fireEvent.click(screen.getByText('@asha'));
    // Nothing sent yet — the sheet is the consent step.
    expect(port.calls.some((c) => c.startsWith('start:'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    expect(port.calls).toContain('start:asha:Hi!');
    expect(port.calls).toContain('open:r-new');
  });

  it('the row menu archives through the port (keyboard path, no swipe needed)', () => {
    const port = fixtureInboxPort();
    render(<InboxShell port={port} />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage Asha' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(port.calls).toContain('arch:r1:true');
  });

  it('delete requires an explicit confirm step', () => {
    const port = fixtureInboxPort();
    render(<InboxShell port={port} />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage Asha' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete conversation' }));
    expect(port.calls).not.toContain('del:r1');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(port.calls).toContain('del:r1');
  });

  it('Block is offered only for rows with a registry peer', () => {
    const port = fixtureInboxPort();
    render(<InboxShell port={port} />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage Hiking club' }));
    expect(screen.queryByRole('menuitem', { name: /Block/ })).toBeNull();
  });

  it('archived mode lists only archived rows and comes back', () => {
    render(<InboxShell port={fixtureInboxPort()} />);
    fireEvent.click(screen.getByRole('button', { name: /Archived/ }));
    expect(screen.getByText('Old chat')).toBeTruthy();
    expect(screen.queryByText('Asha')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /← Archived/ }));
    expect(screen.getByText('Asha')).toBeTruthy();
  });

  it('the New chat sheet creates a group through the port and opens it', () => {
    const port = fixtureInboxPort();
    render(<InboxShell port={port} />);
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.click(screen.getByText('New group'));
    fireEvent.change(screen.getByPlaceholderText('Group name'), { target: { value: 'Trip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(port.calls).toContain('group:Trip');
    expect(port.calls).toContain('open:g-new');
  });

  it('Mark all as read goes through the port', () => {
    const port = fixtureInboxPort();
    render(<InboxShell port={port} />);
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.click(screen.getByText('Mark all as read'));
    expect(port.calls).toContain('markAllRead');
  });

  it('the Bluetooth tab always offers the scanner entrance (legacy bug fix kept)', () => {
    const port = fixtureInboxPort();
    render(<InboxShell port={port} />);
    fireEvent.click(screen.getByRole('tab', { name: /Bluetooth/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Scan for people nearby' }));
    expect(port.calls).toContain('nav:#/bluetooth');
  });
});

describe('usernameQuery', () => {
  it('normalises @Name and rejects non-usernames', () => {
    expect(usernameQuery('@Yuv')).toBe('yuv');
    expect(usernameQuery('  asha_1 ')).toBe('asha_1');
    expect(usernameQuery('two words')).toBeNull();
    expect(usernameQuery('a')).toBeNull();
  });
});
