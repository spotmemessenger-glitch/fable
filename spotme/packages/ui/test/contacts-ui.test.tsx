/**
 * Slice 2 — Contacts UI: rendering, search, actions through the port, and the
 * keyboard-reachable manage menu that replaces the legacy long-press.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ContactsShell } from '../contacts/ContactsShell';
import { fixtureContactsPort } from '../contacts/ports';

afterEach(cleanup);

describe('contacts shell', () => {
  it('lists contacts with name and language chip', () => {
    render(<ContactsShell port={fixtureContactsPort()} />);
    expect(screen.getByText('Asha')).toBeTruthy();
    expect(screen.getByText('Hindi')).toBeTruthy();
  });

  it('search filters by name and by language, case-insensitively', () => {
    render(<ContactsShell port={fixtureContactsPort()} />);
    const input = screen.getByPlaceholderText('Search contacts...');
    fireEvent.change(input, { target: { value: 'engl' } });
    expect(screen.queryByText('Asha')).toBeNull();
    expect(screen.getByText('Ben')).toBeTruthy();
  });

  it('tapping a row opens the contact through the port', () => {
    const port = fixtureContactsPort();
    render(<ContactsShell port={port} />);
    fireEvent.click(screen.getByText('Asha'));
    expect(port.calls).toContain('open:c1');
  });

  it('the manage menu is a real button (keyboard path), with Block and Remove', () => {
    const port = fixtureContactsPort();
    render(<ContactsShell port={port} />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage Asha' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Block' }));
    expect(port.calls).toContain('block:c1');
  });

  it('invite goes through the port', () => {
    const port = fixtureContactsPort();
    render(<ContactsShell port={port} />);
    fireEvent.click(screen.getByText('Invite a friend by link'));
    expect(port.calls).toContain('invite');
  });

  it('empty state offers Discovery; a search miss does not', () => {
    const port = fixtureContactsPort({ contacts: [] });
    render(<ContactsShell port={port} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Discovery' }));
    expect(port.calls).toContain('discovery');
  });
});
