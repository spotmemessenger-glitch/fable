/**
 * Phase 3B — Exchange policy validation + lifecycle engine (in-memory fakes).
 * The refusal battery is the server half of the privacy + safety boundary;
 * the service tests pin ownership, optimistic concurrency, idempotency, and the
 * closed transition table.
 */

import { ExchangeError } from '../src/exchange/exchange.errors';
import {
  validateIntentInput,
  encodeCursor,
  decodeCursor,
  assertTransition,
  EXCHANGE_TRANSITIONS,
} from '../src/exchange/exchange.policy';
import { ExchangeService } from '../src/exchange/exchange.service';
import { ExchangeIntentRepository, CreateIntentResult, NearbyIntentsQuery } from '../src/exchange/exchange.repository';
import { ExchangeIntentRow, ValidatedExchangeIntentInput, ExchangeDecodedCursor } from '../src/exchange/exchange.types';

const okBody = (over: Record<string, unknown> = {}) => ({
  kind: 'need',
  category: 'services/plumbing',
  title: 'Leaking tap',
  text: 'Kitchen tap leaks tonight',
  origin: { lat: 12.9716, lon: 77.5946 },
  idempotencyKey: 'k1',
  ...over,
});

const expectCode = (fn: () => unknown, code: string) => {
  try { fn(); throw new Error('expected a refusal'); }
  catch (e) { expect(e).toBeInstanceOf(ExchangeError); expect((e as ExchangeError).code).toBe(code); }
};

describe('exchange input validation', () => {
  it('accepts a well-formed intent and COARSENS the origin to the grid', () => {
    const v = validateIntentInput('me', okBody({ origin: { lat: 12.971612, lon: 77.594698 } }));
    expect(v.coarseLat).toBe(12.972);
    expect(v.coarseLon).toBe(77.595);
    expect(v.coarseCell).toBe('g12.972:77.595'); // derived coarse cell
  });

  it('REFUSES a precise GeolocationCoordinates shape', () => {
    expectCode(() => validateIntentInput('me', okBody({ origin: { lat: 1, lon: 2, accuracy: 5 } })), 'PRECISE_LOCATION_REFUSED');
    expectCode(() => validateIntentInput('me', { ...okBody(), coords: { latitude: 1 } }), 'PRECISE_LOCATION_REFUSED');
  });

  it('A3: an age/gender field is structurally unsupported', () => {
    expectCode(() => validateIntentInput('me', okBody({ age: 30 })), 'UNSUPPORTED_FIELD');
    expectCode(() => validateIntentInput('me', okBody({ gender: 'x' })), 'UNSUPPORTED_FIELD');
  });

  it('no payment field: informationalPrice is a short label, and an amount field is rejected', () => {
    const v = validateIntentInput('me', okBody({ informationalPrice: '~₹500' }));
    expect(v.informationalPrice).toBe('~₹500');
    expectCode(() => validateIntentInput('me', okBody({ priceAmount: 500 })), 'UNSUPPORTED_FIELD');
  });

  it('radius ceiling is refused loudly, budget must be a band', () => {
    expectCode(() => validateIntentInput('me', okBody({ radiusKm: 999 })), 'RADIUS_OUT_OF_BOUNDS');
    expectCode(() => validateIntentInput('me', okBody({ budgetBand: '500' })), 'MALFORMED_INTENT');
  });

  it('expiry is server-computed and bounded', () => {
    const now = new Date('2026-08-04T00:00:00Z');
    const v = validateIntentInput('me', okBody({ expiresInHours: 100000 }), now);
    const hours = (v.expiresAt!.getTime() - now.getTime()) / 3600_000;
    expect(hours).toBeLessThanOrEqual(24 * 30);
  });
});

describe('exchange cursor', () => {
  it('round-trips signed, rejects forgery, carries depth', () => {
    const c: ExchangeDecodedCursor = { t: 1234567, i: 'id-9', depth: 2 };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expectCode(() => decodeCursor('nope'), 'INVALID_CURSOR');
    const forged = Buffer.from(JSON.stringify({ t: 1, i: 'x', depth: 0 })).toString('base64url') + '.deadbeefdeadbeefdeadbe';
    expectCode(() => decodeCursor(forged), 'INVALID_CURSOR');
  });
});

describe('exchange transition table (closed)', () => {
  it('legal transitions pass; illegal ones throw ILLEGAL_TRANSITION', () => {
    expect(() => assertTransition('draft', 'active')).not.toThrow();
    expect(() => assertTransition('active', 'fulfilled')).not.toThrow();
    expectCode(() => assertTransition('fulfilled', 'active'), 'ILLEGAL_TRANSITION');
    expectCode(() => assertTransition('draft', 'fulfilled'), 'ILLEGAL_TRANSITION');
  });
  it('terminal states have no outgoing transitions', () => {
    for (const t of ['fulfilled', 'expired', 'withdrawn', 'removed'] as const) {
      expect(EXCHANGE_TRANSITIONS[t]).toEqual([]);
    }
  });
});

/* ---- in-memory repository for the service tests ---- */
class FakeRepo implements ExchangeIntentRepository {
  rows = new Map<string, ExchangeIntentRow>();
  private seq = 0;
  private mkRow(input: ValidatedExchangeIntentInput): ExchangeIntentRow {
    const id = `ix-${++this.seq}`;
    const now = new Date();
    return {
      id, ownerId: input.ownerId, ownerKind: input.ownerKind, kind: input.kind, status: 'draft',
      category: input.category, title: input.title, text: input.text, tags: input.tags,
      budgetBand: input.budgetBand ?? null, informationalPrice: input.informationalPrice ?? null,
      availabilityState: input.availabilityState, availabilityFrom: input.availabilityFrom ?? null,
      availabilityTo: input.availabilityTo ?? null, availabilitySchedule: input.availabilitySchedule ?? null,
      coarseLat: input.coarseLat, coarseLon: input.coarseLon, coarseCell: input.coarseCell,
      radiusKm: input.radiusKm, maxRadiusKm: input.maxRadiusKm, visibility: input.visibility,
      moderationState: 'clear', versionSeq: 1, createdAt: now, updatedAt: now, expiresAt: input.expiresAt,
    };
  }
  async createDraft(input: ValidatedExchangeIntentInput): Promise<CreateIntentResult> {
    for (const r of this.rows.values()) {
      if (r.ownerId === input.ownerId && r.status !== 'removed' && (r as { _k?: string })._k === input.idempotencyKey) {
        return { row: r, idempotentReplay: true };
      }
    }
    const row = this.mkRow(input);
    (row as { _k?: string })._k = input.idempotencyKey;
    this.rows.set(row.id, row);
    return { row, idempotentReplay: false };
  }
  async findById(id: string) { return this.rows.get(id) ?? null; }
  async updateFields(id: string, expectedVersion: number, patch: Partial<ValidatedExchangeIntentInput>) {
    const r = this.rows.get(id);
    if (!r || r.versionSeq !== expectedVersion) return null;
    Object.assign(r, patch, { versionSeq: r.versionSeq + 1, updatedAt: new Date() });
    return r;
  }
  async transition(id: string, expectedVersion: number, to: string) {
    const r = this.rows.get(id);
    if (!r || r.versionSeq !== expectedVersion) return null;
    r.status = to; r.versionSeq += 1; r.updatedAt = new Date();
    return r;
  }
  async findDiscoverable(_q: NearbyIntentsQuery) { return []; }
  async findOwn(ownerId: string) { return [...this.rows.values()].filter((r) => r.ownerId === ownerId && r.status !== 'removed'); }
}

describe('exchange lifecycle engine', () => {
  const mk = () => { const repo = new FakeRepo(); return { repo, svc: new ExchangeService(repo) }; };

  it('createDraft is idempotent per (owner, key)', async () => {
    const { svc } = mk();
    const a = await svc.createDraft('me', okBody({ idempotencyKey: 'same' }));
    const b = await svc.createDraft('me', okBody({ idempotencyKey: 'same' }));
    expect(a.id).toBe(b.id);
    expect(b.idempotentReplay).toBe(true);
  });

  it('a non-owner gets uniform NOT_FOUND (no existence leak)', async () => {
    const { svc } = mk();
    const created = await svc.createDraft('owner', okBody());
    await expect(svc.getOwn('someone-else', created.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('optimistic concurrency: a stale version conflicts', async () => {
    const { svc } = mk();
    const c = await svc.createDraft('me', okBody());
    await svc.activate('me', c.id, c.version.seq); // v1 → active, now v2
    await expect(svc.pause('me', c.id, c.version.seq)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('walks a legal lifecycle and refuses an illegal jump', async () => {
    const { svc } = mk();
    const c = await svc.createDraft('me', okBody());
    const active = await svc.activate('me', c.id, c.version.seq);
    const paused = await svc.pause('me', c.id, active.version.seq);
    const resumed = await svc.resume('me', c.id, paused.version.seq);
    const done = await svc.markFulfilled('me', c.id, resumed.version.seq);
    expect(done.status).toBe('fulfilled');
    await expect(svc.activate('me', c.id, done.version.seq)).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
  });

  it('only a draft may be edited', async () => {
    const { svc } = mk();
    const c = await svc.createDraft('me', okBody());
    const active = await svc.activate('me', c.id, c.version.seq);
    await expect(svc.updateDraft('me', c.id, active.version.seq, okBody({ title: 'new' }))).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
  });

  it('projects a disclaimered price and never a payment amount', async () => {
    const { svc } = mk();
    const c = await svc.createDraft('me', okBody({ informationalPrice: '~₹500' }));
    expect(c.informationalPrice).toEqual({ label: '~₹500', disclaimer: 'informational-only-no-payment' });
    expect((c as unknown as Record<string, unknown>).priceAmount).toBeUndefined();
  });
});
