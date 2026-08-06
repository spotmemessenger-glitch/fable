/**
 * Phase 6B — the X9 query-privacy battery. The QueryHandle cannot serialize
 * its text; errors carry closed codes only; correlation ids are random, never
 * text-derived; the telemetry shape has no field text could ride; and every
 * service response is text-free even on error paths.
 */

import { AssistantError } from '../src/assistant/assistant.errors';
import { QueryHandle, mintCorrelationId, telemetryContext } from '../src/assistant/assistant.privacy';
import { DeterministicAssistantIntentRouter } from '../src/assistant/assistant.intent';
import { DeterministicSummaryComposer } from '../src/assistant/assistant.compose';
import { LiveDomainDarknessAdapter } from '../src/assistant/assistant.registry';
import { AssistantService } from '../src/assistant/assistant.service';
import { UnavailableEvidenceAdapter } from '../src/assistant/assistant.ports';

const MARKER = 'zx-unique-query-marker-9q';

function liveService(): AssistantService {
  const u = new UnavailableEvidenceAdapter();
  return new AssistantService(
    new LiveDomainDarknessAdapter(),
    new DeterministicAssistantIntentRouter(),
    new DeterministicSummaryComposer(),
    u, u, u, u, u,
  );
}

describe('QueryHandle (X9)', () => {
  it('cannot serialize its text — JSON/string/inspect all yield the placeholder', () => {
    const h = new QueryHandle(`where is the ${MARKER} clinic`);
    expect(JSON.stringify(h)).not.toContain(MARKER);
    expect(String(h)).toBe('[assistant-query]');
    expect(JSON.stringify({ nested: { h } })).not.toContain(MARKER);
  });

  it('has a bounded lifetime: read() after dispose() throws; no revival', () => {
    const h = new QueryHandle('short lived');
    expect(h.read()).toBe('short lived');
    h.dispose();
    expect(h.disposed).toBe(true);
    expect(() => h.read()).toThrow(AssistantError);
  });

  it('rejects non-string / empty / oversized input with CLOSED details only', () => {
    for (const bad of [null, undefined, 42, {}, '', '   ', 'x'.repeat(513)]) {
      try {
        new QueryHandle(bad);
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(AssistantError);
        const err = e as AssistantError;
        expect(err.code).toBe('invalid-query');
        // The message is code+closed-detail only — never the input.
        expect(err.message).toMatch(/^invalid-query(: [a-z-]+)?$/);
      }
    }
  });

  it('strips control characters at the boundary', () => {
    const h = new QueryHandle('cafe\u0007 near plaza');
    expect(h.read()).toBe('cafe near plaza');
  });
});

describe('correlation ids (X9)', () => {
  it('are unique per request and not derived from the text', () => {
    const a = mintCorrelationId();
    const b = mintCorrelationId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^asst-[0-9a-f-]{36}$/);
  });
});

describe('telemetry context (X9)', () => {
  it('is a closed-field shape — no property can carry query text', () => {
    const ctx = telemetryContext('asst-x', 'places', 'domain-not-active', 'none', 12.7);
    expect(Object.keys(ctx).sort()).toEqual(
      ['answerKind', 'correlationId', 'domain', 'durationMs', 'sensitiveCategory']);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(ctx.durationMs).toBe(13);
  });
});

describe('AssistantError (X9)', () => {
  it('refuses free-text details — only closed identifiers survive', () => {
    const e = new AssistantError('invalid-query', `the user asked ${MARKER}` as string);
    expect(e.detail).toBeNull();
    expect(e.message).toBe('invalid-query');
  });
});

describe('service responses are text-free on every path (X9)', () => {
  it('normal path: the serialized response never contains the query text', async () => {
    const res = await liveService().answer(`find the ${MARKER} clinic`);
    expect(JSON.stringify(res)).not.toContain(MARKER);
    expect(res.sensitiveCategory).toBe('health');
    expect(res.answer.kind).toBe('domain-not-active');
  });

  it('sensitive path: only the closed category and the [PROPOSED] notice leave', async () => {
    const res = await liveService().answer(`${MARKER} suicidal thoughts help`);
    expect(res.sensitiveCategory).toBe('crisis');
    expect(JSON.stringify(res)).not.toContain(MARKER);
    expect(res.sensitiveNotice).not.toMatch(/[0-9]/); // no invented numbers
  });

  it('error path: invalid queries throw with closed codes, no echo of the input', async () => {
    await expect(liveService().answer(123)).rejects.toMatchObject({ code: 'invalid-query' });
    try {
      await liveService().answer(`${'y'.repeat(600)}${MARKER}`);
    } catch (e) {
      expect(JSON.stringify({ m: (e as Error).message, s: (e as Error).stack?.split('\n')[0] }))
        .not.toContain(MARKER);
    }
  });
});

describe('no persistence in the assistant subtree (light 6B check; full fence in 6E)', () => {
  it('the assistant module wires no repository/prisma provider', () => {
    // The module file is the composition root — its source names every
    // provider. A prisma/repository binding appearing there would be the
    // first step toward query persistence.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'assistant', 'assistant.module.ts'), 'utf8');
    expect(src).not.toMatch(/prisma|repository|redis|bullmq/i);
  });
});
