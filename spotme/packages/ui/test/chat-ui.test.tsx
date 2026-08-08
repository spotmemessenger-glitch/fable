/**
 * Chat (final slice, session 1) — message list + composer core. Asserts the
 * React shell reproduces the legacy contract that
 * apps/web/test/chat-characterization.test.js pins on the old stack: day
 * dividers, Read/Sent/Not delivered + Retry, edited mark, reply quotes,
 * typing line, and that every mutation crosses the port.
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

describe('chat shell — message list', () => {
  it('renders the header with name and presence', () => {
    render(<ChatShell port={fixtureChatPort()} />);
    expect(screen.getByText('Asha')).toBeTruthy();
    expect(screen.getByText('Online')).toBeTruthy();
  });

  it('groups messages under day dividers in order', () => {
    render(<ChatShell port={fixtureChatPort()} />);
    expect(screen.getByText('Mon')).toBeTruthy();
    expect(screen.getByText('Today')).toBeTruthy();
    const log = screen.getByRole('log');
    expect(log.textContent!.indexOf('Mon')).toBeLessThan(log.textContent!.indexOf('Today'));
  });

  it('a read message shows the double tick, a sent one the single', () => {
    const { container } = render(<ChatShell port={fixtureChatPort()} />);
    const ticks = container.querySelectorAll('.ch-ticks');
    expect([...ticks].some((t) => t.textContent === '✓✓' && t.classList.contains('ch-read'))).toBe(true);
    expect([...ticks].some((t) => t.textContent === '✓' && !t.classList.contains('ch-read'))).toBe(true);
  });

  it('a failed message reads "Not delivered" and Retry crosses the port', () => {
    const port = fixtureChatPort();
    render(<ChatShell port={port} />);
    expect(screen.getByText('Not delivered')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(port.calls).toContain('retry:m4');
  });

  it('edited messages carry the edited mark', () => {
    render(<ChatShell port={fixtureChatPort()} />);
    expect(screen.getByText('edited')).toBeTruthy();
  });

  it('a reply renders its quoted preview', () => {
    render(<ChatShell port={fixtureChatPort()} />);
    expect(screen.getByText('replying to you')).toBeTruthy();
    const quote = document.querySelector('.ch-quote');
    expect(quote?.textContent).toContain('Me');
    expect(quote?.textContent).toContain('hi!');
  });

  it('a system line renders centred, without a bubble', () => {
    render(<ChatShell port={fixtureChatPort()} />);
    expect(screen.getByRole('note').textContent).toBe('⏱ Timer messages on');
  });

  it('opening the thread sends the read receipt', () => {
    const port = fixtureChatPort();
    render(<ChatShell port={port} />);
    expect(port.calls).toContain('markRead');
  });

  it('long threads window to the newest rows with a reveal button', () => {
    const rows = Array.from({ length: 200 }, (_, i) => row({ id: `m${i}`, text: `msg ${i}` }));
    render(<ChatShell port={fixtureChatPort(rows)} />);
    expect(screen.queryByText('msg 0')).toBeNull();
    expect(screen.getByText('msg 199')).toBeTruthy();
    fireEvent.click(screen.getByText(/Show earlier messages/));
    expect(screen.getByText('msg 40')).toBeTruthy();
  });

  it('the typing label takes over the presence line', () => {
    const port = fixtureChatPort();
    const snap = { ...port.snapshot(), typingLabel: 'Asha is typing…' };
    port.snapshot = () => snap;
    render(<ChatShell port={port} />);
    expect(screen.getAllByText('Asha is typing…').length).toBeGreaterThan(0);
    expect(screen.queryByText('Online')).toBeNull();
  });
});

describe('chat shell — composer', () => {
  it('send is disabled for an empty/whitespace draft', () => {
    render(<ChatShell port={fixtureChatPort()} />);
    const send = screen.getByRole('button', { name: 'Send' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '   ' } });
    expect((send as HTMLButtonElement).disabled).toBe(true);
  });

  it('typing then sending crosses the port trimmed, clears the draft, and stops typing', () => {
    const port = fixtureChatPort();
    render(<ChatShell port={port} />);
    const input = screen.getByLabelText('Message') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  hello there  ' } });
    expect(port.calls).toContain('typing:true');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(port.calls).toContain('send:hello there');
    expect(port.calls).toContain('typing:false');
    expect(input.value).toBe('');
  });

  it('Enter sends; the new message appears in the list', () => {
    const port = fixtureChatPort();
    render(<ChatShell port={port} />);
    const input = screen.getByLabelText('Message');
    fireEvent.change(input, { target: { value: 'via enter' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(port.calls).toContain('send:via enter');
    expect(screen.getByText('via enter')).toBeTruthy();
  });

  it('back crosses the port', () => {
    const port = fixtureChatPort();
    render(<ChatShell port={port} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(port.calls).toContain('back');
  });
});
