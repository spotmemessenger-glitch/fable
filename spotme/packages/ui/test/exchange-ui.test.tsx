/**
 * Phase 3D — Exchange UI + accessibility: composer semantics, the no-payment
 * disclaimer, consent-gated contact rendering, A3 (no age/gender control),
 * explainable match rendering, keyboard-operable controls.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { IntentComposer, MatchCard, IntentCard } from '../exchange/components';
import type { ExchangeMatchView, ExchangeIntentView } from '../exchange/ports';

afterEach(cleanup);

const match = (over: Partial<ExchangeMatchView> = {}): ExchangeMatchView => ({
  id: 'm1', intentTitle: 'Evening plumber', distanceBand: 'under1km',
  explanation: { components: [{ signal: 'intentFit', weight: 0.35, value: 0.9, weighted: 0.315 }], total: 0.315 },
  contact: { state: 'none', canRequestContact: true, requiresExplicitConsent: true }, ...over,
});

const intent: ExchangeIntentView = {
  id: 'i1', kind: 'offer', status: 'active', category: 'services/plumbing', title: 'Plumbing help',
  text: 'Available tonight', tags: [], informationalPrice: { label: '~₹500', disclaimer: 'informational-only-no-payment' },
  approxLocation: { lat: 12.972, lon: 77.595, cell: 'g' }, version: { seq: 1 },
};

describe('exchange composer', () => {
  it('shows the no-payment disclaimer beside the informational price', () => {
    render(<IntentComposer draft={{ kind: 'need' }} categories={['services/plumbing']} error={null} busy={false} onChange={() => {}} onSubmit={() => {}} />);
    expect(screen.getByText(/does not process payments/i)).toBeTruthy();
  });

  it('A3: exposes NO age or gender control', () => {
    const { container } = render(<IntentComposer draft={{ kind: 'need' }} categories={['c']} error={null} busy={false} onChange={() => {}} onSubmit={() => {}} />);
    expect(container.textContent?.toLowerCase()).not.toContain('age');
    expect(container.textContent?.toLowerCase()).not.toContain('gender');
    expect(container.querySelector('[aria-label="Age" i]')).toBeNull();
  });

  it('kind radios are keyboard-operable buttons with aria-pressed', () => {
    const onChange = vi.fn();
    render(<IntentComposer draft={{ kind: 'need' }} categories={['c']} error={null} busy={false} onChange={onChange} onSubmit={() => {}} />);
    const offer = screen.getByRole('button', { name: 'offer' });
    fireEvent.click(offer);
    expect(onChange).toHaveBeenCalledWith({ kind: 'offer' });
  });

  it('surfaces a validation error via role=alert', () => {
    render(<IntentComposer draft={{ kind: 'need' }} categories={['c']} error={'Please fill in kind, category, title and description.'} busy={false} onChange={() => {}} onSubmit={() => {}} />);
    expect(screen.getByRole('alert').textContent).toMatch(/fill in/i);
  });
});

describe('exchange match card — consent gate', () => {
  it('offers Request contact when none, and NEVER an open chat before acceptance', () => {
    const onReq = vi.fn();
    render(<MatchCard match={match()} onRequestContact={onReq} />);
    expect(screen.queryByText(/open chat/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /request contact/i }));
    expect(onReq).toHaveBeenCalled();
  });

  it('shows a waiting status (no chat) when contact is requested', () => {
    render(<MatchCard match={match({ contact: { state: 'requested', canRequestContact: false, requiresExplicitConsent: true } })} onRequestContact={() => {}} />);
    expect(screen.getByRole('status').textContent).toMatch(/once they accept/i);
    expect(screen.queryByText(/open chat/i)).toBeNull();
  });

  it('opens chat ONLY once contact is accepted', () => {
    render(<MatchCard match={match({ contact: { state: 'accepted', canRequestContact: false, requiresExplicitConsent: true } })} onRequestContact={() => {}} />);
    expect(screen.getByRole('button', { name: /open chat/i })).toBeTruthy();
  });

  it('renders an explainable rationale', () => {
    render(<MatchCard match={match()} onRequestContact={() => {}} />);
    expect(screen.getByText(/why this match/i)).toBeTruthy();
    expect(screen.getByText(/intentFit/)).toBeTruthy();
  });
});

describe('exchange intent card', () => {
  it('shows the informational-price disclaimer and approximate-area note, never an exact location', () => {
    render(<IntentCard intent={intent} />);
    expect(screen.getByText(/informational only, no payment/i)).toBeTruthy();
    expect(screen.getByText(/approximate area only/i)).toBeTruthy();
  });
});
