/**
 * The gate in front of the bridged /api/* handlers.
 *
 * WHY IT EXISTS. `main.ts` mounts five plain (req, res) handlers from
 * `web/api` on the Express instance underneath Nest — turn, translate, voice,
 * knock, presence. Each verifies its own token, and four of them now do. But
 * verifying a token only proves it was SIGNED by us; it says nothing about
 * whether the account behind it still exists. So a deleted user's access token
 * went on working against every bridged route for its full remaining lifetime
 * (JWT_ACCESS_TTL, 15 minutes by default), which is precisely the window
 * `auth.service.ts` closes on `/api/auth/*` and nothing closed here.
 *
 * The status codes are the load-bearing part, and they are not
 * interchangeable:
 *
 *   401  "your credentials did not work"  — the client SHOULD retry, and does.
 *   403  "we know who you are, and no"    — terminal; retrying cannot help.
 *
 * The client branches on exactly that distinction (`socket-transport.js` marks
 * a 403 `deleted_account` as `terminal` and stops both its retry loops), so
 * answering 401 for a purged account is what produces a device that spins
 * silently until its battery dies.
 *
 * WHY IT LIVES IN src/ RATHER THAN backend/middleware/. `nest-cli.json` sets
 * `rootDir: src` with `deleteOutDir`, so a .js file outside `src` is never
 * copied into `dist/` and never runs in the deployed image. A security gate
 * that is not invoked is worse than no gate, because it reads like one.
 */

/** What the gate needs to know about a caller. Nothing else is its business. */
export interface GateUser {
  id: string;
  username: string | null;
  deletedAt: Date | null;
}

export interface GateRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: GateUser;
}

export interface GateResponse {
  status(code: number): GateResponse;
  json(body: unknown): unknown;
}

/**
 * A username released rather than an account deleted.
 *
 * `releaseUsername` stamps `deletedAt` AND renames to `released_<id>_<ts>`,
 * keeping the row alive so the person can claim a new handle. Reading
 * `deletedAt` on its own — the obvious implementation, and the one a field
 * called `isDeleted` invites — locks out every user who has ever given up a
 * username. The two facts have to be read together.
 */
const RELEASED_PREFIX = 'released_';

export function isDeletedAccount(user: Pick<GateUser, 'username' | 'deletedAt'>): boolean {
  if (!user.deletedAt) return false;
  return !user.username?.startsWith(RELEASED_PREFIX);
}

/**
 * Build the gate around a token verifier.
 *
 * Injected rather than imported so this file needs no database of its own and
 * can be tested against a plain function.
 */
export function createGuestAuthGate(verifyToken: (token: string) => Promise<GateUser | null>) {
  return async function guestAuthGate(
    req: GateRequest,
    res: GateResponse,
    next: (err?: unknown) => void,
  ): Promise<unknown> {
    const header = req.headers?.authorization;
    const token = (Array.isArray(header) ? header[0] : header)?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Missing authentication token' });
    }

    let user: GateUser | null;
    try {
      user = await verifyToken(token);
    } catch {
      // A bad signature, an expired token, or a database that would not answer.
      // All retryable, so all 401 — a 403 here would permanently stop a client
      // over a transient fault.
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    if (isDeletedAccount(user)) {
      // Terminal, and machine-readable. The client branches on the CODE, not on
      // the status and not on the prose, so this shape is what stops the retry
      // loop rather than the sentence next to it.
      return res.status(403).json({ error: 'deleted_account', message: 'Account has been deleted' });
    }

    req.user = user;
    return next();
  };
}
