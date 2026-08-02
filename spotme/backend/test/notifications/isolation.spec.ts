import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ContentlessEnvelopeBuilder } from '../../src/notifications/envelope/contentless-envelope.builder';
import { EncryptedEnvelopeBuilder } from '../../src/notifications/envelope/encrypted-envelope.builder';
import { NotificationFlags } from '../../src/notifications/notifications.config';
import * as notifCrypto from '../../src/notifications/envelope/notif-crypto';

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

  it('CONFINES every key/seal primitive to the allowlisted notif-crypto module', () => {
    // The gated encrypted path needs real crypto (X25519/ECDH/AES-GCM). Rather
    // than ban it everywhere (it must exist to be shippable later), we CONFINE
    // it: the key-generation + sealing primitives may appear ONLY in the one
    // reviewable file, `notif-crypto.ts`. Anywhere else is a fence breach —
    // scattered crypto is exactly what makes a module unauditable.
    const PRIMITIVE =
      /(generateKeyPair|generateKeySync|createPrivateKey|createCipheriv|createDecipheriv|diffieHellman|subtle\.generateKey|notifPriv)/;
    const ALLOWLIST = new Set(['notif-crypto.ts']);
    const offenders: string[] = [];
    for (const f of files) {
      if (PRIMITIVE.test(readFileSync(f, 'utf8')) && !ALLOWLIST.has(basename(f))) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('NEVER persists a device notification private key (public half only)', () => {
    // The server registers only the PUBLIC notification key. No Prisma write in
    // the module may store a private key, and no code outside the device-side
    // helpers may reference a persisted `notifPriv`/`devicePrivateKey` field.
    const PERSIST_PRIVATE = /notif(ication)?Priv(ate)?Key\s*:/i;
    const offenders: string[] = [];
    for (const f of files) {
      if (PERSIST_PRIVATE.test(readFileSync(f, 'utf8'))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('the encrypted builder is GATED: with the sub-flag off it throws before any crypto', () => {
    const seal = jest.spyOn(notifCrypto, 'sealRichPayload');
    try {
      // Master flag on, sub-flag OFF (the default). Must throw and NOT seal.
      const prevMaster = process.env.NOTIFICATIONS_V2_ENABLED;
      const prevSub = process.env.NOTIF_ENCRYPTED_PAYLOAD_ENABLED;
      process.env.NOTIFICATIONS_V2_ENABLED = 'true';
      delete process.env.NOTIF_ENCRYPTED_PAYLOAD_ENABLED;
      try {
        const builder = new EncryptedEnvelopeBuilder(new NotificationFlags());
        expect(builder.kind).toBe('encrypted');
        expect(() =>
          builder.build({
            routed: { class: 'message' } as never,
            target: { deviceId: 'd', notifPublicKey: 'x' },
            notifId: 'n',
            count: 1,
          }),
        ).toThrow(/gated|security review|ADR-008/i);
        expect(seal).not.toHaveBeenCalled();
      } finally {
        if (prevMaster === undefined) delete process.env.NOTIFICATIONS_V2_ENABLED;
        else process.env.NOTIFICATIONS_V2_ENABLED = prevMaster;
        if (prevSub === undefined) delete process.env.NOTIF_ENCRYPTED_PAYLOAD_ENABLED;
        else process.env.NOTIF_ENCRYPTED_PAYLOAD_ENABLED = prevSub;
      }
    } finally {
      seal.mockRestore();
    }
  });

  it('is imported by AppModule ONLY via the inert DynamicModule (register)', () => {
    // Deliverable 3: the module may be imported, but ONLY through
    // `NotificationsModule.register()`, which registers NOTHING while the master
    // flag is off — so the import is inert. A bare `imports: [NotificationsModule]`
    // (eager wiring) would defeat that and is forbidden.
    const app = readFileSync(APP_MODULE, 'utf8');
    if (/NotificationsModule/.test(app)) {
      expect(app).toMatch(/NotificationsModule\.register\(\)/);
    }
    // register() with the master flag OFF yields no controllers and no providers.
    const prev = process.env.NOTIFICATIONS_V2_ENABLED;
    delete process.env.NOTIFICATIONS_V2_ENABLED;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { NotificationsModule } = require('../../src/notifications/notifications.module');
      const dyn = NotificationsModule.register();
      expect(dyn.controllers ?? []).toEqual([]);
      expect(dyn.providers ?? []).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.NOTIFICATIONS_V2_ENABLED;
      else process.env.NOTIFICATIONS_V2_ENABLED = prev;
    }
  });

  it('defaults the master + encrypted flags OFF when the env is unset', () => {
    const prev = process.env.NOTIFICATIONS_V2_ENABLED;
    delete process.env.NOTIFICATIONS_V2_ENABLED;
    try {
      expect(new NotificationFlags().enabled).toBe(false);
      expect(new NotificationFlags().outboxEnabled).toBe(false);
      // The encrypted-payload sub-flag cannot activate while the master is off,
      // even if its own env is set.
      process.env.NOTIF_ENCRYPTED_PAYLOAD_ENABLED = 'true';
      expect(new NotificationFlags().encryptedPayloadEnabled).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NOTIFICATIONS_V2_ENABLED;
      else process.env.NOTIFICATIONS_V2_ENABLED = prev;
      delete process.env.NOTIF_ENCRYPTED_PAYLOAD_ENABLED;
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
