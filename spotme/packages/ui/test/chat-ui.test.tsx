/**
 * Chat UI parity — the split-bubble is TWO PERMANENTLY VISIBLE sections
 * (never a toggle), Sent+Read-only ticks, Retry on failure, the countdown
 * renders m:ss (not raw minutes), the identity banner states, accessible
 * names on every control, Indic text reaches the DOM intact.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';
import { ChatShell } from '../chat/ChatShell';
import { MessageBubble, ReadRow, TtlCountdown, IdentityBanner } from '../chat/components';
import { ChatController } from '../chat/controller';
import { FixedClock, FixtureChatEngine, FixtureTranslit } from '../chat/fixtures';

afterEach(cleanup);

const noop = () => {};
const now = () => Date.now();

const msg = (over = {}) => ({ id: 'm1', from: 'peer', ts: Date.now(), text: 'hello', ...over });

const shell = (deps = {}) => {
  const clock = new FixedClock(Date.now());
  const engine = new FixtureChatEngine(clock);
  const controller = new ChatController({
    engine, roomId: 'r1', selfId: 'me', clock, translit: new FixtureTranslit(), ...deps,
  });
  return { engine, controller };
};

describe('split-bubble translation (product signature, design system §7)', () => {
  it('original AND translation are both permanently visible — never a toggle', () => {
    const { container } = render(
      <MessageBubble
        m={msg({ text: 'வணக்கம்' })}
        mine={false}
        status="sent"
        translation={{ text: 'Hello', engine: 'instant' }}
        now={now}
        onRetry={noop}
      />,
    );
    const src = container.querySelector('.bubIn .src');
    const tr = container.querySelector('.bubIn .tr');
    expect(src?.textContent).toBe('வணக்கம்');           // Indic intact, exactly as sent
    expect(tr?.querySelector('.trTxt')?.textContent).toBe('Hello');
    expect(tr?.querySelector('.trTag')).toBeTruthy();
    // No toggle: neither section is a button or aria-hidden.
    expect(container.querySelector('.src[aria-hidden], .tr[aria-hidden]')).toBeNull();
    expect(container.querySelector('button.src, button.tr')).toBeNull();
  });

  it('pending translation shows Translating… without hiding the original', () => {
    const { container } = render(
      <MessageBubble m={msg()} mine={false} status="sent" translation={'pending'} now={now} onRetry={noop} />,
    );
    expect(container.querySelector('.src')?.textContent).toBe('hello');
    expect(container.querySelector('.trTag')?.textContent).toBe('Translating…');
  });

  it('no translation → the .tr section simply does not render', () => {
    const { container } = render(
      <MessageBubble m={msg()} mine={false} status="sent" translation={null} now={now} onRetry={noop} />,
    );
    expect(container.querySelector('.tr')).toBeNull();
  });
});

describe('read row — Sent + Read only, Retry on failure', () => {
  it('renders Sent, then Read — and no "Delivered" anywhere', () => {
    const { container, rerender } = render(
      <ReadRow m={msg({ from: 'me' })} status="sent" onRetry={noop} />,
    );
    expect(container.textContent).toContain('Sent');
    rerender(<ReadRow m={msg({ from: 'me' })} status="read" onRetry={noop} />);
    expect(container.textContent).toContain('Read');
    expect(container.textContent).not.toContain('Delivered');
  });

  it('failed renders the warning row with a working Retry button', () => {
    const onRetry = vi.fn();
    const m = msg({ from: 'me', failed: true });
    render(<ReadRow m={m} status="failed" onRetry={onRetry} />);
    expect(screen.getByText('Not delivered')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledWith(m);
  });
});

describe('disappearing-message countdown', () => {
  it('renders a live m:ss countdown, not raw minutes', () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const { container } = render(
        <TtlCountdown m={msg({ ts: t0, ttl: 90 })} now={() => Date.now()} />,
      );
      expect(container.textContent).toContain('⏱ 1:30');
      act(() => { vi.advanceTimersByTime(31_000); });
      expect(container.textContent).toContain('⏱ 0:59');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('identity banner', () => {
  it('ephemeral and unavailable warn; ok and unknown are silent', () => {
    const { container, rerender } = render(
      <IdentityBanner identity="ephemeral" undecryptable={null} />,
    );
    expect(container.textContent).toContain('can’t save its encryption key');
    rerender(<IdentityBanner identity="unavailable" undecryptable={null} />);
    expect(container.textContent).toContain('private browsing');
    rerender(<IdentityBanner identity="unknown" undecryptable={null} />);
    expect(container.querySelector('.sys.warn')).toBeNull();
    rerender(<IdentityBanner identity="ok" undecryptable={null} />);
    expect(container.querySelector('.sys.warn')).toBeNull();
  });

  it('the room-level undecryptable state outranks the device state', () => {
    const { container } = render(
      <IdentityBanner identity="ok" undecryptable="wrong-key" peerName="Suriya" />,
    );
    expect(container.textContent).toContain('Suriya’s security key changed');
  });
});

describe('ChatShell end to end over fixtures', () => {
  it('typing shows the transliteration hint; Enter sends; the bubble appears', () => {
    const { controller } = shell();
    const { container } = render(
      <ChatShell controller={controller} header={{ name: 'Suriya' }} />,
    );
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'vanakkam' } });
    expect(container.querySelector('.tlprev .tlMain')?.textContent).toBe('VANAKKAM');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(container.querySelector('.bubOut')?.textContent).toContain('vanakkam');
    expect(container.querySelector('.readRow')?.textContent).toContain('Sent');
  });

  it('an incoming message renders as a bubIn with the original text', () => {
    const { controller, engine } = shell();
    const { container } = render(
      <ChatShell controller={controller} header={{ name: 'Suriya' }} />,
    );
    act(() => {
      engine.ensure('r1').receive({ id: 'p1', from: 'peer', ts: Date.now(), text: 'ஹலோ' });
    });
    expect(container.querySelector('.bubIn .src')?.textContent).toBe('ஹலோ');
  });

  it('the read event flips my ticks from Sent to Read', () => {
    const { controller, engine } = shell();
    const { container } = render(
      <ChatShell controller={controller} header={{ name: 'Suriya' }} />,
    );
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    act(() => { engine.ensure('r1').markReadUpTo(Date.now() + 1); });
    expect(container.querySelector('.readRow')?.textContent).toContain('Read');
  });

  it('every control has an accessible name', () => {
    const { controller } = shell();
    render(<ChatShell controller={controller} header={{ name: 'S' }} onBack={noop} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy();
  });
});
