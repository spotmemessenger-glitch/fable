import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { webcrypto } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { SUPERSEDE_DOMAIN, transcript } from '../src/auth/signing-transcript';
import { validKey } from '../src/auth/signing-keys.service';

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

// base64 leaves the final quantum's low bits unused (a 32- or 65-byte key ends
// in a 2-byte quantum → 2 free bits), so several DISTINCT strings decode to the
// SAME bytes. These build those non-canonical siblings so H2 can prove a
// re-encoded retired key cannot slip back in.
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function siblings(canonical: string): string[] {
  const pad = canonical.indexOf('=');
  const i = (pad === -1 ? canonical.length : pad) - 1; // last data char
  const v = B64_ALPHABET.indexOf(canonical[i]);
  // Canonical has the low 2 bits zero; setting them yields 3 different strings
  // that all decode to the identical bytes.
  return [1, 2, 3].map(
    (lo) => canonical.slice(0, i) + B64_ALPHABET[(v & 0b111100) | lo] + canonical.slice(i + 1),
  );
}
const nonCanonical = (canonical: string) => siblings(canonical)[0];

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

  // ── H1: per-user lifecycle writes are concurrency-safe ──────────────────

  it('H1: concurrent publishes of DIFFERENT keys leave exactly one active row', async () => {
    const me = await principal();
    const keys = await Promise.all([edKey(), edKey(), edKey(), edKey(), edKey(), edKey()]);

    const results = await Promise.all(
      keys.map((k) => call(me.token, 'PUT', '', { publicKeyB64: k.publicKeyB64, algo: 'Ed25519' })),
    );
    const statuses = results.map((r) => r.status);
    // Exactly one first-publish wins (200); the rest are refused as a different
    // key while one is active (409). None may 500, and only one row exists.
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);

    const body = await (await call(me.token, 'GET', `/${me.id}`)).json();
    expect(body.chain).toHaveLength(1);
    expect(body.chain.filter((r: { status: string }) => r.status === 'active')).toHaveLength(1);
  });

  it('H1: concurrent FIRST-publish of the SAME key is idempotent — one 200, never a 500', async () => {
    const me = await principal();
    const { publicKeyB64 } = await edKey();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => call(me.token, 'PUT', '', { publicKeyB64, algo: 'Ed25519' })),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 500)).toHaveLength(0); // no lost-create-race 500
    expect(statuses.every((s) => s === 200)).toBe(true);

    const body = await (await call(me.token, 'GET', `/${me.id}`)).json();
    expect(body.chain).toHaveLength(1);
    expect(body.status).toBe('active');
    expect(body.publicKeyB64).toBe(publicKeyB64);
  });

  it('H1: a committed withdraw is never clobbered by a racing supersede', async () => {
    // Both correct interleavings net to ZERO active rows: supersede commits then
    // withdraw removes the new key, OR withdraw commits and supersede then finds
    // nothing to supersede (404). The pre-fix bug (active read OUTSIDE the write
    // txn) revived a withdrawn row and left ONE active — reverting the rollback.
    for (let i = 0; i < 8; i++) {
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
      const supersede = call(me.token, 'POST', '/supersede', {
        publicKeyB64: newKey.publicKeyB64,
        algo: 'Ed25519',
        supersessionSigB64: await sign(oldKey.pair, bytes),
      });
      const withdraw = call(me.token, 'DELETE', '');
      const [sRes, wRes] = await Promise.all([supersede, withdraw]);

      // supersede is either 201 (ran first) or 404 (withdraw ran first); the
      // withdraw always succeeds. Neither may 500.
      expect([201, 404]).toContain(sRes.status);
      expect(wRes.status).toBe(200);

      const body = await (await call(me.token, 'GET', `/${me.id}`)).json();
      const active = body.chain.filter((r: { status: string }) => r.status === 'active');
      expect(active).toHaveLength(0); // the committed withdraw was NOT reverted
    }
  });

  // ── H2: base64 is canonicalized, so a re-encoded retired key cannot return ─

  it('H2: a non-canonical sibling of a retired key does not resurrect it', async () => {
    const me = await principal();
    const { publicKeyB64 } = await edKey();
    await call(me.token, 'PUT', '', { publicKeyB64, algo: 'Ed25519' });
    await call(me.token, 'DELETE', ''); // withdraw → served tombstone

    const sibling = nonCanonical(publicKeyB64);
    expect(sibling).not.toBe(publicKeyB64);
    expect(b64(Buffer.from(sibling, 'base64'))).toBe(publicKeyB64); // same bytes, different string

    const res = await call(me.token, 'PUT', '', { publicKeyB64: sibling, algo: 'Ed25519' });
    expect(res.status).toBe(409); // treated as the same RETIRED key, not re-activated

    const body = await (await call(me.token, 'GET', `/${me.id}`)).json();
    expect(body.chain).toHaveLength(1);
    expect(body.status).toBe('withdrawn');
    expect(body.publicKeyB64).toBe(publicKeyB64); // stored canonical, not the sibling
  });

  it('H2: a non-canonical re-publish of my own ACTIVE key is idempotent (200, not 409)', async () => {
    const me = await principal();
    const { publicKeyB64 } = await edKey();
    await call(me.token, 'PUT', '', { publicKeyB64, algo: 'Ed25519' });

    const sibling = nonCanonical(publicKeyB64);
    expect(sibling).not.toBe(publicKeyB64);

    const res = await call(me.token, 'PUT', '', { publicKeyB64: sibling, algo: 'Ed25519' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, idempotent: true });

    const body = await (await call(me.token, 'GET', `/${me.id}`)).json();
    expect(body.chain).toHaveLength(1);
    expect(body.publicKeyB64).toBe(publicKeyB64);
  });
});

/**
 * H2 canonicalization, proven WITHOUT a database. A sibling describe so it runs
 * (and passes) even where Postgres is unreachable and the lifecycle suite above
 * cannot boot — the canonicalization is a pure function of the input string.
 */
describe('base64 canonicalization (no DB)', () => {
  it('collapses every non-canonical sibling of a key to one canonical string', () => {
    const raw = Buffer.alloc(32, 0x5a); // any 32 bytes; validKey only length-checks
    const canonical = raw.toString('base64');

    for (const sibling of siblings(canonical)) {
      expect(sibling).not.toBe(canonical);
      expect(b64(Buffer.from(sibling, 'base64'))).toBe(canonical); // same bytes, different string
      expect(validKey({ publicKeyB64: sibling, algo: 'Ed25519' }).publicKeyB64).toBe(canonical);
    }

    // The canonical form is a fixed point.
    expect(validKey({ publicKeyB64: canonical, algo: 'Ed25519' }).publicKeyB64).toBe(canonical);
  });
});
