/**
 * Wave 1C, C6 — error tracking on the LIVE Discovery routes + the 5xx alert key.
 *
 * Discovery is the first domain real users touch, so a server error here is an
 * incident, not a log line to find later. This filter turns every 5xx on a
 * Discovery route into a single, GREPPABLE marker — `discovery_5xx` — that an
 * alert rule keys off (Railway log-based alert on the marker's rate, or a Sentry
 * alert once a DSN is configured; the existing `initSentry` infra is DSN-gated).
 *
 * PRIVACY IS PRESERVED IN THE ALERT ITSELF (P3/B5): the marker carries the
 * route, the status, the error CLASS, and a correlation id — never a userId,
 * a handle, a coordinate, a token, or the request body. An alert must be safe
 * to read, forward, and screen-share. 4xx (a gate 404, an age 403, a validated
 * refusal) is NOT an incident and does not emit the marker.
 *
 * The client still gets the sanitized response the controller already produces;
 * this filter observes and re-emits, it does not change the contract.
 */

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

@Catch()
export class DiscoveryErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('DiscoveryErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<{ status: (n: number) => { json: (b: unknown) => void }; headersSent?: boolean }>();
    const req = http.getRequest<{ method?: string; originalUrl?: string; url?: string }>();

    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const route = (req?.originalUrl || req?.url || 'unknown').split('?')[0];

    if (status >= 500) {
      const correlationId = randomUUID();
      // The ALERT KEY. Structured, one line, no identity/position/secret — only
      // aggregation-safe fields. `discovery_5xx` is what the alert rule matches.
      // eslint-disable-next-line no-console
      console.error(
        `discovery_5xx ${JSON.stringify({
          marker: 'discovery_5xx',
          route,
          method: req?.method ?? 'unknown',
          status,
          errorClass: exception instanceof Error ? exception.name : typeof exception,
          correlationId,
        })}`,
      );
      // Sentry (if a DSN is configured via the Phase-1G initSentry infra) receives
      // the error object; disabled and silent otherwise. Never the request body.
      const g = globalThis as { __SENTRY__?: { captureException?: (e: unknown, ctx?: unknown) => void } };
      g.__SENTRY__?.captureException?.(exception, { tags: { domain: 'discovery', route }, correlationId });
    }

    if (res?.headersSent) return;
    // Preserve the existing sanitized contract: HttpException bodies pass
    // through; anything else is a generic 500 that reveals nothing.
    const body =
      exception instanceof HttpException
        ? exception.getResponse()
        : { statusCode: 500, error: 'Internal Server Error' };
    res.status(status).json(body);
  }
}
