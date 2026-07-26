import { NextRequest, NextResponse } from "next/server";

/**
 * Shared abuse-resistance layer for the three key-holding proxy routes
 * (/api/agent, /api/tts, /api/stt). Two independent defenses:
 *
 * 1. Origin allowlist — browsers send `Origin` on cross-origin fetches; if
 *    it's present and not one of ours, reject before touching the upstream
 *    API. A missing Origin (non-browser client, some same-origin cases) is
 *    allowed through — this blocks casual hotlinking/embedding from other
 *    sites without breaking legitimate callers that don't send it.
 * 2. Rate limiting — a fixed-window counter keyed by client IP, held in
 *    module scope. Edge functions can spin up multiple isolates, so this is
 *    a best-effort deterrent against a single hot client (script, bot),
 *    not a distributed guarantee — a real production limiter would use
 *    Upstash/Vercel KV for a shared counter across regions.
 */

const ALLOWED_ORIGINS = [
  "https://ysnapai.com",
  "https://www.ysnapai.com",
  "http://localhost:3000",
  "http://localhost:3001",
];
/** Vercel prod alias, per-branch aliases, and preview deployment URLs. */
const VERCEL_ORIGIN_RE = /^https:\/\/ysnap(-[a-z0-9-]+)?\.vercel\.app$/i;

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true; // no Origin header — not a cross-origin browser request
  return ALLOWED_ORIGINS.includes(origin) || VERCEL_ORIGIN_RE.test(origin);
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
/** Hard cap on tracked keys so a distributed-IP flood can't grow this unbounded. */
const MAX_TRACKED_KEYS = 5000;

export function clientKey(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/** Returns null if allowed, or the number of seconds to wait if rate-limited. */
export function rateLimit(key: string, limit: number, windowMs: number): number | null {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    if (buckets.size >= MAX_TRACKED_KEYS) buckets.clear(); // crude pressure release
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  existing.count++;
  if (existing.count > limit) return Math.ceil((existing.resetAt - now) / 1000);
  return null;
}

/** Runs both checks; returns a Response to short-circuit with, or null to proceed. */
export function guard(
  req: NextRequest,
  route: string,
  limit: number,
  windowMs: number,
): NextResponse | null {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return NextResponse.json(
      { error: "origin not allowed" },
      { status: 403, headers: corsHeaders(origin) },
    );
  }
  const retryAfter = rateLimit(`${route}:${clientKey(req)}`, limit, windowMs);
  if (retryAfter !== null) {
    return NextResponse.json(
      { error: "rate limited" },
      {
        status: 429,
        headers: { ...corsHeaders(origin), "Retry-After": String(retryAfter) },
      },
    );
  }
  return null;
}
