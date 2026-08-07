/**
 * Chat (final slice, session 2) — media rows, sheets, reactions, reply
 * composition. Asserts the React shell reproduces the legacy contracts the
 * characterization + view-once suites pin, and that every mutation crosses
 * the port as a callback (never a direct effect).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ChatShell } from '../chat/ChatShell';
import { fixtureChatPort, type MessageRowView } from '../chat/ports';

afterEach(cleanup);

const row = (over: Partial<MessageRowView>): MessageRowView => ({
  id: `r${Math.random()}`, mine: false, kind: 'text', text: 'x', name: 'Asha',
  showName: false, timeLabel: '10:00', dayKey: 'today', dayLabel: 'Today',
  status: 'sent', edited: false, replyPreview: null, reactions: [],
  canEdit: false, copyText: 'x', ...over,
});

describe('media rows', () => {
  it('a photo row renders the image and taps through to openPhoto', () => {
    const port = fixtureChatPort([row({
      id: 'p1', kind: 'media', text: 'Photo', copyText: null,
      media: { type: 'photo', url: 'data:image/png;base64,ok', caption: 'sunset' },
    })]);
    render(<ChatShell port={port} />);
    expect(screen.getByAltText('Photo')).toBeTruthy();
    expect(screen.getByText('sunset')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open photo' }));
    expect(port.calls).toContain('openPhoto:p1');
  });

  it('a view-once row renders as a LOCKED tile — mask only, tap hands the burn to the port', () => {
    const port = fixtureChatPort([row({
      id: 'v1', kind: 'media', text: 'Private photo', copyText: null,
      media: { type: 'viewOnce', maskUrl: 'data:image/png;base64,mask', label: 'Private photo · 5s — tap to open', chip: '🔥 5s' },
    })]);
    const { container } = render(<ChatShell port={port} />);
    expect(screen.getByText('Private photo · 5s — tap to open')).toBeTruthy();
    expect(screen.getByText('🔥 5s')).toBeTruthy();
    // The only image in the tile is the mask — the row carries no photo URL.
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs.every((i) => i.src.includes('mask'))).toBe(true);
    fireEvent.click(container.querySelector('.ch-vonce')!);
    expect(port.calls).toContain('openViewOnce:v1');
    // Revealed state cannot persist in the package: tapping changes nothing
    // locally — no reveal happens until the adapter pushes a new snapshot.
    expect(screen.getByText('Private photo · 5s — tap to open')).toBeTruthy();
  });

  it('my own view-once shows the sent state, opened when spent', () => {
    const port = fixtureChatPort([row({
      id: 'v2', mine: true, kind: 'media', text: 'Private photo', copyText: null,
      media: { type: 'viewOnceMine', label: 'Private photo', chip: '🔥 10s', opened: true },
    })]);
    render(<ChatShell port={port} />);
    expect(screen.getByText('Private photo')).toBeTruthy();
    expect(screen.getByText('Opened')).toBeTruthy();
  });

  it('a voice note renders a playback row with its duration', () => {
    const port = fixtureChatPort([row({
      id: 'a1', kind: 'media', text: 'Voice note (7s)', copyText: null,
      media: { type: 'voice', url: 'data:audio/webm;base64,ok', durLabel: '7s' },
    })]);
    const { container } = render(<ChatShell port={port} />);
    expect(container.querySelector('audio')?.getAttribute('src')).toContain('audio/webm');
    expect(screen.getByText('7s')).toBeTruthy();
  });

  it('a file row renders name, size and a download link', () => {
    const port = fixtureChatPort([row({
      id: 'f1', kind: 'media', text: 'notes.pdf', copyText: null,
      media: { type: 'file', url: 'data:application/pdf;base64,ok', name: 'notes.pdf', sizeLabel: '12 KB' },
    })]);
    const { container } = render(<ChatShell port={port} />);
    const link = container.querySelector('a.ch-file')!;
    expect(link.getAttribute('download')).toBe('notes.pdf');
    expect(screen.getByText('12 KB')).toBeTruthy();
  });

  it('location rows: current renders a map link, live carries the live class, ended has none', () => {
    const port = fixtureChatPort([
      row({ id: 'l1', kind: 'media', text: 'Location', copyText: 'map:1,2', media: { type: 'location', mapUrl: 'https://osm/x', label: 'Current location', live: false } }),
      row({ id: 'l2', kind: 'media', text: 'Live location', copyText: null, media: { type: 'location', mapUrl: 'https://osm/y', label: 'Live location', live: true } }),
      row({ id: 'l3', kind: 'media', text: 'Live location ended', copyText: null, media: { type: 'location', mapUrl: null, label: 'Live location ended', live: false } }),
    ]);
    const { container } = render(<ChatShell port={port} />);
    expect(screen.getByText('Current location')).toBeTruthy();
    expect(container.querySelectorAll('.ch-loc a').length).toBe(2);
    expect(container.querySelector('.ch-loc-live')).toBeTruthy();
    expect(screen.getByText('Live location ended')).toBeTruthy();
  });
});

describe('reaction chips', () => {
  it('aggregated chips render with the legacy grammar (emoji, or "emoji N")', () => {
    render(<ChatShell port={fixtureChatPort()} />);
    expect(screen.getByText('❤️ 2')).toBeTruthy();
    expect(screen.getByText('👍')).toBeTruthy();
  });
});

describe('message sheet (long-press)', () => {
  const open = (port = fixtureChatPort()) => {
    const utils = render(<ChatShell port={port} />);
    fireEvent.contextMenu(screen.getByText('vanakkam'));
    return { port, ...utils };
  };

  it('long-press opens the sheet with reactions and actions', () => {
    open();
    expect(screen.getByRole('button', { name: 'React ❤️' })).toBeTruthy();
    expect(screen.getByText('Reply')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
  });

  it('a reaction crosses the port and closes the sheet', () => {
    const { port } = open();
    fireEvent.click(screen.getByRole('button', { name: 'React ❤️' }));
    expect(port.calls).toContain('react:m1:❤️');
    expect(screen.queryByText('Reply')).toBeNull();
  });

  it('the + grid offers the expanded emoji set', () => {
    const { port } = open();
    fireEvent.click(screen.getByRole('button', { name: 'More reactions' }));
    fireEvent.click(screen.getByRole('button', { name: 'React 🔥' }));
    expect(port.calls).toContain('react:m1:🔥');
  });

  it('Copy passes the row copyText through the port', () => {
    const { port } = open();
    fireEvent.click(screen.getByText('Copy'));
    expect(port.calls).toContain('copy:vanakkam');
  });

  it('Edit shows only on my own text rows and routes the correction', () => {
    const port = fixtureChatPort();
    render(<ChatShell port={port} />);
    fireEvent.contextMenu(screen.getByText('vanakkam'));   // theirs
    expect(screen.queryByText('Edit')).toBeNull();
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.contextMenu(screen.getByText('still there?'));   // mine
    fireEvent.click(screen.getByText('Edit'));
    const box = screen.getByLabelText('Edit message');
    fireEvent.change(box, { target: { value: 'still, corrected' } });
    fireEvent.click(screen.getByText('Save'));
    expect(port.calls).toContain('edit:m3:still, corrected');
  });

  it('Delete asks, then routes for-me vs for-everyone', () => {
    const port = fixtureChatPort();
    render(<ChatShell port={port} />);
    fireEvent.contextMenu(screen.getByText('vanakkam'));   // theirs: no for-everyone
    fireEvent.click(screen.getByText('Delete'));
    expect(screen.queryByText('Delete for everyone')).toBeNull();
    fireEvent.click(screen.getByText('Delete for me'));
    expect(port.calls).toContain('delete:m1:false');
    fireEvent.contextMenu(screen.getByText('still there?'));   // mine: both
    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(screen.getByText('Delete for everyone'));
    expect(port.calls).toContain('delete:m3:true');
  });
});

describe('reply composition', () => {
  it('Reply raises the quote bar and the send carries the same replyTo envelope', () => {
    const port = fixtureChatPort();
    render(<ChatShell port={port} />);
    fireEvent.contextMenu(screen.getByText('vanakkam'));
    fireEvent.click(screen.getByText('Reply'));
    expect(document.querySelector('.ch-replybar')).toBeTruthy();
    const input = screen.getByLabelText('Message');
    fireEvent.change(input, { target: { value: 'replying' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(port.calls).toContain('send:replying:replyTo=m1');
    expect(document.querySelector('.ch-replybar')).toBeNull();
  });

  it('cancelling the quote bar sends without replyTo', () => {
    const port = fixtureChatPort();
    render(<ChatShell port={port} />);
    fireEvent.contextMenu(screen.getByText('vanakkam'));
    fireEvent.click(screen.getByText('Reply'));
    fireEvent.click(screen.getByLabelText('Cancel reply'));
    const input = screen.getByLabelText('Message');
    fireEvent.change(input, { target: { value: 'plain' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(port.calls).toContain('send:plain');
  });
});

describe('attach sheet + recording', () => {
  it('every attach entry invokes its port callback', () => {
    const port = fixtureChatPort();
    render(<ChatShell port={port} />);
    for (const [label, call] of [
      ['Photos', 'attachPhoto:false'],
      ['Private photo', 'attachPhoto:true'],
      ['Document', 'attachFile'],
      ['Voice note', 'voiceRecord'],
      ['Location', 'attachLocation'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(port.calls).toContain(call);
    }
  });

  it('while recording, the composer shows the stop control and tapping it crosses the port', () => {
    const port = fixtureChatPort([]);
    const recSnap = { ...port.snapshot(), recordingLabel: '0:07' };
    port.snapshot = () => recSnap;   // stable object — useSyncExternalStore contract
    render(<ChatShell port={port} />);
    const stop = screen.getByRole('button', { name: 'Stop recording' });
    expect(stop.textContent).toContain('0:07');
    fireEvent.click(stop);
    expect(port.calls).toContain('voiceRecord');
  });
});
