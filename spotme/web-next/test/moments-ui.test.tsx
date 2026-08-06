/**
 * Phase 5D — Moments UI + a11y: untrusted URLs (inert, no unfurl — M6), the
 * closed reaction bar, plain-language visibility labels + the pre-attach
 * explanation (M5), render-side comment nesting from FLAT data (M4),
 * no engagement counters, A3.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MomentCard, UntrustedText, VisibilityControl, LocationExplanation, CommentList } from '../src/moments/components';
import type { MomentView } from '../src/moments/ports';

afterEach(cleanup);

const moment = (over: Partial<MomentView> = {}): MomentView => ({
  id: 'm1', author: { userId: 'u2', displayName: 'Ravi', distanceBand: 'under1km' }, kind: 'text',
  text: 'Free pizza at https://evil.example/claim now', media: [], visibility: 'nearby',
  coarseCellLabel: 'g12.972:77.595', createdAtUTC: 1, myReaction: null, ranking: null, ...over,
});

const noop = () => {};

describe('untrusted URLs (M6)', () => {
  it('renders a URL as INERT text — no anchor, labelled unverified', () => {
    const { container } = render(<UntrustedText text="go to https://evil.example/x?a=1 ok" />);
    expect(container.querySelector('a')).toBeNull(); // never clickable
    expect(screen.getByRole('note').textContent).toContain('https://evil.example/x?a=1');
    expect(screen.getByText(/unverified link/)).toBeTruthy();
  });
  it('no fetch/unfurl happens on render', () => {
    const spy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
    render(<MomentCard moment={moment()} onReact={noop} onReport={noop} onBlock={noop} onHide={noop} />);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('moment card', () => {
  it('shows the approximate-area note when a cell is attached; never a raw coordinate pair link', () => {
    render(<MomentCard moment={moment()} onReact={noop} onReport={noop} onBlock={noop} onHide={noop} />);
    expect(screen.getByText(/approximate area only/i)).toBeTruthy();
  });

  it('the reaction bar is the CLOSED five-member set with aria-pressed', () => {
    const onReact = vi.fn();
    render(<MomentCard moment={moment({ myReaction: 'love' })} onReact={onReact} onReport={noop} onBlock={noop} onHide={noop} />);
    const group = screen.getByRole('group', { name: /react/i });
    const buttons = group.querySelectorAll('button');
    expect([...buttons].map((b) => b.textContent)).toEqual(['like', 'love', 'laugh', 'wow', 'support']);
    expect([...buttons].find((b) => b.textContent === 'love')!.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click([...buttons].find((b) => b.textContent === 'like')!);
    expect(onReact).toHaveBeenCalledWith('like');
  });

  it('NO engagement counters render anywhere; report/block/hide always offered; A3 clean', () => {
    const { container } = render(<MomentCard moment={moment()} onReact={noop} onReport={noop} onBlock={noop} onHide={noop} />);
    expect(container.textContent).not.toMatch(/\d+\s*(likes|views|shares)/i);
    for (const label of ['Report', 'Block', 'Hide']) expect(screen.getByRole('button', { name: label })).toBeTruthy();
    expect(container.textContent?.toLowerCase()).not.toContain('age');
    expect(container.textContent?.toLowerCase()).not.toContain('gender');
  });
});

describe('visibility (M5)', () => {
  it('four tiers with plain-language labels', () => {
    render(<VisibilityControl value="friends" onChange={noop} />);
    expect(screen.getByLabelText(/private — only you/i)).toBeTruthy();
    expect(screen.getByLabelText(/nearby — anyone around your approximate area/i)).toBeTruthy();
    expect((screen.getByLabelText(/friends/i) as HTMLInputElement).checked).toBe(true);
  });

  it('the pre-attach explanation is plain language and offers a real decline', () => {
    const onConfirm = vi.fn(); const onCancel = vi.fn();
    render(<LocationExplanation onConfirm={onConfirm} onCancel={onCancel} />);
    const dialog = screen.getByRole('alertdialog', { name: /attaching your location/i });
    expect(dialog.textContent).toMatch(/approximate area only/i);
    expect(dialog.textContent).toMatch(/never your exact position/i);
    fireEvent.click(screen.getByRole('button', { name: /don't attach/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('comments (M4 — flat data, render-side nesting)', () => {
  it('builds one level of visual nesting from parentId over FLAT rows', () => {
    render(<CommentList comments={[
      { id: 'c1', parentId: null, author: { displayName: 'A' }, text: 'top' },
      { id: 'c2', parentId: 'c1', author: { displayName: 'B' }, text: 'reply' },
    ]} />);
    const list = screen.getByRole('list', { name: /comments/i });
    const nested = list.querySelector('li ul li');
    expect(nested?.textContent).toContain('reply');
  });
});
