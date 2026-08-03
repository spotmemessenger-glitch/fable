/**
 * Checkpoint 10 — component tests: every explicit state renders actionable
 * copy; the filter sheet is EXACTLY three controls (A3/A8); person cards are
 * band-only with the D9 gate and safety actions; place cards are honest about
 * open-status and attribution; the list virtualizes; map/list share selection.
 */

import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryResult, DiscoveryState, NearbyPersonPublic, NearbyPlacePublic, CoarsePublicLocation, RankingBreakdown } from '@spotme/contracts';
import { FilterSheet, PersonCard, PlaceCard, ResultList, StateBanner } from '../src/discovery/components';
import { DiscoveryShell, markersFor } from '../src/discovery/DiscoveryShell';
import { MapView } from '../src/discovery/MapView';

afterEach(cleanup);

const coarse = { lat: 12.97, lon: 77.59, cell: '12.97:77.59' } as CoarsePublicLocation;
const ranking: RankingBreakdown = { total: 0.5, components: [], omittedSignals: [], confidence: 0.5, source: 'deterministic-baseline' };

const person = (id: string, over: Partial<NearbyPersonPublic> = {}): NearbyPersonPublic => ({
  userId: id,
  displayName: `Person ${id}`,
  distanceBand: 'under500m',
  approxLocation: coarse,
  freshness: { observedAt: '2026-08-03T18:00:00Z' },
  friendRequest: { canSendRequest: true, state: 'none' },
  safety: { canBlock: true, canReport: true, canHide: true },
  ...over,
});

const place = (id: string, over: Partial<NearbyPlacePublic> = {}): NearbyPlacePublic => ({
  placeId: id,
  name: `Place ${id}`,
  category: 'cafe',
  approxLocation: coarse,
  source: { kind: 'place-provider', provider: 'fixture', attribution: 'Fixture Data' },
  freshness: {},
  ...over,
});

const page = (results: DiscoveryResult[]) => ({
  contractsVersion: 1 as const,
  results,
  radius: { km: 2 },
  cursor: null,
  freshness: {},
});

describe('FilterSheet — A3/A8', () => {
  it('renders EXACTLY three controls: distance band, category, open-now', () => {
    render(<FilterSheet filters={{}} categories={['cafe']} openNowSupported onChange={() => {}} />);
    const inputs = [...document.querySelectorAll('.disc-filters select, .disc-filters input')];
    expect(inputs).toHaveLength(3);
    expect(screen.getByLabelText('Distance band')).toBeTruthy();
    expect(screen.getByLabelText('Category')).toBeTruthy();
    expect(screen.getByLabelText('Open now (places only)')).toBeTruthy();
    // No age or gender control exists anywhere in the sheet.
    expect(document.body.textContent!.toLowerCase()).not.toContain('age');
    expect(document.body.textContent!.toLowerCase()).not.toContain('gender');
  });

  it('open-now is disabled with a visible note when the sources cannot support it', () => {
    render(<FilterSheet filters={{}} categories={[]} openNowSupported={false} onChange={() => {}} />);
    expect((screen.getByLabelText('Open now (places only)') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/not supported by current sources/)).toBeTruthy();
  });
});

describe('PersonCard — bands only, D9 gate, safety actions', () => {
  it('shows the distance band, never coordinates or metres', () => {
    const { container } = render(
      <PersonCard person={person('u1')} selected={false} onSelect={() => {}} onFriendRequest={() => {}} onBlock={() => {}} onReport={() => {}} onHide={() => {}} />,
    );
    expect(screen.getByText('under500m away')).toBeTruthy();
    expect(container.innerHTML).not.toContain('12.97');
    expect(container.innerHTML).not.toContain('77.59');
  });

  it('friend-request states follow the D9 gate; chat only appears at accepted', () => {
    for (const [state, label] of [
      ['none', 'Friend request'],
      ['pending-sent', 'Request sent'],
      ['accepted', 'Friends — chat available'],
    ] as const) {
      cleanup();
      render(
        <PersonCard person={person('u1', { friendRequest: { canSendRequest: true, state } })} selected={false} onSelect={() => {}} onFriendRequest={() => {}} onBlock={() => {}} onReport={() => {}} onHide={() => {}} />,
      );
      expect(screen.getByText(label)).toBeTruthy();
      if (state !== 'accepted') expect(screen.queryByText(/chat/i)).toBeNull();
    }
  });

  it('block, report and hide are always present', () => {
    render(<PersonCard person={person('u1')} selected={false} onSelect={() => {}} onFriendRequest={() => {}} onBlock={() => {}} onReport={() => {}} onHide={() => {}} />);
    for (const l of ['Block', 'Report', 'Hide this result']) expect(screen.getByLabelText(l)).toBeTruthy();
  });
});

describe('PlaceCard — honest open-status and attribution', () => {
  it('unknown open-status renders NOTHING (never a guess)', () => {
    render(<PlaceCard place={place('p1')} selected={false} onSelect={() => {}} onDirections={() => {}} onSave={() => {}} />);
    expect(screen.queryByText(/open now/i)).toBeNull();
    expect(screen.queryByText(/closed/i)).toBeNull();
    expect(screen.getByText('Source: Fixture Data')).toBeTruthy();
  });
  it('distance is labeled straight line', () => {
    render(<PlaceCard place={place('p1', { deviceDistanceM: 240 })} selected={false} onSelect={() => {}} onDirections={() => {}} onSave={() => {}} />);
    expect(screen.getByText('~240 m (straight line)')).toBeTruthy();
  });
});

describe('StateBanner — every failure says what happened and what to do next', () => {
  const states: DiscoveryState[] = [
    { kind: 'permission-required' },
    { kind: 'location-unavailable', reason: 'no GPS signal' },
    { kind: 'empty', radius: { km: 2 }, suggestion: 'Try a wider radius.' },
    { kind: 'provider-unavailable', providers: ['places'] },
    { kind: 'offline' },
    { kind: 'failed', error: { code: 'X', message: 'Search failed.', retryable: true, nextStep: 'Check your connection and retry.' } },
  ];
  it.each(states.map((s) => [s.kind, s] as const))('%s state renders copy + an action', (_k, s) => {
    render(<StateBanner state={s} onRetry={() => {}} onEnableLocation={() => {}} />);
    expect(document.querySelector('.disc-state, [role=alert], [role=status]')).toBeTruthy();
    expect(document.querySelector('button')).toBeTruthy();
  });
  it('searching renders fixed-height skeletons (no layout shift, aria-busy)', () => {
    render(<StateBanner state={{ kind: 'searching', query: {} as never }} onRetry={() => {}} onEnableLocation={() => {}} />);
    expect(document.querySelector('[aria-busy=true]')).toBeTruthy();
    expect(document.querySelectorAll('.disc-skeleton').length).toBeGreaterThan(0);
  });
});

describe('ResultList — virtualization', () => {
  it('renders a bounded window of DOM rows for 1000 results', () => {
    const results: DiscoveryResult[] = Array.from({ length: 1000 }, (_, i) => ({
      type: 'person', person: person(`u${i}`), ranking,
    }));
    render(
      <ResultList results={results} selectedId={null} onSelect={() => {}} onFriendRequest={() => {}} onBlock={() => {}} onReport={() => {}} onHide={() => {}} onDirections={() => {}} onSave={() => {}} viewportRows={6} />,
    );
    const rows = document.querySelectorAll('[role=listitem]');
    expect(rows.length).toBeLessThan(20);
  });
});

describe('map/list synchronization', () => {
  it('selecting a marker calls the SAME onSelect the list uses; both highlight', () => {
    const onSelect = vi.fn();
    const results: DiscoveryResult[] = [
      { type: 'person', person: person('u1'), ranking },
      { type: 'place', place: place('p1'), ranking },
    ];
    const markers = markersFor(results, 'p1');
    render(<MapView markers={markers} center={coarse} selectedId={'p1'} onSelect={onSelect} />);
    fireEvent.click(screen.getByLabelText('Map marker u1 (approximate)'));
    expect(onSelect).toHaveBeenCalledWith('u1');
    expect(document.querySelector('.disc-marker.selected')).toBeTruthy();
  });

  it('person markers always render as approximate', () => {
    const results: DiscoveryResult[] = [{ type: 'person', person: person('u1'), ranking }];
    const markers = markersFor(results, null);
    expect(markers[0].approximate).toBe(true);
  });
});

describe('DiscoveryShell — composition', () => {
  it('ready state shows list + map (split), with visibility explanation before enabling', () => {
    const results: DiscoveryResult[] = [{ type: 'person', person: person('u1'), ranking }];
    render(
      <DiscoveryShell
        state={{ kind: 'ready', page: page(results) }}
        searchText="" mode="split" filters={{}} categories={['cafe']} openNowSupported={false}
        visibilityEnabled={false} selectedId={null} markers={markersFor(results, null)} center={coarse}
        onSearchText={() => {}} onSubmit={() => {}} onMode={() => {}} onFilters={() => {}} onVisibility={() => {}}
        onSelect={() => {}} onFriendRequest={() => {}} onBlock={() => {}} onReport={() => {}} onHide={() => {}}
        onDirections={() => {}} onSave={() => {}} onRetry={() => {}} onEnableLocation={() => {}}
      />,
    );
    expect(screen.getByLabelText('Nearby results')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Map with 1 nearby markers/ })).toBeTruthy();
    expect(screen.getByText(/approximate/)).toBeTruthy(); // privacy explainer visible BEFORE enabling
    expect(screen.getByLabelText('Enable discovery visibility')).toBeTruthy();
  });
});
