/**
 * Phase 6B — deterministic intent routing + sensitive-query classification
 * (X9). Routing is a pure function of the text; classification yields ONLY a
 * closed category; the [PROPOSED] notice copy invents no hotline, number, or
 * diagnosis language.
 */

import { DeterministicAssistantIntentRouter } from '../src/assistant/assistant.intent';
import {
  SENSITIVE_NOTICE_COPY, classifySensitiveQuery, sensitiveNoticeFor,
} from '../src/assistant/assistant.sensitive';

describe('deterministic assistant intent routing', () => {
  const router = new DeterministicAssistantIntentRouter();

  it('routes @handle to username with the extracted handle', () => {
    expect(router.parse('@ash_a')).toEqual({ domain: 'username', handle: 'ash_a' });
  });

  it('routes domain keywords to events / exchange / people', () => {
    expect(router.parse('concerts this weekend').domain).toBe('events');
    expect(router.parse('anyone want to swap books?').domain).toBe('exchange');
    expect(router.parse("who's nearby right now").domain).toBe('people');
  });

  it('defaults to places — the map is the surface', () => {
    expect(router.parse('quiet cafe with wifi').domain).toBe('places');
    expect(router.parse('').domain).toBe('places');
  });

  it('is deterministic: identical text, identical intent', () => {
    const a = router.parse('rooftop shows tonight');
    const b = router.parse('rooftop shows tonight');
    expect(a).toEqual(b);
  });
});

describe('sensitive-query classification (X9)', () => {
  it('classifies to CLOSED categories', () => {
    expect(classifySensitiveQuery('clinic for these symptoms')).toBe('health');
    expect(classifySensitiveQuery('I want to hurt myself')).toBe('crisis');
    expect(classifySensitiveQuery('need a lawyer for a custody case')).toBe('legal');
    expect(classifySensitiveQuery('drowning in payday loan debt')).toBe('financial');
    expect(classifySensitiveQuery('best coffee near the plaza')).toBe('none');
  });

  it('crisis wins over a co-occurring health word', () => {
    expect(classifySensitiveQuery('depression medication overdose')).toBe('crisis');
  });

  it('returns ONLY the category — never an object carrying the text', () => {
    const result = classifySensitiveQuery('my private health question');
    expect(typeof result).toBe('string');
  });

  it('[PROPOSED] copy invents no hotline/phone number — the copy contains no digits at all', () => {
    for (const copy of Object.values(SENSITIVE_NOTICE_COPY)) {
      expect(copy).not.toMatch(/[0-9]/);
    }
  });

  it('[PROPOSED] copy makes no diagnosis/treatment/emergency-suitability claims and points to professionals', () => {
    for (const copy of Object.values(SENSITIVE_NOTICE_COPY)) {
      expect(copy.toLowerCase()).toMatch(/professional|emergency services/);
      expect(copy.toLowerCase()).not.toMatch(/\byou (have|should take|need)\b/);
    }
    expect(SENSITIVE_NOTICE_COPY.crisis).toContain('cannot assess emergencies');
    expect(sensitiveNoticeFor('none')).toBeNull();
  });
});
