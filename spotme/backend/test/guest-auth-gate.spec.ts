import { createGuestAuthGate, isDeletedAccount, GateUser } from '../src/middleware/guestAuth';

/**
 * The gate must stop a deleted account, and stop NOBODY ELSE.
 *
 * Making a retry loop stop is trivial; making it stop only for the terminal
 * case is the actual problem, because an over-firing gate turns a rare fault
 * into a common one. Most of this file is about the cases that must still be
 * allowed through or still be retryable.
 *
 * The `released_` case is the one worth reading twice. `releaseUsername`
 * stamps `deletedAt` AND renames the row, keeping the user alive — so a gate
 * that reads `deletedAt` alone (or a field called `isDeleted`) locks out every
 * person who has ever given up a username.
 */

const call = async (
  gate: ReturnType<typeof createGuestAuthGate>,
  headers: Record<string, string | undefined>,
) => {
  const sent: { code?: number; body?: any } = {};
  const res = {
    status(code: number) {
      sent.code = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return body;
    },
  };
  let passed = false;
  const req: any = { headers };
  await gate(req, res as any, () => {
    passed = true;
  });
  return { ...sent, passed, req };
};

const live: GateUser = { id: 'u1', username: 'ada', deletedAt: null };
const deleted: GateUser = { id: 'u2', username: 'bo', deletedAt: new Date() };
const released: GateUser = {
  id: 'u3',
  username: 'released_u3abcdef_m5x',
  deletedAt: new Date(),
};

describe('guestAuthGate', () => {
  it('THE POINT: a deleted account is refused 403 with a machine-readable code', async () => {
    const gate = createGuestAuthGate(async () => deleted);
    const r = await call(gate, { authorization: 'Bearer t' });
    expect(r.code).toBe(403);
    expect(r.body.error).toBe('deleted_account');
    expect(r.passed).toBe(false);
  });

  it('403 and not 401, because the client treats 401 as retryable', async () => {
    const gate = createGuestAuthGate(async () => deleted);
    const r = await call(gate, { authorization: 'Bearer t' });
    expect(r.code).not.toBe(401);
  });

  it('a live account passes straight through', async () => {
    const gate = createGuestAuthGate(async () => live);
    const r = await call(gate, { authorization: 'Bearer t' });
    expect(r.passed).toBe(true);
    expect(r.code).toBeUndefined();
    expect(r.req.user.id).toBe('u1');
  });

  it('THE TRAP: a RELEASED username is alive and must still pass', async () => {
    const gate = createGuestAuthGate(async () => released);
    const r = await call(gate, { authorization: 'Bearer t' });
    expect(r.passed).toBe(true);
    expect(r.code).toBeUndefined();
  });

  it('a missing token is 401, not 403 — nothing has been proved about the account', async () => {
    const gate = createGuestAuthGate(async () => live);
    const r = await call(gate, {});
    expect(r.code).toBe(401);
    expect(r.passed).toBe(false);
  });

  it('a verifier that THROWS is 401, so a database blip stays retryable', async () => {
    const gate = createGuestAuthGate(async () => {
      throw new Error('jwt expired');
    });
    const r = await call(gate, { authorization: 'Bearer t' });
    expect(r.code).toBe(401);
  });

  it('an unknown user is 401, not 403 — a token we cannot resolve is not a deletion', async () => {
    const gate = createGuestAuthGate(async () => null);
    const r = await call(gate, { authorization: 'Bearer t' });
    expect(r.code).toBe(401);
  });

  it('a malformed Authorization header is refused rather than throwing', async () => {
    const gate = createGuestAuthGate(async () => live);
    const r = await call(gate, { authorization: 'Bearer' });
    expect(r.code).toBe(401);
    expect(r.passed).toBe(false);
  });
});

describe('isDeletedAccount', () => {
  it('reads deletedAt and the username together, never deletedAt alone', () => {
    expect(isDeletedAccount({ username: 'ada', deletedAt: null })).toBe(false);
    expect(isDeletedAccount({ username: 'bo', deletedAt: new Date() })).toBe(true);
    expect(isDeletedAccount({ username: 'released_x_y', deletedAt: new Date() })).toBe(false);
    // A row with no username at all and a deletion stamp is deleted.
    expect(isDeletedAccount({ username: null, deletedAt: new Date() })).toBe(true);
  });
});
