/**
 * Slice 1 — the Exchange screens.
 *
 * The heaviest assertions here are NEGATIVE. Three fields in the mocks have no
 * server field behind them, and the failure mode is not a crash — it is a
 * plausible-looking number that a reader believes. So the suite pins their
 * ABSENCE, and it pins the wording of the primary action, because "Message"
 * would promise a chat the server refuses.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BrowseScreen, DetailScreen, CreateScreen, MyIntentsScreen, approxDistance,
} from '../exchange/screens';
import type { ExchangeIntentView, ExchangeMatchView } from '../exchange/ports';

const intent = (over: Partial<ExchangeIntentView> = {}): ExchangeIntentView => ({
  id: 'i1', kind: 'need', status: 'active', category: 'help/moving',
  title: 'Someone to help move a bookshelf',
  text: 'Second floor, no lift.',
  tags: ['Lifting', 'Weekend'],
  budgetBand: 'low',
  approxLocation: { lat: 12.971, lon: 77.594, cell: 'g12.97:77.59' },
  radius: { km: 3, maxKm: 25 },
  availability: { state: 'recurring', scheduleLabel: 'Sat & Sun, mornings' },
  visibility: 'discoverable',
  createdAtIso: '2026-08-07T09:00:00.000Z',
  expiresAtIso: null,
  version: { seq: 1 },
  ...over,
});

const noContact: ExchangeMatchView['contact'] = {
  state: 'none', canRequestContact: true, requiresExplicitConsent: true,
};
const noop = () => {};

afterEach(cleanup);
const detailProps = {
  contact: noContact, onRequestContact: noop, onSave: noop, onShare: noop,
  onReport: noop, onWithdraw: noop, onMarkFulfilled: noop, onBack: noop,
};

/* ------------------------------------------------- the invented fields */

describe('fields with no server behind them are ABSENT, not faked', () => {
  it('Create step 3 shows no audience estimate', () => {
    render(
      <CreateScreen
        step={3} categories={['help/moving']} maxKm={25}
        draft={{ kind: 'need', category: 'help/moving', title: 't', text: 'x', scheduleLabel: '', radiusKm: 3, discoverable: true }}
        onDraft={noop} onStep={noop} onSubmit={noop}
      />,
    );
    expect(document.body.textContent).not.toMatch(/seen by/i);
    expect(document.body.textContent).not.toMatch(/~\s*\d+\s*people/i);
  });

  it('My intents shows no contact count', () => {
    render(
      <MyIntentsScreen
        tab="active" results={[intent()]}
        onTab={noop} onPause={noop} onResume={noop} onEdit={noop} onWithdraw={noop} onMarkFulfilled={noop}
      />,
    );
    expect(document.body.textContent).not.toMatch(/\d+\s*(person|people)\s*messaged/i);
  });

  it('Browse renders no image for any card — Exchange has no media', () => {
    render(
      <BrowseScreen
        tab="need" servicesOnly={false} categories={['help/moving']} state="ok"
        results={[intent(), intent({ id: 'i2', title: 'Second' })]}
        onTab={noop} onServicesOnly={noop} onCategory={noop} onOpen={noop}
      />,
    );
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(document.querySelectorAll('[style*="background-image"]')).toHaveLength(0);
  });

  it('the 30-day claim lives ONLY in the composer, where it is a parameter', () => {
    /* INVERTED (proximity slice): the composer sends expiresInHours: 720 —
     * the server's opt-in ceiling — so CreateScreen step 3 SAYS 30 days and
     * that is now true. Screens that don't set expiry still must not claim
     * a window they don't control. */
    const { unmount } = render(
      <CreateScreen
        step={3}
        draft={{ kind: 'need', category: 'c', title: '', text: '', scheduleLabel: '', radiusKm: 3, discoverable: true }}
        categories={['c']} maxKm={25} onDraft={noop} onStep={noop} onSubmit={noop}
      />,
    );
    expect(screen.getByText(/visible for 30 days/i)).toBeTruthy();
    unmount();
    render(
      <MyIntentsScreen
        tab="active" results={[intent()]}
        onTab={noop} onPause={noop} onResume={noop} onEdit={noop} onWithdraw={noop} onMarkFulfilled={noop}
      />,
    );
    expect(document.body.textContent).not.toMatch(/30 days/i);
  });

  it('Detail shows expiry ONLY when the server sent one', () => {
    const { unmount } = render(<DetailScreen intent={intent({ expiresAtIso: null })} {...detailProps} />);
    expect(screen.queryByText(/visible until/i)).toBeNull();
    unmount();
    render(<DetailScreen intent={intent({ expiresAtIso: '2026-09-01T00:00:00.000Z' })} {...detailProps} />);
    expect(screen.getByText('2026-09-01')).toBeTruthy();
  });

  it('Browse offers the "Within 5 km" pill — it maps to the REAL radiusKm parameter now', () => {
    /* INVERTED (proximity slice): browse accepts lat/lon/radiusKm and filters
     * with ST_DWithin server-side, so the pill is a genuine control, not a
     * decoration. It renders ONLY when the host wires onNearby — a fixture
     * that has no geo path shows no pill. */
    const onNearby = vi.fn();
    const { unmount } = render(
      <BrowseScreen
        tab="need" servicesOnly={false} categories={['help/moving']} state="ok" results={[intent()]}
        nearbyOn={false} onNearby={onNearby}
        onTab={noop} onServicesOnly={noop} onCategory={noop} onOpen={noop}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Within 5 km' }));
    expect(onNearby).toHaveBeenCalledWith(true);
    unmount();

    render(
      <BrowseScreen
        tab="need" servicesOnly={false} categories={['help/moving']} state="ok" results={[intent()]}
        onTab={noop} onServicesOnly={noop} onCategory={noop} onOpen={noop}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Within 5 km' })).toBeNull();
  });

  it('nearby asked but no location ⇒ the page SAYS it is showing everywhere', () => {
    render(
      <BrowseScreen
        tab="need" servicesOnly={false} categories={['help/moving']} state="ok" results={[intent()]}
        nearbyOn scope="everywhere" onNearby={noop}
        onTab={noop} onServicesOnly={noop} onCategory={noop} onOpen={noop}
      />,
    );
    expect(screen.getByText(/showing everywhere/i)).toBeTruthy();
  });

  it('a geo-scoped card renders the server BAND, never metres', () => {
    render(
      <BrowseScreen
        tab="need" servicesOnly={false} categories={['help/moving']} state="ok"
        results={[intent({ distanceBand: 'under1km' })]}
        onTab={noop} onServicesOnly={noop} onCategory={noop} onOpen={noop}
      />,
    );
    expect(screen.getByText('within 1 km')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\b\d{3,4}\s?m away/);
  });
});

/* ------------------------------------------------------------ consent */

describe('the primary action does not promise a chat', () => {
  it('reads "Request contact", never "Message"', () => {
    render(<DetailScreen intent={intent()} {...detailProps} />);
    expect(screen.getByRole('button', { name: 'Request contact' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^message/i })).toBeNull();
  });

  it('states that the other person chooses', () => {
    render(<DetailScreen intent={intent()} {...detailProps} />);
    expect(screen.getByText(/chat opens only if they accept/i)).toBeTruthy();
  });

  it('cannot be pressed again once requested', () => {
    render(
      <DetailScreen
        intent={intent()} {...detailProps}
        contact={{ state: 'requested', canRequestContact: true, requiresExplicitConsent: true }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Contact requested' }).hasAttribute('disabled')).toBe(true);
  });
});

/* ----------------------------------------------------- hard UI rules */

describe('hard rules', () => {
  it('distance is always approximate, never exact', () => {
    expect(approxDistance(0.62)).toBe('about 600 m');
    expect(approxDistance(2.4)).toBe('about 2.4 km');
    expect(approxDistance(12.7)).toBe('about 13 km');
    expect(approxDistance(0.01)).toBe('about 100 m'); // never "10 m" precision
  });

  it('the area is a circle and carries no pin', () => {
    render(<DetailScreen intent={intent()} {...detailProps} />);
    expect(document.querySelectorAll('.x-area-circle')).toHaveLength(1);
    expect(document.querySelectorAll('.x-area-map marker')).toHaveLength(0);
    expect(screen.getByText(/area shown is approximate/i)).toBeTruthy();
  });

  it('budget is a band, never a number or a currency', () => {
    render(<DetailScreen intent={intent({ budgetBand: 'medium' })} {...detailProps} />);
    const band = document.querySelector('.x-band')!;
    expect(band.textContent).toBe('Medium');
    expect(band.textContent).not.toMatch(/[₹$€£]|\d/);
  });

  it('there is no cart and no checkout anywhere', () => {
    render(
      <BrowseScreen tab="need" servicesOnly={false} categories={[]} state="ok" results={[intent()]}
        onTab={noop} onServicesOnly={noop} onCategory={noop} onOpen={noop} />,
    );
    expect(document.body.textContent).not.toMatch(/cart|checkout|buy now/i);
  });

  it('Report is reachable on the user-content surface', () => {
    render(<DetailScreen intent={intent()} {...detailProps} />);
    expect(screen.getByRole('button', { name: 'Report' })).toBeTruthy();
  });

  it('every icon-only control has an accessible name', () => {
    render(<DetailScreen intent={intent()} {...detailProps} />);
    for (const b of Array.from(document.querySelectorAll('button'))) {
      const name = b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '';
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------- withdraw / mark fulfilled */

describe('Withdraw and Mark fulfilled have a home', () => {
  it('live in the Detail overflow menu, not dropped', async () => {
    const withdraw = vi.fn();
    render(<DetailScreen intent={intent()} {...detailProps} onWithdraw={withdraw} />);
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = screen.getByRole('menu');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Withdraw' }));
    expect(withdraw).toHaveBeenCalledTimes(1);
  });

  it('and in every My-intents row', async () => {
    const fulfil = vi.fn();
    render(
      <MyIntentsScreen tab="active" results={[intent()]}
        onTab={noop} onPause={noop} onResume={noop} onEdit={noop}
        onWithdraw={noop} onMarkFulfilled={fulfil} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Mark fulfilled' }));
    expect(fulfil).toHaveBeenCalledWith('i1');
  });
});

/* ---------------------------------------------------------- navigation */

describe('screens wire their controls', () => {
  it('Browse tabs and Services-only raise callbacks', async () => {
    const onTab = vi.fn(); const onServices = vi.fn();
    render(
      <BrowseScreen tab="need" servicesOnly={false} categories={['a']} state="ok" results={[]}
        onTab={onTab} onServicesOnly={onServices} onCategory={noop} onOpen={noop} />,
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Offers' }));
    expect(onTab).toHaveBeenCalledWith('offer');
    await userEvent.click(screen.getByRole('button', { name: 'Services only' }));
    expect(onServices).toHaveBeenCalledWith(true);
  });

  it('My intents exposes all four states', () => {
    render(
      <MyIntentsScreen tab="matched" results={[]}
        onTab={noop} onPause={noop} onResume={noop} onEdit={noop} onWithdraw={noop} onMarkFulfilled={noop} />,
    );
    for (const t of ['Active', 'Paused', 'Matched', 'Fulfilled']) {
      expect(screen.getByRole('tab', { name: t })).toBeTruthy();
    }
  });

  it('Create step 3 offers None/Low/Medium/High', () => {
    render(
      <CreateScreen step={3} categories={['a']} maxKm={25}
        draft={{ kind: 'need', category: 'a', title: '', text: '', scheduleLabel: '', radiusKm: 3, discoverable: true }}
        onDraft={noop} onStep={noop} onSubmit={noop} />,
    );
    for (const b of ['None', 'Low', 'Medium', 'High']) {
      expect(screen.getByRole('button', { name: b })).toBeTruthy();
    }
  });
});
