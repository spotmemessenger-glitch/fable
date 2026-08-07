/**
 * Phase 4C — Events UI + accessibility: source attribution, approximate-area
 * note, cancelled provenance, popularity present vs omitted (C2), explainable
 * ranking, A3 (no age/gender), keyboard-operable save.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { EventCard } from '../events/components';
import type { EventView } from '../events/ports';

afterEach(cleanup);

const ev = (over: Partial<EventView> = {}): EventView => ({
  id: 'fixture:e1', category: 'music', title: 'Rooftop set', description: 'Live music',
  time: { startUTC: 1_900_000_000_000, endUTC: 1_900_010_800_000, timezone: 'Asia/Kolkata', allDay: false },
  state: 'happening-now', venue: { lat: 12.972, lon: 77.595, cell: 'g12.972:77.595' },
  distanceBand: 'under1km', popularity: 0.6,
  source: { provider: 'fixture', sourceName: 'Acme Listings', url: 'https://example.test/e', confidence: 0.9, provenance: null },
  ranking: { components: [{ signal: 'time', weight: 0.4, value: 1, weighted: 0.4 }, { signal: 'popularity', weight: 0.1, value: 0.6, weighted: 0.06 }], omittedSignals: [], total: 0.46 },
  ...over,
});

describe('events card', () => {
  it('credits the source and shows the approximate-area note, never a precise point', () => {
    render(<EventCard event={ev()} />);
    expect(screen.getByText(/Acme Listings/)).toBeTruthy();
    expect(screen.getByText(/approximate venue area only/i)).toBeTruthy();
  });

  it('shows sourced popularity when present, and "not provided" when omitted (C2)', () => {
    const { rerender } = render(<EventCard event={ev({ popularity: 0.6 })} />);
    expect(screen.getByText(/popularity 60%/i)).toBeTruthy();
    rerender(<EventCard event={ev({ popularity: null, ranking: { components: [{ signal: 'time', weight: 0.4, value: 1, weighted: 0.4 }], omittedSignals: ['popularity'], total: 0.4 } })} />);
    expect(screen.getByText(/popularity not provided/i)).toBeTruthy();
    expect(screen.getByText(/popularity: not provided by the source — omitted/i)).toBeTruthy();
  });

  it('renders a cancelled event with its source provenance', () => {
    render(<EventCard event={ev({ state: 'cancelled', source: { provider: 'fixture', sourceName: 'Acme', url: null, confidence: 0.9, provenance: { lifecycle: 'cancelled', assertedBy: 'Acme', note: 'Venue closed' } } })} />);
    expect(screen.getByRole('status').textContent).toMatch(/cancelled — per acme: venue closed/i);
  });

  it('renders an explainable ranking breakdown', () => {
    render(<EventCard event={ev()} />);
    expect(screen.getByText(/why this ranking/i)).toBeTruthy();
    expect(screen.getByText(/^time:/)).toBeTruthy();
  });

  it('A3: exposes NO age or gender control', () => {
    const { container } = render(<EventCard event={ev()} />);
    expect(container.textContent?.toLowerCase()).not.toContain('age');
    expect(container.textContent?.toLowerCase()).not.toContain('gender');
    expect(container.querySelector('[aria-label="Age" i]')).toBeNull();
  });

  it('save is a keyboard-operable button with aria-pressed', () => {
    const onToggleSave = vi.fn();
    render(<EventCard event={ev({ saved: false })} onToggleSave={onToggleSave} />);
    const btn = screen.getByRole('button', { name: /save/i });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(onToggleSave).toHaveBeenCalled();
  });

  it('open-in-maps points at the COARSE venue, never a precise fix', () => {
    render(<EventCard event={ev()} />);
    const link = screen.getByRole('link', { name: /open .* venue in maps/i });
    expect(link.getAttribute('href')).toBe('geo:12.972,77.595');
  });
});
