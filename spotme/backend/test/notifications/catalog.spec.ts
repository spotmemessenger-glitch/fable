import { NotificationCatalog } from '../../src/notifications/catalog/notification-catalog';
import { NOTIFICATION_CLASSES } from '../../src/notifications/catalog/notification-class';

/**
 * The catalog is the single source of per-class policy. These pin the
 * deliberate differences between classes (design §1 table, §8.6) so a careless
 * edit that, say, makes a call collapsible or a story max-priority is caught.
 */
describe('NotificationCatalog', () => {
  const catalog = new NotificationCatalog();

  it('resolves a policy for every declared class', () => {
    for (const cls of NOTIFICATION_CLASSES) {
      const p = catalog.policy(cls);
      expect(p.class).toBe(cls);
      expect(p.ttlSeconds).toBeGreaterThan(0);
    }
    expect(catalog.all()).toHaveLength(NOTIFICATION_CLASSES.length);
  });

  it('keeps message = today’s behaviour: high, per-room, long TTL, on by default', () => {
    const p = catalog.policy('message');
    expect(p.priority).toBe('high');
    expect(p.collapse).toBe('per-room');
    expect(p.ttlSeconds).toBeGreaterThanOrEqual(3600);
    expect(p.defaultEnabled).toBe(true);
  });

  it('treats a call as max-priority, never-collapse, short-TTL, DND-piercing', () => {
    const p = catalog.policy('call');
    expect(p.priority).toBe('max');
    expect(p.collapse).toBe('never');
    expect(p.ttlSeconds).toBeLessThanOrEqual(60); // a late call is noise
    expect(p.canPierceDnd).toBe(true);
    expect(p.defaultEnabled).toBe(false); // needs the P5 producer + sign-off
  });

  it('gives story the battery-friendly low priority and mention the mentions level', () => {
    expect(catalog.policy('story').priority).toBe('low');
    expect(catalog.policy('mention').minLevel).toBe('mentions');
    expect(catalog.policy('mention').defaultEnabled).toBe(false); // owner decision
  });

  it('marks the security family critical (security channel) and off by default', () => {
    for (const cls of ['security', 'login', 'verification'] as const) {
      expect(catalog.policy(cls).channel).toBe('security');
      expect(catalog.policy(cls).defaultEnabled).toBe(false);
    }
  });

  it('renders a route from server-known ids only, and empty for silent', () => {
    expect(catalog.renderRoute('message', { room: 'r1' })).toBe('thread/r1');
    expect(catalog.renderRoute('call', { call: 'c9' })).toBe('call/c9');
    expect(catalog.renderRoute('story', { actor: 'alice' })).toBe('story/alice');
    expect(catalog.renderRoute('silent', {})).toBe('');
  });

  it('recognises known classes and throws on an unknown one', () => {
    expect(catalog.isKnown('message')).toBe(true);
    expect(catalog.isKnown('nope')).toBe(false);
    expect(() => catalog.policy('nope' as never)).toThrow(/unknown/);
  });

  it('never carries message content: title/body are generic templates only', () => {
    for (const p of catalog.all()) {
      // The only interpolation token is {actor} (display identity), never content.
      const dynamic = p.titleTemplate.match(/\{(\w+)\}/g) ?? [];
      for (const tok of dynamic) expect(tok).toBe('{actor}');
    }
  });
});
