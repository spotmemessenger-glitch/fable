/**
 * Nearby Moments — signed, depth-bounded keyset cursor (anti-enumeration).
 * Same discipline as the exchange/events cursors: HMAC over the payload
 * (env key or per-process random), depth bound, timing-safe verify.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { MomentsError } from './moments.errors';

export interface MomentDecodedCursor {
  t: number;
  i: string;
  depth: number;
}

export const MAX_CURSOR_DEPTH = 50;

const KEY: Buffer =
  process.env.MOMENTS_CURSOR_SECRET && process.env.MOMENTS_CURSOR_SECRET.length >= 16
    ? Buffer.from(process.env.MOMENTS_CURSOR_SECRET, 'utf8')
    : randomBytes(32);

const sig = (p: string) => createHmac('sha256', KEY).update(p).digest('base64url').slice(0, 22);
const invalid = () => new MomentsError('INVALID_CURSOR', 'cursor is not one we issued', false, 'restart from the first page');

export function encodeCursor(c: MomentDecodedCursor): string {
  const p = Buffer.from(JSON.stringify({ t: c.t, i: c.i, depth: c.depth }), 'utf8').toString('base64url');
  return `${p}.${sig(p)}`;
}

export function decodeCursor(raw: string): MomentDecodedCursor {
  const dot = raw.indexOf('.');
  if (dot <= 0) throw invalid();
  const p = raw.slice(0, dot);
  const a = Buffer.from(raw.slice(dot + 1));
  const b = Buffer.from(sig(p));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw invalid();
  let parsed: Partial<MomentDecodedCursor>;
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
    throw new MomentsError('CURSOR_TOO_DEEP', 'pagination depth limit reached', false, 'narrow the feed (mode, category) instead of paging further');
  }
  return { t: parsed.t, i: parsed.i, depth: parsed.depth };
}
