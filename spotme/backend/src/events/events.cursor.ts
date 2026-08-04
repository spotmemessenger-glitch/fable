/**
 * Live Nearby Events — signed, depth-bounded keyset cursor (Phase 4B).
 *
 * The cursor is `base64url(payload).sig` where sig is an HMAC over the payload
 * (env key or a per-process random key). A forged/edited cursor fails the
 * signature check; `depth` bounds how far a client may page (anti-enumeration).
 * Mirrors the exchange cursor discipline.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventsError } from './events.errors';

export interface EventDecodedCursor {
  /** Keyset anchor: the last row's start instant (epoch ms; 0 for null starts). */
  t: number;
  /** Keyset anchor: the last row's id. */
  i: string;
  /** Pages consumed so far — bounds enumeration. */
  depth: number;
}

/** Deepest page a signed cursor may reach before we refuse (anti-enumeration). */
export const MAX_CURSOR_DEPTH = 50;

const CURSOR_KEY: Buffer =
  process.env.EVENTS_CURSOR_SECRET && process.env.EVENTS_CURSOR_SECRET.length >= 16
    ? Buffer.from(process.env.EVENTS_CURSOR_SECRET, 'utf8')
    : randomBytes(32);

const sig = (p: string) => createHmac('sha256', CURSOR_KEY).update(p).digest('base64url').slice(0, 22);
const invalid = () => new EventsError('INVALID_CURSOR', 'cursor is not one we issued', false, 'restart from the first page (no cursor)');

export function encodeCursor(c: EventDecodedCursor): string {
  const p = Buffer.from(JSON.stringify({ t: c.t, i: c.i, depth: c.depth }), 'utf8').toString('base64url');
  return `${p}.${sig(p)}`;
}

export function decodeCursor(raw: string): EventDecodedCursor {
  const dot = raw.indexOf('.');
  if (dot <= 0) throw invalid();
  const p = raw.slice(0, dot);
  const a = Buffer.from(raw.slice(dot + 1));
  const b = Buffer.from(sig(p));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw invalid();
  let parsed: Partial<EventDecodedCursor>;
  try {
    parsed = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (
    typeof parsed?.t !== 'number' || !Number.isFinite(parsed.t) ||
    typeof parsed?.i !== 'string' || !parsed.i ||
    typeof parsed?.depth !== 'number' || !Number.isInteger(parsed.depth) || parsed.depth < 0
  ) throw invalid();
  if (parsed.depth > MAX_CURSOR_DEPTH) {
    throw new EventsError('CURSOR_TOO_DEEP', 'pagination depth limit reached', false, 'narrow the query (category, time window) instead of paging further');
  }
  return { t: parsed.t, i: parsed.i, depth: parsed.depth };
}
