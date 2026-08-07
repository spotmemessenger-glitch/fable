/**
 * Slice 2 — Stories UI: rings, seen state, the honest my-story path, and
 * navigation actions through the port.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { StoriesShell } from '../stories/StoriesShell';
import { fixtureStoriesPort } from '../stories/ports';

afterEach(cleanup);

describe('stories shell', () => {
  it('renders a ring per person, unseen rings marked', () => {
    render(<StoriesShell port={fixtureStoriesPort()} />);
    const asha = screen.getByText('Asha').closest('button')!;
    const ben = screen.getByText('Ben').closest('button')!;
    expect(asha.getAttribute('data-seen')).toBe('0');
    expect(ben.getAttribute('data-seen')).toBe('1');
  });

  it('tapping a person opens their chat through the port', () => {
    const port = fixtureStoriesPort();
    render(<StoriesShell port={port} />);
    fireEvent.click(screen.getByText('Asha'));
    expect(port.calls).toContain('person:c1');
  });

  it('My story goes through the port (the adapter toasts about native)', () => {
    const port = fixtureStoriesPort();
    render(<StoriesShell port={port} />);
    fireEvent.click(screen.getByText('My story'));
    expect(port.calls).toContain('my-story');
    expect(screen.getByText(/native-app feature/)).toBeTruthy();
  });

  it('profile and chats buttons are labelled and wired', () => {
    const port = fixtureStoriesPort();
    render(<StoriesShell port={port} />);
    fireEvent.click(screen.getByRole('button', { name: 'My profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    expect(port.calls).toEqual(expect.arrayContaining(['profile', 'chats']));
  });

  it('empty state explains where rings come from', () => {
    render(<StoriesShell port={fixtureStoriesPort({ people: [] })} />);
    expect(screen.getByText('No stories yet')).toBeTruthy();
  });
});
