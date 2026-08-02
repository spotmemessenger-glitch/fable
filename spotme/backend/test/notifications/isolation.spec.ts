import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ContentlessEnvelopeBuilder } from '../../src/notifications/envelope/contentless-envelope.builder';
import { EncryptedEnvelopeBuilder } from '../../src/notifications/envelope/encrypted-envelope.seam';
import { NotificationFlags } from '../../src/notifications/notifications.config';

/**
 * FENCES (design §4.4, §17.3). These are build-breaking guards that keep the
 * notification platform ISOLATED from the Priority-1 crypto programme and
 * CONTENT-LESS by construction. If any of these fail, the crypto/isolation
 * invariant has been violated and the change must not ship.
 */

const NOTIF_DIR = join(__dirname, '..', '..', 'src', 'notifications');
const APP_MODULE = join(__dirname, '..', '..', 'src', 'app.module.ts');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('notification platform isolation fences', () => {
  const files = walk(NOTIF_DIR);

  it('has source files to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('imports NOTHING from the Priority-1 message-identity crypto', () => {
    // node:crypto (used only for an opaque collapse HASH, not a key) is allowed;
    // signing/ratchet/x3dh/prekey/e2e and any web/ crypto module are forbidden.
    const FORBIDDEN =
      /from\s+['"][^'"]*(signing-key|signing-identity|ratchet|x3dh|prekey|double-ratchet|\/e2e|web\/src)[^'"]*['"]/i;
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (FORBIDDEN.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('generates NO notification key anywhere in the module', () => {
    // Guards against key GENERATION primitives and the notifPriv symbol. Reading
    // the pre-existing VAPID credential from env (shipped web-push behaviour) is
    // NOT generation and is deliberately not matched here.
    const FORBIDDEN =
      /(generateKeyPair|generateKeySync|createPrivateKey|subtle\.generateKey|notifPriv)/;
    const offenders: string[] = [];
    for (const f of files) {
      if (FORBIDDEN.test(readFileSync(f, 'utf8'))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('the encrypted envelope is a documented SEAM only — it throws, ships no crypto', () => {
    const builder = new EncryptedEnvelopeBuilder();
    expect(builder.kind).toBe('encrypted');
    expect(() =>
      builder.build({
        routed: {} as never,
        target: { deviceId: 'd' },
        notifId: 'n',
        count: 1,
      }),
    ).toThrow(/documented seam|security review/i);
  });

  it('is NOT imported by AppModule (not wired into the running app)', () => {
    const app = readFileSync(APP_MODULE, 'utf8');
    expect(app).not.toMatch(/NotificationsModule/);
    expect(app).not.toMatch(/notifications\//);
  });

  it('defaults the master flag OFF when the env is unset', () => {
    const prev = process.env.NOTIFICATIONS_V2_ENABLED;
    delete process.env.NOTIFICATIONS_V2_ENABLED;
    try {
      expect(new NotificationFlags().enabled).toBe(false);
      expect(new NotificationFlags().outboxEnabled).toBe(false);
      // The encrypted-native path is hard-off regardless of env.
      process.env.NOTIF_ENCRYPTED_NATIVE = 'true';
      expect(new NotificationFlags().encryptedNativeEnabled).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NOTIFICATIONS_V2_ENABLED;
      else process.env.NOTIFICATIONS_V2_ENABLED = prev;
      delete process.env.NOTIF_ENCRYPTED_NATIVE;
    }
  });
});

describe('content-less envelope (the shipped floor)', () => {
  const builder = new ContentlessEnvelopeBuilder();

  it('emits generic title/body + metadata-only data (no room id, no route, no content)', () => {
    const msg = builder.build({
      routed: {
        class: 'message',
        recipientId: 'uB',
        roomId: 'r1',
        eventSeq: 7,
        priority: 'high',
        ttlSeconds: 3600,
        dedupeKey: 'd',
        collapseKey: 'ck',
        wireCollapseId: 'opaque16charsXX',
        route: 'thread/r1',
        title: 'Alice',
        body: 'New message',
      },
      target: { deviceId: 'dev1', token: 'tok' },
      notifId: 'ntf_1',
      count: 3,
    });

    expect(msg.title).toBe('Alice');
    expect(msg.body).toBe('New message');
    expect(msg.collapseId).toBe('opaque16charsXX');
    // Data is metadata only.
    expect(Object.keys(msg.data).sort()).toEqual(['c', 'k', 'n']);
    expect(msg.data.c).toBe('3');
    // The room id and route never appear on the wire in the floor.
    expect(JSON.stringify(msg)).not.toContain('r1');
    expect(JSON.stringify(msg)).not.toContain('thread/');
  });
});
