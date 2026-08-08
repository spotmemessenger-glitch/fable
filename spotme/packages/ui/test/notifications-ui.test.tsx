/**
 * Slice 2 — Notifications UI, plus the surface's privacy battery: the nearby
 * row must render only the preformatted approximate label — raw coordinates
 * must not exist anywhere in the port types or reach the DOM.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { NotificationsShell } from '../notifications/NotificationsShell';
import { fixtureNotificationsPort } from '../notifications/ports';

afterEach(cleanup);

describe('notifications shell', () => {
  it('shows the enable prompt only while permission is undecided', () => {
    const { unmount } = render(<NotificationsShell port={fixtureNotificationsPort()} />);
    expect(screen.getByText('Turn on device notifications')).toBeTruthy();
    unmount();
    render(<NotificationsShell port={fixtureNotificationsPort({ enablePrompt: false })} />);
    expect(screen.queryByText('Turn on device notifications')).toBeNull();
  });

  it('enable goes through the port in one tap', () => {
    const port = fixtureNotificationsPort();
    render(<NotificationsShell port={port} />);
    fireEvent.click(screen.getByText('Turn on device notifications'));
    expect(port.calls).toContain('enable');
  });

  it('a chat row opens its thread; section count is capped at 99+', () => {
    const port = fixtureNotificationsPort();
    render(<NotificationsShell port={port} />);
    fireEvent.click(screen.getByText('Asha'));
    expect(port.calls).toContain('thread:r1');
  });

  it('Say hi opens a chat with the nearby person through the port', () => {
    const port = fixtureNotificationsPort();
    render(<NotificationsShell port={port} />);
    fireEvent.click(screen.getByRole('button', { name: 'Say hi' }));
    expect(port.calls).toContain('hi:p1');
  });

  it('empty state renders when there is nothing to show', () => {
    render(<NotificationsShell port={fixtureNotificationsPort({ chats: [], nearby: [] })} />);
    expect(screen.getByText('You are all caught up')).toBeTruthy();
  });
});

describe('notifications privacy — approximate location only', () => {
  it('the nearby row shows the preformatted label, never a coordinate', () => {
    render(<NotificationsShell port={fixtureNotificationsPort()} />);
    expect(screen.getByText('Active now · about 300 m away')).toBeTruthy();
    // No decimal pair that could be a lat/lon leaks into the DOM.
    expect(document.body.textContent).not.toMatch(/\d{1,3}\.\d{3,}/);
  });

  it('the port types carry no lat/lon fields at all', () => {
    const src = readFileSync(join(process.cwd(), 'notifications', 'ports.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(src).not.toMatch(/\b(lat|lon|lng|latitude|longitude|position|coords)\s*[:?]/);
  });
});
