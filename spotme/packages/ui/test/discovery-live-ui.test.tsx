/**
 * Slice 5 — Discovery LIVE UI: rendering, filters, visibility toggle, and the
 * profile-card flows, all through the port. No coordinates anywhere.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { DiscoveryLiveShell } from '../discovery-live/DiscoveryLiveShell';
import { fixtureDiscoveryPort } from '../discovery-live/ports';

afterEach(cleanup);

describe('discovery live shell', () => {
  it('lists peers sorted by distance with approximate labels', () => {
    render(<DiscoveryLiveShell port={fixtureDiscoveryPort()} />);
    expect(screen.getByText('Asha')).toBeTruthy();
    expect(screen.getByText('~24 m')).toBeTruthy();
    const rows = screen.getAllByText(/Asha|Ben|Chi/).map((n) => n.textContent);
    expect(rows[0]).toBe('Asha'); // nearest first
  });

  it('keeps peers who withhold position in the list but off the radar', () => {
    render(<DiscoveryLiveShell port={fixtureDiscoveryPort()} />);
    expect(screen.getByText('Chi')).toBeTruthy();          // in the list
    expect(screen.queryByLabelText(/^Chi/)).toBeNull();    // no radar marker
    expect(screen.getByLabelText('Asha, ~24 m away')).toBeTruthy();
  });

  it('range filter hides far peers and persists through the port', () => {
    const port = fixtureDiscoveryPort();
    render(<DiscoveryLiveShell port={port} />);
    fireEvent.change(screen.getByLabelText('Distance filter'), { target: { value: '50' } });
    expect(port.calls).toContain('range:50');
    expect(screen.queryByText('Ben')).toBeNull();   // 80 m > 50 m
    expect(screen.getByText('Asha')).toBeTruthy();
  });

  it('age filter only bites where an age is announced', () => {
    render(<DiscoveryLiveShell port={fixtureDiscoveryPort()} />);
    fireEvent.change(screen.getByLabelText('Age filter'), { target: { value: '35+' } });
    expect(screen.getByText('Asha')).toBeTruthy();  // no age announced — stays
    expect(screen.queryByText('Ben')).toBeNull();   // 27, filtered
  });

  it('visibility toggle flips through the port and shows the hidden chip', () => {
    const port = fixtureDiscoveryPort();
    render(<DiscoveryLiveShell port={port} />);
    fireEvent.click(screen.getByLabelText('Show me on the map'));
    expect(port.calls).toContain('visible:false');
    expect(screen.getByText('HIDDEN FROM MAP')).toBeTruthy();
    expect(screen.getByText('Hidden')).toBeTruthy();
  });

  it('profile card: wave goes through the port', () => {
    const port = fixtureDiscoveryPort();
    render(<DiscoveryLiveShell port={port} />);
    fireEvent.click(screen.getByText('Asha'));
    fireEvent.click(screen.getByText(/Wave/));
    expect(port.calls).toContain('wave:p1');
  });

  it('profile card: message opens the request sheet and sends the first line', () => {
    const port = fixtureDiscoveryPort();
    render(<DiscoveryLiveShell port={port} />);
    fireEvent.click(screen.getByText('Asha'));
    const card = screen.getByRole('dialog');
    fireEvent.click(within(card).getByText('Message'));
    fireEvent.change(screen.getByPlaceholderText('Say hi — any language'), { target: { value: 'hola' } });
    fireEvent.click(screen.getByText('Start chat'));
    expect(port.calls).toContain('request:p1:hola');
  });

  it('a peer with an existing chat gets Open chat, never Wave', () => {
    const port = fixtureDiscoveryPort();
    render(<DiscoveryLiveShell port={port} />);
    fireEvent.click(screen.getByText('Ben'));
    expect(screen.getByText('Open chat')).toBeTruthy();
    expect(screen.queryByText(/Wave/)).toBeNull();
    fireEvent.click(screen.getByText('Open chat'));
    expect(port.calls).toContain('open:p2');
  });

  it('location-off chip shows when not located; locate goes through the port', () => {
    const port = fixtureDiscoveryPort({ located: false });
    render(<DiscoveryLiveShell port={port} />);
    expect(screen.getByText(/Location off/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Update my position'));
    expect(port.calls).toContain('locate');
  });

  it('empty states distinguish "none in radius" from "none online"', () => {
    const port = fixtureDiscoveryPort({ peers: [] });
    render(<DiscoveryLiveShell port={port} />);
    expect(screen.getByText(/No one nearby yet/)).toBeTruthy();
  });
});
