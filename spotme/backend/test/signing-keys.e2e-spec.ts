import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { webcrypto } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { SUPERSEDE_DOMAIN, transcript } from '../src/auth/signing-transcript';

/**
 * The published signing-key lifecycle (ADR-008 Phase 2B), tested through real
 * HTTP against a real Postgres — because every rule here exists to survive a
 * hostile caller, and a mocked repository cannot say whether the rules hold
 * where the hostile caller actually arrives.
 *
 * The properties, in the order a rollback incident would need them:
 *   - publish is principal-keyed and idempotent; a DIFFERENT key while one is
 *     active is refused (silent replacement IS the substitution attack)
 *   - supersession requires the OLD key's signature over the length-prefixed
 *     transcript, verified BEFORE the chain changes
 *   - withdraw is the executable rollback: a served tombstone, idempotent on
 *     retry, and "never published" stays distinguishable from "rolled back"
 *   - a retired key never returns
 */
jest.setTimeout(60_000);

const hex = (n: number) =>
  Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

const b64 = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf as Uint8Array).toString('base64');

async function edKey() {
  const pair = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = await webcrypto.subtle.exportKey('raw', pair.publicKey);
  return { pair, publicKeyB64: b64(raw) };
}

async function sign(pair: CryptoKeyPair, bytes: Uint8Array) {
  return b64(await webcrypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, bytes as BufferSource));
}

describe('signing-key lifecycle', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  async function principal() {
    const id = hex(16);
    const res = await fetch(`${url}/api/auth/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        username: 'sk_' + id.slice(0, 10),
        name: 'Signing',
        secret: 'signsecret1',
      }),
    });
    const { accessToken, user } = (await res.json()) as {
      accessToken: string;
      user?: { id: string };
    };
    return { token: accessToken, id: user?.id ?? id };
  }

  const call = (token: string, method: string, path: string, body?: unknown) =>
    fetch(`${url}/api/v2/auth/signing-key${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('CROSS-IMPLEMENTATION PIN: the transcript encodes exactly as the web module does', () => {
    // Computed from web/src/lib/crypto/signing-identity.js `transcript()` —
    // if either side changes its framing, this vector breaks in that suite.
    const expected =
      '000000050000001b73706f746d652d7369676e696e672d7375706572736564652d7631' +
      '00000006757365722d31000000034f4c44000000034e45570000000745643235353139';
    const got = Buffer.from(
      transcript(SUPERSEDE_DOMAIN, ['user-1', 'OLD', 'NEW', 'Ed25519']),
    ).toString('hex');
    expect(got).toBe(expected);
  });

  it('rejects every unauthenticated call', async () => {
    for (const [method, path] of [
      ['PUT', ''],
      ['POST', '/supersede'],
      ['DELETE', ''],
      ['GET', '/someone'],
    ] as const) {
      const res = await fetch(`${url}/api/v2/auth/signing-key${path}`, { method });
      expect(res.status).toBe(401);
    }
  });

  it('publishes, serves, and is idempotent for the same key', async () => {
    const me = await principal();
    const { publicKeyB64 } = await edKey();

    const first = await call(me.token, 'PUT', '', { publicKeyB64, algo: 'Ed25519' });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, status: 'active' });

    const again = await call(me.token, 'PUT', '', { publicKeyB64, algo: 'Ed25519' });
    expect(await again.json()).toMatchObject({ ok: true, idempotent: true });

    const seen = await call(me.token, 'GET', `/${me.id}`);
    const body = await seen.json();
    expect(body).toMatchObject({ status: 'active', publicKeyB64, algo: 'Ed25519' });
    expect(body.chain).toHaveLength(1);
  });

  it('REFUSES a different key while one is active — replacement is supersession only', async () => {
    const me = await principal();
    const a = await edKey();
    const b = await edKey();
    await call(me.token, 'PUT', '', { publicKeyB64: a.publicKeyB64, algo: 'Ed25519' });

    const swap = await call(me.token, 'PUT', '', { publicKeyB64: b.publicKeyB64, algo: 'Ed25519' });
    expect(swap.status).toBe(409);

    const seen = await call(me.token, 'GET', `/${me.id}`);
    expect((await seen.json()).publicKeyB64).toBe(a.publicKeyB64);
  });

  it('refuses garbage at the door: bad algo, wrong length, non-base64', async () => {
    const me = await principal();
    const { publicKeyB64 } = await edKey();
    const cases = [
      { publicKeyB64, algo: 'X25519' }, // an AGREEMENT algo is not a signing algo
      { publicKeyB64: b64(Buffer.alloc(31)), algo: 'Ed25519' },
      { publicKeyB64: '!!!not-base64!!!', algo: 'Ed25519' },
      { algo: 'Ed25519' },
    ];
    for (const body of cases) {
      const res = await call(me.token, 'PUT', '', body);
      expect(res.status).toBe(400);
    }
  });

  it('supersedes with a valid old-key signature, retiring the old row into a checkable chain', async () => {
    const me = await principal();
    const oldKey = await edKey();
    const newKey = await edKey();
    await call(me.token, 'PUT', '', { publicKeyB64: oldKey.publicKeyB64, algo: 'Ed25519' });

    const bytes = transcript(SUPERSEDE_DOMAIN, [
      me.id,
      oldKey.publicKeyB64,
      newKey.publicKeyB64,
      'Ed25519',
    ]);
    const res = await call(me.token, 'POST', '/supersede', {
      publicKeyB64: newKey.publicKeyB64,
      algo: 'Ed25519',
      supersessionSigB64: await sign(oldKey.pair, bytes),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      ok: true,
      previousPublicKeyB64: oldKey.publicKeyB64,
    });

    const seen = await call(me.token, 'GET', `/${me.id}`);
    const body = await seen.json();
    expect(body).toMatchObject({ status: 'active', publicKeyB64: newKey.publicKeyB64 });
    expect(body.chain).toHaveLength(2);
    const retired = body.chain.find(
      (r: { publicKeyB64: string }) => r.publicKeyB64 === oldKey.publicKeyB64,
    );
    expect(retired.status).toBe('superseded');
    expect(typeof retired.supersessionSigB64).toBe('string');
    expect(retired.supersededById).toBeTruthy();
  });

  it('REFUSES a supersession signed by the wrong key — the chain is untouched', async () => {
    const me = await principal();
    const oldKey = await edKey();
    const newKey = await edKey();
    const attacker = await edKey();
    await call(me.token, 'PUT', '', { publicKeyB64: oldKey.publicKeyB64, algo: 'Ed25519' });

    const bytes = transcript(SUPERSEDE_DOMAIN, [
      me.id,
      oldKey.publicKeyB64,
      newKey.publicKeyB64,
      'Ed25519',
    ]);
    const res = await call(me.token, 'POST', '/supersede', {
      publicKeyB64: newKey.publicKeyB64,
      algo: 'Ed25519',
      supersessionSigB64: await sign(attacker.pair, bytes),
    });
    expect(res.status).toBe(400);

    const seen = await call(me.token, 'GET', `/${me.id}`);
    const body = await seen.json();
    expect(body.publicKeyB64).toBe(oldKey.publicKeyB64);
    expect(body.chain).toHaveLength(1);
  });

  it('REFUSES a signature over the wrong transcript — swapped fields are a different claim', async () => {
    const me = await principal();
    const oldKey = await edKey();
    const newKey = await edKey();
    await call(me.token, 'PUT', '', { publicKeyB64: oldKey.publicKeyB64, algo: 'Ed25519' });

    // Signed old/new SWAPPED: same strings, different claim. Length-prefixed
    // framing is exactly what makes this distinguishable from the real one.
    const swapped = transcript(SUPERSEDE_DOMAIN, [
      me.id,
      newKey.publicKeyB64,
      oldKey.publicKeyB64,
      'Ed25519',
    ]);
    const res = await call(me.token, 'POST', '/supersede', {
      publicKeyB64: newKey.publicKeyB64,
      algo: 'Ed25519',
      supersessionSigB64: await sign(oldKey.pair, swapped),
    });
    expect(res.status).toBe(400);
  });

  it('withdraws into a SERVED tombstone — distinguishable from never-published, idempotent on retry', async () => {
    const me = await principal();
    const { publicKeyB64 } = await edKey();
    await call(me.token, 'PUT', '', { publicKeyB64, algo: 'Ed25519' });

    const gone = await call(me.token, 'DELETE', '');
    expect(await gone.json()).toMatchObject({ ok: true, status: 'withdrawn', publicKeyB64 });

    // The tombstone is served: status is withdrawn, NOT 'none'.
    const seen = await call(me.token, 'GET', `/${me.id}`);
    const body = await seen.json();
    expect(body.status).toBe('withdrawn');
    expect(body.publicKeyB64).toBe(publicKeyB64);

    // Retry mid-incident: still ok, marked idempotent.
    const again = await call(me.token, 'DELETE', '');
    expect(await again.json()).toMatchObject({ ok: true, idempotent: true });

    // Someone who never published is a 404 on withdraw and 'none' on fetch.
    const fresh = await principal();
    expect((await call(fresh.token, 'DELETE', '')).status).toBe(404);
    const none = await call(fresh.token, 'GET', `/${fresh.id}`);
    expect((await none.json()).status).toBe('none');
  });

  it('a retired key NEVER returns — but a fresh key after withdrawal is allowed', async () => {
    const me = await principal();
    const first = await edKey();
    const second = await edKey();
    await call(me.token, 'PUT', '', { publicKeyB64: first.publicKeyB64, algo: 'Ed25519' });
    await call(me.token, 'DELETE', '');

    // The rollback is not undone by republishing the same key.
    const resurrect = await call(me.token, 'PUT', '', {
      publicKeyB64: first.publicKeyB64,
      algo: 'Ed25519',
    });
    expect(resurrect.status).toBe(409);

    // A genuinely new key may start a new chain.
    const restart = await call(me.token, 'PUT', '', {
      publicKeyB64: second.publicKeyB64,
      algo: 'Ed25519',
    });
    expect(restart.status).toBe(200);
    const seen = await call(me.token, 'GET', `/${me.id}`);
    const body = await seen.json();
    expect(body).toMatchObject({ status: 'active', publicKeyB64: second.publicKeyB64 });
    // Both the tombstone and the new active row are in the chain.
    expect(body.chain).toHaveLength(2);
  });

  it('cannot touch anybody else: the principal is the only writable subject', async () => {
    const me = await principal();
    const them = await principal();
    const mine = await edKey();
    const theirs = await edKey();
    await call(them.token, 'PUT', '', { publicKeyB64: theirs.publicKeyB64, algo: 'Ed25519' });

    // A body userId is ignored everywhere — publish under MY token lands on ME.
    await call(me.token, 'PUT', '', {
      publicKeyB64: mine.publicKeyB64,
      algo: 'Ed25519',
      userId: them.id,
    } as unknown as { publicKeyB64: string; algo: string });
    const theirsSeen = await call(me.token, 'GET', `/${them.id}`);
    expect((await theirsSeen.json()).publicKeyB64).toBe(theirs.publicKeyB64);
    const mineSeen = await call(me.token, 'GET', `/${me.id}`);
    expect((await mineSeen.json()).publicKeyB64).toBe(mine.publicKeyB64);

    // And MY withdraw does not touch THEIR key.
    await call(me.token, 'DELETE', '');
    const after = await call(me.token, 'GET', `/${them.id}`);
    expect((await after.json()).status).toBe('active');
  });
});
