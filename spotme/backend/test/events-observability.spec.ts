/**
 * Phase 4D — Events instrumentation: closed metric + label registries. A label
 * can never become an identity/position/attribution channel.
 */

import {
  assertEventsLabels, EVENTS_METRICS, EVENTS_METRIC_LABELS, EVENTS_LABEL_VALUES, EventsLabelViolation,
} from '../src/events/events.observability';

describe('events observability (closed registries)', () => {
  it('accepts an allow-listed metric + enum label value', () => {
    expect(() => assertEventsLabels(EVENTS_METRICS.dedupMerges, { basis: 'cross-provider-match' })).not.toThrow();
    expect(() => assertEventsLabels(EVENTS_METRICS.browseDuration, { outcome: 'ok' })).not.toThrow();
  });

  it('refuses a non-allow-listed label key', () => {
    expect(() => assertEventsLabels(EVENTS_METRICS.browseDuration, { sourceName: 'Acme' } as never)).toThrow(EventsLabelViolation);
  });

  it('refuses categorically-forbidden identity/position/attribution keys', () => {
    for (const k of ['originLat', 'sourceName', 'organizerRef', 'lat', 'lon', 'cell', 'url']) {
      expect(() => assertEventsLabels(EVENTS_METRICS.providerDuration, { [k]: 'x', provider: 'fixture', outcome: 'ok' } as never)).toThrow(EventsLabelViolation);
    }
  });

  it('refuses a value outside its key enum, and any decimal-shaped value', () => {
    expect(() => assertEventsLabels(EVENTS_METRICS.dedupMerges, { basis: 'guessed' })).toThrow(EventsLabelViolation);
    expect(() => assertEventsLabels(EVENTS_METRICS.providerDuration, { provider: '12.972', outcome: 'ok' })).toThrow(EventsLabelViolation);
  });

  it('the metric + label registries are closed and non-empty', () => {
    expect(Object.keys(EVENTS_METRICS).length).toBe(6);
    for (const labels of Object.values(EVENTS_METRIC_LABELS)) expect(Array.isArray(labels)).toBe(true);
    // provider enum is adapter TYPES only — never a source/organizer name.
    expect(EVENTS_LABEL_VALUES.provider).toEqual(['fixture', 'unconfigured', 'unavailable']);
  });
});
