import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { webcrypto } from 'node:crypto';
import { AppModule } from '../src/app.module';

/**
 * X3DH prekey distribution (ADR-004 §8), through real HTTP against real
 * Postgres. The properties that matter are all about a hostile or racing
 * caller, so a mocked repository would test the wrong thing:
 *   - publish is principal-keyed and validates key shapes
 *   - a bundle fetch serves the identity + signed prekey + at most one OPK
 *   - **one-time prekeys are single-use** — two fetches never get the same one,
 *     and this is asserted under real concurrency
 *   - exhaustion serves a bundle WITHOUT an OPK (never an error, never a reuse)
 *   - SPK rotation retires the old key; the server never verifies the sig
 */
jest.setTimeout(60_000);

const hex = (n: number) =>
  Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
const b64 = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf as Uint8Array).toString('base64');

async function x25519Pub(): Promise<string> {
  const pair = (await webcrypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  return b64(await webcrypto.subtle.exportKey('raw', pair.publicKey));
}
const fakeSig = () => b64(Buffer.alloc(64, 0x07));

describe('X3DH prekeys', () => {
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
      body: JSON.stringify({ id, username: 'pk_' + id.slice(0, 10), name: 'PK', secret: 'pksecret123', birthYearMonth: '1990-01' }),
    });
    const { accessToken, user } = (await res.json()) as { accessToken: string; user?: { id: string } };
    return { token: accessToken, id: user?.id ?? id };
  }

  const call = (token: string, method: string, path: string, body?: unknown) =>
    fetch(`${url}/api/v2/auth/prekeys${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  // Publish an agreement identity key too, so a bundle fetch has an `ik` to serve.
  async function publishIdentity(token: string) {
    const pub = await x25519Pub();
    await fetch(`${url}/api/v2/auth/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ publicKey: pub, algo: 'X25519' }),
    });
    return pub;
  }

  async function bundleBody(deviceId: string, opkCount: number) {
    const opks = [];
    for (let i = 0; i < opkCount; i++) opks.push({ keyId: i, pub: await x25519Pub() });
    return { deviceId, spk: { keyId: 1, pub: await x25519Pub(), sig: fakeSig() }, opks };
  }

  it('rejects unauthenticated calls', async () => {
    expect((await fetch(`${url}/api/v2/auth/prekeys`, { method: 'PUT' })).status).toBe(401);
    expect((await fetch(`${url}/api/v2/auth/prekeys/bundle/x`, { method: 'GET' })).status).toBe(401);
  });

  it('publishes a bundle and reports the OPK pool size', async () => {
    const me = await principal();
    const dev = hex(32);
    const res = await call(me.token, 'PUT', '', await bundleBody(dev, 5));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, opksStored: 5 });

    const count = await call(me.token, 'GET', `/count/${dev}`);
    expect(await count.json()).toMatchObject({ opks: 5, hasSignedPreKey: true });
  });

  it('validates key shapes at the door', async () => {
    const me = await principal();
    const dev = hex(32);
    const good = await x25519Pub();
    const cases = [
      { deviceId: 'not-hex', spk: { keyId: 1, pub: good, sig: fakeSig() }, opks: [] },
      { deviceId: dev, spk: { keyId: 1, pub: b64(Buffer.alloc(31)), sig: fakeSig() }, opks: [] },
      { deviceId: dev, spk: { keyId: 1, pub: good, sig: b64(Buffer.alloc(63)) }, opks: [] },
      { deviceId: dev, spk: { keyId: -1, pub: good, sig: fakeSig() }, opks: [] },
      { deviceId: dev, spk: { keyId: 1, pub: good, sig: fakeSig() }, opks: [{ keyId: 0, pub: b64(Buffer.alloc(10)) }] },
    ];
    for (const body of cases) {
      expect((await call(me.token, 'PUT', '', body)).status).toBe(400);
    }
  });

  it('serves a peer bundle: identity + signed prekey + one OPK', async () => {
    const bob = await principal();
    const bobPub = await publishIdentity(bob.token);
    const dev = hex(32);
    await call(bob.token, 'PUT', '', await bundleBody(dev, 3));

    const alice = await principal();
    const res = await call(alice.token, 'GET', `/bundle/${bob.id}?deviceId=${dev}`);
    expect(res.status).toBe(200);
    const bundle = await res.json();
    expect(bundle.ik).toBe(bobPub);
    expect(bundle.spk).toMatchObject({ keyId: 1 });
    expect(bundle.opk).toBeTruthy();
    expect(typeof bundle.opk.keyId).toBe('number');

    // The pool dropped by exactly one.
    expect((await call(bob.token, 'GET', `/count/${dev}`).then((r) => r.json())).opks).toBe(2);
  });

  it('ONE-TIME PREKEYS ARE SINGLE-USE — concurrent fetches never collide', async () => {
    const bob = await principal();
    await publishIdentity(bob.token);
    const dev = hex(32);
    await call(bob.token, 'PUT', '', await bundleBody(dev, 10));

    // Ten fetchers race for ten OPKs. Every served OPKID must be distinct.
    const fetchers = await Promise.all(
      Array.from({ length: 10 }, () => principal()),
    );
    const bundles = await Promise.all(
      fetchers.map((a) => call(a.token, 'GET', `/bundle/${bob.id}?deviceId=${dev}`).then((r) => r.json())),
    );
    const served = bundles.map((b) => b.opk?.keyId).filter((k) => k !== undefined && k !== null);
    expect(served.length).toBeGreaterThan(0);
    expect(new Set(served).size).toBe(served.length); // no duplicates
    expect((await call(bob.token, 'GET', `/count/${dev}`).then((r) => r.json())).opks).toBe(10 - served.length);
  });

  it('exhaustion serves a bundle WITHOUT an OPK — never an error, never a reuse', async () => {
    const bob = await principal();
    await publishIdentity(bob.token);
    const dev = hex(32);
    await call(bob.token, 'PUT', '', await bundleBody(dev, 1)); // exactly one OPK

    const a1 = await principal();
    const a2 = await principal();
    const first = await call(a1.token, 'GET', `/bundle/${bob.id}?deviceId=${dev}`).then((r) => r.json());
    const second = await call(a2.token, 'GET', `/bundle/${bob.id}?deviceId=${dev}`).then((r) => r.json());
    expect(first.opk).toBeTruthy();
    expect(second.opk).toBeNull(); // pool empty, bundle still served
    expect(second.spk).toBeTruthy();
    expect(second.ik).toBeTruthy();
  });

  it('rotating the signed prekey retires the old one', async () => {
    const bob = await principal();
    await publishIdentity(bob.token);
    const dev = hex(32);
    await call(bob.token, 'PUT', '', {
      deviceId: dev,
      spk: { keyId: 1, pub: await x25519Pub(), sig: fakeSig() },
      opks: [],
    });
    const newSpk = await x25519Pub();
    await call(bob.token, 'PUT', '', {
      deviceId: dev,
      spk: { keyId: 2, pub: newSpk, sig: fakeSig() },
      opks: [],
    });
    const alice = await principal();
    const bundle = await call(alice.token, 'GET', `/bundle/${bob.id}?deviceId=${dev}`).then((r) => r.json());
    expect(bundle.spk.keyId).toBe(2);
    expect(bundle.spk.pub).toBe(newSpk);
  });

  it('a bundle for a device with no signed prekey is a 404, not a partial answer', async () => {
    const bob = await principal();
    await publishIdentity(bob.token);
    const alice = await principal();
    const res = await call(alice.token, 'GET', `/bundle/${bob.id}?deviceId=${hex(32)}`);
    expect(res.status).toBe(404);
  });
});
