/**
 * Wave 1C, C6 — error tracking on live Discovery routes + the 5xx alert key.
 * Asserts the marker fires on a real 5xx, is privacy-safe, and does NOT fire on
 * ordinary 4xx (a gate 404 / age 403 / validated refusal is not an incident).
 */

import { ArgumentsHost, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { DiscoveryErrorFilter } from '../src/discovery/discovery-error.filter';

function fakeHost(method: string, urlPath: string): { host: ArgumentsHost; sent: { code?: number; body?: unknown } } {
  const sent: { code?: number; body?: unknown } = {};
  const res = { headersSent: false, status: (n: number) => ({ json: (b: unknown) => { sent.code = n; sent.body = b; } }) };
  const req = { method, originalUrl: urlPath, url: urlPath };
  const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) } as unknown as ArgumentsHost;
  return { host, sent };
}

describe('C6 — discovery_5xx alert marker', () => {
  let logs: string[];
  const orig = console.error;
  beforeEach(() => { logs = []; console.error = (...a: unknown[]) => logs.push(a.map(String).join(' ')); });
  afterEach(() => { console.error = orig; });

  const filter = () => new DiscoveryErrorFilter();

  it('a real 5xx emits ONE discovery_5xx marker with route/status/errorClass — and no identity/location/secret', () => {
    const { host, sent } = fakeHost('POST', '/api/v2/discovery/query?token=SHOULD_NOT_APPEAR');
    filter().catch(new InternalServerErrorException('boom at lat 12.976543'), host);
    const marker = logs.find((l) => l.includes('discovery_5xx'));
    expect(marker).toBeTruthy();
    const json = JSON.parse(marker!.replace(/^discovery_5xx /, ''));
    expect(json.marker).toBe('discovery_5xx');
    expect(json.route).toBe('/api/v2/discovery/query'); // query string stripped
    expect(json.status).toBe(500);
    expect(json.errorClass).toBeTruthy();
    expect(typeof json.correlationId).toBe('string');
    // Privacy of the alert itself: no coordinate, no token, no body, no userId.
    const all = marker!;
    expect(all).not.toContain('12.976543');
    expect(all).not.toContain('SHOULD_NOT_APPEAR');
    expect(all).not.toMatch(/userId|handle|"lat"|"lon"|Bearer/);
    // Client still gets a sanitized 500.
    expect(sent.code).toBe(500);
  });

  it('a 4xx (age 403) does NOT emit the alert marker — refusals are not incidents', () => {
    const { host, sent } = fakeHost('GET', '/api/v2/discovery/visibility');
    filter().catch(new ForbiddenException({ error: 'age_requirement', message: 'nope' }), host);
    expect(logs.find((l) => l.includes('discovery_5xx'))).toBeUndefined();
    expect(sent.code).toBe(403);
  });

  it('an unknown non-HTTP throw is a 500 marker AND a sanitized generic body (no internals leak)', () => {
    const { host, sent } = fakeHost('POST', '/api/v2/discovery/query');
    filter().catch(new Error('secret internal detail: db://user:pass@host'), host);
    expect(logs.find((l) => l.includes('discovery_5xx'))).toBeTruthy();
    expect(JSON.stringify(sent.body)).not.toContain('db://');
    expect(JSON.stringify(sent.body)).toContain('Internal Server Error');
  });
});
