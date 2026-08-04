/**
 * Exchange policy — validation, coarsening, ceilings, the lifecycle transition
 * table, and the signed keyset cursor. The server half of the privacy + safety
 * boundary: a precise-shaped payload is refused, coordinates are re-quantized to
 * the coarse grid, an age/gender field is structurally unsupported (A3), and no
 * payment field is accepted.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ExchangeError, preciseLocationRefused } from './exchange.errors';
import {
  EXCHANGE_CONTRACTS_VERSION,
  ExchangeDecodedCursor,
  ExchangeIntentStatus,
  ValidatedExchangeIntentInput,
} from './exchange.types';

export const EXCHANGE_POLICY_DEFAULTS = {
  maxRadiusKm: 25,
  defaultRadiusKm: 5,
  maxPageSize: 30,
  defaultPageSize: 20,
  maxCursorDepth: 20,
  /** TTL ceiling for an intent's expiry (hours) — [PROPOSED] 24 h default. */
  maxExpiryHours: 24 * 30,
  defaultExpiryHours: 24,
  /** Coarse grid decimals (ADR-018 cell supersedes at activation). */
  coarseGridDecimals: 3,
  maxTitle: 140,
  maxText: 2000,
  maxTags: 12,
} as const;

const INPUT_KEYS = new Set([
  'kind', 'category', 'title', 'text', 'tags', 'budgetBand', 'informationalPrice',
  'availability', 'origin', 'radiusKm', 'visibility', 'idempotencyKey', 'expiresInHours',
]);
const ORIGIN_KEYS = new Set(['lat', 'lon', 'cell']);
const PRECISE_SHAPE_MARKERS = ['accuracy', 'altitude', 'altitudeAccuracy', 'heading', 'speed', 'timestamp', 'coords', 'latitude', 'longitude'];
/** A precise coordinate / coordinate-pair shape (for refusing a crafted cell). */
const COORDINATE_SHAPE = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}|-?\d{1,3}\.\d{4,}/;
const KINDS = new Set(['need', 'offer', 'service']);
const BUDGET = new Set(['low', 'medium', 'high']);
const VISIBILITY = new Set(['hidden', 'discoverable']);

const bad = (msg: string, nextStep: string) => new ExchangeError('MALFORMED_INTENT', msg, false, nextStep);

function assertExactKeys(obj: Record<string, unknown>, allowed: Set<string>, what: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new ExchangeError(
        'UNSUPPORTED_FIELD',
        `unsupported field '${k}' in ${what}`,
        false,
        "send only the documented fields; age/gender fields do not exist (A3), and there is no payment field",
      );
    }
  }
}

/* ------------------------------------------------------------ cursor (signed) */

const CURSOR_KEY: Buffer =
  process.env.EXCHANGE_CURSOR_SECRET && process.env.EXCHANGE_CURSOR_SECRET.length >= 16
    ? Buffer.from(process.env.EXCHANGE_CURSOR_SECRET, 'utf8')
    : randomBytes(32);
const sig = (p: string) => createHmac('sha256', CURSOR_KEY).update(p).digest('base64url').slice(0, 22);
const invalidCursor = () => new ExchangeError('INVALID_CURSOR', 'cursor is not one we issued', false, 'restart from the first page');

export function encodeCursor(c: ExchangeDecodedCursor): string {
  const p = Buffer.from(JSON.stringify({ t: c.t, i: c.i, depth: c.depth }), 'utf8').toString('base64url');
  return `${p}.${sig(p)}`;
}

export function decodeCursor(raw: string): ExchangeDecodedCursor {
  const dot = raw.indexOf('.');
  if (dot <= 0) throw invalidCursor();
  const p = raw.slice(0, dot);
  const a = Buffer.from(raw.slice(dot + 1));
  const b = Buffer.from(sig(p));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw invalidCursor();
  let parsed: Partial<ExchangeDecodedCursor>;
  try {
    parsed = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (
    typeof parsed?.t !== 'number' || !Number.isFinite(parsed.t) ||
    typeof parsed?.i !== 'string' || !parsed.i ||
    typeof parsed?.depth !== 'number' || !Number.isInteger(parsed.depth) || parsed.depth < 0
  ) throw invalidCursor();
  return { t: parsed.t, i: parsed.i, depth: parsed.depth };
}

/* ---------------------------------------------------------- input validation */

export function validateIntentInput(
  ownerId: string,
  body: unknown,
  now = new Date(),
  policy = EXCHANGE_POLICY_DEFAULTS,
): ValidatedExchangeIntentInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('intent must be an object', 'send the documented shape');
  const b = body as Record<string, unknown>;
  if (PRECISE_SHAPE_MARKERS.some((m) => m in b)) throw preciseLocationRefused();
  assertExactKeys(b, INPUT_KEYS, 'intent');

  const kind = b.kind;
  if (typeof kind !== 'string' || !KINDS.has(kind)) throw bad('kind must be need|offer|service', 'send a valid kind');
  const category = b.category;
  if (typeof category !== 'string' || !category || category.length > 64) throw bad('category must be a short string', 'send a category label');
  const title = b.title;
  if (typeof title !== 'string' || !title || title.length > policy.maxTitle) throw bad('title required, bounded', `<= ${policy.maxTitle} chars`);
  const text = b.text;
  if (typeof text !== 'string' || !text || text.length > policy.maxText) throw bad('text required, bounded', `<= ${policy.maxText} chars`);
  let tags: string[] = [];
  if ('tags' in b) {
    if (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== 'string') || b.tags.length > policy.maxTags) {
      throw bad('tags must be a bounded string array', `<= ${policy.maxTags} tags`);
    }
    tags = b.tags as string[];
  }
  let budgetBand: 'low' | 'medium' | 'high' | undefined;
  if ('budgetBand' in b) {
    if (typeof b.budgetBand !== 'string' || !BUDGET.has(b.budgetBand)) throw bad('budgetBand must be low|medium|high', 'send a band, never an exact amount');
    budgetBand = b.budgetBand as 'low' | 'medium' | 'high';
  }
  // informationalPrice is display-only: a label, never a number/amount.
  let informationalPrice: string | undefined;
  if ('informationalPrice' in b) {
    if (typeof b.informationalPrice !== 'string' || b.informationalPrice.length > 40) throw bad('informationalPrice must be a short label', 'display label only — Exchange takes no payment');
    informationalPrice = b.informationalPrice;
  }

  /* availability */
  let availabilityState: 'window' | 'recurring' | 'unknown' = 'unknown';
  let availabilityFrom: Date | undefined, availabilityTo: Date | undefined, availabilitySchedule: string | undefined;
  if ('availability' in b) {
    const av = b.availability as Record<string, unknown>;
    if (!av || typeof av !== 'object') throw bad('availability must be an object', 'send {state,...}');
    if (av.state === 'window') {
      const f = Date.parse(String(av.fromIso)), t = Date.parse(String(av.toIso));
      if (!Number.isFinite(f) || !Number.isFinite(t) || t <= f) throw bad('availability window invalid', 'send fromIso < toIso');
      availabilityState = 'window'; availabilityFrom = new Date(f); availabilityTo = new Date(t);
    } else if (av.state === 'recurring') {
      if (typeof av.scheduleLabel !== 'string' || !av.scheduleLabel) throw bad('recurring needs a scheduleLabel', 'send a label');
      availabilityState = 'recurring'; availabilitySchedule = av.scheduleLabel;
    } else if (av.state !== 'unknown') {
      throw bad('availability.state must be window|recurring|unknown', 'send a valid state');
    }
  }

  /* origin — coarse contract only, re-quantized server-side */
  const origin = b.origin as Record<string, unknown> | undefined;
  if (!origin || typeof origin !== 'object') throw bad('origin missing', 'send a coarse origin {lat, lon}');
  if (PRECISE_SHAPE_MARKERS.some((m) => m in origin)) throw preciseLocationRefused();
  assertExactKeys(origin, ORIGIN_KEYS, 'origin');
  const lat = origin.lat, lon = origin.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) throw bad('origin lat/lon must be finite', 'send the coarse origin');
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw bad('origin out of range', 'send WGS84 coordinates');
  const q = 10 ** policy.coarseGridDecimals;
  const coarseLat = Math.round(lat * q) / q;
  const coarseLon = Math.round(lon * q) / q;
  // The cell is ALWAYS server-derived from the coarsened point — a client
  // `origin.cell` is NEVER trusted (review CELL-BYPASS). Trusting it would let
  // a precise coordinate ride the cell string into the DB, the public browse
  // projection, and the search index despite lat/lon being re-quantized. A
  // client-supplied cell (if any) must exactly match the derived form or it is
  // refused; a precise-shaped cell is refused outright.
  const derivedCell = `g${coarseLat.toFixed(policy.coarseGridDecimals)}:${coarseLon.toFixed(policy.coarseGridDecimals)}`;
  if ('cell' in origin) {
    if (typeof origin.cell !== 'string') throw bad('origin.cell must be a string', 'omit cell; it is derived server-side');
    if (COORDINATE_SHAPE.test(origin.cell)) throw preciseLocationRefused();
    if (origin.cell && origin.cell !== derivedCell) throw bad('origin.cell does not match the coarse grid', 'omit cell; it is derived server-side from the coarse point');
  }
  const coarseCell = derivedCell;

  /* radius */
  let radiusKm: number = policy.defaultRadiusKm;
  if ('radiusKm' in b) {
    if (typeof b.radiusKm !== 'number' || !Number.isFinite(b.radiusKm) || b.radiusKm <= 0) throw bad('radiusKm must be positive', 'send km');
    if (b.radiusKm > policy.maxRadiusKm) throw new ExchangeError('RADIUS_OUT_OF_BOUNDS', `radius ${b.radiusKm} exceeds ${policy.maxRadiusKm} km`, false, `retry with <= ${policy.maxRadiusKm} km`);
    radiusKm = b.radiusKm;
  }

  let visibility: 'hidden' | 'discoverable' = 'hidden';
  if ('visibility' in b) {
    if (typeof b.visibility !== 'string' || !VISIBILITY.has(b.visibility)) throw bad('visibility must be hidden|discoverable', 'send a valid visibility');
    visibility = b.visibility as 'hidden' | 'discoverable';
  }

  const idempotencyKey = b.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 128) throw bad('idempotencyKey required', 'send a stable client key');

  let ttlHours: number = policy.defaultExpiryHours;
  if ('expiresInHours' in b) {
    if (typeof b.expiresInHours !== 'number' || !Number.isFinite(b.expiresInHours) || b.expiresInHours <= 0) throw bad('expiresInHours must be positive', 'omit or send hours');
    ttlHours = Math.min(b.expiresInHours, policy.maxExpiryHours);
  }
  const expiresAt = new Date(now.getTime() + ttlHours * 3600_000);

  return {
    ownerId, ownerKind: 'user', kind: kind as 'need' | 'offer' | 'service',
    category, title, text, tags, budgetBand, informationalPrice,
    availabilityState, availabilityFrom, availabilityTo, availabilitySchedule,
    coarseLat, coarseLon, coarseCell, radiusKm, maxRadiusKm: policy.maxRadiusKm,
    visibility, idempotencyKey, expiresAt,
  };
}

/* ----------------------------------------------------- lifecycle transitions */

/** The allowed status transitions (mission §15). A transition not listed is an
 *  ILLEGAL_TRANSITION — the state machine is closed. */
export const EXCHANGE_TRANSITIONS: Record<ExchangeIntentStatus, ReadonlyArray<ExchangeIntentStatus>> = {
  draft: ['active', 'withdrawn', 'removed'],
  active: ['paused', 'matched', 'fulfilled', 'expired', 'withdrawn', 'removed'],
  paused: ['active', 'expired', 'withdrawn', 'removed'],
  matched: ['active', 'fulfilled', 'expired', 'withdrawn', 'removed'],
  fulfilled: [],
  expired: [],
  withdrawn: [],
  removed: [],
};

export function assertTransition(from: ExchangeIntentStatus, to: ExchangeIntentStatus): void {
  if (!EXCHANGE_TRANSITIONS[from]?.includes(to)) {
    throw new ExchangeError('ILLEGAL_TRANSITION', `cannot move an intent from '${from}' to '${to}'`, false, 'refresh the intent and retry a legal transition');
  }
}
export { EXCHANGE_CONTRACTS_VERSION };
